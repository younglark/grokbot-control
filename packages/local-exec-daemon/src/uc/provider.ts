import { loadSettings } from "../settings";
import { HttpStatusError, ReplyQueue } from "../transport/replies";
import { requestError } from "../exec/handlers";
import * as crypto from "node:crypto";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { GrokBotService } from "../generated/svc_aiserver.v1.GrokBotService_connect";
import { GrokBotUserComputerQueuedRequest, GrokBotUserComputerRequestFrame,
  GrokBotUserComputerResponseFrame, GrokBotUserComputerHello,
  GrokBotUserComputerClientMessage, GrokBotUserComputerControlMessage,
  GrokBotUserComputerMessagesError, GrokBotUserComputerFileError, GrokBotUserComputerMessagesAccepted,
  SubmitGrokBotUserComputerResponsesRequest } from "../generated/aiserver.v1_pb";
import {
  lastAllocatedExecIdOrZero,
  cancelRequest,
  dispatchExec,
  type Emit,
  type ExecFrameOut,
} from "../exec/handlers";
import {
  decodeExecServerMessageJson,
  encodeExecClientControlMessageJson,
  encodeExecClientMessageJson,
  execServerMessageToRecord,
  isExecServerDecodeError,
} from "../exec/exec-codec";
import type { PermissionMode } from "../settings";
import { isSupervised } from "../state/discovery";
import type { UserComputerHello, UserComputerTransport } from "./types";

export type UcProviderOptions = {
  backendUrl: string;
  machineId: string;
  credential: string;
  root: string;
  permission: PermissionMode;
  hello: Omit<UserComputerHello, "supervised"> & { supervised?: boolean };
  onInflight?: (n: number) => void;
  /** Max poll limit (official default-ish). */
  pollLimit?: number;
  accountScope?: string;
};

const requestKinds = Object.fromEntries(GrokBotUserComputerRequestFrame.fields.list().map(f => [f.localName, f.no]));

// Only business mapping remains here. Field numbers, oneof and int64 are runtime-owned.
export type Queued = { id: string; requestId: string; kind: number; serverMessage: Record<string, unknown>; parseError?: string };
export function parseQueued(item: GrokBotUserComputerQueuedRequest): Queued {
  const id = item.id;
  const frame = item.frame;
  const requestId = frame?.requestId || id;
  try {
    if (!id || !frame?.frame.case) throw new Error("invalid request oneof");
    const kind = GrokBotUserComputerRequestFrame.fields.list().find(f => f.localName === frame.frame.case)!.no;
    let serverMessage: Record<string, unknown> = {};
    if (frame.frame.case === "exec") {
      // Official: ExecServerMessage.fromJsonString(serverMessageJson, { ignoreUnknownFields: true }).
      const decoded = decodeExecServerMessageJson(frame.frame.value.serverMessageJson);
      serverMessage = execServerMessageToRecord(decoded);
    }
    return { id, requestId, kind, serverMessage };
  } catch (error) {
    const parseError = isExecServerDecodeError(error)
      ? (error as Error).message
      : error instanceof Error && error.message === "invalid request oneof"
        ? "This computer's local-exec daemon does not understand that request frame; update the desktop app."
        : "Malformed local-exec request frame";
    return { id, requestId, kind: 0, serverMessage: {}, parseError };
  }
}
function responseFrame(frame: ExecFrameOut): GrokBotUserComputerResponseFrame {
  const result = new GrokBotUserComputerResponseFrame({requestId: frame.requestId});
  if (frame.kind === "client") {
    // Outer payload remains messageJson string; inner body is schema-validated when possible.
    result.frame = {case: "client", value: new GrokBotUserComputerClientMessage({
      messageJson: encodeExecClientMessageJson(frame.message),
    })};
  } else if (frame.kind === "control") {
    result.frame = {case: "control", value: new GrokBotUserComputerControlMessage({
      messageJson: encodeExecClientControlMessageJson(frame.message),
      cwdState: frame.cwdState,
    })};
  } else if (frame.kind === "messages-error") result.frame = {case: "messagesError", value: new GrokBotUserComputerMessagesError({error: frame.error})};
  else if (frame.kind === "file-error") result.frame = {case: "fileError", value: new GrokBotUserComputerFileError({error: frame.error})};
  return result;
}
function authError(error: unknown): boolean {
  return error instanceof ConnectError && (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied);
}

/**
 * UserComputer ConnectRPC transport (P2 skeleton).
 * Speaks Watch/Poll/Submit/Withdraw against a lab fake peer or compatible backend.
 */
/** Official h9r / m9r / A9 (daemon.formatted.cjs L177855–177856, L135894–135895, L178589–178599). */
export const UC_BACKLOG_STALE_MS = 15_000;
export const UC_BACKLOG_NUDGE_MS = 5_000;
export const UC_BACKLOG_CLOSED_BEFORE_START =
  "The user's computer stopped serving requests before this one started. Retry it once the computer is back.";
/** Official keepAliveTick interval c9r (L177956 / L177848 area). */
export const UC_KEEPALIVE_INTERVAL_MS = 500;
/** Official rgt / _9r (daemon.formatted.cjs L177859–177860). */
export const UC_INFLIGHT_MAX = 8;
/**
 * Official keepalive constants (daemon.formatted.cjs L177848–177854, L97389, L177276):
 * l9r admit→first due 1s; u9r heard→next due 3s; d9r keepalive submit deadline 3s;
 * f9r ResourceExhausted pause 5s; p9r batching window 1.5s; E0 stuck-submit cutoff 120s; X7e 256 ids.
 */
export const UC_KEEPALIVE_ADMIT_MS = 1_000;
export const UC_KEEPALIVE_HEARD_MS = 3_000;
export const UC_KEEPALIVE_SUBMIT_DEADLINE_MS = 3_000;
export const UC_KEEPALIVE_EXHAUSTED_PAUSE_MS = 5_000;
export const UC_KEEPALIVE_WINDOW_MS = 1_500;
export const UC_KEEPALIVE_STUCK_SUBMIT_MS = 120_000;
export const UC_KEEPALIVE_MAX_IDS = 256;
/** Official S9r: safety poll cadence while the Watch is connected. */
export const UC_SAFETY_POLL_MS = 30_000;
export const UC_DATA_SUBMIT_DEADLINE_MS = 120_000;
/** Bound for deferred closing replies: backlog (64) plus one poll's worth of busy rejections (64). */
export const UC_PENDING_CLOSINGS_MAX = 128;
/** Official Kce (daemon.formatted.cjs L81192). */
export const UC_CANCELLED_BEFORE_START = "Cancelled before it started on the user's computer.";

/** Official A9r: if any eligible id is due, send every eligible id due within the window, earliest first. */
export function selectKeepAliveIds(dueAt: Map<string, number>, eligible: Set<string>, now: number): string[] {
  const e = [...dueAt].filter(([id]) => eligible.has(id));
  if (!e.some(([, d]) => d <= now)) return [];
  return e.filter(([, d]) => d <= now + UC_KEEPALIVE_WINDOW_MS).sort(([, a], [, b]) => a - b)
    .slice(0, UC_KEEPALIVE_MAX_IDS).map(([id]) => id);
}
export const UC_BACKLOG_MAX = 64;
export const UC_BUSY_TEXT =
  "The user's computer is busy with other requests right now; try again shortly.";

export class UserComputerProvider implements UserComputerTransport {
  private closed = false;
  private stopped = false;
  private abort = new AbortController();
  private presenceToken = crypto.randomBytes(16).toString("hex");
  private pendingAcks: string[] = [];
  private seen = new Set<string>();
  private inflight = 0;
  private pollBusy = false;
  private replies?: ReplyQueue;
  private backlog: Queued[] = [];
  private active = new Set<string>();
  private activeJobs = new Set<Promise<void>>();
  private pollAgain = false;
  private pollTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;
  private admissionClosed = false;
  /** Official keepAliveDueAt / cancelledIds / keepAlivePausedUntil / proven (Watch `connected` seen). */
  readonly keepAliveDueAt = new Map<string, number>();
  private cancelledIds = new Set<string>();
  private keepAlivePausedUntil = 0;
  private keepAliveSending = false;
  private proven = false;
  private pendingClosings: ExecFrameOut[] = [];
  /** Some polled item was left unacknowledged because its closing reply could not be held. */
  private unackedWaiting = false;
  private announcedStanding?: string;
  /** Official lastPolledAt (monotonic in daemon; wall clock here). */
  lastPolledAt = 0;
  get blocked(): boolean { return this.admissionClosed; }
  private channel: { backendUrl: string; machineId: string; credential: string } | null =
    null;

  private client: Client<typeof GrokBotService>;
  constructor(private readonly opts: UcProviderOptions) {
    this.client = createClient(GrokBotService, createConnectTransport({
      baseUrl: opts.backendUrl, httpVersion: "1.1", useBinaryFormat: true,
      readMaxBytes: 8 * 1024 * 1024, writeMaxBytes: 8 * 1024 * 1024,
    }));
  }

  async start(): Promise<void> {
    const supervised = this.opts.hello.supervised ?? (await isSupervised());
    const hello: UserComputerHello = {
      ...this.opts.hello,
      supervised,
      standing: this.opts.hello.standing || "always",
      serverAuthoritative: this.opts.hello.serverAuthoritative ?? false,
    };
    this.channel = {
      backendUrl: this.opts.backendUrl.replace(/\/$/, ""),
      machineId: this.opts.machineId,
      credential: this.opts.credential,
    };
    this.replies = new ReplyQueue(async (body, signal) => {
      const ch = this.channel!;
      // Queue bodies retain response payloads, not the authority of expired creds.
      const request = SubmitGrokBotUserComputerResponsesRequest.fromBinary(body);
      request.machineId = ch.machineId; request.credential = ch.credential;
      let res;
      // Official dataDeadline E0 = 120s (daemon.formatted.cjs L97389, L177954). A 2s cap re-submitted the
      // same frames every ~2.4s while the peer was slow (oracle uc-keepalive stall).
      try { res = await this.client.submitGrokBotUserComputerResponses(request, {timeoutMs: UC_DATA_SUBMIT_DEADLINE_MS, signal}); }
      catch (error) {
        // Channel fencing: a rejection of a credential that has since been rotated is retried on the
        // current channel instead of closing it (official rejectCredential checks channel identity).
        if (authError(error)) throw new HttpStatusError(401, ch);
        throw error;
      }
      this.noteHeard(request.frames.map(f => f.requestId));
      const accepted = res.acceptedCount;
      const submitted = request.frames.length;
      // Official successful Submit is terminal even when the machine rejected
      // some frames. Only transport/HTTP errors are retried, never accepted_count.
      if (accepted < submitted) console.error(
        `[user-computer-provider] server accepted ${accepted} of ${submitted} response frames; the rest were not queued for this machine`,
      );
    }, (e) => {
      // Fenced where the failure is set (not only when the RPC returned): a stale channel's 401 never
      // closes admission of a channel that rotated in between (official rejectCredential: channel===e).
      if (e.epoch !== undefined && e.epoch !== this.channel) return false;
      this.admissionClosed = true; this.abort.abort(); return true;
    },
    // Official replies.take() submits every ready frame in one batch; encoded protobuf requests
    // merge by concatenation (repeated `frames`; machineId/credential are reset per submit above).
    undefined, undefined, bodies => Buffer.concat(bodies));
    this.lastPolledAt = Date.now();
    // Official polls on Watch connected / notify / heartbeat plus a 30 s safety poll (S9r, D:L177858,
    // L177943, L178389–178403). A former 250 ms poll setInterval here put extra timer wake-ups next
    // to the 500 ms keepalive tick: instrumented offline runs showed ours' tick timers firing earlier
    // (mean +0.30 ms vs official +0.47…0.57 ms per tick), so the 6th tick after a heard keepalive
    // (due exactly +3000 ms) sometimes missed by <1 ms and slipped one tick (+500 ms).
    this.pollTimer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, UC_SAFETY_POLL_MS);
    // Official keepAliveTick (~500ms) runs superviseBacklog then sendKeepAlives.
    // Official hc/yre tick is serial: the next tick is scheduled UC_KEEPALIVE_INTERVAL_MS after the
    // previous tick (including its keepalive submit) completes, not on a fixed grid.
    const tick = async (): Promise<void> => {
      if (this.closed) return;
      try { this.flushClosings(); this.superviseBacklog(); await this.sendKeepAlives(); } catch { /* tick failures never stop the loop */ }
      if (!this.closed) this.keepAliveTimer = setTimeout(() => void tick(), UC_KEEPALIVE_INTERVAL_MS);
    };
    this.keepAliveTimer = setTimeout(() => void tick(), UC_KEEPALIVE_INTERVAL_MS);
    let attempts = 0;
    while (!this.closed) {
      if (this.admissionClosed) { await new Promise(r => setTimeout(r, 100)); continue; }
      hello.standing = (await loadSettings()).permission;
      hello.serverAuthoritative = this.opts.hello.serverAuthoritative;
      this.announcedStanding = hello.standing;
      await this.watchLoop(hello);
      if (this.closed) break;
      await new Promise(r => setTimeout(r, Math.min(2000, 100 * 2 ** Math.min(attempts++, 4))));
    }
    clearInterval(this.pollTimer);
    clearTimeout(this.keepAliveTimer);
  }

  /** Same-machine, same-scope rotation resumes the SAME reply/ack/task state. */
  updateChannel(next: { backendUrl: string; machineId: string; credential: string; accountScope?: string; serverAuthoritative?: boolean }): boolean {
    if (!this.channel || this.closed || next.machineId !== this.opts.machineId || next.accountScope !== this.opts.accountScope || next.backendUrl.replace(/\/$/, "") !== this.opts.backendUrl.replace(/\/$/, "")) return false;
    if (next.serverAuthoritative) this.opts.hello.serverAuthoritative = true;
    if (next.credential === this.channel.credential) return false;
    this.channel = { ...this.channel, credential: next.credential };
    // Never relax an authoritative channel by credential file mutation.
    if (next.serverAuthoritative) this.opts.hello.serverAuthoritative = true;
    this.proven = false;
    this.abort.abort(); this.abort = new AbortController();
    this.admissionClosed = false; this.replies?.resume(); return true;
  }

  // Interface compatibility with earlier stub signature
  async startWithChannel(
    _channel: { backendUrl: string; machineId: string; credential: string },
    _hello: UserComputerHello,
  ): Promise<void> {
    return this.start();
  }

  beginShutdown(): void {
    this.closed = true; clearInterval(this.pollTimer); clearTimeout(this.keepAliveTimer); this.abort.abort();
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.beginShutdown();
    this.backlog = [];
    this.active.forEach(id => cancelRequest(id));
    // Abort exits must reach emit before draining/stopping the reply lane.
    await Promise.race([Promise.all([...this.activeJobs]), new Promise(r => setTimeout(r, 1000))]);
    const drained = await this.replies?.drain();
    if (drained === false) console.error("[user-computer-provider] reply drain deadline (pending replies retained until process exit)");
    this.replies?.stop();
    this.abort.abort();
    const ch = this.channel;
    if (!ch) return;
    try {
      await this.client.withdrawGrokBotUserComputerPresence({
        machineId: ch.machineId, credential: ch.credential, presenceToken: this.presenceToken,
      }, {timeoutMs: 2000});
    } catch {
      /* ignore */
    }
  }

  private bump(delta: number): void {
    this.inflight += delta;
    this.opts.onInflight?.(this.inflight);
  }

  private emit: Emit = (frame) => this.queueSubmit([frame]);

  private queueSubmit(frames: ExecFrameOut[]): Promise<void> {
    const ch = this.channel;
    if (!ch || frames.length === 0 || !this.replies) return Promise.resolve();
    return this.replies.enqueue(Buffer.from(new SubmitGrokBotUserComputerResponsesRequest({
      machineId: ch.machineId, credential: ch.credential, frames: frames.map(responseFrame),
    }).toBinary()), frames.map(f => f.requestId));
  }

  async pollOnce(): Promise<void> {
    if (this.pollBusy) { this.pollAgain = true; return; }
    // Official keeps polling at capacity/backpressure so cancel + superviseBacklog nudge stay live.
    if (this.closed || this.admissionClosed || !this.channel) return;
    this.pollBusy = true;
    const acks = this.pendingAcks.splice(0);
    const pollChannel = this.channel;
    let polled = false;
    try {
      const ch = pollChannel;
      const liveStanding = (await loadSettings()).permission;
      if (this.announcedStanding !== undefined && liveStanding !== this.announcedStanding) {
        // Re-announce policy by replacing only the Watch connection, never tasks.
        this.announcedStanding = liveStanding;
        this.abort.abort(); this.abort = new AbortController();
      }
      const slots = Math.max(0, UC_INFLIGHT_MAX + UC_BACKLOG_MAX - this.active.size - this.backlog.length);
      // Continue polling at capacity: cancel controls must remain reachable.
      const res = await this.client.pollGrokBotUserComputerRequests({
        machineId: ch.machineId, credential: ch.credential, ackIds: acks,
        limit: Math.min(this.opts.pollLimit ?? UC_BACKLOG_MAX, Math.max(1, slots)),
      }, {timeoutMs: 2000});
      const queued = res.requests.map(parseQueued).filter(q => q.id);
      // Only forget queue ids after the peer confirms receipt of prior acks.
      acks.forEach(id => this.seen.delete(id));
      for (const q of queued) {
        if (this.seen.has(q.id)) continue;
        // Capacity is checked before ack/admission. Cancel controls bypass backlog.
        this.seen.add(q.id); this.pendingAcks.push(q.id);
        if (q.parseError) { if (!this.storeClosingFrame({ kind: "control", requestId: q.requestId, message: { throw: { error: q.parseError } } })) this.unack(q); continue; }
        if (q.kind === requestKinds.cancel) {
          // Official (D:L178526–178535, Gl/Kce): each cancelled backlog entry gets a closing error.
          const dropped = this.backlog.filter(x => x.requestId === q.requestId);
          // No room to hold their closing replies: leave the cancel unacknowledged (redelivered by the
          // next poll) instead of dropping terminal frames of already-acknowledged backlog work.
          if (dropped.length > this.closingRoom()) { this.unack(q); continue; }
          this.cancelledIds.add(q.requestId);
          this.backlog = this.backlog.filter(x => x.requestId !== q.requestId);
          // Official replies.drop(requestId) + submitAbort when the in-flight batch is all cancelled.
          cancelRequest(q.requestId);
          if (typeof this.replies?.drop === 'function') this.replies.drop(id => this.cancelledIds.has(id));
          for (const d of dropped) this.storeClosing(d, UC_CANCELLED_BEFORE_START);
          continue;
        }
        // Promote before admit (official startRequest.finally pulls while inflight<8,
        // D:L178576–178583). Same-poll recoveries with replies.available must free
        // backlog slots before the busy check — otherwise a recovered lane falsely
        // busy-rejects while active still has room.
        this.runBacklog();
        // Official busy: inflight>=8 && backlog>=64 (D:L178548–178552).
        // Lab compensation (NOT claimed equivalent): if backlog is still full after
        // promote — including reply-stall where runBacklog cannot move work —
        // refuse so backlog never grows past 64.
        if (this.backlog.length >= UC_BACKLOG_MAX) {
          // The queue item is acknowledged only once its busy reply is held (lane or bounded deferral);
          // otherwise it stays unacknowledged and the server redelivers it on a later poll.
          if (!this.storeClosing(q, UC_BUSY_TEXT)) this.unack(q);
          continue;
        }
        // Official startRequest suppresses an already-inflight requestId with
        // no additional result; queue-id ack remains separate. Pending backlog
        // entries are not a durable request-id dedup ledger.
        if (this.active.has(q.requestId)) continue;
        this.noteAdmitted(q.requestId);
        this.backlog.push(q); this.runBacklog();
      }
      // A previously saturated reply lane may have recovered with no new jobs.
      this.runBacklog();
      this.lastPolledAt = Date.now(); polled = true;
    } catch (e) {
      this.pendingAcks.unshift(...acks);
      if (authError(e)) this.rejectCredential(pollChannel);
      // Failed poll never re-executes an admitted request.
    } finally {
      this.pollBusy = false;
      // Official pollOnce loops at once while acks are pending or the page was full
      // (D:L178459–178557), so a burst (e.g. 64 cancels) is drained in back-to-back polls, not one
      // page per safety-poll tick. Only once the provider loop is running (pollTimer).
      const drain = polled && this.pollTimer !== undefined && !this.closed && this.pendingAcks.length > 0;
      if (this.pollAgain || drain) { this.pollAgain = false; setTimeout(() => void this.pollOnce().catch(() => undefined), drain ? 0 : 25); }
    }
  }
  /**
   * Official superviseBacklog (daemon.formatted.cjs L178589–178599):
   * age > 15s → drain backlog with A9 closing text; age >= 5s → nudge poll.
   * Exposed for regressions (clock injectable via nowMs).
   */
  superviseBacklog(nowMs = Date.now()): void {
    if (this.backlog.length === 0 || this.closed || this.admissionClosed) return;
    if (this.lastPolledAt <= 0) return;
    const age = nowMs - this.lastPolledAt;
    if (age > UC_BACKLOG_STALE_MS) {
      // Items whose closing reply cannot be held yet stay in the backlog (still held and keepalived)
      // and are drained on a later tick.
      const drained = this.backlog.splice(0, this.backlog.length);
      for (const q of drained) if (!this.storeClosing(q, UC_BACKLOG_CLOSED_BEFORE_START)) this.backlog.push(q);
    } else if (age >= UC_BACKLOG_NUDGE_MS) {
      void this.pollOnce().catch(() => undefined);
    }
  }

  noteAdmitted(requestId: string, now = performance.now()): void {
    this.keepAliveDueAt.set(requestId, now + UC_KEEPALIVE_ADMIT_MS);
  }
  noteHeard(requestIds: Iterable<string>, now = performance.now()): void {
    for (const id of requestIds) this.keepAliveDueAt.set(id, now + UC_KEEPALIVE_HEARD_MS);
  }
  private heldRequestIds(): Set<string> {
    const held = new Set<string>(this.active);
    for (const q of this.backlog) held.add(q.requestId);
    for (const id of this.replies?.requestIds() ?? []) held.add(id);
    for (const id of this.replies?.submitting ?? []) held.add(id);
    for (const f of this.pendingClosings) held.add(f.requestId);
    return held;
  }
  /** Official keepAliveEligibleIds: backlog, queued replies, and a submitting batch unless stuck ≥120s; minus cancelled. Running requests with nothing queued are not eligible. */
  keepAliveEligibleIds(now: number): Set<string> {
    const out = new Set<string>();
    for (const q of this.backlog) out.add(q.requestId);
    const submitting = this.replies?.submitting ?? [];
    const stuck = submitting.length > 0 && now - (this.replies?.submittingSince ?? now) >= UC_KEEPALIVE_STUCK_SUBMIT_MS;
    const stuckIds = new Set(stuck ? submitting : []);
    for (const id of this.replies?.requestIds() ?? []) if (!stuckIds.has(id)) out.add(id);
    if (!stuck) for (const id of submitting) out.add(id);
    // Deferred closing replies are queued replies not yet in the lane (official: replies.requestIds()).
    for (const f of this.pendingClosings) out.add(f.requestId);
    for (const id of this.cancelledIds) out.delete(id);
    return out;
  }
  /** Official sendKeepAlives (daemon.formatted.cjs L178625–178661): messagesAccepted frames only. */
  async sendKeepAlives(now = performance.now()): Promise<string[]> {
    const ch = this.channel;
    if (!ch || !this.proven || this.closed || this.admissionClosed || this.keepAliveSending) return [];
    const held = this.heldRequestIds();
    for (const id of [...this.keepAliveDueAt.keys()]) if (!held.has(id)) this.keepAliveDueAt.delete(id);
    for (const id of [...this.cancelledIds]) if (!held.has(id)) this.cancelledIds.delete(id);
    if (now < this.keepAlivePausedUntil) return [];
    const ids = selectKeepAliveIds(this.keepAliveDueAt, this.keepAliveEligibleIds(now), now);
    if (ids.length === 0) return [];
    this.keepAliveSending = true;
    try {
      await this.client.submitGrokBotUserComputerResponses(new SubmitGrokBotUserComputerResponsesRequest({
        machineId: ch.machineId, credential: ch.credential,
        frames: ids.map(requestId => new GrokBotUserComputerResponseFrame({ requestId,
          frame: { case: "messagesAccepted", value: new GrokBotUserComputerMessagesAccepted() } })),
      }), { timeoutMs: UC_KEEPALIVE_SUBMIT_DEADLINE_MS });
      this.noteHeard(ids);
    } catch (error) {
      if (authError(error)) this.rejectCredential(ch);
      else if (error instanceof ConnectError && error.code === Code.ResourceExhausted) {
        this.keepAlivePausedUntil = performance.now() + UC_KEEPALIVE_EXHAUSTED_PAUSE_MS;
      }
    } finally { this.keepAliveSending = false; }
    return ids;
  }

  /**
   * Closing replies (busy / cancelled-before-start / backlog drained / parse error / unsupported).
   * A closing reply is either held by the reply lane (`offer`, sync) or, while the lane is full, by a
   * bounded deferral list retried in order from the keepalive tick. If neither can hold it the caller
   * keeps the work retryable (queue item left unacknowledged, backlog item kept, job retries):
   * a terminal frame is never dropped after its queue item was acknowledged.
   */
  private closingFrame(q: Queued, error: string): ExecFrameOut {
    if ([requestKinds.upload, requestKinds.download, requestKinds.discoverAiTool].includes(q.kind)) return { kind: "file-error", requestId: q.requestId, error };
    if (q.kind === requestKinds.messagesOp) return { kind: "messages-error", requestId: q.requestId, error };
    return { kind: "control", requestId: q.requestId, message: { throw: { id: 0, error } } };
  }
  private storeClosing(q: Queued, error: string): boolean { return this.storeClosingFrame(this.closingFrame(q, error)); }
  /** Same as storeClosing (name kept for regressions/probes); returns whether the reply is held. */
  private emitClosing(q: Queued, error: string): boolean { return this.storeClosing(q, error); }
  private storeClosingFrame(frame: ExecFrameOut): boolean {
    if (this.closed) return false;
    if (!this.pendingClosings.length && this.offerFrame(frame)) return true;
    if (this.pendingClosings.length >= UC_PENDING_CLOSINGS_MAX) return false;
    this.pendingClosings.push(frame); return true;
  }
  /** Free deferral slots (the lane itself may hold more; this is the guaranteed part). */
  private closingRoom(): number { return UC_PENDING_CLOSINGS_MAX - this.pendingClosings.length; }
  private offerFrame(frame: ExecFrameOut): boolean {
    const ch = this.channel; const r = this.replies;
    if (!ch || !r) return false;
    if (typeof r.offer === "function") return r.offer(Buffer.from(new SubmitGrokBotUserComputerResponsesRequest({
      machineId: ch.machineId, credential: ch.credential, frames: [responseFrame(frame)] }).toBinary()), [frame.requestId]);
    // Minimal stubs without offer(): fall back to emit; a rejection re-defers (bounded).
    let p: Promise<void>;
    try { p = Promise.resolve(this.emit(frame)); } catch (e) { p = Promise.reject(e); }
    p.catch(() => { if (!this.closed && this.pendingClosings.length < UC_PENDING_CLOSINGS_MAX) this.pendingClosings.push(frame); });
    return true;
  }
  /** Leave a polled queue item unacknowledged so the server redelivers it. */
  private unack(q: Queued): void {
    this.unackedWaiting = true;
    this.seen.delete(q.id);
    const i = this.pendingAcks.lastIndexOf(q.id); if (i >= 0) this.pendingAcks.splice(i, 1);
  }
  /** Retry deferred closing replies in order while the lane accepts them. */
  private flushClosings(): void {
    while (this.pendingClosings.length && !this.closed && this.offerFrame(this.pendingClosings[0])) this.pendingClosings.shift();
    // Items left unacknowledged for lack of room are fetched again by one poll as soon as room exists
    // (event-driven; there is no fast poll timer, official polls on Watch events + 30 s safety poll).
    if (this.unackedWaiting && this.closingRoom() > 0 && !this.closed) { this.unackedWaiting = false; void this.pollOnce().catch(() => undefined); }
  }
  /** Official rejectCredential(e): only the channel that is still current may be closed. */
  private rejectCredential(ch: { credential: string } | null): void {
    if (!ch || this.channel !== ch) return;
    this.admissionClosed = true; this.abort.abort();
  }

  private runBacklog(): void {
    while (!this.closed && !this.admissionClosed && this.active.size < UC_INFLIGHT_MAX && this.backlog.length && this.replies?.available) {
      const q = this.backlog.shift()!;
      if (this.active.has(q.requestId)) continue;
      this.active.add(q.requestId); this.bump(1);
      const job = this.handleQueued(q).catch(e => requestError(q.requestId, lastAllocatedExecIdOrZero(), e, this.emit))
        .catch(() => { console.error("[user-computer-provider] request reply failed"); })
        .then(() => undefined).finally(() => { this.activeJobs.delete(job); this.active.delete(q.requestId); this.bump(-1); this.runBacklog(); });
      this.activeJobs.add(job);
    }
  }
  private async handleQueued(q: Queued): Promise<void> {
    if (q.kind !== requestKinds.exec) {
      // Frozen oracle dispatch maps unimplemented outer variants to an error.
      // Full variant-specific payloads remain a documented gap (not silent success).
      const error = "This computer's local-exec daemon does not understand that request frame; update the desktop app.";
      // An admitted job: wait (bounded by the job's own slot) until its terminal frame is held.
      while (!this.closed && !this.storeClosing(q, error)) await new Promise(r => setTimeout(r, UC_KEEPALIVE_INTERVAL_MS));
      return;
    }
    // Authoritative / approval / scope grants are NOT implemented. Fail closed.
    const live = await loadSettings();
    const permission = this.opts.hello.serverAuthoritative ? "ask" : live.permission;
    await dispatchExec({ root: this.opts.root, requestId: q.requestId,
      serverMessage: q.serverMessage, permission, emit: this.emit });
  }

  private async watchLoop(hello: UserComputerHello): Promise<void> {
    const ch = this.channel!;
    this.proven = false;
    try {
      const events = this.client.watchGrokBotUserComputerRequests({
        machineId: ch.machineId, credential: ch.credential, presenceToken: this.presenceToken,
        hello: GrokBotUserComputerHello.fromJsonString(JSON.stringify(hello)),
      }, {signal: this.abort.signal});
      for await (const event of events) {
        if (event.event.case === "connected") this.proven = true;
        if (["connected", "notify", "heartbeat"].includes(event.event.case || "")) {
          void this.pollOnce().catch(() => undefined);
        }
      }
    } catch (error) {
      if (authError(error)) this.rejectCredential(ch);
      // One Watch connection ending never closes reply, task or acknowledgment state.
    }
  }
}
