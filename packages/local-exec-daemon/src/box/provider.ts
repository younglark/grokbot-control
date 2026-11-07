import { loadSettings } from "../settings";
import { requestError } from "../exec/handlers";
import { HttpStatusError, ReplyQueue } from "../transport/replies";
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
import { decodeExecServerMessageValue, execServerMessageToRecord, isExecServerDecodeError } from "../exec/exec-codec";

export type BoxProviderOptions = {
  connection: Connection;
  root: string;
  computerId: string;
  label: string;
  variant: string;
  permission: PermissionMode;
  onInflight?: (n: number) => void;
};

type JsonFrame = Record<string, unknown>;

function httpRequest(
  urlStr: string,
  opts: { method: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const u = new URL(urlStr);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) { res.destroy(); reject(new Error("HTTP response limit")); return; }
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error("HTTP deadline")));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function openSse(
  urlStr: string,
  onData: (data: unknown) => void,
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
        headers: { ...headers, accept: "text/event-stream" },
      },
      (res) => {
        if ((res.statusCode || 0) !== 200) { res.resume(); reject(new HttpStatusError(res.statusCode || 0)); return; }
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          if (buf.length > 8 * 1024 * 1024) { req.destroy(); reject(new Error("SSE limit")); return; }
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  onData(JSON.parse(line.slice(6)));
                } catch {
                  /* ignore */
                }
              }
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    const onAbort = () => {
      req.destroy();
      resolve();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

export class BoxProvider {
  private closed = false;
  private stopped = false;
  private abort = new AbortController();
  private providerId: string | undefined;
  private inflight = 0;
  private seen = new Set<string>();
  private jobs = new Map<string, Promise<void>>();
  private replies: ReplyQueue;
  private rejected = false;
  private retryTimer?: NodeJS.Timeout;
  get headers(): Record<string, string> {
    return { ...(this.opts.connection.token ? { authorization: `Bearer ${this.opts.connection.token}` } : {}), ...this.opts.connection.headers };
  }

  constructor(private readonly opts: BoxProviderOptions) {
    this.replies = new ReplyQueue(async body => {
      const res = await httpRequest(`${this.opts.connection.baseUrl.replace(/\/$/, "")}/local-exec/responses`, {
        method: "POST", headers: { ...this.headers, "content-type": "application/json" }, body: body.toString("utf8") });
      if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status);
    }, () => { this.rejected = true; this.abort.abort(); });
  }

  async start(): Promise<void> {
    let attempt = 0;
    while (!this.closed && !this.rejected) {
      try {
        await openSse(`${this.opts.connection.baseUrl.replace(/\/$/, "")}/local-exec/requests`, data => {
          void this.onEvent(data).catch(e => {
            const ev = data as Record<string, unknown>;
            void requestError(String(ev?.requestId || ""), 0, e, this.emitExec)
              .catch(() => console.error("[box-provider] request reply failed"));
          });
        }, this.abort.signal, this.headers);
      } catch (e) {
        if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) this.rejected = true;
      }
      if (this.closed || this.rejected) break;
      await new Promise<void>(resolve => {
        this.retryTimer = setTimeout(resolve, Math.min(2000, 100 * 2 ** Math.min(attempt++, 4)));
        this.abort.signal.addEventListener("abort", () => { clearTimeout(this.retryTimer); resolve(); }, { once: true });
      });
    }
  }
  beginShutdown(): void { this.closed = true; this.abort.abort(); }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.beginShutdown();
    this.jobs.forEach((_, id) => cancelRequest(id));
    await Promise.race([Promise.all([...this.jobs.values()]), new Promise(r => setTimeout(r, 1000))]);
    const drained = await this.replies.drain();
    if (!drained) console.error("[box-provider] reply drain deadline");
    this.replies.stop();
  }
  private post(frames: JsonFrame[]): Promise<void> {
    return this.replies.enqueue(Buffer.from(JSON.stringify({ frames, ...(this.providerId ? { providerId: this.providerId } : {}) })));
  }

  private emitExec = (frame: ExecFrameOut): Promise<void> => this.post([frame as unknown as JsonFrame]);

  private bump(delta: number): void {
    this.inflight += delta;
    this.opts.onInflight?.(this.inflight);
  }

  private async onEvent(data: unknown): Promise<void> {
    if (this.closed || this.rejected || !this.replies.available || data == null || typeof data !== "object") return;
    const ev = data as Record<string, unknown>;
    const kind = ev.kind;

    if (kind === "welcome") {
      this.providerId = typeof ev.providerId === "string" ? ev.providerId : undefined;
      const supervised = await isSupervised();
      const live = await loadSettings();
      await this.post([
        {
          kind: "hello",
          localRoot: this.opts.root,
          terminalsFolder: `${this.opts.root}/terminals`,
          computerId: this.opts.computerId,
          label: this.opts.label,
          supervised,
          variant: this.opts.variant,
          standing: live.permission,
          capabilities: { messagesOpGeneration: 4 },
        },
        { kind: "ping", supervised },
      ]);
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
      cancelRequest(String(ev.requestId || ""));
      return;
    }

    if (kind === "download") {
      handleDownload({
        root: this.opts.root,
        requestId: String(ev.requestId || ""),
        filePath: String(ev.path || ""),
        permission: (await loadSettings()).permission,
        emit: this.emitExec,
      });
    }
  }
}
