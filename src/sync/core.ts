import path from "node:path";
import fs from "node:fs";
import {
  decodeStored,
  decodeBody,
  type BodyDecode,
  DECODER,
} from "./decode.js";
import { renderEntry, dataBlock } from "./render.js";
import { GbcError } from "../errors.js";
import { okResult, failResult, type ResultEnvelope } from "../dto/result.js";
import type { GrokBotClient } from "../connect/client.js";
import { Archive, component, hash } from "./fs.js";
import {
  ATTACHMENT_DOWNLOADER,
  DEFAULT_ATTACH,
  HARD_ATTACH,
  acceptStoreRead,
  assertRemotePath,
  downloadHttpsBytes,
  objectRel,
  redactAttachmentError,
  refRel,
  sha256Hex,
  type AttachmentLocal,
  type FetchFn,
} from "./attachments.js";

export type Scope = {
  backend: string;
  account_id: string;
  team_id: string;
  assurance: "operator_asserted_unverified";
};
export type PullInput = {
  dir: string;
  agentId: string;
  sessionId?: string;
  accountId: string;
  teamId: string;
  acknowledgeUnverifiedScope: boolean;
  dryRun?: boolean;
  maxPages?: number;
  maxBytes?: number;
  timeoutMs?: number;
};
export type LocalInput = {
  dir: string;
  agentId?: string;
  sessionId?: string;
  dryRun?: boolean;
};
export type AttachmentsInput = LocalInput & {
  /** Optional exact remote file_path filter (not a local path). */
  path?: string;
  maxBytes?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
};
export const DEFAULTS = {
  maxPages: 100,
  maxBytes: 32 * 1024 * 1024,
  timeoutMs: 30000,
};
export function jsonSafe(value: any): any {
  if (value?.toJson) return value.toJson();
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint"
        ? String(v)
        : v instanceof Uint8Array
          ? Buffer.from(v).toString("base64")
          : v,
    ),
  );
}
function uint(v: unknown): string {
  if (
    (typeof v !== "bigint" && typeof v !== "string" && typeof v !== "number") ||
    (typeof v === "number" && !Number.isSafeInteger(v)) ||
    !/^\d+$/.test(String(v))
  )
    throw new GbcError(
      "invalid_argument",
      "invalid/unsafe uint64 in transcript",
    );
  const n = BigInt(v);
  if (n > 18446744073709551615n)
    throw new GbcError("invalid_argument", "uint64 out of range");
  return String(n);
}
function generation(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff)
    throw new GbcError("invalid_argument", "invalid generation");
  return v;
}
function bounded(v: number | undefined, def: number, max: number): number {
  const n = v ?? def;
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new GbcError("invalid_argument", `sync bound must be 1..${max}`);
  return n;
}
function scope(backend: string, i: PullInput): Scope {
  if (!i.acknowledgeUnverifiedScope || !i.accountId || !i.teamId)
    throw new GbcError(
      "denied",
      "sync requires explicit stable account-id, team-id (use none if no team), and acknowledgement of unverified identity; auth API has no verified stable account ID",
    );
  component(i.accountId);
  component(i.teamId);
  if (i.accountId.includes("@"))
    throw new GbcError(
      "invalid_argument",
      "account-id must be a stable provider ID, not an email address",
    );
  const u = new URL(backend);
  if (u.username || u.password || u.search || u.hash)
    throw new GbcError(
      "invalid_argument",
      "backend must not contain credentials/query/fragment",
    );
  return {
    backend: backend.replace(/\/$/, ""),
    account_id: i.accountId,
    team_id: i.teamId,
    assurance: "operator_asserted_unverified",
  };
}
function botDir(id: string) {
  return `bots/${component(id)}`;
}
function sessionDir(a: string, s: string) {
  return `${botDir(a)}/sessions/${component(s)}`;
}
function genDir(a: string, s: string, g: number) {
  return `${sessionDir(a, s)}/generations/${generation(g)}`;
}
function manifest(a: Archive, expected?: Scope, create = false) {
  const m = a.json("manifest.json");
  if (!m && create) {
    a.writeJson("manifest.json", {
      format_version: 1,
      scope: expected,
      pagination_live_verified: false,
      attachment_policy: "references_only",
      sessions: [],
    });
    return a.json("manifest.json");
  }
  if (!m || m.format_version !== 1 || !Array.isArray(m.sessions))
    throw new GbcError("failed_precondition", "not a supported sync archive");
  if (m.sessions.length > 10000)
    throw new GbcError(
      "resource_exhausted",
      "archive session index bound exceeded",
    );
  for (const x of m.sessions) {
    component(x.agent_id);
    component(x.session_id);
  }
  if (
    expected &&
    ["backend", "account_id", "team_id", "assurance"].some(
      (k) => m.scope?.[k] !== expected[k as keyof Scope],
    )
  )
    throw new GbcError(
      "denied",
      "archive scope mismatch (backend/account/team); choose a separate root",
    );
  return m;
}
export type Entry = {
  agent_id: string;
  session_id: string;
  generation: number;
  seq: string;
  updated_seq: string;
  entry_id?: string;
  entry_kind: string;
  body_base64?: string;
  body_omitted: boolean;
  blob_hash?: string;
  last_available_body?: { updated_seq: string; body_base64: string };
  decode_status: BodyDecode["decode_status"];
  decode_reason?: string;
  encryption_status: BodyDecode["encryption_status"];
  decoded?: BodyDecode["decoded"];
  raw: unknown;
  wire_base64?: string;
  untrusted: true;
  attachment_local?: AttachmentLocal;
};
export function entryRecord(
  e: any,
  agent: string,
  session: string,
  g: number,
): Entry {
  const body = e.body;
  if (body != null && !(body instanceof Uint8Array))
    throw new GbcError(
      "invalid_argument",
      "expected protobuf bytes, not guessed UTF-8",
    );
  return {
    agent_id: agent,
    session_id: session,
    generation: g,
    seq: uint(e.seq),
    updated_seq: uint(e.updatedSeq),
    entry_id: e.entryId || undefined,
    entry_kind: String(e.entryKind ?? ""),
    body_base64:
      body == null ? undefined : Buffer.from(body).toString("base64"),
    body_omitted: Boolean(e.bodyOmitted),
    blob_hash: e.blobHash || undefined,
    raw: jsonSafe(e),
    wire_base64: e.toBinary
      ? Buffer.from(e.toBinary()).toString("base64")
      : undefined,
    untrusted: true,
    ...decodeBody(body, Boolean(e.bodyOmitted), String(e.entryKind ?? "")),
  };
}
function parseEntries(
  text: string | undefined,
  agent: string,
  session: string,
  g: number,
): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const line of (text ?? "").split("\n")) {
    if (!line) continue;
    const e: Entry = JSON.parse(line);
    if (
      e.agent_id !== agent ||
      e.session_id !== session ||
      e.generation !== g ||
      uint(e.seq) !== e.seq ||
      uint(e.updated_seq) !== e.updated_seq ||
      out.has(e.seq)
    )
      throw new GbcError(
        "failed_precondition",
        "corrupt or wrong-scope local entries",
      );
    const {
      decoded: _decoded,
      decode_status: _status,
      decode_reason: _reason,
      encryption_status: _encryption,
      ...original
    } = e;
    out.set(e.seq, { ...original, ...decodeStored(e) });
  }
  return out;
}
function merge(out: Map<string, Entry>, e: Entry) {
  const old = out.get(e.seq);
  if (!old || BigInt(e.updated_seq) > BigInt(old.updated_seq)) {
    if (old && (e.body_omitted || e.body_base64 === undefined)) {
      // An omitted newer observation must not erase a previously available body.
      e.last_available_body =
        old.body_base64 !== undefined && !old.body_omitted
          ? { updated_seq: old.updated_seq, body_base64: old.body_base64 }
          : old.last_available_body;
    }
    out.set(e.seq, e);
  } else if (
    e.updated_seq === old.updated_seq &&
    old.body_omitted &&
    !e.body_omitted
  )
    out.set(e.seq, e);
  // Missing/older entries never delete or overwrite newer local versions.
}
function fail(e: unknown): ResultEnvelope {
  // Never echo arbitrary RPC/error text (may contain signed URLs or secrets).
  const rpcCode = (e as { code?: number })?.code;
  const rpcCodes: Record<number, string> = {
    1: "canceled",
    3: "invalid_argument",
    4: "deadline_exceeded",
    5: "not_found",
    7: "permission_denied",
    8: "resource_exhausted",
    14: "unavailable",
    16: "unauthenticated",
  };
  if (
    !(e instanceof GbcError) &&
    typeof rpcCode === "number" &&
    rpcCodes[rpcCode]
  )
    return failResult(
      rpcCodes[rpcCode],
      "sync read RPC failed; original error text suppressed to avoid leaking credentials/URLs",
      { retryable: rpcCode === 14 || rpcCode === 8 },
    );
  const known = e instanceof GbcError;
  return failResult(
    known ? e.code : "sync_failed",
    known
      ? e.message
      : "sync/local IO failed; archive preserved; rerun from history head after resolving cause",
    { retryable: false },
  );
}

/** Shared CLI/MCP core. Only list agents, sessions and transcript RPCs. No Watch or server writes. */
export class SyncOps {
  constructor(
    private client: GrokBotClient,
    private backend: string,
    private simulated = false,
    private fetchImpl: FetchFn = globalThis.fetch.bind(globalThis),
  ) {}
  private async result(
    fn: () => Promise<unknown>,
    code?: string,
  ): Promise<ResultEnvelope> {
    try {
      return okResult(await fn(), { simulated: this.simulated, code });
    } catch (e) {
      return { ...fail(e), simulated: this.simulated };
    }
  }
  pull(i: PullInput): Promise<ResultEnvelope> {
    return this.result(
      async () => {
        const identity = scope(this.backend, i);
        component(i.agentId);
        if (i.sessionId !== undefined) component(i.sessionId);
        if (!path.isAbsolute(i.dir))
          throw new GbcError("invalid_argument", "sync root must be absolute");
        const maxPages = bounded(i.maxPages, DEFAULTS.maxPages, 1000),
          maxBytes = bounded(i.maxBytes, DEFAULTS.maxBytes, 256 * 1024 * 1024),
          timeoutMs = bounded(i.timeoutMs, DEFAULTS.timeoutMs, 300000);
        if (i.dryRun)
          return {
            dry_run: true,
            scope: identity,
            would_pull_agent: i.agentId,
            session_id: i.sessionId ?? null,
            no_rpc_or_files: true,
          };
        const a = new Archive(i.dir, true),
          release = a.lock();
        try {
          const m = manifest(a, identity, true);
          const deadline = Date.now() + timeoutMs;
          let pages = 0,
            bytes = 0;
          const call = async (method: string, req: unknown): Promise<any> => {
            const ms = deadline - Date.now();
            if (ms <= 0)
              throw new GbcError(
                "deadline_exceeded",
                "sync time budget exhausted; rerun from head",
              );
            const ac = new AbortController();
            let timer: NodeJS.Timeout | undefined;
            try {
              return await Promise.race([
                this.client[method](req, { timeoutMs: ms, signal: ac.signal }),
                new Promise((_, reject) => {
                  timer = setTimeout(() => {
                    ac.abort();
                    reject(
                      new GbcError(
                        "deadline_exceeded",
                        "sync time budget exhausted; rerun from head",
                      ),
                    );
                  }, ms);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          };
          const botRes = await call("listGrokBotAgents", {});
          const bot = (botRes.agents ?? []).find(
            (b: any) => b.agentId === i.agentId || b.id === i.agentId,
          );
          if (!bot)
            throw new GbcError(
              botRes.truncated ? "lookup_incomplete" : "not_found",
              botRes.truncated
                ? "agent list truncated; absence cannot establish nonexistence"
                : "agent not returned by list RPC",
            );
          const sessionsRes = await call("listGrokBotAgentSessions", {
            agentId: i.agentId,
          });
          let sessions: any[] = sessionsRes.sessions ?? [];
          if (i.sessionId !== undefined)
            sessions = sessions.filter((s) => s.sessionId === i.sessionId);
          if (i.sessionId !== undefined && sessions.length !== 1)
            throw new GbcError(
              "not_found",
              "explicit session not returned uniquely by session RPC",
            );
          if (sessions.length > 50)
            throw new GbcError(
              "resource_exhausted",
              "more than 50 sessions; select --session-id",
            );
          const seenSessions = new Set<string>();
          for (const s of sessions) {
            component(s.sessionId);
            if (s.agentId !== i.agentId || seenSessions.has(s.sessionId))
              throw new GbcError(
                "failed_precondition",
                "invalid/duplicate session scope",
              );
            seenSessions.add(s.sessionId);
          }
          const botJson =
            JSON.stringify({
              agent_id: i.agentId,
              raw: jsonSafe(bot),
              untrusted: true,
            }) + "\n";
          if (Buffer.byteLength(botJson) > maxBytes)
            throw new GbcError(
              "resource_exhausted",
              "bot metadata exceeds byte bound",
            );
          a.atomic(`${botDir(i.agentId)}/bot.json`, botJson);
          const summaries: unknown[] = [];
          for (const s of sessions) {
            const sid = s.sessionId as string;
            let g: number | undefined,
              before: string | undefined,
              stop = "page_budget",
              fetched = new Map<string, Entry>();
            const pageMeta: unknown[] = [];
            while (
              pages < maxPages &&
              bytes < maxBytes &&
              Date.now() < deadline
            ) {
              const res = await call("listGrokBotTranscriptEntries", {
                agentId: i.agentId,
                sessionId: sid,
                limit: 100,
                ...(g === undefined ? {} : { generation: g }),
                ...(before === undefined ? {} : { beforeSeq: BigInt(before) }),
              });
              pages++;
              const nextG = generation(res.generation);
              if (g !== undefined && nextG !== g) {
                stop = "generation_changed";
                break;
              }
              g = nextG;
              const responseSize = Buffer.byteLength(
                JSON.stringify(jsonSafe(res)),
              );
              if (bytes + responseSize > maxBytes) {
                stop = "byte_budget";
                break;
              }
              const rows: Entry[] = (res.entries ?? []).map((e: any) =>
                entryRecord(e, i.agentId, sid, g!),
              );
              const size = Buffer.byteLength(
                rows.map((e) => JSON.stringify(e)).join("\n"),
              );
              if (bytes + Math.max(size, responseSize) > maxBytes) {
                stop = "byte_budget";
                break;
              }
              bytes += Math.max(size, responseSize);
              const { entries: _entries, ...meta } = jsonSafe(res);
              pageMeta.push({ before_seq: before ?? null, response: meta });
              if (!rows.length) {
                stop = "empty_page_unverified";
                break;
              }
              let min: bigint | undefined;
              for (const e of rows) {
                const n = BigInt(e.seq);
                min = min === undefined || n < min ? n : min;
              }
              if (
                before !== undefined &&
                (min! >= BigInt(before) ||
                  rows.some((e) => BigInt(e.seq) >= BigInt(before!)))
              ) {
                stop = "cursor_no_progress_or_boundary_overlap";
                break;
              }
              for (const e of rows) merge(fetched, e);
              before = String(min);
              if (min === 0n) {
                stop = "seq_zero_unverified";
                break;
              }
              stop = "page_budget";
            }
            if (Date.now() >= deadline) stop = "time_budget";
            else if (bytes >= maxBytes) stop = "byte_budget";
            if (g === undefined) {
              summaries.push({
                session_id: sid,
                stop_reason: stop,
                published: false,
              });
              continue;
            }
            // Don't activate a generation which changed during the scan.
            if (stop === "generation_changed") {
              a.writeJson(`${sessionDir(i.agentId, sid)}/session.json`, {
                agent_id: i.agentId,
                session_id: sid,
                current_generation: null,
                raw: jsonSafe(s),
                sync_status: "generation_changed; repull required",
                untrusted: true,
              });
              summaries.push({
                session_id: sid,
                stop_reason: stop,
                published: false,
              });
              continue;
            }
            const gd = genDir(i.agentId, sid, g),
              oldText = a.read(`${gd}/entries.jsonl`);
            const out = parseEntries(oldText, i.agentId, sid, g);
            const oldState = a.json(`${gd}/state.json`);
            const recovered =
              oldText !== undefined &&
              oldState?.entries_sha256 !== hash(oldText);
            for (const e of fetched.values()) merge(out, e);
            const text =
              [...out.values()]
                .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
                .map((e) => JSON.stringify(e))
                .join("\n") + (out.size ? "\n" : "");
            if (Buffer.byteLength(text) > 64 * 1024 * 1024)
              throw new GbcError(
                "resource_exhausted",
                "session archive exceeds 64MiB snapshot bound; sharding not implemented",
              );
            const state = {
              generation: g,
              entries_sha256: hash(text),
              entries: out.size,
              fetched_entries: fetched.size,
              observed_at_ms: String(Date.now()),
              completeness: "unknown",
              pagination_live_verified: false,
              stop_reason: stop,
              history_before_seq: before ?? null,
              restart_policy: "always_from_head",
              recovered_data_state_mismatch: recovered,
              pages: pageMeta,
              attachments: "references_only",
              decoder: DECODER,
              decoded_entries: [...out.values()].filter(
                (e) => e.decode_status === "decoded",
              ).length,
              encryption: "per_entry; unknown unless validated plaintext JSON",
              omitted_entries: [...out.values()].filter((e) => e.body_omitted)
                .length,
            };
            if (Buffer.byteLength(JSON.stringify(state)) > 64 * 1024 * 1024)
              throw new GbcError(
                "resource_exhausted",
                "session state exceeds 64MiB bound",
              );
            // Entries are committed before state; checksum detects the inter-file crash window.
            a.atomic(`${gd}/entries.jsonl`, text);
            a.writeJson(`${gd}/state.json`, state);
            a.writeJson(`${sessionDir(i.agentId, sid)}/session.json`, {
              agent_id: i.agentId,
              session_id: sid,
              current_generation: g,
              raw: jsonSafe(s),
              untrusted: true,
            });
            if (
              !m.sessions.some(
                (x: any) => x.agent_id === i.agentId && x.session_id === sid,
              )
            )
              m.sessions.push({ agent_id: i.agentId, session_id: sid });
            if (m.sessions.length > 10000)
              throw new GbcError(
                "resource_exhausted",
                "archive session index bound exceeded",
              );
            a.writeJson("manifest.json", m);
            summaries.push({
              session_id: sid,
              generation: g,
              entries: out.size,
              fetched_entries: fetched.size,
              completeness: "unknown",
              stop_reason: stop,
              recovered,
            });
          }
          return {
            scope: identity,
            pages,
            bytes,
            sessions: summaries,
            note: "Snapshot observations, not a complete mirror. No deletion, decryption, blob_hash body hydration or Watch; attachments are a separate on-demand command; pagination unverified live. Known UI JSON kinds decoded; unknown bodies opaque.",
          };
        } finally {
          release();
        }
      },
      i.dryRun ? "dry_run" : undefined,
    );
  }
  status(i: LocalInput): Promise<ResultEnvelope> {
    return this.result(async () => {
      const a = new Archive(i.dir),
        m = manifest(a);
      const selected = this.selected(m, i);
      return {
        scope: m.scope,
        locked: a.read(".sync/lock") !== undefined,
        sessions: selected.map((x: any) => {
          const local = a.json(
            `${sessionDir(x.agent_id, x.session_id)}/session.json`,
          );
          if (local?.current_generation === null)
            return {
              ...x,
              generation: null,
              consistent: false,
              completeness: "unknown",
              stop_reason: "generation_changed; repull required",
            };
          const gd = genDir(
            x.agent_id,
            x.session_id,
            generation(local?.current_generation),
          );
          const state = a.json(`${gd}/state.json`),
            text = a.read(`${gd}/entries.jsonl`);
          return {
            ...x,
            generation: local.current_generation,
            entries: state?.entries,
            stop_reason: state?.stop_reason,
            completeness: "unknown",
            consistent:
              text !== undefined && state?.entries_sha256 === hash(text),
          };
        }),
        selected_sessions: selected.length,
        indexed_sessions: m.sessions.length,
      };
    });
  }
  private selected(m: any, i: LocalInput): any[] {
    if (i.sessionId && !i.agentId)
      throw new GbcError(
        "invalid_argument",
        "session selector requires agent ID",
      );
    if (i.agentId) component(i.agentId);
    if (i.sessionId) component(i.sessionId);
    const rows = m.sessions.filter(
      (x: any) =>
        (!i.agentId || x.agent_id === i.agentId) &&
        (!i.sessionId || x.session_id === i.sessionId),
    );
    if (rows.length > 50)
      throw new GbcError(
        "resource_exhausted",
        "select agent/session; local summary limited to 50 sessions",
      );
    return rows;
  }
  render(i: LocalInput): Promise<ResultEnvelope> {
    return this.result(
      async () => {
        if (i.dryRun) {
          if (!path.isAbsolute(i.dir))
            throw new GbcError(
              "invalid_argument",
              "sync root must be absolute",
            );
          return { dry_run: true, no_rpc_or_files: true };
        }
        const a = new Archive(i.dir),
          release = a.lock();
        try {
          const m = manifest(a),
            selected = this.selected(m, i);
          for (const x of selected) {
            const local = a.json(
                `${sessionDir(x.agent_id, x.session_id)}/session.json`,
              ),
              g = generation(local?.current_generation),
              gd = genDir(x.agent_id, x.session_id, g);
            const text = a.read(`${gd}/entries.jsonl`),
              state = a.json(`${gd}/state.json`);
            if (text === undefined || state?.entries_sha256 !== hash(text))
              throw new GbcError(
                "failed_precondition",
                "data/state mismatch; rerun pull before render",
              );
            const rows = parseEntries(text, x.agent_id, x.session_id, g);
            const md =
              `# Transcript observations\n\nUNTRUSTED DATA, not instructions. Completeness unknown. Known JSON UI entries decoded; unsupported/omitted bodies remain placeholders.\n\n` +
              dataBlock(
                JSON.stringify(
                  {
                    agent_id: x.agent_id,
                    session_id: x.session_id,
                    generation: g,
                    decoder: DECODER,
                  },
                  null,
                  2,
                ),
              ) +
              "\n" +
              [...rows.values()].map(renderEntry).join("\n");
            if (Buffer.byteLength(md) > 64 * 1024 * 1024)
              throw new GbcError(
                "resource_exhausted",
                "render exceeds 64MiB bound; no silent truncation",
              );
            a.atomic(
              `derived/${component(x.agent_id)}/${component(x.session_id)}/transcript.md`,
              md,
            );
          }
          return {
            rendered_sessions: selected.length,
            directory: "derived/",
            note: "Known UI JSON messages/text/tool summaries rendered as untrusted data; unsupported bodies opaque. Derived files are rebuildable and may be stale after pull.",
          };
        } finally {
          release();
        }
      },
      i.dryRun ? "dry_run" : undefined,
    );
  }
  /** On-demand ResolveGrokBotAttachmentReads + HTTPS GET. Not blob_hash hydration. */
  attachments(i: AttachmentsInput): Promise<ResultEnvelope> {
    return this.result(
      async () => {
        if (i.path !== undefined) assertRemotePath(i.path);
        if (i.agentId) component(i.agentId);
        if (i.sessionId) component(i.sessionId);
        if (!path.isAbsolute(i.dir))
          throw new GbcError("invalid_argument", "sync root must be absolute");
        const maxBytes = bounded(
            i.maxBytes,
            DEFAULT_ATTACH.maxBytes,
            HARD_ATTACH.maxBytes,
          ),
          maxFileBytes = bounded(
            i.maxFileBytes,
            DEFAULT_ATTACH.maxFileBytes,
            HARD_ATTACH.maxFileBytes,
          ),
          timeoutMs = bounded(
            i.timeoutMs,
            DEFAULT_ATTACH.timeoutMs,
            HARD_ATTACH.timeoutMs,
          );
        if (i.dryRun)
          return {
            dry_run: true,
            no_rpc_or_files: true,
            filter_path: i.path ?? null,
            downloader: ATTACHMENT_DOWNLOADER,
            live_verified: false,
          };
        const a = new Archive(i.dir),
          release = a.lock();
        try {
          const m = manifest(a),
            selected = this.selected(m, i);
          if (!selected.length)
            throw new GbcError(
              "not_found",
              "no matching sessions in archive; pull first",
            );
          type Wanted = {
            agent_id: string;
            session_id: string;
            generation: number;
            seq: string;
            remote_path: string;
            file_name?: string;
          };
          const wanted: Wanted[] = [];
          const sessionRows = new Map<
            string,
            { agent: string; session: string; g: number; entries: Map<string, Entry> }
          >();
          for (const x of selected) {
            const local = a.json(
              `${sessionDir(x.agent_id, x.session_id)}/session.json`,
            );
            if (local?.current_generation === null)
              throw new GbcError(
                "failed_precondition",
                "generation changed; repull before attachments",
              );
            const g = generation(local?.current_generation),
              gd = genDir(x.agent_id, x.session_id, g);
            const text = a.read(`${gd}/entries.jsonl`),
              state = a.json(`${gd}/state.json`);
            if (text === undefined || state?.entries_sha256 !== hash(text))
              throw new GbcError(
                "failed_precondition",
                "data/state mismatch; rerun pull before attachments",
              );
            const rows = parseEntries(text, x.agent_id, x.session_id, g);
            sessionRows.set(`${x.agent_id}\0${x.session_id}`, {
              agent: x.agent_id,
              session: x.session_id,
              g,
              entries: rows,
            });
            for (const e of rows.values()) {
              const d = decodeStored(e).decoded;
              if (d?.kind !== "user-attachment" || !d.attachment?.file_path)
                continue;
              const rp = assertRemotePath(d.attachment.file_path);
              if (i.path !== undefined && rp !== i.path) continue;
              wanted.push({
                agent_id: x.agent_id,
                session_id: x.session_id,
                generation: g,
                seq: e.seq,
                remote_path: rp,
                file_name: d.attachment.file_name,
              });
            }
          }

          const verifyExisting = (
            agentId: string,
            rp: string,
          ): AttachmentLocal | undefined => {
            const existingRef = a.json(refRel(agentId, rp));
            if (
              existingRef?.status !== "ok" ||
              typeof existingRef.content_sha256 !== "string" ||
              existingRef.relative_path !==
                objectRel(agentId, existingRef.content_sha256)
            )
              return undefined;
            try {
              const abs = a.file(objectRel(agentId, existingRef.content_sha256));
              const fd = fs.openSync(
                abs,
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
              );
              let bytes: Buffer;
              try {
                const st = fs.fstatSync(fd);
                if (!st.isFile() || st.nlink !== 1 || st.size > maxFileBytes)
                  return undefined;
                bytes = fs.readFileSync(fd);
              } finally {
                fs.closeSync(fd);
              }
              if (sha256Hex(bytes) !== existingRef.content_sha256)
                return undefined;
              return {
                remote_path: rp,
                status: "ok",
                relative_path: existingRef.relative_path,
                content_sha256: existingRef.content_sha256,
                size_bytes: existingRef.size_bytes,
                content_type: existingRef.content_type,
                etag: existingRef.etag,
                reason: "already_present",
                observed_at_ms: String(Date.now()),
                live_verified: false,
              };
            } catch {
              return undefined;
            }
          };
          const byAgent = new Map<string, string[]>();
          const results: AttachmentLocal[] = [];
          const pathResult = new Map<string, AttachmentLocal>();
          for (const w of wanted) {
            const key = `${w.agent_id}\0${w.remote_path}`;
            if (pathResult.has(key)) continue;
            const existing = verifyExisting(w.agent_id, w.remote_path);
            if (existing) {
              pathResult.set(key, existing);
              results.push(existing);
              continue;
            }
            const list = byAgent.get(w.agent_id) ?? [];
            if (!list.includes(w.remote_path)) list.push(w.remote_path);
            byAgent.set(w.agent_id, list);
          }
          const deadline = Date.now() + timeoutMs;
          let spent = 0;
          const call = async (method: string, req: unknown): Promise<any> => {
            const ms = deadline - Date.now();
            if (ms <= 0)
              throw new GbcError(
                "deadline_exceeded",
                "attachment time budget exhausted",
              );
            const ac = new AbortController();
            let timer: NodeJS.Timeout | undefined;
            try {
              return await Promise.race([
                this.client[method](req, { timeoutMs: ms, signal: ac.signal }),
                new Promise((_, reject) => {
                  timer = setTimeout(() => {
                    ac.abort();
                    reject(
                      new GbcError(
                        "deadline_exceeded",
                        "attachment time budget exhausted",
                      ),
                    );
                  }, ms);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          };
          for (const [agentId, paths] of byAgent) {
            for (let iPath = 0; iPath < paths.length; iPath += DEFAULT_ATTACH.resolveBatch) {
              const batch = paths.slice(iPath, iPath + DEFAULT_ATTACH.resolveBatch);
              // Prefer session_id only when filtering a single session (optional in proto).
              const sessionHint =
                i.sessionId && selected.every((s: any) => s.session_id === i.sessionId)
                  ? i.sessionId
                  : undefined;
              let res: any;
              try {
                res = await call("resolveGrokBotAttachmentReads", {
                  agentId,
                  paths: batch,
                  ...(sessionHint ? { sessionId: sessionHint } : {}),
                });
              } catch (e) {
                const red = redactAttachmentError(e);
                for (const rp of batch) {
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: red.status,
                    reason: red.reason,
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  pathResult.set(`${agentId}\0${rp}`, local);
                  results.push(local);
                }
                continue;
              }
              const reads = new Map<string, any>();
              for (const r of res.reads ?? []) reads.set(String(r.path), r);
              for (const rp of batch) {
                const key = `${agentId}\0${rp}`;
                const accepted = acceptStoreRead(
                  rp,
                  reads.get(rp),
                  Date.now(),
                );
                if (!accepted.ok) {
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: accepted.status,
                    reason: accepted.reason,
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  a.writeJson(refRel(agentId, rp), {
                    ...local,
                    downloader: ATTACHMENT_DOWNLOADER,
                  });
                  pathResult.set(key, local);
                  results.push(local);
                  continue;
                }
                const store = accepted.store;
                if (
                  store.size_bytes !== undefined &&
                  store.size_bytes > maxFileBytes
                ) {
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: "error",
                    reason: "size_or_budget",
                    size_bytes: store.size_bytes,
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  a.writeJson(refRel(agentId, rp), {
                    ...local,
                    downloader: ATTACHMENT_DOWNLOADER,
                  });
                  pathResult.set(key, local);
                  results.push(local);
                  continue;
                }
                if (
                  store.size_bytes !== undefined &&
                  spent + store.size_bytes > maxBytes
                ) {
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: "error",
                    reason: "size_or_budget",
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  pathResult.set(key, local);
                  results.push(local);
                  continue;
                }
                const remain = deadline - Date.now();
                if (remain <= 0) {
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: "error",
                    reason: "timeout",
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  pathResult.set(key, local);
                  results.push(local);
                  continue;
                }
                try {
                  const { bytes, content_type } = await downloadHttpsBytes(
                    store.url,
                    {
                      maxBytes: maxFileBytes,
                      expectedSize: store.size_bytes,
                      timeoutMs: remain,
                      fetchImpl: this.fetchImpl,
                    },
                  );
                  if (spent + bytes.byteLength > maxBytes) {
                    const local: AttachmentLocal = {
                      remote_path: rp,
                      status: "error",
                      reason: "size_or_budget",
                      observed_at_ms: String(Date.now()),
                      live_verified: false,
                    };
                    pathResult.set(key, local);
                    results.push(local);
                    continue;
                  }
                  const digest = sha256Hex(bytes);
                  const rel = objectRel(agentId, digest);
                  a.atomicBytes(rel, bytes);
                  spent += bytes.byteLength;
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: "ok",
                    relative_path: rel,
                    content_sha256: digest,
                    size_bytes: bytes.byteLength,
                    content_type: store.content_type ?? content_type,
                    etag: store.etag,
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  a.writeJson(refRel(agentId, rp), {
                    ...local,
                    downloader: ATTACHMENT_DOWNLOADER,
                  });
                  pathResult.set(key, local);
                  results.push(local);
                } catch (e) {
                  const red = redactAttachmentError(e);
                  const local: AttachmentLocal = {
                    remote_path: rp,
                    status: red.status,
                    reason: red.reason,
                    observed_at_ms: String(Date.now()),
                    live_verified: false,
                  };
                  a.writeJson(refRel(agentId, rp), {
                    ...local,
                    downloader: ATTACHMENT_DOWNLOADER,
                  });
                  pathResult.set(key, local);
                  results.push(local);
                }
              }
            }
          }
          // Update entries + state + optional derived markdown references.
          let updatedSessions = 0;
          for (const row of sessionRows.values()) {
            let changed = false;
            for (const e of row.entries.values()) {
              const d = decodeStored(e).decoded;
              if (d?.kind !== "user-attachment" || !d.attachment?.file_path)
                continue;
              const rp = d.attachment.file_path;
              const local = pathResult.get(`${row.agent}\0${rp}`);
              if (!local) continue;
              e.attachment_local = local;
              changed = true;
            }
            if (!changed) continue;
            const gd = genDir(row.agent, row.session, row.g);
            const text =
              [...row.entries.values()]
                .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
                .map((e) => JSON.stringify(e))
                .join("\n") + (row.entries.size ? "\n" : "");
            const prev = a.json(`${gd}/state.json`) ?? {};
            const state = {
              ...prev,
              entries_sha256: hash(text),
              entries: row.entries.size,
              attachments: "on_demand_partial",
              attachment_downloader: ATTACHMENT_DOWNLOADER,
              attachment_live_verified: false,
            };
            a.atomic(`${gd}/entries.jsonl`, text);
            a.writeJson(`${gd}/state.json`, state);
            updatedSessions++;
          }
          // Summaries must never include signed URLs.
          return {
            downloader: ATTACHMENT_DOWNLOADER,
            live_verified: false,
            requested_paths: [...byAgent.values()].reduce((n, p) => n + p.length, 0),
            results: results.map((r) => ({
              remote_path: r.remote_path,
              status: r.status,
              relative_path: r.relative_path,
              content_sha256: r.content_sha256,
              size_bytes: r.size_bytes,
              content_type: r.content_type,
              reason: r.reason,
              observed_at_ms: r.observed_at_ms,
            })),
            updated_sessions: updatedSessions,
            bytes_downloaded: spent,
            note: "On-demand user-attachment download via ResolveGrokBotAttachmentReads; not live verified. Signed URLs never stored. blob_hash body hydration and ReadGrokBotAgentAttachmentChunk not implemented. Chunked RPC remains future work.",
          };
        } finally {
          release();
        }
      },
      i.dryRun ? "dry_run" : undefined,
    );
  }
}
