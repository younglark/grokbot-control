import { trace } from "../trace";
/**
 * UC reply storage + flush, mirroring the original daemon (0.79.3, daemon.formatted.cjs):
 *  - `oee` (L177276–177400): per-request lanes in a Map, unbounded; take() fills one submit by rounds,
 *    one frame per lane per round (non-file first, file frames gated by previousCarriedFile), limits
 *    X7e=256 frames, K_=8 MiB, j2=1 MiB file bytes; lanes taken from move to the END of the Map (kept
 *    across batches); requeue() puts frames back at the FRONT (lane order preserved); drop() deletes.
 *  - flush (L178671–178700): serial; after a submit that kept closing frames and nothing else is ready,
 *    wait closingRetry (500 ms ×2 … 4 s, until-signal) before the next flush.
 *  - submit (L178707–178760): submitRetry 3 attempts, fixed 200 ms (sxe/egt); Unauthenticated → requeue
 *    all + rejectCredential, not an attempt; aborted (cancel) → batch gone; exhausted → keep only frames
 *    that close a request (x9r) whose budget since first submit has not expired, drop the rest.
 * UC only; the Box lane keeps transport/replies.ts.
 */
import { GrokBotUserComputerResponseFrame, SubmitGrokBotUserComputerResponsesRequest } from "../generated/aiserver.v1_pb";
import { ExecClientControlMessage, ExecClientMessage } from "../generated/agent.v1_pb";
import { HttpStatusError } from "../transport/replies";

type Frame = GrokBotUserComputerResponseFrame;
export const UC_TAKE_MAX_FRAMES = 256;            // X7e
export const UC_TAKE_MAX_BYTES = 8 * 1024 * 1024; // K_
export const UC_TAKE_MAX_FILE_BYTES = 1024 * 1024; // j2
export const UC_SUBMIT_ATTEMPTS = 3;              // sxe
export const UC_SUBMIT_RETRY_MS = 200;            // egt
export const UC_CLOSING_RETRY_INITIAL_MS = 500;   // o9r
export const UC_CLOSING_RETRY_MAX_MS = 4_000;     // i9r
export const UC_CLOSING_BUDGET_MS = 30_000;       // oxe
export const UC_FILE_BUDGET_MS = 120_000;         // E0
export const UC_MESSAGES_BUDGET_MS = 180_000;     // Gpe
export const UC_LOCAL_TOOL_BUDGET_MS = 180_000;   // a9r

function fileBytes(f: Frame): number { return f.frame.case === "file" ? f.frame.value.data.length : 0; }
function frameBytes(f: Frame): number {
  const v = f.frame;
  switch (v.case) {
    case "file": return v.value.data.length;
    case "client": case "control": return v.value.messageJson.length;
    case "fileError": case "messagesError": return v.value.error.length;
    default: return 0;
  }
}
const CLOSING_SHELL_EVENTS = new Set(["exit", "rejected", "permissionDenied", "sandboxUnsupported", "backgrounded"]);
/** Official x9r: retry budget of a frame that closes a request, or undefined (dropped after retries). */
export function closingBudgetMs(f: Frame): number | undefined {
  const v = f.frame;
  try {
    switch (v.case) {
      case "client": {
        const m = ExecClientMessage.fromJsonString(v.value.messageJson, { ignoreUnknownFields: true }).message;
        if (m.case === "shellStream") return CLOSING_SHELL_EVENTS.has(String((m.value as { event?: { case?: string } }).event?.case)) ? UC_CLOSING_BUDGET_MS : undefined;
        return m.case !== undefined ? UC_CLOSING_BUDGET_MS : undefined;
      }
      case "control": {
        const c = ExecClientControlMessage.fromJsonString(v.value.messageJson, { ignoreUnknownFields: true }).message.case;
        return c === "throw" || c === "streamClose" ? UC_CLOSING_BUDGET_MS : undefined;
      }
      case "file": return v.value.last && v.value.seq === 0 ? UC_FILE_BUDGET_MS : undefined;
      case "fileError": return UC_FILE_BUDGET_MS;
      case "messagesError": return UC_MESSAGES_BUDGET_MS;
      default: {
        const k = (v as { case?: string }).case;
        if (k === "urlTransfer") return UC_FILE_BUDGET_MS;
        if (k === "messagesResult" || k === "messagesConsentResult") return UC_MESSAGES_BUDGET_MS;
        if (k === "localToolResult") return UC_LOCAL_TOOL_BUDGET_MS;
        return undefined;
      }
    }
  } catch { return undefined; }
}

export type UcLanesOptions = {
  /** One Submit attempt; throws on failure. Auth failures must throw HttpStatusError(401, channel). */
  send: (frames: Frame[], signal: AbortSignal) => Promise<void>;
  /** Official rejectCredential: false when the rejected channel is no longer current (retry at once). */
  reject: (e: HttpStatusError) => boolean | void;
  isCancelled: (requestId: string) => boolean;
  canFlush?: () => boolean;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
};

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Error("aborted"));
  const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
  signal.addEventListener("abort", onAbort, { once: true });
});

export class UcReplyLanes {
  private lanes = new Map<string, Frame[]>();
  private previousCarriedFile = false;
  private closingSince = new WeakMap<Frame, number>();
  private closingRetryAttempt = 0;
  private closingRetryWait?: Promise<void>;
  private flushing_ = false;
  /** True while a flush loop owns the mutex (probes / drain). */
  get flushing(): boolean { return this.flushing_; }
  private stopped = false;
  private closing = false;
  private idleWaiters = new Set<() => void>();
  /** D:L178677: close stops normal flushes without aborting the current submit or rejecting late frames. */
  pauseForClose(): void { this.closing = true; }
  waitForIdle(): Promise<void> {
    return !this.flushing_ ? Promise.resolve() : new Promise(resolve => this.idleWaiters.add(resolve));
  }
  /** Current lanes have materialised frames only, not attached async streams (D:oee.dropStreams). */
  dropStreams(): void { /* no attached stream objects in this implementation */ }
  /** D:L178101–178134: one control submit per batch; failure drops that batch, no normal retry/backoff. */
  async drainOnClose(send: (frames: Frame[]) => Promise<void>): Promise<void> {
    this.flushing_ = true;
    try {
      for (let frames = this.take(); frames.length > 0; frames = this.take()) {
        try { await send(frames); }
        catch (error) { this.log(`[user-computer-provider] dropping ${frames.length}-frame response batch on close: ${String(error)}`); return; }
      }
    } finally {
      this.flushing_ = false;
      for (const done of this.idleWaiters) done();
      this.idleWaiters.clear();
    }
  }
  private stopSignal = new AbortController();
  private submitAbort?: AbortController;
  private submittingFrames: Frame[] = [];
  submitting: string[] = [];
  submittingSince = 0;
  failure?: Error;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: (msg: string) => void;
  constructor(private readonly o: UcLanesOptions) {
    this.now = o.now ?? (() => performance.now());
    this.sleep = o.sleep ?? defaultSleep;
    this.log = o.log ?? (m => console.error(m));
  }

  get available(): boolean { return !this.stopped && !this.failure; }
  get readyCount(): number { let n = 0; for (const l of this.lanes.values()) n += l.length; return n; }
  /** Official replies.requestIds(): request ids with queued (not submitting) frames. */
  requestIds(): Set<string> { return new Set(this.lanes.keys()); }
  /** Lane ids in Map order (for probes/regressions). */
  laneOrder(): string[] { return [...this.lanes.keys()]; }

  push(frames: Frame[]): void { for (const f of frames) this.laneOf(f.requestId).push(f); }
  private laneOf(id: string): Frame[] { let l = this.lanes.get(id); if (!l) { l = []; this.lanes.set(id, l); } return l; }
  private decode(body: Buffer): Frame[] { return SubmitGrokBotUserComputerResponsesRequest.fromBinary(body).frames; }
  /** Producers never wait (official enqueue = replies.push + flush). */
  enqueue(body: Buffer, _ids: string[] = []): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("reply lane stopped"));
    this.push(this.decode(body)); trace("enqueue", { flushing: this.flushing_ }); void this.flush(); return Promise.resolve();
  }
  offer(body: Buffer, _ids: string[] = []): boolean {
    if (this.stopped) return false;
    this.push(this.decode(body)); void this.flush(); return true;
  }

  take(): Frame[] {
    const out: Frame[] = []; const touched = new Set<string>(); let bytes = 0, fbytes = 0;
    const one = (id: string, lane: Frame[], file: boolean): boolean => {
      const f = lane[0]; if (f === undefined) return false;
      const fb = fileBytes(f); if ((fb > 0) !== file) return false;
      const b = frameBytes(f);
      if (out.length > 0 && (out.length >= UC_TAKE_MAX_FRAMES || bytes + b > UC_TAKE_MAX_BYTES || fbytes + fb > UC_TAKE_MAX_FILE_BYTES)) return false;
      lane.shift(); out.push(f); bytes += b; fbytes += fb; touched.add(id); return true;
    };
    for (let more = true; more;) { more = false; for (const [id, l] of this.lanes) if (one(id, l, false)) more = true; }
    if (out.length === 0 || !this.previousCarriedFile) for (const [id, l] of this.lanes) one(id, l, true);
    this.previousCarriedFile = fbytes > 0;
    for (const id of touched) { const l = this.lanes.get(id); this.lanes.delete(id); if (l && l.length > 0) this.lanes.set(id, l); }
    return out;
  }
  requeue(frames: Frame[]): void {
    const by = new Map<string, Frame[]>();
    for (const f of frames) { const g = by.get(f.requestId); if (g) g.push(f); else by.set(f.requestId, [f]); }
    const front = new Map<string, Frame[]>();
    for (const [id, fs] of by) { const l = this.lanes.get(id) ?? []; l.unshift(...fs); this.lanes.delete(id); front.set(id, l); }
    this.lanes = new Map([...front, ...this.lanes]);
  }
  /** Official replies.drop(requestId) for every cancelled id, plus submitAbort when the in-flight batch is all cancelled. */
  drop(isCancelled: (id: string) => boolean): number {
    let n = 0;
    for (const id of [...this.lanes.keys()]) if (isCancelled(id)) { n += this.lanes.get(id)!.length; this.lanes.delete(id); }
    if (this.submittingFrames.length > 0 && this.submittingFrames.every(f => isCancelled(f.requestId))) this.submitAbort?.abort();
    return n;
  }

  /**
   * Official flush (L178671–178700), same state machine:
   *   if (!flushing) { flushing = true; try { for (;;) { re-read channel/proven; take; submit;
   *     if (kept > 0 && readyCount === kept) { schedule closing backoff; return } } } finally { flushing = false } }
   * A call while flushing simply returns: the owner re-reads its state at every iteration, so frames
   * queued meanwhile are taken by the next iteration (official "immediate flush" for new frames), and a
   * resume() that clears a credential pause while the owner is still in submit() is seen by the owner's
   * next check instead of being swallowed. There is no sticky request flag (it re-submitted kept closing
   * frames at once and defeated the 500 ms closing backoff).
   */
  async flush(): Promise<void> {
    if (this.flushing_) return;
    this.flushing_ = true;
    try {
      for (;;) {
        // official: `if (channel === undefined || !proven) return` — here a current-channel 401 pause
        if (this.stopped || this.closing || this.failure || this.o.canFlush?.() === false) return;
        const frames = this.take();
        trace("take", { n: frames.length, rids: [...new Set(frames.map(f => f.requestId.slice(0, 16)))] });
        if (frames.length === 0) return;
        const ac = new AbortController();
        this.submitAbort = ac; this.submittingFrames = frames;
        this.submitting = [...new Set(frames.map(f => f.requestId))]; this.submittingSince = this.now();
        const kept = await this.submit(frames, ac.signal);
        trace("submit-done", { n: frames.length, kept });
        this.submittingFrames = []; this.submitting = []; this.submitAbort = undefined;
        if (kept > 0 && this.readyCount === kept) { this.closingRetryWait ??= this.flushAfterClosingBackoff(); return; }
        // kept < 0 (paused) falls through to the state check above: a resume() that already ran continues here.
      }
    } finally {
      this.submittingFrames = []; this.submitting = []; this.submitAbort = undefined; this.flushing_ = false;
      for (const done of this.idleWaiters) done();
      this.idleWaiters.clear();
    }
  }
  private async flushAfterClosingBackoff(): Promise<void> {
    this.closingRetryAttempt += 1;
    const ms = Math.min(UC_CLOSING_RETRY_MAX_MS, UC_CLOSING_RETRY_INITIAL_MS * 2 ** (this.closingRetryAttempt - 1));
    try { await this.sleep(ms, this.stopSignal.signal); } catch { /* stopped */ }
    this.closingRetryWait = undefined;
    if (!this.stopped) await this.flush();
  }
  /** Returns how many frames were requeued (closing frames kept after exhausted retries); -1 = paused. */
  private async submit(frames: Frame[], signal: AbortSignal): Promise<number> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= UC_SUBMIT_ATTEMPTS; attempt++) {
      if (this.stopped) { this.requeue(frames); return 0; }
      if (signal.aborted) return 0;
      try {
        await this.o.send(frames, AbortSignal.any([signal, this.stopSignal.signal]));
        this.closingRetryAttempt = 0; return 0;
      } catch (e) {
        // stop() is not a cancel: the batch stays held for drain/process exit.
        if (this.stopped) { this.requeue(frames); return 0; }
        if (signal.aborted) return 0; // cancelled: the batch is gone (official: return 0 when s.aborted)
        if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
          this.requeue(frames);
          if (this.o.reject(e) === false) return 0; // stale channel: retry at once on the current one
          this.failure = e; return -1;
        }
        lastError = e;
        if (attempt < UC_SUBMIT_ATTEMPTS) {
          try { await this.sleep(UC_SUBMIT_RETRY_MS, AbortSignal.any([signal, this.stopSignal.signal])); }
          catch { if (this.stopped) this.requeue(frames); return 0; }
        }
      }
    }
    const now = this.now(); const keep: Frame[] = []; let expired = 0;
    for (const f of frames) {
      if (this.o.isCancelled(f.requestId)) continue;
      const budget = closingBudgetMs(f);
      if (budget === undefined) continue;
      const since = this.closingSince.get(f) ?? this.submittingSince;
      if (now - since >= budget) { expired++; continue; }
      this.closingSince.set(f, since); keep.push(f);
    }
    const why = lastError instanceof Error ? lastError.message : String(lastError);
    const p = expired > 0 ? `, including ${expired} closing frames past their retry budget` : "";
    this.log(keep.length === 0 && expired === 0
      ? `[user-computer-provider] dropping ${frames.length}-frame response batch after ${UC_SUBMIT_ATTEMPTS} failed submits: ${why}`
      : `[user-computer-provider] after ${UC_SUBMIT_ATTEMPTS} failed submits, keeping ${keep.length} of ${frames.length} response frames that close requests and dropping the rest${p}: ${why}`);
    this.requeue(keep);
    return keep.length;
  }

  /** Clear a credential pause and request a flush (honored even if one is in progress). */
  resume(): void { if (this.stopped) return; this.failure = undefined; void this.flush(); }
  async drain(ms = 1500): Promise<boolean> {
    const end = Date.now() + ms;
    while ((this.readyCount > 0 || this.flushing) && !this.failure && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    return this.readyCount === 0 && !this.flushing;
  }
  stop(): void { this.stopped = true; this.stopSignal.abort(); this.submitAbort?.abort(); }
}
