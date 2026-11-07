/** On-demand user-attachment download (App 0.79.3 ResolveGrokBotAttachmentReads evidence).
 * Not transcript blob_hash hydration. Signed URLs are never persisted or echoed.
 */
import { createHash } from "node:crypto";
import { GbcError } from "../errors.js";
import { component } from "./fs.js";

export const ATTACHMENT_DOWNLOADER =
  "resolve-attachment-reads/0.79.3-ondemand-v1";
export const DEFAULT_ATTACH = {
  maxFileBytes: 32 * 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 30000,
  resolveBatch: 8,
} as const;
export const HARD_ATTACH = {
  maxFileBytes: 128 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024,
  timeoutMs: 300000,
  resolveBatch: 32,
  pathBytes: 4096,
} as const;

export type AttachmentLocalStatus =
  "ok" | "not_in_store" | "no_storage" | "error" | "skipped";

export type AttachmentLocal = {
  remote_path: string;
  status: AttachmentLocalStatus;
  relative_path?: string;
  content_sha256?: string;
  size_bytes?: number;
  content_type?: string;
  etag?: string;
  reason?: string;
  observed_at_ms: string;
  live_verified: false;
};

// App main-core: /home/box/agent-data (model alias), /home/box/sand-data.
// These strings are REMOTE references, never paths read from this computer.
export function assertRemotePath(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 4096 ||
    /[\x00-\x1f\x7f\\]/.test(value)
  )
    throw new GbcError(
      "invalid_argument",
      "invalid remote attachment reference",
    );
  let p = value;
  if (p.startsWith("file:")) {
    let u: URL;
    try {
      u = new URL(p);
    } catch {
      throw new GbcError("invalid_argument", "invalid remote file URL");
    }
    if (
      u.host ||
      u.search ||
      u.hash ||
      p !== `file://${u.pathname}` ||
      /%2f|%5c/i.test(u.pathname)
    )
      throw new GbcError("invalid_argument", "invalid remote file URL");
    try {
      p = decodeURIComponent(u.pathname);
    } catch {
      throw new GbcError(
        "invalid_argument",
        "invalid remote file URL encoding",
      );
    }
  }
  if (
    /[\x00-\x1f\x7f\\]/.test(p) ||
    p.split("/").some((x) => x === "." || x === "..")
  )
    throw new GbcError(
      "invalid_argument",
      "unsafe remote attachment reference",
    );
  const m =
    /^\/home\/box\/(?:agent-data|sand-data)\/agents\/([A-Za-z0-9._-]{1,128})\/(attachments|assets)\/([0-9a-f]{64}\.[0-9a-z]{1,16})$/.exec(
      p,
    );
  if (!m || m[1] === "." || m[1] === "..")
    throw new GbcError(
      "unsupported",
      "not a supported App store attachment alias",
    );
  return `/home/box/agent-data/agents/${m[1]}/${m[2]}/${m[3]}`;
}
export function pathKey(remotePath: string): string {
  return createHash("sha256")
    .update(assertRemotePath(remotePath))
    .digest("hex");
}
export function objectRel(agentId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new GbcError("invalid_argument", "invalid content hash");
  return `bots/${component(agentId)}/attachments/objects/sha256-${sha256}`;
}
export function refRel(
  agentId: string,
  remotePath: string,
  sessionId = "",
): string {
  const sk = createHash("sha256").update(sessionId).digest("hex");
  return `bots/${component(agentId)}/attachments/refs-v2/${sk}/${pathKey(remotePath)}.json`;
}
export function mapOutcome(outcome: unknown): AttachmentLocalStatus | "store" {
  const n =
    typeof outcome === "number"
      ? outcome
      : typeof outcome === "bigint"
        ? Number(outcome)
        : undefined;
  const s = typeof outcome === "string" ? outcome : undefined;
  if (
    n === 1 ||
    s === "STORE" ||
    s === "GROK_BOT_ATTACHMENT_READ_OUTCOME_STORE"
  )
    return "store";
  if (
    n === 2 ||
    s === "NOT_IN_STORE" ||
    s === "GROK_BOT_ATTACHMENT_READ_OUTCOME_NOT_IN_STORE"
  )
    return "not_in_store";
  if (
    n === 3 ||
    s === "NO_STORAGE" ||
    s === "GROK_BOT_ATTACHMENT_READ_OUTCOME_NO_STORAGE"
  )
    return "no_storage";
  return "error";
}

function int64Ms(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < 0n) return undefined;
    return Number(v);
  }
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function int64Size(v: unknown): number | undefined {
  return int64Ms(v);
}

export type ResolvedStore = {
  remote_path: string;
  url: string;
  expires_at_ms?: number;
  content_type?: string;
  size_bytes?: number;
  etag?: string;
};

/** Validate STORE read without exposing the URL to callers' logs. */
export function acceptStoreRead(
  remotePath: string,
  read: any,
  nowMs: number,
):
  | { ok: true; store: ResolvedStore }
  | { ok: false; status: AttachmentLocalStatus; reason: string } {
  const path = String(read?.path ?? "");
  if (path !== remotePath)
    return {
      ok: false,
      status: "error",
      reason: "resolve_path_mismatch",
    };
  const mapped = mapOutcome(read?.outcome);
  if (mapped !== "store")
    return {
      ok: false,
      status: mapped === "error" ? "error" : mapped,
      reason: mapped === "error" ? "resolve_outcome_unusable" : mapped,
    };
  const url = read?.url;
  if (typeof url !== "string" || !url)
    return { ok: false, status: "error", reason: "store_missing_url" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: "error", reason: "store_url_unusable" };
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.port && parsed.port !== "443")
  )
    return { ok: false, status: "error", reason: "store_url_not_https" };
  const expires = int64Ms(read?.expiresAtMs ?? read?.expires_at_ms);
  if (expires === undefined || expires <= nowMs + 1000)
    return { ok: false, status: "error", reason: "store_url_expired" };
  const size = int64Size(read?.sizeBytes ?? read?.size_bytes);
  const contentType =
    typeof read?.contentType === "string"
      ? read.contentType
      : typeof read?.content_type === "string"
        ? read.content_type
        : undefined;
  const etag = typeof read?.etag === "string" ? read.etag : undefined;
  if (
    size === undefined ||
    !etag ||
    etag.length > 512 ||
    /[\x00-\x20\x7f]/.test(etag)
  )
    return { ok: false, status: "error", reason: "invalid_store_metadata" };
  if (
    contentType &&
    (contentType.length > 256 || /[\x00-\x1f\x7f]/.test(contentType))
  )
    return { ok: false, status: "error", reason: "invalid_store_metadata" };
  return {
    ok: true,
    store: {
      remote_path: remotePath,
      url,
      expires_at_ms: expires,
      content_type: contentType,
      size_bytes: size,
      etag,
    },
  };
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type TransferBudget = {
  bytes: number;
  maxBytes: number;
  deadline: number;
};
/** Stream directly into a private staging sink. Failed network bytes count too. */
export async function downloadToStage(
  url: string,
  opts: {
    maxBytes: number;
    expectedSize?: number;
    budget: TransferBudget;
    fetchImpl: FetchFn;
    etag?: string;
    sink: { write(bytes: Uint8Array): void; discard(): void };
  },
): Promise<{ status: number; digest?: string; size?: number }> {
  const remain = opts.budget.deadline - Date.now();
  if (remain <= 0)
    throw new GbcError("deadline_exceeded", "attachment command deadline");
  if (
    opts.expectedSize !== undefined &&
    (opts.expectedSize > opts.maxBytes ||
      opts.expectedSize > opts.budget.maxBytes - opts.budget.bytes)
  )
    throw new GbcError(
      "resource_exhausted",
      "attachment size exceeds remaining budget",
    );
  const ac = new AbortController(),
    timer = setTimeout(() => ac.abort(), remain);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const aborted = new Promise<never>((_, reject) =>
    ac.signal.addEventListener(
      "abort",
      () => reject(new GbcError("deadline_exceeded", "attachment deadline")),
      { once: true },
    ),
  );
  try {
    const headers: Record<string, string> = {};
    if (opts.etag)
      headers["if-none-match"] =
        opts.etag.startsWith('"') || opts.etag.startsWith("W/")
          ? opts.etag
          : `"${opts.etag}"`;
    const res = await Promise.race([
      opts.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: ac.signal,
      }),
      aborted,
    ]);
    response = res;
    if (res.status === 403 || (res.status === 304 && opts.etag)) {
      await res.body?.cancel();
      return { status: res.status };
    }
    if (res.status !== 200)
      throw new GbcError("unavailable", "attachment HTTP response rejected");
    const len = res.headers.get("content-length");
    if (
      len !== null &&
      (!/^\d+$/.test(len) ||
        !Number.isSafeInteger(Number(len)) ||
        Number(len) > opts.maxBytes ||
        Number(len) > opts.budget.maxBytes - opts.budget.bytes ||
        (opts.expectedSize !== undefined && Number(len) !== opts.expectedSize))
    )
      throw new GbcError(
        "failed_precondition",
        "attachment size header mismatch",
      );
    const h = createHash("sha256");
    let size = 0;
    reader = res.body?.getReader();
    if (!reader && opts.expectedSize !== 0)
      throw new GbcError("failed_precondition", "attachment body missing");
    while (reader) {
      if (Date.now() >= opts.budget.deadline)
        throw new GbcError("deadline_exceeded", "attachment command deadline");
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      opts.budget.bytes += value.byteLength;
      if (
        size > opts.maxBytes ||
        (opts.expectedSize !== undefined && size > opts.expectedSize) ||
        opts.budget.bytes > opts.budget.maxBytes
      )
        throw new GbcError(
          "resource_exhausted",
          "attachment streaming budget exceeded",
        );
      h.update(value);
      opts.sink.write(value);
    }
    if (
      (opts.expectedSize !== undefined && size !== opts.expectedSize) ||
      (len !== null && size !== Number(len))
    )
      throw new GbcError("failed_precondition", "attachment size mismatch");
    return { status: 200, digest: h.digest("hex"), size };
  } catch (e) {
    if (e instanceof GbcError) throw e;
    throw new GbcError(
      ac.signal.aborted ? "deadline_exceeded" : "unavailable",
      "attachment transfer failed (URL suppressed)",
    );
  } finally {
    clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(() => {});
    } else if (response?.body) {
      void response.body.cancel().catch(() => {});
    }
    // Do not reject the already-finished abort promise in finally.
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function redactAttachmentError(e: unknown): {
  status: AttachmentLocalStatus;
  reason: string;
} {
  if (e instanceof GbcError) {
    if (e.code === "resource_exhausted")
      return { status: "error", reason: "size_or_budget" };
    if (e.code === "deadline_exceeded")
      return { status: "error", reason: "timeout" };
    if (e.code === "unavailable")
      return { status: "error", reason: "http_or_transport" };
    return { status: "error", reason: e.code };
  }
  return { status: "error", reason: "download_failed" };
}
