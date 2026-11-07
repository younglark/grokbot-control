/** On-demand user-attachment download (App 0.79.3 ResolveGrokBotAttachmentReads evidence).
 * Not transcript blob_hash hydration. Signed URLs are never persisted or echoed.
 */
import { createHash } from "node:crypto";
import { GbcError } from "../errors.js";
import { component } from "./fs.js";

export const ATTACHMENT_DOWNLOADER = "resolve-attachment-reads/0.79.3-ondemand-v1";
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
  pathBytes: 1024,
} as const;

export type AttachmentLocalStatus =
  | "ok"
  | "not_in_store"
  | "no_storage"
  | "error"
  | "skipped";

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

export function assertRemotePath(path: string): string {
  if (typeof path !== "string" || !path)
    throw new GbcError("invalid_argument", "attachment path required");
  if (Buffer.byteLength(path) > HARD_ATTACH.pathBytes || /[\x00-\x1f]/.test(path))
    throw new GbcError(
      "invalid_argument",
      "attachment path must be <=1024 bytes without control characters",
    );
  // Never treat remote path as a local filesystem path.
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => p === "." || p === ".."))
    throw new GbcError("invalid_argument", "unsafe attachment path encoding");
  return path;
}

export function pathKey(remotePath: string): string {
  return component(assertRemotePath(remotePath));
}

export function objectRel(agentId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new GbcError("invalid_argument", "invalid content hash");
  return `bots/${component(agentId)}/attachments/objects/sha256-${sha256}`;
}

export function refRel(agentId: string, remotePath: string): string {
  return `bots/${component(agentId)}/attachments/refs/${pathKey(remotePath)}.json`;
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
  const path = String(read?.path ?? remotePath);
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
      reason:
        mapped === "error" ? "resolve_outcome_unusable" : mapped,
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
  if (parsed.protocol !== "https:")
    return { ok: false, status: "error", reason: "store_url_not_https" };
  const expires = int64Ms(read?.expiresAtMs ?? read?.expires_at_ms);
  if (expires !== undefined && expires <= nowMs)
    return { ok: false, status: "error", reason: "store_url_expired" };
  const size = int64Size(read?.sizeBytes ?? read?.size_bytes);
  const contentType =
    typeof read?.contentType === "string"
      ? read.contentType
      : typeof read?.content_type === "string"
        ? read.content_type
        : undefined;
  const etag = typeof read?.etag === "string" ? read.etag : undefined;
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

export type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function downloadHttpsBytes(
  url: string,
  opts: {
    maxBytes: number;
    expectedSize?: number;
    timeoutMs: number;
    fetchImpl: FetchFn;
    signal?: AbortSignal;
  },
): Promise<{ bytes: Uint8Array; content_type?: string }> {
  if (opts.expectedSize !== undefined && opts.expectedSize > opts.maxBytes)
    throw new GbcError(
      "resource_exhausted",
      "attachment declared size exceeds file bound",
    );
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: ac.signal,
    });
    if (!res.ok)
      throw new GbcError(
        "unavailable",
        `attachment HTTP status ${res.status}`,
      );
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      if (!/^\d+$/.test(declared))
        throw new GbcError("failed_precondition", "invalid content-length");
      const n = Number(declared);
      if (!Number.isSafeInteger(n) || n > opts.maxBytes)
        throw new GbcError(
          "resource_exhausted",
          "attachment content-length exceeds file bound",
        );
      if (opts.expectedSize !== undefined && n !== opts.expectedSize)
        throw new GbcError(
          "failed_precondition",
          "attachment content-length mismatches resolve size",
        );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > opts.maxBytes)
      throw new GbcError(
        "resource_exhausted",
        "attachment body exceeds file bound",
      );
    if (
      opts.expectedSize !== undefined &&
      buf.byteLength !== opts.expectedSize
    )
      throw new GbcError(
        "failed_precondition",
        "attachment body size mismatches resolve size",
      );
    const ct = res.headers.get("content-type") ?? undefined;
    return { bytes: buf, content_type: ct ?? undefined };
  } catch (e) {
    if (e instanceof GbcError) throw e;
    if ((e as Error)?.name === "AbortError")
      throw new GbcError("deadline_exceeded", "attachment download timed out");
    throw new GbcError(
      "unavailable",
      "attachment download failed; URL suppressed",
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
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
