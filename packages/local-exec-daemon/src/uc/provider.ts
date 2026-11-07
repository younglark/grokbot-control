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
  GrokBotUserComputerMessagesError, GrokBotUserComputerFileError,
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
    this.replies = new ReplyQueue(async body => {
      const ch = this.channel!;
      // Queue bodies retain response payloads, not the authority of expired creds.
      const request = SubmitGrokBotUserComputerResponsesRequest.fromBinary(body);
      request.machineId = ch.machineId; request.credential = ch.credential;
      let res;
      try { res = await this.client.submitGrokBotUserComputerResponses(request, {timeoutMs: 2000}); }
      catch (error) { if (authError(error)) throw new HttpStatusError(401); throw error; }
      const accepted = res.acceptedCount;
      const submitted = request.frames.length;
      // Official successful Submit is terminal even when the machine rejected
      // some frames. Only transport/HTTP errors are retried, never accepted_count.
      if (accepted < submitted) console.error(
        `[user-computer-provider] server accepted ${accepted} of ${submitted} response frames; the rest were not queued for this machine`,
      );
    }, () => { this.admissionClosed = true; this.abort.abort(); });
    this.lastPolledAt = Date.now();
    this.pollTimer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, 250);
    // Official keepAliveTick (~500ms) runs superviseBacklog then sendKeepAlives.
    this.keepAliveTimer = setInterval(() => {
      this.superviseBacklog();
    }, UC_KEEPALIVE_INTERVAL_MS);
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
    clearInterval(this.keepAliveTimer);
  }

  /** Same-machine, same-scope rotation resumes the SAME reply/ack/task state. */
  updateChannel(next: { backendUrl: string; machineId: string; credential: string; accountScope?: string; serverAuthoritative?: boolean }): boolean {
    if (!this.channel || this.closed || next.machineId !== this.opts.machineId || next.accountScope !== this.opts.accountScope || next.backendUrl.replace(/\/$/, "") !== this.opts.backendUrl.replace(/\/$/, "")) return false;
    if (next.serverAuthoritative) this.opts.hello.serverAuthoritative = true;
    if (next.credential === this.channel.credential) return false;
    this.channel = { ...this.channel, credential: next.credential };
    // Never relax an authoritative channel by credential file mutation.
    if (next.serverAuthoritative) this.opts.hello.serverAuthoritative = true;
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
    this.closed = true; clearInterval(this.pollTimer); clearInterval(this.keepAliveTimer); this.abort.abort();
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
    }).toBinary()));
  }

  async pollOnce(): Promise<void> {
    if (this.pollBusy) { this.pollAgain = true; return; }
    // Official keeps polling at capacity/backpressure so cancel + superviseBacklog nudge stay live.
    if (this.closed || this.admissionClosed || !this.channel) return;
    this.pollBusy = true;
    const acks = this.pendingAcks.splice(0);
    try {
      const ch = this.channel;
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
        if (q.parseError) { await this.emit({ kind: "control", requestId: q.requestId, message: { throw: { error: q.parseError } } }); continue; }
        if (q.kind === requestKinds.cancel) {
          this.backlog = this.backlog.filter(x => x.requestId !== q.requestId);
          cancelRequest(q.requestId); continue;
        }
        // Official (D:L178548–178552): when inflight>=8 and backlog>=64 → busy.
        // Lab runBacklog still gates on replies.available, so active can fall <8
        // while backlog stays full; hard-cap backlog at 64 so that state cannot
        // push past the official ceiling (equivalent total-capacity hard top).
        if (this.backlog.length >= UC_BACKLOG_MAX) {
          this.emitBusy(q);
          continue;
        }
        // Official startRequest suppresses an already-inflight requestId with
        // no additional result; queue-id ack remains separate. Pending backlog
        // entries are not a durable request-id dedup ledger.
        if (this.active.has(q.requestId)) continue;
        this.backlog.push(q); this.runBacklog();
      }
      // A previously saturated reply lane may have recovered with no new jobs.
      this.runBacklog();
      this.lastPolledAt = Date.now();
    } catch (e) {
      this.pendingAcks.unshift(...acks);
      if (authError(e)) {
        this.admissionClosed = true; this.abort.abort();
      }
      // Failed poll never re-executes an admitted request.
    } finally {
      this.pollBusy = false;
      if (this.pollAgain) { this.pollAgain = false; setTimeout(() => void this.pollOnce(), 25); }
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
      const drained = this.backlog.splice(0, this.backlog.length);
      for (const q of drained) {
        const error = UC_BACKLOG_CLOSED_BEFORE_START;
        if ([requestKinds.upload, requestKinds.download, requestKinds.discoverAiTool].includes(q.kind)) {
          void this.emit({ kind: "file-error", requestId: q.requestId, error });
        } else if (q.kind === requestKinds.messagesOp) {
          void this.emit({ kind: "messages-error", requestId: q.requestId, error });
        } else {
          void this.emit({ kind: "control", requestId: q.requestId, message: { throw: { id: 0, error } } });
        }
      }
    } else if (age >= UC_BACKLOG_NUDGE_MS) {
      void this.pollOnce().catch(() => undefined);
    }
  }

  private emitBusy(q: Queued): void {
    const error = UC_BUSY_TEXT;
    if ([requestKinds.upload, requestKinds.download, requestKinds.discoverAiTool].includes(q.kind)) {
      void this.emit({ kind: "file-error", requestId: q.requestId, error });
    } else if (q.kind === requestKinds.messagesOp) {
      void this.emit({ kind: "messages-error", requestId: q.requestId, error });
    } else {
      void this.emit({ kind: "control", requestId: q.requestId, message: { throw: { id: 0, error } } });
    }
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
      if (q.kind === requestKinds.discoverAiTool) this.emit({ kind: "file-error", requestId: q.requestId, error });
      else if (q.kind === requestKinds.messagesOp) this.emit({ kind: "messages-error", requestId: q.requestId, error });
      else this.emit({ kind: "control", requestId: q.requestId, message: { throw: { id: 0, error } } });
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
    try {
      const events = this.client.watchGrokBotUserComputerRequests({
        machineId: ch.machineId, credential: ch.credential, presenceToken: this.presenceToken,
        hello: GrokBotUserComputerHello.fromJsonString(JSON.stringify(hello)),
      }, {signal: this.abort.signal});
      for await (const event of events) {
        if (["connected", "notify", "heartbeat"].includes(event.event.case || "")) {
          void this.pollOnce().catch(() => undefined);
        }
      }
    } catch (error) {
      if (authError(error)) { this.admissionClosed = true; this.abort.abort(); }
      // One Watch connection ending never closes reply, task or acknowledgment state.
    }
  }
}
