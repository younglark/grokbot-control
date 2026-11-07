import { loadSettings } from "../settings";
import { HttpStatusError, ReplyQueue } from "../transport/replies";
import { requestError } from "../exec/handlers";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import * as crypto from "node:crypto";
import {
  decodeFields,
  encBool,
  encMsg,
  encStr,
  encVarint,
  envelope,
  firstStr,
  firstVarint,
  takeEnvelopes,
  unwrapConnectBody,
  type PbFields,
} from "./pb";
import {
  cancelRequest,
  dispatchExec,
  type Emit,
  type ExecFrameOut,
} from "../exec/handlers";
import type { PermissionMode } from "../settings";
import { isSupervised } from "../state/discovery";
import type { UserComputerHello, UserComputerTransport } from "./types";

const WATCH = "/aiserver.v1.GrokBotService/WatchGrokBotUserComputerRequests";
const POLL = "/aiserver.v1.GrokBotService/PollGrokBotUserComputerRequests";
const SUBMIT = "/aiserver.v1.GrokBotService/SubmitGrokBotUserComputerResponses";
const WITHDRAW = "/aiserver.v1.GrokBotService/WithdrawGrokBotUserComputerPresence";

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

function httpLib(u: URL) {
  return u.protocol === "https:" ? https : http;
}

function postBinary(
  urlStr: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: Buffer }> {
  const u = new URL(urlStr);
  const lib = httpLib(u);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(body.length),
        },
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
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error("HTTP deadline")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function encodeCapabilities(caps: Record<string, unknown> | undefined): Buffer {
  if (!caps) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  if (typeof caps.messagesOp === "boolean") parts.push(encBool(1, caps.messagesOp));
  if (typeof caps.messagesOpGeneration === "number")
    parts.push(encVarint(2, caps.messagesOpGeneration));
  if (typeof caps.localStandingGrants === "boolean")
    parts.push(encBool(3, caps.localStandingGrants));
  if (typeof caps.aiToolSetup === "boolean") parts.push(encBool(4, caps.aiToolSetup));
  if (typeof caps.shell === "boolean") parts.push(encBool(6, caps.shell));
  if (typeof caps.urlFileTransfer === "boolean") parts.push(encBool(11, caps.urlFileTransfer));
  return Buffer.concat(parts);
}

function encodeHello(hello: UserComputerHello): Buffer {
  const parts = [
    encStr(1, hello.label),
    encStr(2, hello.localRoot),
    encStr(3, hello.terminalsFolder),
    encStr(4, hello.standing),
    encBool(5, hello.supervised),
    encStr(6, hello.variant),
    encBool(7, hello.serverAuthoritative),
    encStr(9, ""),
  ];
  const caps = encodeCapabilities(hello.capabilities);
  if (caps.length) parts.push(encMsg(8, caps));
  return Buffer.concat(parts);
}

function encodeWatchRequest(
  machineId: string,
  credential: string,
  hello: UserComputerHello,
  presenceToken: string,
): Buffer {
  return Buffer.concat([
    encStr(1, machineId),
    encStr(2, credential),
    encMsg(3, encodeHello(hello)),
    encStr(4, presenceToken),
  ]);
}

function encodePollRequest(
  machineId: string,
  credential: string,
  ackIds: string[],
  limit: number,
): Buffer {
  const parts = [encStr(1, machineId), encStr(2, credential)];
  for (const id of ackIds) parts.push(encStr(3, id));
  parts.push(encVarint(4, limit));
  return Buffer.concat(parts);
}

function encodeResponseFrame(frame: ExecFrameOut): Buffer {
  const parts = [encStr(1, frame.requestId)];
  if (frame.kind === "client") {
    parts.push(encMsg(2, encStr(1, JSON.stringify(frame.message))));
  } else if (frame.kind === "control") {
    const ctrl = [encStr(1, JSON.stringify(frame.message))];
    if (frame.cwdState) ctrl.push(encStr(2, frame.cwdState));
    parts.push(encMsg(3, Buffer.concat(ctrl)));
  } else if (frame.kind === "messages-error") {
    parts.push(encMsg(7, encStr(1, frame.error)));
  } else if (frame.kind === "file-error") {
    parts.push(encMsg(5, encStr(1, frame.error)));
  }
  return Buffer.concat(parts);
}

function encodeSubmitRequest(
  machineId: string,
  credential: string,
  frames: ExecFrameOut[],
): Buffer {
  const parts = [encStr(1, machineId), encStr(2, credential)];
  for (const f of frames) parts.push(encMsg(3, encodeResponseFrame(f)));
  return Buffer.concat(parts);
}

function encodeWithdraw(
  machineId: string,
  credential: string,
  presenceToken: string,
): Buffer {
  return Buffer.concat([
    encStr(1, machineId),
    encStr(2, credential),
    encStr(3, presenceToken),
  ]);
}

export type Queued = { id: string; requestId: string; kind: number; serverMessage: Record<string, unknown>; parseError?: string };
export function parseQueued(fields: PbFields): Queued | null {
  const id = firstStr(fields, 1);
  const buf = fields[2]?.[0]?.t === "b" ? fields[2][0].v as Buffer : null;
  if (!id || !buf) throw new Error("invalid queued request");
  const ff = decodeFields(buf);
  const requestId = firstStr(ff, 1) || id;
  const kinds = [2,3,4,5,6,7,9,12,13,14].filter(k => !!ff[k]);
  if (kinds.length !== 1) throw new Error("invalid request oneof");
  const kind = kinds[0]; let serverMessage: Record<string, unknown> = {};
  if (kind === 2) {
    const exec = decodeFields(ff[2][0].v as Buffer);
    const value = JSON.parse(firstStr(exec, 1));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid exec JSON object");
    serverMessage = value;
  }
  return { id, requestId, kind, serverMessage };
}

function parsePollResponse(body: Buffer): Queued[] {
  const fields = decodeFields(unwrapConnectBody(body));
  const out: Queued[] = [];
  for (const it of fields[1] || []) {
    if (it.t !== "b") continue;
    let f: PbFields = {};
    try {
      decodeFields(it.v as Buffer, f);
      const q = parseQueued(f);
      if (q) out.push(q);
    } catch (error) {
      // A malformed request is terminal for that queue id, not the whole batch.
      const id = firstStr(f, 1);
      if (!id) continue; // Cannot acknowledge an unidentifiable/corrupt item.
      let requestId = id;
      const identity: PbFields = {};
      try { if (f[2]?.[0]?.t === "b") decodeFields(f[2][0].v as Buffer, identity); } catch { /* preserve decoded prefix */ }
      requestId = firstStr(identity, 1) || id;
      const parseError = error instanceof SyntaxError
        ? `cannot decode agent.v1.ExecServerMessage from JSON: ${error.message}`
        : error instanceof Error && error.message === "invalid request oneof"
          ? "This computer's local-exec daemon does not understand that request frame; update the desktop app."
          : "Malformed local-exec request frame";
      out.push({ id, requestId, kind: 0, serverMessage: {}, parseError });
    }
  }
  return out;
}

function watchEventKind(msg: Buffer): "connected" | "notify" | "heartbeat" | "unknown" {
  const f = decodeFields(msg);
  if (f[1]) return "connected";
  if (f[2]) return "notify";
  if (f[3]) return "heartbeat";
  return "unknown";
}

/**
 * UserComputer ConnectRPC transport (P2 skeleton).
 * Speaks Watch/Poll/Submit/Withdraw against a lab fake peer or compatible backend.
 */
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
  private admissionClosed = false;
  private announcedStanding?: string;
  get blocked(): boolean { return this.admissionClosed; }
  private channel: { backendUrl: string; machineId: string; credential: string } | null =
    null;

  constructor(private readonly opts: UcProviderOptions) {}

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
      const fields = decodeFields(body);
      const currentBody = Buffer.concat([encStr(1, ch.machineId), encStr(2, ch.credential),
        ...(fields[3] || []).map(f => encMsg(3, f.v as Buffer))]);
      const res = await postBinary(`${ch.backendUrl}${SUBMIT}`, currentBody, { "content-type": "application/proto" });
      if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status);
      const accepted = firstVarint(decodeFields(res.body), 1) ?? 0;
      const submitted = (fields[3] || []).length;
      // Official successful Submit is terminal even when the machine rejected
      // some frames. Only transport/HTTP errors are retried, never accepted_count.
      if (accepted < submitted) console.error(
        `[user-computer-provider] server accepted ${accepted} of ${submitted} response frames; the rest were not queued for this machine`,
      );
    }, () => { this.admissionClosed = true; this.abort.abort(); });
    this.pollTimer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, 250);
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
    this.closed = true; clearInterval(this.pollTimer); this.abort.abort();
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
      await postBinary(
        `${ch.backendUrl}${WITHDRAW}`,
        encodeWithdraw(ch.machineId, ch.credential, this.presenceToken),
        { "content-type": "application/proto" },
      );
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
    return this.replies.enqueue(encodeSubmitRequest(ch.machineId, ch.credential, frames));
  }

  private async pollOnce(): Promise<void> {
    if (this.pollBusy) { this.pollAgain = true; return; }
    if (this.closed || this.admissionClosed || !this.channel || !this.replies?.available) return;
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
      const slots = Math.max(0, 8 + 64 - this.active.size - this.backlog.length);
      // Continue polling at capacity: cancel controls must remain reachable.
      const res = await postBinary(`${ch.backendUrl}${POLL}`,
        encodePollRequest(ch.machineId, ch.credential, acks, Math.min(this.opts.pollLimit ?? 64, Math.max(1, slots))),
        { "content-type": "application/proto" });
      if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status);
      const queued = parsePollResponse(res.body);
      // Only forget queue ids after the peer confirms receipt of prior acks.
      acks.forEach(id => this.seen.delete(id));
      for (const q of queued) {
        if (this.seen.has(q.id)) continue;
        // Capacity is checked before ack/admission. Cancel controls bypass backlog.
        this.seen.add(q.id); this.pendingAcks.push(q.id);
        if (q.parseError) { await this.emit({ kind: "control", requestId: q.requestId, message: { throw: { error: q.parseError } } }); continue; }
        if (q.kind !== 6 && this.active.size >= 8 && this.backlog.length >= 64) {
          const error = "The user's computer is busy with other requests right now; try again shortly.";
          if ([3,4,12].includes(q.kind)) this.emit({ kind: "file-error", requestId: q.requestId, error });
          else if (q.kind === 7) this.emit({ kind: "messages-error", requestId: q.requestId, error });
          else this.emit({ kind: "control", requestId: q.requestId, message: { throw: { id: 0, error } } });
          continue;
        }
        if (q.kind === 6) {
          this.backlog = this.backlog.filter(x => x.requestId !== q.requestId);
          cancelRequest(q.requestId); continue;
        }
        // Official startRequest suppresses an already-inflight requestId with
        // no additional result; queue-id ack remains separate. Pending backlog
        // entries are not a durable request-id dedup ledger.
        if (this.active.has(q.requestId)) continue;
        this.backlog.push(q); this.runBacklog();
      }
      // A previously saturated reply lane may have recovered with no new jobs.
      this.runBacklog();
    } catch (e) {
      this.pendingAcks.unshift(...acks);
      if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
        this.admissionClosed = true; this.abort.abort();
      }
      // Failed poll never re-executes an admitted request.
    } finally {
      this.pollBusy = false;
      if (this.pollAgain) { this.pollAgain = false; setTimeout(() => void this.pollOnce(), 25); }
    }
  }
  private runBacklog(): void {
    while (!this.closed && !this.admissionClosed && this.active.size < 8 && this.backlog.length && this.replies?.available) {
      const q = this.backlog.shift()!;
      if (this.active.has(q.requestId)) continue;
      this.active.add(q.requestId); this.bump(1);
      const job = this.handleQueued(q).catch(e => requestError(q.requestId, Number(q.serverMessage.id) || 1, e, this.emit))
        .catch(() => { console.error("[user-computer-provider] request reply failed"); })
        .then(() => undefined).finally(() => { this.activeJobs.delete(job); this.active.delete(q.requestId); this.bump(-1); this.runBacklog(); });
      this.activeJobs.add(job);
    }
  }
  private async handleQueued(q: Queued): Promise<void> {
    if (q.kind !== 2) {
      // Frozen oracle dispatch maps unimplemented outer variants to an error.
      // Full variant-specific payloads remain a documented gap (not silent success).
      const error = "This computer's local-exec daemon does not understand that request frame; update the desktop app.";
      if (q.kind === 12) this.emit({ kind: "file-error", requestId: q.requestId, error });
      else if (q.kind === 7) this.emit({ kind: "messages-error", requestId: q.requestId, error });
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
    const u = new URL(`${ch.backendUrl}${WATCH}`);
    const lib = httpLib(u);
    const body = envelope(
      encodeWatchRequest(ch.machineId, ch.credential, hello, this.presenceToken),
    );

    await new Promise<void>((resolve) => {
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: "POST",
          headers: {
            "content-type": "application/connect+proto",
            "connect-protocol-version": "1",
            "connect-content-encoding": "identity",
            accept: "application/connect+proto",
            "content-length": String(body.length),
          },
        },
        (res) => {
          if ((res.statusCode || 0) !== 200) {
            if (res.statusCode === 401 || res.statusCode === 403) this.admissionClosed = true;
            res.resume(); resolve(); return;
          }
          let buf = Buffer.alloc(0);
          res.on("data", (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            let parsed;
            try { parsed = takeEnvelopes(buf); } catch { req.destroy(); resolve(); return; }
            const { messages, rest, ended, endError } = parsed;
            if (endError === "unauthenticated" || endError === "permission_denied") this.admissionClosed = true;
            buf = Buffer.from(rest);
            for (const msg of messages) {
              let kind;
              try { kind = watchEventKind(msg); } catch { req.destroy(); resolve(); return; }
              if (kind === "connected" || kind === "notify" || kind === "heartbeat") {
                void this.pollOnce().catch(() => undefined);
              }
            }
            if (ended) resolve();
          });
          res.on("end", () => resolve());
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      const onAbort = () => {
        req.destroy();
        resolve();
      };
      if (this.abort.signal.aborted) onAbort();
      else this.abort.signal.addEventListener("abort", onAbort, { once: true });
      req.write(body);
      req.end();
    });
  }
}

/** Paths used by fake-peer tests (exported for scripts). */
export const UC_RPC_PATHS = { WATCH, POLL, SUBMIT, WITHDRAW } as const;
