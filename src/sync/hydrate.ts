/** App 0.79.3 ge/Ee/j3: version-exact omitted reads and transcript-body blob reads.
 * No Watch; no attachments. Opaque blob refs are NOT asserted to be SHA-256.
 */
import fs from "node:fs";
import { GbcError } from "../errors.js";
import { Archive } from "./fs.js";
import {
  decodeBody,
  decodeStored,
  hydrationBinding,
  verifiedHydratedBytes,
  BODY_DECODE_MAX,
  type Hydration,
  type ObjectReader,
} from "./decode.js";
import {
  downloadToStage,
  sha256Hex,
  type FetchFn,
  type TransferBudget,
} from "./attachments.js";
import type { Entry } from "./core.js";

/** Same-version failures that must not burn hydrate_rpc_budget forever. */
const DETERMINISTIC = new Set([
  "body_unavailable",
  "exact_row_missing",
  "body_version_changed",
  "seq_successor_overflow",
  "invalid_blob_reference",
  "body_encoding",
  "body_version_invalid",
]);

export type HydrateStats = {
  needed: number;
  recovered: number;
  decode_failed: number;
  failed: number;
  cached_version: number;
  skipped_deterministic: number;
  version_adopted: number;
  inline_observed: number;
  inline_decode_failed: number;
  omitted_observed: number;
  blob_observed: number;
  requests: number;
  reread_pages: number;
  archive_body_skipped: number;
  network_bytes: number;
  generation_changed: boolean;
};

export const hydrationCoverage = (
  rows: Entry[],
  readObject?: ObjectReader,
) => ({
  retained_rows: rows.length,
  observed_inline: rows.filter((e) => e.body_base64 !== undefined).length,
  observed_omitted: rows.filter((e) => e.body_omitted).length,
  observed_blob_ref: rows.filter((e) => !!e.blob_hash).length,
  hydrated_version_bound: rows.filter(
    (e) => !!verifiedHydratedBytes(e, readObject),
  ).length,
  decoded: rows.filter(
    (e) => decodeStored(e, readObject).decode_status === "decoded",
  ).length,
  unavailable_or_unsupported: rows.filter(
    (e) => decodeStored(e, readObject).decode_status !== "decoded",
  ).length,
  current_membership: "unknown; retained observations, deletes not consumed",
});

function jsonSafe(v: any): any {
  if (v?.toJson) return v.toJson();
  return JSON.parse(
    JSON.stringify(v, (_k, x) =>
      typeof x === "bigint"
        ? String(x)
        : x instanceof Uint8Array
          ? Buffer.from(x).toString("base64")
          : x,
    ),
  );
}
function reason(e: unknown) {
  return e instanceof GbcError ? e.code : "body_read_failed";
}
function safeRef(ref: unknown): string {
  if (
    typeof ref !== "string" ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/.test(ref) ||
    ref === "." ||
    ref === ".."
  )
    throw new GbcError(
      "invalid_blob_reference",
      "body blob reference must be a safe opaque segment",
    );
  return ref;
}
function uint64(v: unknown): string {
  if (
    (typeof v !== "string" && typeof v !== "bigint") ||
    !/^(0|[1-9][0-9]*)$/.test(String(v)) ||
    BigInt(v) > 18446744073709551615n
  )
    throw new GbcError("body_version_invalid", "invalid exact row uint64");
  return String(v);
}
function storeUrl(instruction: any, rel: string): string {
  if (instruction?.relPath !== rel || typeof instruction?.url !== "string")
    throw new GbcError("presign_mapping", "body presign mapping mismatch");
  const expiry = String(instruction.expiresAtMs ?? "");
  if (
    !/^\d+$/.test(expiry) ||
    !Number.isSafeInteger(Number(expiry)) ||
    Number(expiry) <= Date.now() + 1000
  )
    throw new GbcError(
      "presign_expired",
      "body URL missing/invalid/expired expiry",
    );
  let u: URL;
  try {
    u = new URL(instruction.url);
  } catch {
    throw new GbcError("presign_url", "invalid body URL");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443")
  )
    throw new GbcError("presign_url", "unusable body URL");
  return instruction.url;
}

function archiveReader(archive: Archive): ObjectReader {
  return (rel: string) => {
    try {
      const fd = fs.openSync(
        archive.file(rel),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        const st = fs.fstatSync(fd);
        if (st.nlink !== 1 || st.size > BODY_DECODE_MAX) return;
        return fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
  };
}

/** Strip body bytes from reread JSON; body lives only in content-addressed object. */
function rereadMeta(
  r: any,
  bodyObject?: { object_rel: string; content_sha256: string },
): Hydration["reread"] {
  const raw = jsonSafe(r);
  if (raw && typeof raw === "object") {
    delete (raw as any).body;
    delete (raw as any).bodyBase64;
    if (bodyObject) (raw as any).body_object = bodyObject;
  }
  return {
    raw,
    ...(r.toBinary
      ? { wire_base64: Buffer.from(r.toBinary()).toString("base64") }
      : {}),
    ...(bodyObject ?? {}),
  };
}

function adoptNewerObservation(e: Entry, r: any): void {
  const body = r.body;
  if (body != null && !(body instanceof Uint8Array))
    throw new GbcError("body_encoding", "expected body bytes");
  e.updated_seq = uint64(r.updatedSeq);
  if (typeof r.entryId === "string" && r.entryId) e.entry_id = r.entryId;
  e.entry_kind = String(r.entryKind ?? e.entry_kind);
  e.body_omitted = Boolean(r.bodyOmitted);
  e.blob_hash = r.blobHash || undefined;
  e.body_base64 =
    body == null ? undefined : Buffer.from(body).toString("base64");
  e.raw = jsonSafe(r);
  e.wire_base64 = r.toBinary
    ? Buffer.from(r.toBinary()).toString("base64")
    : undefined;
  delete e.hydration;
  delete e.decoded;
  delete e.decode_reason;
  delete e.body_source;
  delete e.last_available_body;
  delete e.attachment_local;
}

export async function hydrateEntries(
  rows: Entry[],
  ctx: {
    archive: Archive;
    fetchImpl: FetchFn;
    call: (method: string, request: any) => Promise<any>;
    maxRequests: number;
    maxBodyBytes: number;
    budget: TransferBudget;
    maxArchiveBytes?: number;
    /** Seqs observed in this pull page set — hydrated before older archive rows. */
    prioritySeqs?: Set<string>;
  },
): Promise<HydrateStats> {
  const stats: HydrateStats = {
    needed: 0,
    recovered: 0,
    decode_failed: 0,
    failed: 0,
    cached_version: 0,
    skipped_deterministic: 0,
    version_adopted: 0,
    inline_observed: 0,
    inline_decode_failed: 0,
    omitted_observed: 0,
    blob_observed: 0,
    requests: 0,
    reread_pages: 0,
    archive_body_skipped: 0,
    network_bytes: 0,
    generation_changed: false,
  };
  const readObject = archiveReader(ctx.archive);
  const start = ctx.budget.bytes;
  const call = async (method: string, req: any) => {
    if (ctx.budget.bytes >= ctx.budget.maxBytes)
      throw new GbcError("resource_exhausted", "body byte budget exhausted");
    if (stats.requests >= ctx.maxRequests)
      throw new GbcError(
        "hydrate_rpc_budget",
        "body read RPC budget exhausted",
      );
    if (Date.now() >= ctx.budget.deadline)
      throw new GbcError("deadline_exceeded", "body read deadline");
    stats.requests++;
    if (method === "listGrokBotTranscriptEntries") stats.reread_pages++;
    const res = await ctx.call(method, req);
    const bytes = Buffer.byteLength(JSON.stringify(jsonSafe(res)));
    ctx.budget.bytes += bytes;
    if (ctx.budget.bytes > ctx.budget.maxBytes)
      throw new GbcError(
        "resource_exhausted",
        "body read response budget exceeded",
      );
    return res;
  };
  const blobs = new Map<
    string,
    Promise<{ bytes: Buffer; digest: string; rel: string }>
  >();
  const blob = async (e: Entry, ref: string) => {
    const key = JSON.stringify([e.agent_id, e.session_id, e.generation, ref]);
    let pending = blobs.get(key);
    if (pending) return pending;
    pending = (async () => {
      const rp = `blobs/${safeRef(ref)}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const presign = await call("presignSandBoxStoreReads", {
          relPaths: [rp],
        });
        if (
          !Array.isArray(presign.instructions) ||
          presign.instructions.length !== 1
        )
          throw new GbcError(
            "presign_mapping",
            "missing/duplicate/conflicting body presign instructions",
          );
        const url = storeUrl(presign.instructions[0], rp),
          stage = ctx.archive.stage();
        try {
          const transfer = await downloadToStage(url, {
            maxBytes: Math.min(ctx.maxBodyBytes, BODY_DECODE_MAX),
            budget: ctx.budget,
            fetchImpl: ctx.fetchImpl,
            sink: stage,
          });
          if (transfer.status === 403) {
            if (attempt === 0) continue;
            throw new GbcError(
              "permission_denied",
              "body URL rejected after bounded refresh",
            );
          }
          if (transfer.status !== 200 || !transfer.digest)
            throw new GbcError("body_http_status", "body response rejected");
          const rel = `bodies/objects/sha256-${transfer.digest}`;
          stage.commit(rel);
          const bytes = readObject(rel);
          if (!bytes || sha256Hex(bytes) !== transfer.digest)
            throw new GbcError(
              "body_integrity",
              "body object integrity mismatch",
            );
          return { bytes, digest: transfer.digest, rel };
        } finally {
          stage.discard();
        }
      }
      throw new GbcError("body_read_failed", "body read exhausted");
    })();
    blobs.set(key, pending);
    return pending;
  };

  const maxArchiveBytes = ctx.maxArchiveBytes ?? 64 * 1024 * 1024;
  let archiveBytes = rows.reduce(
    (n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 1,
    0,
  );
  const priority = ctx.prioritySeqs ?? new Set<string>();
  const ordered = [...rows].sort((a, b) => {
    const ap = priority.has(a.seq) ? 0 : 1;
    const bp = priority.has(b.seq) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const as = BigInt(a.seq),
      bs = BigInt(b.seq);
    return as < bs ? 1 : as > bs ? -1 : 0;
  });

  const publish = (e: Entry, h: Hydration) => {
    const originalSize = Buffer.byteLength(JSON.stringify(e));
    const candidate: Entry = { ...e, hydration: h };
    delete candidate.decoded;
    delete candidate.decode_reason;
    delete candidate.body_source;
    Object.assign(candidate, decodeStored(candidate, readObject));
    let delta = Buffer.byteLength(JSON.stringify(candidate)) - originalSize;
    if (archiveBytes + delta > maxArchiveBytes) {
      stats.archive_body_skipped++;
      if (h.status === "fetched") {
        stats.recovered--;
        if (h.reason?.startsWith("decoder:")) stats.decode_failed--;
        stats.failed++;
        h = {
          format_version: 1,
          status: "error",
          binding: h.binding,
          source: h.source,
          context: h.context,
          observed_at_ms: h.observed_at_ms,
          reason: "archive_body_budget",
          attempts: h.attempts ?? 1,
          retry: "retryable",
        };
      } else {
        h = {
          ...h,
          reason: "archive_body_budget",
          retry: "retryable",
        };
      }
      const minimal = { ...candidate, hydration: h };
      delete minimal.decoded;
      delete minimal.decode_reason;
      delete minimal.body_source;
      Object.assign(minimal, decodeStored(minimal, readObject));
      delta = Buffer.byteLength(JSON.stringify(minimal)) - originalSize;
      if (archiveBytes + delta <= maxArchiveBytes) {
        delete e.decoded;
        delete e.decode_reason;
        delete e.body_source;
        Object.assign(e, minimal);
        archiveBytes += delta;
      }
    } else {
      delete e.decoded;
      delete e.decode_reason;
      delete e.body_source;
      Object.assign(e, candidate);
      archiveBytes += delta;
    }
  };

  for (const e of ordered) {
    if (e.body_omitted) stats.omitted_observed++;
    if (e.blob_hash) stats.blob_observed++;
    if (e.body_base64 !== undefined) {
      stats.inline_observed++;
      if (decodeStored(e, readObject).decode_status !== "decoded")
        stats.inline_decode_failed++;
      continue;
    }
    stats.needed++;
    if (e.hydration && e.hydration.format_version !== 1) {
      stats.failed++;
      continue;
    }
    const bindingNow = hydrationBinding(e);
    if (
      e.hydration?.status === "error" &&
      e.hydration.retry === "never" &&
      e.hydration.binding === bindingNow &&
      DETERMINISTIC.has(e.hydration.reason ?? "")
    ) {
      stats.skipped_deterministic++;
      continue;
    }
    const cached = verifiedHydratedBytes(e, readObject);
    if (cached) {
      stats.cached_version++;
      if (decodeStored(e, readObject).decode_status !== "decoded")
        stats.decode_failed++;
      continue;
    }

    let h: Hydration = {
      format_version: 1,
      status: "error",
      binding: bindingNow,
      source: e.blob_hash ? "blob" : "omitted_list",
      context: {
        archive_scope_sha256: e.archive_scope_sha256 ?? "",
        agent_id: e.agent_id,
        session_id: e.session_id,
        generation: e.generation,
        seq: e.seq,
        updated_seq: e.updated_seq,
        entry_id: e.entry_id,
      },
      observed_at_ms: String(Date.now()),
      attempts: (e.hydration?.attempts ?? 0) + 1,
      retry: "retryable",
    };

    try {
      let bytes: Buffer | undefined,
        remote = e.blob_hash;
      // App Ee: inline already handled; prefer blob ref; else omitted exact re-list.
      if (!remote && e.body_omitted) {
        const seq = BigInt(e.seq);
        if (seq === 18446744073709551615n)
          throw new GbcError(
            "seq_successor_overflow",
            "cannot form before_seq=UINT64_MAX+1",
          );
        // App ge always passes generation, including 0.
        const res = await call("listGrokBotTranscriptEntries", {
          agentId: e.agent_id,
          sessionId: e.session_id,
          generation: e.generation,
          beforeSeq: seq + 1n,
          limit: 1,
        });
        if (res.generation !== e.generation) {
          stats.generation_changed = true;
          throw new GbcError(
            "generation_changed",
            "omitted read changed generation",
          );
        }
        if (!Array.isArray(res.entries) || res.entries.length !== 1)
          throw new GbcError(
            "exact_row_missing",
            "exact body row missing/conflicting",
          );
        const r = res.entries[0];
        if (uint64(r.seq) !== e.seq)
          throw new GbcError(
            "body_version_changed",
            "omitted read does not match exact row/version",
          );
        if (String(r.entryKind ?? "") !== e.entry_kind)
          throw new GbcError(
            "body_version_changed",
            "omitted read does not match exact row/version",
          );
        if (e.entry_id !== undefined && r.entryId !== e.entry_id)
          throw new GbcError(
            "body_version_changed",
            "omitted read does not match exact row/version",
          );

        const remoteUpdated = uint64(r.updatedSeq);
        if (BigInt(remoteUpdated) > BigInt(e.updated_seq)) {
          // Same seq/identity with a newer version: merge then hydrate that version.
          adoptNewerObservation(e, r);
          stats.version_adopted++;
          h.binding = hydrationBinding(e);
          h.context = {
            archive_scope_sha256: e.archive_scope_sha256 ?? "",
            agent_id: e.agent_id,
            session_id: e.session_id,
            generation: e.generation,
            seq: e.seq,
            updated_seq: e.updated_seq,
            entry_id: e.entry_id,
          };
          if (e.body_base64 !== undefined) {
            // Newer observation brought inline body — retained as observation, not hydration.
            Object.assign(e, decodeStored(e, readObject));
            // Count as recovered coverage without inventing hydration present.
            stats.recovered++;
            continue;
          }
          remote = e.blob_hash;
          if (!remote) {
            h.reread = rereadMeta(r);
            throw new GbcError(
              "body_unavailable",
              "exact row still has no body/ref",
            );
          }
          h.reread = rereadMeta(r);
        } else if (remoteUpdated !== e.updated_seq) {
          throw new GbcError(
            "body_version_changed",
            "omitted read does not match exact row/version",
          );
        } else {
          // Exact same version — take body/blob from the reread.
          if (
            r.body instanceof Uint8Array &&
            r.body.length > Math.min(ctx.maxBodyBytes, BODY_DECODE_MAX)
          )
            throw new GbcError(
              "resource_exhausted",
              "exact body exceeds bound",
            );
          if (r.body !== undefined && r.body !== null) {
            if (!(r.body instanceof Uint8Array))
              throw new GbcError("body_encoding", "expected body bytes");
            bytes = Buffer.from(r.body);
            // Defer reread meta until object hash is known (no body in raw JSON).
            (h as any)._exact_reread_row = r;
          } else if (r.blobHash) {
            remote = String(r.blobHash);
            h.reread = rereadMeta(r);
          } else
            throw new GbcError(
              "body_unavailable",
              "exact row still has no body/ref",
            );
        }
      }

      if (!bytes && remote) {
        h.source = "blob";
        h.remote_blob_ref = safeRef(remote);
        const b = await blob(e, remote);
        bytes = b.bytes;
        h.content_sha256 = b.digest;
        h.object_rel = b.rel;
      }
      if (!bytes)
        throw new GbcError("body_unavailable", "no inline body or blob ref");
      if (bytes.length > ctx.maxBodyBytes || bytes.length > BODY_DECODE_MAX)
        throw new GbcError("resource_exhausted", "body exceeds decode limit");

      h.status = "fetched";
      h.content_sha256 = sha256Hex(bytes);
      h.object_rel = `bodies/objects/sha256-${h.content_sha256}`;
      // Persist once as content-addressed object; do not also inline body_base64.
      if (h.source === "omitted_list" || !ctx.archive.read(h.object_rel))
        ctx.archive.atomicBytes(h.object_rel, bytes);
      const bodyObject = {
        object_rel: h.object_rel,
        content_sha256: h.content_sha256,
      };
      const exactRow = (h as any)._exact_reread_row;
      delete (h as any)._exact_reread_row;
      if (exactRow) h.reread = rereadMeta(exactRow, bodyObject);
      else if (h.reread) {
        h.reread = {
          ...h.reread,
          ...bodyObject,
          raw:
            h.reread.raw && typeof h.reread.raw === "object"
              ? { ...(h.reread.raw as object), body_object: bodyObject }
              : h.reread.raw,
        };
      }
      delete h.body_base64;
      stats.recovered++;
      const decoded = decodeBody(bytes, false, e.entry_kind);
      if (decoded.decode_status !== "decoded") {
        h.reason = `decoder:${decoded.decode_reason ?? decoded.decode_status}`;
        stats.decode_failed++;
      }
    } catch (error) {
      h.reason = reason(error);
      if (DETERMINISTIC.has(h.reason)) h.retry = "never";
      stats.failed++;
    }
    publish(e, h);
    if (stats.generation_changed) break;
  }
  stats.network_bytes = ctx.budget.bytes - start;
  return stats;
}
