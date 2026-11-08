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
  constructor(private send: (body: Buffer) => Promise<void>, private reject: () => void,
    readonly maxBytes = 8 * 1024 * 1024, readonly maxFrames = 256) {}
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
      const item = this.items[0];
      if (this.submitting !== item.ids) { this.submitting = item.ids; this.submittingSince = performance.now(); }
      try { await this.send(item.body); this.submitting = []; this.items.shift(); this.bytes -= item.body.length; this.admitWaiters(); }
      catch (e) {
        item.attempts++; this.submitting = [];
        if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
          this.failure = e; this.reject(); break;
        }
        this.timer = setTimeout(() => { this.running = false; void this.pump(); }, Math.min(2000, 100 * 2 ** Math.min(item.attempts, 5)));
        return;
      }
    }
    this.running = false;
  }
  /** Request ids holding queued (not currently submitting) replies (official replies.requestIds()). */
  requestIds(): Set<string> {
    const out = new Set<string>();
    this.items.forEach((it, i) => { if (i === 0 && this.submitting === it.ids && this.submitting.length) return; it.ids.forEach(id => out.add(id)); });
    this.waiters.forEach(w => w.ids.forEach(id => out.add(id)));
    return out;
  }
  resume(): void { if (this.stopped) return; this.failure=undefined; void this.pump(); }
  async drain(ms = 1500): Promise<boolean> {
    const end = Date.now() + ms;
    while ((this.items.length || this.waiters.length) && !this.failure && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    return this.items.length === 0 && this.waiters.length === 0;
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.timer);
    this.waiters.splice(0).forEach(w=>w.reject(new Error("reply shutdown deadline"))); this.waiterBytes=0;
  }
}
