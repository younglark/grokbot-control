/** Bounded in-memory lane. Retries only replies; never retries execution.
 * Transient failures retain bytes indefinitely with capped backoff. Authentication
 * failure pauses the same lane until same-scope credentials explicitly rotate. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) { super(`reply HTTP ${status}`); }
}
export class ReplyQueue {
  private items: { body: Buffer; attempts: number; ids: string[] }[] = [];
  /** Request ids of the batch currently being submitted (official `submitting`), and since when. */
  submitting: string[] = [];
  submittingSince = 0;
  private bytes = 0;
  private running = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private waiters: { body: Buffer; ids: string[]; resolve: () => void; reject: (e: Error) => void }[] = [];
  private waiterBytes = 0;
  failure?: Error;
  private submitAbort?: AbortController;
  /** Items in the submit currently in flight (a prefix of `items`). */
  private inflight: { body: Buffer; attempts: number; ids: string[] }[] = [];
  /**
   * `merge`, when given, coalesces every queued item into one submit, like official
   * `replies.take()` (daemon.formatted.cjs L178680). UC protobuf bodies merge by concatenation
   * (repeated `frames`); lanes without it (Box JSON) keep one body per submit.
   */
  constructor(private send: (body: Buffer, signal: AbortSignal) => Promise<void>, private reject: () => void,
    readonly maxBytes = 8 * 1024 * 1024, readonly maxFrames = 256, private merge?: (bodies: Buffer[]) => Buffer) {}
  // Reserve capacity for already-admitted requests (start/exit/control frames).
  get available(): boolean { return !this.stopped && !this.failure && this.waiters.length === 0 && this.items.length < Math.max(1, this.maxFrames - 32) && this.bytes < this.maxBytes * 0.75; }
  enqueue(body: Buffer, ids: string[] = []): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("reply lane stopped"));
    if (body.length > this.maxBytes) return Promise.reject(new Error("reply exceeds lane byte capacity"));
    if (this.waiters.length === 0 && this.items.length < this.maxFrames && this.bytes + body.length <= this.maxBytes) {
      this.items.push({ body, attempts: 0, ids }); this.bytes += body.length; void this.pump(); return Promise.resolve();
    }
    // Producers must await capacity / pause their output pipes. Bounded pending
    // credits cover admitted producers only; overflow is explicit, not silent.
    if (this.waiters.length >= 64 || this.waiterBytes + body.length > this.maxBytes) return Promise.reject(new Error("reply producer capacity exceeded"));
    return new Promise((resolve, reject) => { this.waiters.push({body,ids,resolve,reject}); this.waiterBytes += body.length; });
  }
  private admitWaiters(): void {
    while (this.waiters.length && this.items.length < this.maxFrames && this.bytes + this.waiters[0].body.length <= this.maxBytes) {
      const w = this.waiters.shift()!; this.waiterBytes -= w.body.length;
      this.items.push({body:w.body,attempts:0,ids:w.ids}); this.bytes += w.body.length; w.resolve();
    }
  }
  private async pump(): Promise<void> {
    if (this.running || this.stopped || this.failure) return;
    this.running = true;
    while (this.items.length && !this.stopped && !this.failure) {
      const batch = this.merge ? this.items.slice(0, this.maxFrames) : [this.items[0]];
      const ids = [...new Set(batch.flatMap(b => b.ids))];
      if (this.inflight.length !== batch.length || this.inflight.some((b, i) => b !== batch[i]) || !this.submitting.length) { this.submittingSince = performance.now(); }
      this.inflight = batch; this.submitting = ids;
      const body = this.merge && batch.length > 1 ? this.merge(batch.map(b => b.body)) : batch[0].body;
      const ac = new AbortController(); this.submitAbort = ac;
      try {
        await this.send(body, ac.signal); this.submitting = []; this.submitAbort = undefined; this.inflight = [];
        for (const b of batch) { const i = this.items.indexOf(b); if (i >= 0) { this.items.splice(i, 1); this.bytes -= b.body.length; } }
        this.admitWaiters();
      }
      catch (e) {
        this.submitAbort = undefined; this.submitting = []; this.inflight = [];
        // Aborted because every request in this batch was cancelled (drop): it is already gone.
        if (ac.signal.aborted && !batch.some(b => this.items.includes(b))) continue;
        if (this.stopped) break;
        batch.forEach(b => b.attempts++);
        if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
          this.failure = e; this.reject(); break;
        }
        this.timer = setTimeout(() => { this.running = false; void this.pump(); }, Math.min(2000, 100 * 2 ** Math.min(batch[0].attempts, 5)));
        return;
      }
    }
    this.running = false;
  }
  /** Request ids holding queued (not currently submitting) replies (official replies.requestIds()). */
  requestIds(): Set<string> {
    const out = new Set<string>();
    this.items.forEach(it => { if (this.inflight.includes(it)) return; it.ids.forEach(id => out.add(id)); });
    this.waiters.forEach(w => w.ids.forEach(id => out.add(id)));
    return out;
  }
  /**
   * Official replies.drop(requestId) + submitAbort: remove queued replies that belong only to
   * cancelled requests, and abort the in-flight submit when every id in it is cancelled. Batches
   * that also carry other requests' frames are kept (their slow submit keeps the 120s deadline).
   */
  drop(isCancelled: (id: string) => boolean): number {
    const only = (ids: string[]) => ids.length > 0 && ids.every(isCancelled);
    let n = 0;
    // The in-flight submit is aborted (and its items dropped) only when every item in it is cancelled;
    // a mixed batch keeps going under the 120s deadline.
    const abortInflight = this.inflight.length > 0 && this.inflight.every(it => only(it.ids));
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!only(it.ids)) continue;
      if (this.inflight.includes(it) && !abortInflight) continue;
      this.items.splice(i, 1); this.bytes -= it.body.length; n++;
    }
    if (abortInflight) this.submitAbort?.abort();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (!only(w.ids)) continue;
      this.waiters.splice(i, 1); this.waiterBytes -= w.body.length; w.resolve(); n++;
    }
    if (n) this.admitWaiters();
    return n;
  }
  resume(): void { if (this.stopped) return; this.failure=undefined; void this.pump(); }
  async drain(ms = 1500): Promise<boolean> {
    const end = Date.now() + ms;
    while ((this.items.length || this.waiters.length) && !this.failure && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    return this.items.length === 0 && this.waiters.length === 0;
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer); this.submitAbort?.abort();
    this.waiters.splice(0).forEach(w=>w.reject(new Error("reply shutdown deadline"))); this.waiterBytes=0;
  }
}
