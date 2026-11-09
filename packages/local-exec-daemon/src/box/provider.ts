import { loadSettings, loadSettingsSync, messagesSettings } from "../settings";
import { boxMessagesOpFrame, draftCardCodes, locateSidecar, messagesCapabilities, MessagesExecutor, UNSUPPORTED_FRAME, type MessagesOp } from "./messages-op";
import { dataRootFromEnv } from "../util";
import { approvalsPathFor, discoverAiToolRefusal, downloadRefusal, execRefusal, retirementsPathFor, standingGrantsPathFor, uploadRefusal } from "../uc/approvals";
import { UC_MAX_FILE_BYTES, writeUploadFile } from "../uc/file-source";
import { aiToolConfigDirsFromEnv, describeAiToolDiscovery, discoverAiToolBytes, isAiToolSource, type AiToolConfigDirs } from "../uc/ai-tool-discovery";
import { StringDecoder } from "node:string_decoder";
import { ASK_MSG, NEVER_MSG, requestError } from "../exec/handlers";
import { HttpStatusError } from "../transport/replies";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import type { Connection } from "../state/connection";
import { isSupervised } from "../state/discovery";
import type { PermissionMode } from "../settings";
import {
  cancelRequest,
  dispatchExec,
  handleDownload,
  type ExecFrameOut,
} from "../exec/handlers";
import { decodeExecServerMessageValue, execServerMessageToRecord, isExecServerDecodeError, prepareBoxExecFrame } from "../exec/exec-codec";

export type BoxProviderOptions = {
  /** Initial connection; the original has none and resolves one on every dial (D:$L wiring 179311–179319). */
  connection?: Connection;
  root: string;
  computerId: string;
  label: string;
  variant: string;
  permission: PermissionMode;
  onInflight?: (n: number) => void;
  /** D:v_ 135920 maxFileBytes default 104857600; also sizes the SSE upload frame limit (OJe). */
  maxFileBytes?: number;
  /** D:187322–187325 */
  aiToolConfigDirs?: AiToolConfigDirs;
  /** D:$L resolveConnection 179318–179322: re-read on every dial and by the heartbeat "moved" check. */
  resolveConnection?: () => Promise<Connection | null>;
  /** D:postBatch 137311: (resolveResponseConnection ?? resolveConnection)() — the daemon passes `we` (no UC check). */
  resolveResponseConnection?: () => Promise<Connection | null>;
  /** Test hook for D:CJe 97387 heartbeat interval (10 s). */
  heartbeatMs?: number;
  /** D:$L clock option (e.clock ?? qr) — drives deadline, backoff, watchdog and heartbeat timers. */
  clock?: BoxClock;
  /** D:onConnectionStale (Box wiring ge, 179322): called after Cwr=3 consecutive failed streams. */
  onConnectionStale?: () => Promise<void>;
  /** Test hook for D:Ed 83034 (sidecar lookup); default locateSidecar(). */
  sidecar?: () => string | undefined;
};
/** D:CJe 97387 */
export const BOX_HEARTBEAT_MS = 10_000;
/** D:137179–137185: reconnect backoff Twr 1 s → vwr 10 s (factor 2, no jitter, B7t 78xxx), connect deadline Rwr 15 s,
 * stall watchdog Iwr 35 s, Cwr 3 consecutive failures → onConnectionStale, postRetry imt 3 × amt 200 ms. */
export const BOX_BACKOFF_INITIAL_MS = 1_000;
export const BOX_BACKOFF_MAX_MS = 10_000;
export const BOX_CONNECT_DEADLINE_MS = 15_000;
export const BOX_STALL_MS = 35_000;
export const BOX_STALE_AFTER_FAILURES = 3;
/** D:B7t: min(max, initial · 2^(attempt−1)), attempt starting at 1. */
export function boxBackoffMs(attempt: number): number { return Math.min(BOX_BACKOFF_MAX_MS, BOX_BACKOFF_INITIAL_MS * 2 ** (attempt - 1)); }
/** D:qr.schedule 78117 shape; injectable for tests (fake clocks). */
export type BoxClock = { schedule(ms: number, fn: () => void): { dispose(): void } };
/** D:qr.schedule 78117–78140: every policy timer is unref'd unless keepEventLoopAlive (no Box policy sets it, 78244). */
export const boxRealClock: BoxClock = { schedule(ms, fn) { const t = setTimeout(fn, ms); t.unref(); return { dispose: () => clearTimeout(t) }; } };
/** D:E0 97389 data-post deadline, ok control-post deadline. */
export const BOX_DATA_POST_MS = 120_000;
export const BOX_CONTROL_POST_MS = 10_000;
/** D:qi 78160 */
class DeadlineExceededError extends Error {
  readonly code = "deadline_exceeded";
  constructor(policy: string) { super(`Deadline exceeded for ${policy}`); this.name = "DeadlineExceededError"; }
}
/** D:H5e 137172–137178 */
class ResponsePostError extends Error {
  readonly code: string;
  constructor(status: number) { super("response POST failed"); this.name = "SandLocalExecResponsePostError"; this.code = `http_${status}`; }
}
/** D:xt 78680 / un 78672 / j7t: `${name} (${code or first E* code along the cause chain})`. */
export function describeError(t: unknown): string {
  if (!(t instanceof Error)) return typeof t;
  const e = (t as { code?: unknown }).code;
  let r: string | undefined = typeof e === "string" && e.length > 0 ? e : undefined;
  if (r === undefined) {
    const seen = new Set<unknown>();
    for (let n: unknown = t; n != null && typeof n === "object" && !seen.has(n); n = (n as { cause?: unknown }).cause) {
      seen.add(n); const c = (n as { code?: unknown }).code;
      if (typeof c === "string" && /^E[A-Z_]+$/.test(c)) { r = c; break; }
    }
  }
  return r !== undefined ? `${t.name} (${r})` : t.name;
}
/** D:kwr/Pwr 137196–137205 */
export function sameConnection(t: Connection, e: Connection): boolean {
  const r = Object.entries(t.headers ?? {}), n = new Map(Object.entries(e.headers ?? {}));
  return t.baseUrl === e.baseUrl && t.token === e.token && r.length === n.size && r.every(([k, v]) => n.get(k) === v);
}

/** D:OJe 97402: largest accepted SSE event (base64 of maxFileBytes + 64 KiB envelope). */
export function maxUploadFrameBytes(maxFileBytes: number): number { return Math.ceil((maxFileBytes * 4) / 3) + 64 * 1024; }
/** D:kJe 97399 */
export function uploadFrameTooLarge(maxFileBytes: number): string {
  return `The upload exceeds Grok Bot's ${(maxFileBytes / (1024 * 1024)).toFixed(1)} MiB limit for transferring a single file over local-exec and was refused before being read into memory. Transfer a smaller file, or split it into parts.`;
}

type JsonFrame = Record<string, unknown>;


/** D:137431–137475 SSE reader: event blocks split on a blank line; an event (or an unterminated buffer) longer than
 * maxUploadFrameBytes is handed to onOversized and skipped up to the next blank line. No other size cap.
 */
function openSse(
  urlStr: string,
  onConnected: () => void,
  onChunk: () => void,
  onBlock: (block: string) => void,
  onOversized: (buffer: string) => void,
  maxFrame: number,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<void> {
  const u = new URL(urlStr);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: { accept: "text/event-stream", ...headers }, // D:cmt 137186
      },
      (res) => {
        if ((res.statusCode || 0) !== 200) { res.resume(); reject(new HttpStatusError(res.statusCode || 0)); return; }
        onConnected();
        const decoder = new StringDecoder("utf8");
        let l = "", skipping = false;
        res.on("data", (chunk: Buffer) => {
          onChunk();
          l += decoder.write(chunk);
          if (skipping) {
            const end = l.indexOf("\n\n");
            if (end < 0) { l = l.slice(-1); return; }
            l = l.slice(end + 2); skipping = false;
          }
          let g = l.indexOf("\n\n");
          while (g >= 0) {
            if (g > maxFrame) onOversized(l); else onBlock(l.slice(0, g));
            l = l.slice(g + 2);
            g = l.indexOf("\n\n");
          }
          if (l.length > maxFrame) { onOversized(l); l = l.slice(-1); skipping = true; }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const onAbort = () => {
      req.destroy();
      reject(signal.reason instanceof Error ? signal.reason : new Error("local-exec requests stream aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

const str = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === undefined || typeof v === "string";

export class BoxProvider {
  private closed = false;
  private stopped = false;
  private abort = new AbortController();
  private providerId: string | undefined;
  private inflight = 0;
  private seen = new Set<string>();
  private jobs = new Map<string, Promise<void>>();
  /** D:$L outbox / flushing 137281–137282 */
  private outbox: JsonFrame[] = [];
  private flushing = false;
  private wakeBackoff?: () => void;
  private wakeRequested = false;
  private streamAbort?: AbortController;
  private get clock(): BoxClock { return this.opts.clock ?? boxRealClock; }
  /** D:v_.inflight 135944: one entry per requestId for every withInflight kind; `cancelled` set by handleCancel. */
  private fileInflight = new Map<string, { cancelled: boolean }>();
  private conn: Connection | undefined;
  private heartbeatTimer?: { dispose(): void };
  private readonly maxFileBytes: number;
  private readonly aiToolConfigDirs: AiToolConfigDirs;
  get headers(): Record<string, string> {
    return { ...this.conn?.headers, ...(this.conn?.token ? { authorization: `Bearer ${this.conn.token}` } : {}) };
  }

  constructor(private readonly opts: BoxProviderOptions) {
    this.conn = opts.connection;
    this.maxFileBytes = opts.maxFileBytes ?? UC_MAX_FILE_BYTES;
    this.aiToolConfigDirs = opts.aiToolConfigDirs ?? aiToolConfigDirsFromEnv();
  }

  /** D:runLoop 137338–137377: e = backoff attempt (reset to 1 on connect, +1 after each wait), r = consecutive failed
   * streams (reset on connect); every status, including 401/403, is retried (no permanent stop on GET failures).
   */
  async start(): Promise<void> {
    let e = 1, r = 0;
    while (!this.closed) {
      try { await this.streamRequests(() => { e = 1; r = 0; }); }
      catch { r += 1; }
      if (this.closed) break;
      if (r >= BOX_STALE_AFTER_FAILURES && this.opts.onConnectionStale != null) {
        r = 0;
        try { await this.opts.onConnectionStale(); }
        catch (s) { console.error(`[local-exec-provider] stale-connection re-resolve failed: ${describeError(s)}`); }
      }
      const n = { h: undefined as { dispose(): void } | undefined };
      try {
        if (!this.wakeRequested) await new Promise<void>(res => {
          n.h = this.clock.schedule(boxBackoffMs(e), res);
          this.wakeBackoff = res;
        });
      } finally { this.wakeBackoff = undefined; this.wakeRequested = false; n.h?.dispose(); }
      e += 1;
    }
  }
  /** D:redial 137286 */
  redial(): void { this.streamAbort?.abort(); }
  /** D:wakeFromReconnectBackoff 137289 */
  wakeFromReconnectBackoff(): void { this.wakeRequested = true; this.wakeBackoff?.(); }
  /** D:streamRequests 137390–137475 */
  private async streamRequests(onConnect: () => void): Promise<void> {
    const stream = new AbortController();
    this.streamAbort = stream;
    const onProviderAbort = () => stream.abort();
    this.abort.signal.addEventListener("abort", onProviderAbort, { once: true });
    if (this.abort.signal.aborted) stream.abort();
    // D:connectDeadline (Gi, Rwr 15 s) covers resolveConnection + the request until response headers.
    let connected = false;
    const deadline = this.clock.schedule(BOX_CONNECT_DEADLINE_MS, () => {
      if (!connected) stream.abort(new Error("Deadline exceeded for local-exec-sse-connect"));
    });
    let watchdog: { dispose(): void } | undefined;
    let watchdogDisposed = false;
    const kick = () => {
      if (watchdogDisposed) return;
      watchdog?.dispose();
      watchdog = this.clock.schedule(BOX_STALL_MS, () => stream.abort(new Error("local-exec-sse-stall")));
    };
    try {
      if (this.opts.resolveConnection) {
        const c = await this.opts.resolveConnection();
        if (!c) throw new Error("local-exec connection unavailable");
        this.conn = c;
      }
      if (stream.signal.aborted) throw stream.signal.reason ?? new Error("aborted");
      const dialed = this.conn;
      if (dialed === undefined) throw new Error("local-exec connection unavailable");
      await openSse(`${dialed.baseUrl}/local-exec/requests`, // D:RJe 97376, no slash trimming
        () => { connected = true; deadline.dispose(); onConnect(); kick(); void this.onConnected(dialed, stream); },
        kick,
        block => this.dispatchEventBlock(block), buffer => this.rejectOversizedFrame(buffer),
        maxUploadFrameBytes(this.maxFileBytes), stream.signal, this.headers);
    } finally {
      // D:137472–137474: watchdog + heartbeat disposed and providerId cleared when the stream ends.
      deadline.dispose(); watchdogDisposed = true; watchdog?.dispose();
      stream.abort(); this.heartbeatTimer?.dispose(); this.heartbeatTimer = undefined; this.providerId = undefined;
      this.abort.signal.removeEventListener("abort", onProviderAbort);
    }
  }
  /** D:close 137284: closed + abort the current stream only; a backoff wait in progress is NOT ended (it is unref'd). */
  beginShutdown(): void { this.closed = true; this.abort.abort(); }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.beginShutdown();
    this.jobs.forEach((_, id) => cancelRequest(id));
    await Promise.race([Promise.all([...this.jobs.values()]), new Promise(r => setTimeout(r, 1000))]);
    // D:close has no reply drain: flush stops between batches once closed (137291–137300).
  }
  /** D:streamRequests 137408–137440: right after a successful connect, hello is POSTed directly (postBatch with the
   * control deadline, not awaited, no providerId yet), then the heartbeat starts with a leading tick.
   */
  private async onConnected(dialed: Connection, stream: AbortController): Promise<void> {
    const supervised = await this.currentSupervised();
    if (stream.signal.aborted) return;
    void this.postBatch([{
      kind: "hello",
      localRoot: this.opts.root,
      terminalsFolder: `${this.opts.root}/terminals`,
      computerId: this.opts.computerId,
      label: this.opts.label,
      ...(supervised !== undefined ? { supervised } : {}),
      ...(this.opts.variant !== undefined ? { variant: this.opts.variant } : {}),
      capabilities: {
        ...((this.opts.sidecar ?? locateSidecar)() !== undefined ? { messagesOp: true } : {}),
        messagesOpGeneration: 4, // D:gE 97145
      },
    }], BOX_CONTROL_POST_MS, "local-exec-control-post");
    const tick = async () => {
      if (stream.signal.aborted) return;
      try {
        const p = await this.currentSupervised();
        void this.postBatch([{ kind: "ping", ...(p !== undefined ? { supervised: p } : {}) }], BOX_CONTROL_POST_MS, "local-exec-control-post");
        if (this.opts.resolveConnection) {
          let moved = false;
          try { const c = await this.opts.resolveConnection(); moved = !c || !sameConnection(c, dialed); }
          catch { moved = false; } // "unreadable" keeps the stream (D:dialedConnectionState 137380–137386)
          if (moved) stream.abort();
        }
      } finally {
        // D:yre cadence: next tick intervalMs after this one completes.
        if (!stream.signal.aborted) this.heartbeatTimer = this.clock.schedule(this.opts.heartbeatMs ?? BOX_HEARTBEAT_MS, () => void tick());
      }
    };
    void tick();
  }
  private async currentSupervised(): Promise<boolean | undefined> { return await isSupervised(); }
  /** D:enqueue 137292 / flush 137293–137306: the whole outbox is one POST (data deadline E0 120 s); the posted
   * prefix is removed whether posted or dropped; a dropped batch stops this flush (the rest waits for the next enqueue).
   */
  private enqueue(frame: JsonFrame): void { this.outbox.push(frame); void this.flush(); }
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0 && !this.closed) {
        const e = this.outbox.slice();
        const r = await this.postBatch(e, BOX_DATA_POST_MS, "local-exec-data-post");
        this.outbox.splice(0, e.length);
        if (r === "dropped") break;
      }
    } finally { this.flushing = false; }
  }
  /** D:postBatch 137307–137330: postRetry (Pu imt=3, fixed amt=200 ms, unref'd waits); each attempt re-reads the
   * connection (resolveResponseConnection) and runs one fetch under the deadline (Gi); non-2xx → H5e(status).
   * After 3 failures: console.error with xt(last error) and the batch is dropped.
   */
  private async postBatch(frames: JsonFrame[], timeoutMs: number, policy: string): Promise<"posted" | "dropped"> {
    let last: unknown;
    for (let attempt = 1; ; attempt++) {
      try {
        let n = this.conn;
        const resolve = this.opts.resolveResponseConnection ?? this.opts.resolveConnection;
        if (resolve) {
          const c = await resolve();
          if (!c) throw new Error("local-exec connection unavailable");
          n = c;
        }
        if (n === undefined) throw new Error("local-exec connection unavailable");
        const ac = new AbortController();
        let fail: (e: Error) => void = () => {};
        const failed = new Promise<never>((_, rej) => { fail = rej; });
        const h = this.clock.schedule(timeoutMs, () => { const err = new DeadlineExceededError(policy); fail(err); ac.abort(err); });
        let res: Response;
        try {
          res = await Promise.race([fetch(`${n.baseUrl}/local-exec/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", ...n.headers, ...(n.token ? { authorization: `Bearer ${n.token}` } : {}) },
            body: JSON.stringify({ providerId: this.providerId, frames }),
            signal: ac.signal,
          }), failed]);
        } finally { h.dispose(); }
        if (!res.ok) throw new ResponsePostError(res.status);
        return "posted";
      } catch (e) {
        last = e;
        if (attempt >= 3) break;
        await new Promise<void>(r => this.clock.schedule(200, r));
      }
    }
    console.error(`[local-exec-provider] dropping ${frames.length}-frame response batch after 3 failed POSTs: ${describeError(last)}`);
    return "dropped";
  }
  /** D:dispatchEventBlock 137486–137510: `data:` lines (prefix 5, trimmed) joined by newline, one JSON value. */
  private dispatchEventBlock(block: string): void {
    const r = block.split("\n").filter(o => o.startsWith("data:")).map(o => o.slice(5).trim());
    if (r.length === 0) return;
    let data: unknown;
    try { data = JSON.parse(r.join("\n")); }
    catch (o) { console.error(`[local-exec-provider] dropping unparseable request frame: ${o instanceof Error ? o.message : String(o)}`); return; }
    void this.onEvent(data).catch(e => {
      const ev = data as Record<string, unknown>;
      void requestError(String(ev?.requestId || ""), 0, e, this.emitExec)
        .catch(() => console.error("[box-provider] request reply failed"));
    });
  }
  /** D:rejectOversizedFrame 137476–137485: requestId from the first 4096 chars, kJe file-error; no requestId → nothing. */
  private rejectOversizedFrame(buffer: string): void {
    const r = buffer.length > 4096 ? buffer.slice(0, 4096) : buffer;
    const n = /"requestId"\s*:\s*"([^"\\]+)"/.exec(r);
    if (n !== null) void this.emitExec({ kind: "file-error", requestId: n[1], error: uploadFrameTooLarge(this.maxFileBytes) })
      .catch(() => console.error("[box-provider] request reply failed"));
  }
  /** D:withInflight 136032–136042: a requestId already in flight is ignored; slot counted while running. */
  private async withInflight(requestId: string, run: (entry: { cancelled: boolean }) => Promise<void>): Promise<void> {
    if (this.fileInflight.has(requestId)) return;
    const entry = { cancelled: false };
    this.fileInflight.set(requestId, entry); this.bump(1);
    try { await run(entry); } finally { this.fileInflight.delete(requestId); this.bump(-1); }
  }
  private boxRefusalInput() {
    const live = loadSettingsSync(), dataRoot = dataRootFromEnv();
    return {
      permission: live.permission, ceiling: live.settings.localToolPermissionCeiling,
      serverAuthoritative: false, authorization: { kind: "none" } as const,
      // D:re() 179276–179288 via j(Y) (no accountScope on Box → standing grants never apply, Cqt 81454).
      messagesEnabled: messagesSettings(live).enabled, standingGrantsPath: standingGrantsPathFor(dataRoot),
      terminalsFolder: `${this.opts.root}/terminals`,
      approvalsPath: approvalsPathFor(dataRoot), retirementsPath: retirementsPathFor(dataRoot),
    };
  }
  private post(frames: JsonFrame[]): Promise<void> {
    for (const f of frames) this.enqueue(f);
    return Promise.resolve();
  }

  private emitExec = (frame: ExecFrameOut): Promise<void> => this.post([prepareBoxExecFrame(frame)]);

  private bump(delta: number): void {
    this.inflight += delta;
    this.opts.onInflight?.(this.inflight);
  }

  private async onEvent(data: unknown): Promise<void> {
    if (this.closed || data == null || typeof data !== "object") return;
    const ev = data as Record<string, unknown>;
    const kind = ev.kind;

    if (kind === "welcome") {
      // D:handleRequest 137512–137515: welcome only records providerId; hello is sent at connect time.
      if (typeof ev.providerId === "string") this.providerId = ev.providerId;
      return;
    }

    if (kind === "exec") {
      const requestId = String(ev.requestId || "");
      if (this.seen.has(requestId)) return;
      this.seen.add(requestId);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      this.bump(1);
      try {
        let serverMessage: Record<string, unknown>;
        try {
          serverMessage = execServerMessageToRecord(
            decodeExecServerMessageValue((ev.serverMessage ?? {}) as import("@bufbuild/protobuf").JsonValue),
          );
        } catch (error) {
          const msg = isExecServerDecodeError(error)
            ? (error as Error).message
            : "Malformed local-exec request frame";
          await requestError(requestId, 0, msg, this.emitExec);
          return;
        }
        const job = dispatchExec({
          root: this.opts.root,
          requestId,
          serverMessage,
          permission: (await loadSettings()).permission,
          emit: this.emitExec,
        });
        this.jobs.set(requestId, job);
        await job;
      } finally {
        this.jobs.delete(requestId);
        this.bump(-1);
      }
      return;
    }

    if (kind === "cancel") {
      // D:handleCancel 136353–136364: mark the inflight entry cancelled (exec abort stays with cancelRequest).
      const id = String(ev.requestId || "");
      const entry = this.fileInflight.get(id);
      if (entry) entry.cancelled = true;
      cancelRequest(id);
      return;
    }

    if (kind === "messages-op") {
      const parsed = boxMessagesOpFrame.safeParse(ev);
      if (!parsed.success) {
        // D:Mwr 137547–137553: schema failure on a messages-op with a non-empty string requestId → messages-error z2.
        console.error("[local-exec-provider] dropping unparseable request frame: messages-op");
        if (typeof ev.requestId === "string" && ev.requestId.length > 0)
          await this.emitExec({ kind: "messages-error", requestId: ev.requestId, error: UNSUPPORTED_FRAME });
        return;
      }
      await this.handleMessagesOp(parsed.data);
      return;
    }

    if (kind === "download") {
      // D:Nwr 137564–137566 forces authorization none on Box; ceiling/approval still apply.
      if (!str(ev.requestId) || !str(ev.path) || !optStr(ev.approvalId)) { console.error("[local-exec-provider] dropping unparseable request frame: download"); return; }
      const requestId = ev.requestId, filePath = ev.path;
      await this.withInflight(requestId, async () => {
        const refusal = await downloadRefusal({ ...this.boxRefusalInput(), file: filePath, approvalId: ev.approvalId as string | undefined });
        if (refusal !== undefined) { await this.emitExec({ kind: "file-error", requestId, error: refusal }); return; }
        await handleDownload({ root: this.opts.root, requestId, filePath, emit: this.emitExec });
      });
      return;
    }

    if (kind === "upload") {
      // D:rHt 97417–97423 schema; Nwr 137571–137578 base64 → bytes, authorization none; v_.handle 135989–136004
      // write-file refusal → file-error; upload() 136374–136382 size check, n9, cp; Dwr 137583–137599 → {kind:file} without bytesBase64.
      if (!str(ev.requestId) || !str(ev.path) || !str(ev.bytesBase64) || !optStr(ev.approvalId)) { console.error("[local-exec-provider] dropping unparseable request frame: upload"); return; }
      const requestId = ev.requestId, filePath = ev.path;
      const bytes = new Uint8Array(Buffer.from(ev.bytesBase64, "base64"));
      await this.withInflight(requestId, async () => {
        const refusal = await uploadRefusal({ ...this.boxRefusalInput(), file: filePath, approvalId: ev.approvalId as string | undefined });
        if (refusal !== undefined) { await this.emitExec({ kind: "file-error", requestId, error: refusal }); return; }
        let frame: ExecFrameOut;
        try { await writeUploadFile(this.opts.root, filePath, bytes, this.maxFileBytes); frame = { kind: "file", requestId }; }
        catch (e) { frame = { kind: "file-error", requestId, error: e instanceof Error ? e.message : String(e) }; }
        await this.emitExec(frame);
      });
      return;
    }

    if (kind === "discover-ai-tool") {
      // D:rHt 97436–97441 (source enum QP); Nwr 137565–137566 authorization none; v_.handle 136010–136024 VJe JSON bytes.
      if (!str(ev.requestId) || !isAiToolSource(ev.source) || !optStr(ev.approvalId)) { console.error("[local-exec-provider] dropping unparseable request frame: discover-ai-tool"); return; }
      const requestId = ev.requestId, source = ev.source;
      await this.withInflight(requestId, async () => {
        const refusal = await discoverAiToolRefusal({ ...this.boxRefusalInput(), target: describeAiToolDiscovery(source).target, approvalId: ev.approvalId as string | undefined });
        if (refusal !== undefined) { await this.emitExec({ kind: "file-error", requestId, error: refusal }); return; }
        let frame: ExecFrameOut;
        try { frame = { kind: "file", requestId, bytes: await discoverAiToolBytes(source, { configDirs: this.aiToolConfigDirs }) }; }
        catch (e) { frame = { kind: "file-error", requestId, error: e instanceof Error ? e.message : String(e) }; }
        await this.emitExec(frame);
      });
    }
  }

  /** D:v_.handle 135972–135983: withInflight → shared v_ messages path (src/box/messages-op.ts). Box builds v_ without
   * decideLocalUse and Box frames carry no sendKey/draftCard ($L 137232–137243, rHt 97430).
   */
  private messages = new MessagesExecutor({
    capabilities: () => { const m = messagesSettings(loadSettingsSync()); return messagesCapabilities(m.enabled, { read: m.read, send: m.send }); },
    isLocalUseBlocked: async t => await execRefusal({ ...this.boxRefusalInput(), approvalId: t.approvalId, describes: t.describes }),
    sidecar: () => (this.opts.sidecar ?? locateSidecar)(),
  }, draftCardCodes(NEVER_MSG, ASK_MSG));
  private async handleMessagesOp(e: { requestId: string; op: MessagesOp; approvalId?: string }): Promise<void> {
    await this.withInflight(e.requestId, entry => this.messages.handle(e, entry, f =>
      // D:Dwr 137583–137590: messages-accepted / messages-consent-result are not relayed on Box.
      f.kind === "messages-accepted" || f.kind === "messages-consent-result" ? undefined : this.post([f as JsonFrame])));
  }
}
