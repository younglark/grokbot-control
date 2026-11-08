import { trace } from "../trace";
import { loadSettings, loadSettingsSync } from "../settings";
import { HttpStatusError, type ReplyQueue } from "../transport/replies";
import { UcReplyLanes } from "./reply-lanes";
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
import { dataRootFromEnv } from "../util";
import { approvalsPathFor, authorizationOf, describeExec, execRefusal, retireApproval, retirementsPathFor, type Authorization } from "./approvals";
import type { UserComputerHello, UserComputerTransport } from "./types";

export type ResolvedUcChannel = { backendUrl: string; machineId: string; credential: string };
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
  /** D:L179387–179395: live scope lookup, not the construction-time credential snapshot. */
  resolveChannel?: () => Promise<ResolvedUcChannel | null>;
};

const requestKinds = Object.fromEntries(GrokBotUserComputerRequestFrame.fields.list().map(f => [f.localName, f.no]));

// Only business mapping remains here. Field numbers, oneof and int64 are runtime-owned.
export type Queued = { id: string; requestId: string; kind: number; serverMessage: Record<string, unknown>; parseError?: string;
  /** Exec: D v9r (L178863) approvalId + c5 authorization; retire-approval: approvalId. */
  approvalId?: string; authorization?: Authorization };
export function parseQueued(item: GrokBotUserComputerQueuedRequest): Queued {
  const id = item.id;
  const frame = item.frame;
  const requestId = frame?.requestId || id;
  try {
    if (!id || !frame?.frame.case) throw new Error("invalid request oneof");
    const kind = GrokBotUserComputerRequestFrame.fields.list().find(f => f.localName === frame.frame.case)!.no;
    let serverMessage: Record<string, unknown> = {};
    if (frame.frame.case === "retireApproval") {
      return { id, requestId, kind, serverMessage, approvalId: frame.frame.value.approvalId };
    }
    if (frame.frame.case === "exec") {
      const value = frame.frame.value;
      const meta = { approvalId: value.approvalId, authorization: authorizationOf(value) };
      // Official: ExecServerMessage.fromJsonString(serverMessageJson, { ignoreUnknownFields: true }).
      const decoded = decodeExecServerMessageJson(value.serverMessageJson);
      serverMessage = execServerMessageToRecord(decoded);
      return { id, requestId, kind, serverMessage, ...meta };
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
/**
 * Bound for deferred closing replies (busy / cancelled-before-start / drained / parse error).
 * Official holds every closing reply in per-request reply lanes with no cap (oee.push, D:L177276ff)
 * and therefore ACKs every polled item. With a FIFO queue whose head only advances on ACK, a control
 * message (cancel) behind K polled-but-unACKable items is reachable only once those K closing replies
 * are held: no-ACK-then-drop + bounded memory ⇒ some K beyond which a control waits for the reply lane
 * to recover. A closing reply is small and fixed-shape (requestId + a shared constant text), so it is
 * held compactly and budgeted by bytes (1/8 of the 8 MiB lane) and count, instead of by a small count.
 */
export const UC_PENDING_CLOSINGS_MAX = 8192;
/** Official tgt (D:L177848). */
export const UC_POLL_LIMIT = 64;
export const UC_PENDING_CLOSINGS_MAX_BYTES = 1 << 20;
/** Accounted cost of one deferred closing reply: requestId (UTF-16) + fixed object overhead. */
export function closingCost(requestId: string): number { return 96 + 2 * requestId.length; }

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
  private closing = false;
  private watchStopped = false;
  private closeDrained = false;
  private onPollIdle?: () => void;
  private onInflightDrained?: () => void;
  private abort = new AbortController();
  private presenceToken = crypto.randomBytes(16).toString("hex");
  private pendingAcks: string[] = [];
  private seen = new Set<string>();
  private inflight = 0;
  private pollBusy = false;
  private replies?: ReplyQueue | UcReplyLanes;
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
  private pendingClosingBytes = 0;
  /** Some polled item was left unacknowledged because its closing reply could not be held. */
  private unackedWaiting = false;
  private announcedStanding?: string;
  /** Official lastPolledAt (monotonic in daemon; wall clock here). */
  lastPolledAt = 0;
  get blocked(): boolean { return this.admissionClosed; }
  /**
   * Fixed for the provider's lifetime (official keeps it in the per-scope descriptor and closes/recreates
   * the provider when it changes, D:L179352). Taken only from the local credential record, never from a request.
   */
  get serverAuthoritative(): boolean { return this.opts.hello.serverAuthoritative === true; }
  /** Official getStanding (D:L179397): undefined under serverAuthoritative → hello.standing "" (L178209). */
  private standingFor(permission: PermissionMode): string { return this.serverAuthoritative ? "" : permission; }
  /** In-flight retire-approval writes (no inflight slot, no reply; official startRequest without E7). */
  private retireJobs = new Set<Promise<void>>();
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
    // Official reply lanes + flush/submit retry (oee, L177276; flush/submit L178671–178760): see reply-lanes.ts.
    this.replies = new UcReplyLanes({
      canFlush: () => !!this.channel && this.proven && !this.closed && !this.closing,
      send: async (frames, signal) => {
        const ch = this.channel!;
        // Frames carry no authority: machineId/credential come from the current channel at each attempt.
        const request = new SubmitGrokBotUserComputerResponsesRequest({ machineId: ch.machineId, credential: ch.credential, frames });
        let res;
        // Official dataDeadline E0 = 120s per attempt (daemon.formatted.cjs L97389, L177954).
        try { res = await this.client.submitGrokBotUserComputerResponses(request, {timeoutMs: UC_DATA_SUBMIT_DEADLINE_MS, signal}); }
        catch (error) {
          // Channel fencing: a rejection of a credential that has since been rotated is retried on the
          // current channel instead of closing it (official rejectCredential checks channel identity).
          if (authError(error)) throw new HttpStatusError(401, ch);
          throw error;
        }
        this.noteHeard(frames.map(f => f.requestId));
        const accepted = res.acceptedCount;
        // Official successful Submit is terminal even when the machine rejected some frames.
        if (accepted < frames.length) console.error(
          `[user-computer-provider] server accepted ${accepted} of ${frames.length} response frames; the rest were not queued for this machine`,
        );
      },
      // Fenced where the failure is set: a stale channel's 401 never closes a channel that rotated in between.
      reject: (e) => {
        if (e.epoch !== undefined && e.epoch !== this.channel) return false;
        this.proven = false; this.admissionClosed = true; this.abort.abort(); return true;
      },
      isCancelled: (id) => this.cancelledIds.has(id),
    });
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
    while (!this.closed && !this.watchStopped) {
      let liveChannel: ResolvedUcChannel | null = null;
      try { liveChannel = await this.resolveChannel(); }
      catch { console.error("[user-computer-provider] channel resolve failed"); }
      if (liveChannel === null) {
        this.channel = null; this.proven = false; this.abandonWork();
        await new Promise(r => setTimeout(r, 10_000)); // original channelRetry, even after a resolve error
        continue;
      }
      this.applyResolvedChannel(liveChannel);
      if (this.closed || this.watchStopped) break;
      if (this.admissionClosed) { await new Promise(r => setTimeout(r, 100)); continue; }
      hello.standing = this.standingFor((await loadSettings()).permission);
      hello.serverAuthoritative = this.opts.hello.serverAuthoritative;
      this.announcedStanding = hello.standing;
      await this.watchLoop(hello);
      if (this.closed || this.watchStopped) break;
      await new Promise(r => setTimeout(r, Math.min(2000, 100 * 2 ** Math.min(attempts++, 4))));
    }
    clearInterval(this.pollTimer);
    clearTimeout(this.keepAliveTimer);
  }

  private resolveChannel(): Promise<ResolvedUcChannel | null> {
    return this.opts.resolveChannel ? this.opts.resolveChannel() : Promise.resolve(this.channel ?? {
      backendUrl: this.opts.backendUrl, machineId: this.opts.machineId, credential: this.opts.credential,
    });
  }
  private applyResolvedChannel(next: ResolvedUcChannel): boolean {
    const old = this.channel;
    if (old && old.backendUrl === next.backendUrl && old.machineId === next.machineId && old.credential === next.credential) return false;
    this.client = createClient(GrokBotService, createConnectTransport({
      baseUrl: next.backendUrl, httpVersion: "1.1", useBinaryFormat: true,
      readMaxBytes: 8 * 1024 * 1024, writeMaxBytes: 8 * 1024 * 1024,
    }));
    this.channel = next;
    this.proven = false;
    this.abort.abort(); this.abort = new AbortController();
    this.admissionClosed = false; this.replies?.resume();
    return true;
  }
  /** D:L178180–178220: re-resolve a current scope; missing channel abandons work. */
  async rehelloIfChanged(): Promise<void> {
    if (this.channel !== null) {
      const next = await this.resolveChannel();
      if (next === null) {
        this.channel = null; this.proven = false; this.abandonWork(); this.abort.abort(); return;
      }
      if (this.applyResolvedChannel(next)) return;
    }
    const standing = this.standingFor((await loadSettings()).permission);
    if (this.announcedStanding !== undefined && this.announcedStanding !== standing) {
      this.announcedStanding = standing;
      this.abort.abort(); this.abort = new AbortController();
    }
  }

  /** Same-machine, same-scope rotation resumes the SAME reply/ack/task state. */
  updateChannel(next: { backendUrl: string; machineId: string; credential: string; accountScope?: string; serverAuthoritative?: boolean }): boolean {
    if (!this.channel || this.closed || next.machineId !== this.opts.machineId || next.accountScope !== this.opts.accountScope || next.backendUrl.replace(/\/$/, "") !== this.opts.backendUrl.replace(/\/$/, "")) return false;
    // A serverAuthoritative change (either direction) is not a rotation: the caller closes this provider and
    // creates a new one (official D:L179352). Never mutate the mode in place.
    if ((next.serverAuthoritative === true) !== this.serverAuthoritative) return false;
    if (next.credential === this.channel.credential) return false;
    this.channel = { ...this.channel, credential: next.credential };
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
  /** D:L178009–178025. Reentrant close returns immediately; it does not join the first close. */
  async stop(options: { withdrawPresence?: boolean } = {}): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.stopped = true; // existing pending-approval guard; do not spawn after close starts
    const withdraw = options.withdrawPresence === true ? this.stopWatchingAndWithdraw() : Promise.resolve();
    clearTimeout(this.keepAliveTimer);
    clearInterval(this.pollTimer);
    if (this.replies instanceof UcReplyLanes) this.replies.pauseForClose();
    this.abandonWork();
    if (this.pollBusy) await this.awaitSettledOnClose("the in-flight poll", done => { this.onPollIdle = done; });
    this.onPollIdle = undefined;
    if (this.active.size > 0) await this.awaitSettledOnClose("in-flight requests", done => { this.onInflightDrained = done; });
    this.onInflightDrained = undefined;
    await this.drainOnClose();
    this.closed = true;
    this.abort.abort();
    await withdraw;
  }

  private async stopWatchingAndWithdraw(): Promise<void> {
    // D:L178027–178049: begin withdrawal BEFORE poll/inflight/flush drain; await it last.
    this.watchStopped = true;
    this.abort.abort();
    const ch = this.channel;
    if (!ch) return;
    try {
      await this.client.withdrawGrokBotUserComputerPresence({
        machineId: ch.machineId, credential: ch.credential, presenceToken: this.presenceToken,
      }, { timeoutMs: 750 }); // g9r
    } catch { /* original reports failure but close still completes */
      console.error("[user-computer-provider] presence withdraw failed");
    }
  }

  private abandonWork(): void {
    const pending = this.backlog;
    this.backlog = [];
    for (const q of pending) void Promise.resolve(this.emit(this.closingFrame(q, UC_BACKLOG_CLOSED_BEFORE_START)))
      .catch(() => console.error("[user-computer-provider] abandoned backlog reply failed"));
    for (const id of this.active) cancelRequest(id);
  }

  private async awaitSettledOnClose(label: string, register: (done: () => void) => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>(resolve => {
      register(resolve);
      timer = setTimeout(() => { console.error(`[user-computer-provider] close gave up waiting for ${label}`); resolve(); }, 10_000); // ok
    });
    clearTimeout(timer);
  }

  private async drainOnClose(): Promise<void> {
    if (this.replies instanceof UcReplyLanes) {
      const replies = this.replies;
      replies.dropStreams();
      if (replies.flushing) await this.awaitSettledOnClose("the in-progress flush", done => { void replies.waitForIdle().then(done); });
      const ch = this.channel, client = this.client;
      if (ch && this.proven) await replies.drainOnClose(async frames => {
        await client.submitGrokBotUserComputerResponses({ machineId: ch.machineId, credential: ch.credential, frames }, { timeoutMs: 10_000 });
      });
    } else {
      // Compatibility for pre-lanes transports/test doubles, not the production start path.
      await this.replies?.drain();
      this.replies?.stop();
    }
    this.closeDrained = true;
  }

  private bump(delta: number): void {
    this.inflight += delta;
    this.opts.onInflight?.(this.inflight);
  }

  private emit: Emit = (frame) => this.queueSubmit([frame]);

  private queueSubmit(frames: ExecFrameOut[]): Promise<void> {
    const ch = this.channel;
    if (frames.length === 0 || !this.replies || (!ch && !(this.replies instanceof UcReplyLanes))) return Promise.resolve();
    // Lane envelopes are decoded to frames only; missing channel must not discard abandonWork's terminal.
    return this.replies.enqueue(Buffer.from(new SubmitGrokBotUserComputerResponsesRequest({
      machineId: ch?.machineId ?? "", credential: ch?.credential ?? "", frames: frames.map(responseFrame),
    }).toBinary()), frames.map(f => f.requestId));
  }

  async pollOnce(): Promise<void> {
    if (this.pollBusy) { this.pollAgain = true; return; }
    // Official keeps polling at capacity/backpressure so cancel + superviseBacklog nudge stay live.
    if (this.closed || this.closing || this.admissionClosed || !this.channel) return;
    this.pollBusy = true;
    const acks = this.pendingAcks.splice(0);
    const pollChannel = this.channel;
    let polled = false;
    try {
      const ch = pollChannel;
      const liveStanding = this.standingFor((await loadSettings()).permission);
      if (this.announcedStanding !== undefined && liveStanding !== this.announcedStanding) {
        // Re-announce policy by replacing only the Watch connection, never tasks.
        this.announcedStanding = liveStanding;
        this.abort.abort(); this.abort = new AbortController();
      }
      // Continue polling at capacity: cancel controls must remain reachable.
      const res = await this.client.pollGrokBotUserComputerRequests({
        machineId: ch.machineId, credential: ch.credential, ackIds: acks,
        // Official tgt=64 on every poll regardless of local capacity (D:L177848, L178474).
        limit: this.opts.pollLimit ?? UC_POLL_LIMIT,
      }, {timeoutMs: 10_000}); // original controlDeadline ok
      if (this.channel !== pollChannel) { this.pendingAcks.unshift(...acks); return; }
      const queued = res.requests.map(parseQueued).filter(q => q.id);
      trace("poll-items", { n: queued.length, rids: queued.map(q => q.requestId.slice(0, 16)) });
      // Only forget queue ids after the peer confirms receipt of prior acks.
      acks.forEach(id => this.seen.delete(id));
      for (const q of queued) {
        if (this.seen.has(q.id)) continue;
        // Capacity is checked before ack/admission. Cancel controls bypass backlog.
        this.seen.add(q.id); this.pendingAcks.push(q.id);
        if (q.parseError) { if (!this.storeClosingFrame({ kind: "control", requestId: q.requestId, message: { throw: { error: q.parseError } } })) this.unack(q); continue; }
        if (q.kind === requestKinds.retireApproval) {
          // Official (D:L178509–178555, v_.handle L135964, wUe L81351): ACKed like any item, not E7 → no keepalive,
          // no inflight slot, no busy/backlog; persisted under the per-file lock; NO reply frame of any kind.
          this.startRetire(q.approvalId ?? "");
          continue;
        }
        if (q.kind === requestKinds.cancel) {
          // Official (D:L178526–178535, Gl/Kce): each cancelled backlog entry gets a closing error.
          const dropped = this.backlog.filter(x => x.requestId === q.requestId);
          // No room to hold their closing replies: leave the cancel unacknowledged (redelivered by the
          // next poll) instead of dropping terminal frames of already-acknowledged backlog work.
          // Reserve against the ACTUAL closing frames (their real requestId cost), all or nothing:
          // only when every terminal frame can be held are the backlog removal and the cancel ACK
          // committed; otherwise nothing is removed and the cancel stays unACKed (redelivered).
          const closings = dropped.map(d => this.closingFrame(d, UC_CANCELLED_BEFORE_START));
          if (!this.canHoldClosings(closings)) { this.unack(q); continue; }
          this.cancelledIds.add(q.requestId);
          this.backlog = this.backlog.filter(x => x.requestId !== q.requestId);
          // Official replies.drop(requestId) + submitAbort when the in-flight batch is all cancelled.
          cancelRequest(q.requestId);
          if (typeof this.replies?.drop === 'function') this.replies.drop(id => this.cancelledIds.has(id));
          for (const f of closings) if (!this.storeClosingFrame(f)) throw new Error("reserved closing reply not held");
          continue;
        }
        // D:L178543–178546: a poll already in flight when close starts ACKs and closes new exec work.
        if (this.closing) {
          await this.emit(this.closingFrame(q, UC_BACKLOG_CLOSED_BEFORE_START));
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
      this.onPollIdle?.();
      if (this.closeDrained) void this.drainOnClose();
      // Official pollOnce loops at once while acks are pending or the page was full
      // (D:L178459–178557), so a burst (e.g. 64 cancels) is drained in back-to-back polls, not one
      // page per safety-poll tick. Only once the provider loop is running (pollTimer).
      const drain = polled && this.pollTimer !== undefined && !this.closed && !this.closing && this.pendingAcks.length > 0;
      if (!this.closing && (this.pollAgain || drain)) { this.pollAgain = false; setTimeout(() => void this.pollOnce().catch(() => undefined), drain ? 0 : 25); }
    }
  }
  /**
   * Official superviseBacklog (daemon.formatted.cjs L178589–178599):
   * age > 15s → drain backlog with A9 closing text; age >= 5s → nudge poll.
   * Exposed for regressions (clock injectable via nowMs).
   */
  superviseBacklog(nowMs = Date.now()): void {
    if (this.backlog.length === 0 || this.closed || this.closing || this.admissionClosed) return;
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
    if (!ch || !this.proven || this.closed || this.closing || this.admissionClosed || this.keepAliveSending) return [];
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
    if (this.closingRoom() <= 0 || this.pendingClosingBytes + closingCost(frame.requestId) > UC_PENDING_CLOSINGS_MAX_BYTES) return false;
    this.deferClosing(frame); return true;
  }
  /** True iff the deferral alone (lane not counted) can hold every frame by count and actual byte cost. */
  private canHoldClosings(frames: ExecFrameOut[]): boolean {
    if (this.closed) return false;
    const bytes = this.pendingClosings.reduce((n, f) => n + closingCost(f.requestId), 0) + frames.reduce((n, f) => n + closingCost(f.requestId), 0);
    return this.pendingClosings.length + frames.length <= UC_PENDING_CLOSINGS_MAX && bytes <= UC_PENDING_CLOSINGS_MAX_BYTES;
  }
  private deferClosing(frame: ExecFrameOut): void { this.pendingClosings.push(frame); this.pendingClosingBytes += closingCost(frame.requestId); }
  /** Free deferral slots (the lane itself may hold more; this is the guaranteed part). */
  private closingRoom(): number {
    // Recomputed from the list so tests/probes that replace it stay consistent.
    this.pendingClosingBytes = this.pendingClosings.reduce((n, f) => n + closingCost(f.requestId), 0);
    return Math.max(0, Math.min(UC_PENDING_CLOSINGS_MAX - this.pendingClosings.length,
      Math.floor((UC_PENDING_CLOSINGS_MAX_BYTES - this.pendingClosingBytes) / closingCost("x".repeat(64)))));
  }
  private offerFrame(frame: ExecFrameOut): boolean {
    const ch = this.channel; const r = this.replies;
    if (!r || (!ch && !(r instanceof UcReplyLanes))) return false;
    if (typeof r.offer === "function") return r.offer(Buffer.from(new SubmitGrokBotUserComputerResponsesRequest({
      machineId: ch?.machineId ?? "", credential: ch?.credential ?? "", frames: [responseFrame(frame)] }).toBinary()), [frame.requestId]);
    // Minimal stubs without offer(): fall back to emit; a rejection re-defers (bounded).
    let p: Promise<void>;
    try { p = Promise.resolve(this.emit(frame)); } catch (e) { p = Promise.reject(e); }
    p.catch(() => { if (!this.closed && this.closingRoom() > 0) this.deferClosing(frame); });
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
    while (this.pendingClosings.length && !this.closed && this.offerFrame(this.pendingClosings[0])) { const f = this.pendingClosings.shift()!; this.pendingClosingBytes -= closingCost(f.requestId); }
    // Items left unacknowledged for lack of room are fetched again by one poll as soon as room exists
    // (event-driven; there is no fast poll timer, official polls on Watch events + 30 s safety poll).
    if (this.unackedWaiting && this.closingRoom() > 0 && !this.closed) { this.unackedWaiting = false; void this.pollOnce().catch(() => undefined); }
  }
  /** Official rejectCredential(e): only the channel that is still current may be closed. */
  private rejectCredential(ch: { credential: string } | null): void {
    if (!ch || this.channel !== ch) return;
    this.proven = false; this.admissionClosed = true; this.abort.abort();
  }

  private runBacklog(): void {
    while (!this.closed && !this.closing && !this.admissionClosed && this.active.size < UC_INFLIGHT_MAX && this.backlog.length && this.replies?.available) {
      const q = this.backlog.shift()!;
      if (this.active.has(q.requestId)) continue;
      this.active.add(q.requestId); this.bump(1); trace("admit", { rid: q.requestId.slice(0, 16) });
      const job = this.handleQueued(q).catch(e => requestError(q.requestId, lastAllocatedExecIdOrZero(), e, this.emit, { root: this.opts.root, serverMessage: q.serverMessage }))
        .catch(() => { console.error("[user-computer-provider] request reply failed"); })
        .then(() => undefined).finally(() => { this.activeJobs.delete(job); this.active.delete(q.requestId); this.bump(-1); if (this.active.size === 0) this.onInflightDrained?.(); this.runBacklog(); });
      this.activeJobs.add(job);
    }
  }
  private startRetire(approvalId: string): void {
    const root = dataRootFromEnv();
    const job = retireApproval(approvalId, approvalsPathFor(root), retirementsPathFor(root))
      .catch(() => console.error("[user-computer-provider] failed to retire approval"))
      .finally(() => { this.retireJobs.delete(job); });
    this.retireJobs.add(job);
  }
  /** Test hook: wait for pending retire-approval writes. */
  async settleRetirements(): Promise<void> { await Promise.all([...this.retireJobs]); }
  private async handleQueued(q: Queued): Promise<void> {
    if (q.kind !== requestKinds.exec) {
      // Frozen oracle dispatch maps unimplemented outer variants to an error.
      // Full variant-specific payloads remain a documented gap (not silent success).
      const error = "This computer's local-exec daemon does not understand that request frame; update the desktop app.";
      // An admitted job: wait (bounded by the job's own slot) until its terminal frame is held.
      while (!this.closed && !this.storeClosing(q, error)) await new Promise(r => setTimeout(r, UC_KEEPALIVE_INTERVAL_MS));
      return;
    }
    // t117u: exec approval chain (src/uc/approvals.ts) — server flags only on a serverAuthoritative channel,
    // local approvals file + retirements + 1h recordedAtMs expiry + Yce. Other request kinds stay unimplemented.
    // Official re() (D:L179276–179288) calls N.getLocalToolPermission() → load() → readFileSync (L82881/L82271/pue)
    // synchronously inside startRequest, before its first await (v_.handle L135963 → withInflight L136032 →
    // handleExecRequest L136309–136318 have no earlier await). Same here: one synchronous read per request, so execs
    // reach allocateExecId in admission order without any chain, cache or shared promise (t108u).
    const live = loadSettingsSync();
    const dataRoot = dataRootFromEnv();
    const terminalsFolder = this.opts.hello.terminalsFolder;
    // t110u: official `let i = await this.options.isLocalUseBlocked?.(...)` (D:L136318) — every request of a Poll
    // batch reads its permission synchronously first; exec id + heartbeat arm follow only after this await
    // (nextExecId++ L136332 → wE.handle h() L98140). Then `if (r.cancelled) { n(O6r(s)); return; }` (L136328–136331,
    // O6r L136419 = streamClose{id:0}): a cancel that landed meanwhile never starts the exec.
    // t117u: the await is now the AUe decision itself (official awaits isLocalUseBlocked → AUe → Qce).
    const refusal = await execRefusal({
      permission: live.permission,
      ceiling: live.settings.localToolPermissionCeiling,
      serverAuthoritative: this.serverAuthoritative,
      accountScope: this.opts.accountScope,
      approvalId: q.approvalId,
      authorization: q.authorization ?? { kind: "none" },
      describes: describeExec(q.serverMessage, terminalsFolder),
      terminalsFolder,
      approvalsPath: approvalsPathFor(dataRoot),
      retirementsPath: retirementsPathFor(dataRoot),
    });
    // t112u: official order after that await (D:L136324–136332): (1) blocked → `n(x9({requestId, error}))`, x9
    // (L136410) = control throw{id:0,error}, no exec id consumed; (2) cancelled → O6r; (3) nextExecId++.
    // AUe (L81503) / Qce (L81473): see approvals.ts. Text: NEVER_MSG = Xh (L81193), ASK_MSG = i5 (L81199).
    if (refusal !== undefined) {
      await this.emit({ kind: "control", requestId: q.requestId, message: { throw: { id: 0, error: refusal } } });
      return;
    }
    // Our guard (official stop path not mapped): stop() cancels only registered shells, so a stop landing in this
    // await also ends the request here instead of spawning after shutdown.
    if (this.cancelledIds.has(q.requestId) || this.stopped) {
      await this.emit({ kind: "control", requestId: q.requestId, message: { streamClose: { id: 0 } } });
      return;
    }
    await dispatchExec({ root: this.opts.root, requestId: q.requestId,
      // Authorised once above (as official: no second permission gate inside the exec handlers).
      // Approval does not reach back: a later retire/revoke never stops an exec already running (official).
      serverMessage: q.serverMessage, permission: "always", emit: this.emit });
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
        if (event.event.case === "connected") {
          // Official (L178388–178403): proven, requestPoll, flush — flush wakes held replies once the new Watch is up.
          this.proven = true;
          // official connected → this.flush() (not a credential resume)
          const r = this.replies as { flush?: () => Promise<void> } | undefined;
          if (r && typeof r.flush === "function") void r.flush();
        }
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
