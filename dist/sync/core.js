import { hydrateEntries, hydrationCoverage } from "./hydrate.js";
import path from "node:path";
import { publicHttpsFetch } from "./download-policy.js";
import fs from "node:fs";
import { decodeStored, decodeBody, DECODER, } from "./decode.js";
import { renderEntry, dataBlock } from "./render.js";
import { GbcError } from "../errors.js";
import { okResult, failResult } from "../dto/result.js";
import { Archive, component, hash, sessionComponent } from "./fs.js";
import { ATTACHMENT_DOWNLOADER, DEFAULT_ATTACH, HARD_ATTACH, acceptStoreRead, assertRemotePath, downloadToStage, objectRel, redactAttachmentError, refRel, } from "./attachments.js";
export const DEFAULTS = {
    maxPages: 100,
    maxBytes: 32 * 1024 * 1024,
    timeoutMs: 30000,
};
export function jsonSafe(value) {
    if (value?.toJson)
        return value.toJson();
    return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint"
        ? String(v)
        : v instanceof Uint8Array
            ? Buffer.from(v).toString("base64")
            : v));
}
function uint(v) {
    if ((typeof v !== "bigint" && typeof v !== "string" && typeof v !== "number") ||
        (typeof v === "number" && !Number.isSafeInteger(v)) ||
        !/^\d+$/.test(String(v)))
        throw new GbcError("invalid_argument", "invalid/unsafe uint64 in transcript");
    const n = BigInt(v);
    if (n > 18446744073709551615n)
        throw new GbcError("invalid_argument", "uint64 out of range");
    return String(n);
}
function generation(v) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff)
        throw new GbcError("invalid_argument", "invalid generation");
    return v;
}
function bounded(v, def, max) {
    const n = v ?? def;
    if (!Number.isInteger(n) || n < 1 || n > max)
        throw new GbcError("invalid_argument", `sync bound must be 1..${max}`);
    return n;
}
function scope(backend, i) {
    if (!i.acknowledgeUnverifiedScope || !i.accountId || !i.teamId)
        throw new GbcError("denied", "sync requires explicit stable account-id, team-id (use none if no team), and acknowledgement of unverified identity; auth API has no verified stable account ID");
    component(i.accountId);
    component(i.teamId);
    if (i.accountId.includes("@"))
        throw new GbcError("invalid_argument", "account-id must be a stable provider ID, not an email address");
    const u = new URL(backend);
    if (u.username || u.password || u.search || u.hash)
        throw new GbcError("invalid_argument", "backend must not contain credentials/query/fragment");
    return {
        backend: backend.replace(/\/$/, ""),
        account_id: i.accountId,
        team_id: i.teamId,
        assurance: "operator_asserted_unverified",
    };
}
/** Canonical manifest binding; never a token/email-derived identity claim. */
function scopeKey(s) {
    if (!s ||
        ![s.backend, s.account_id, s.team_id].every((v) => typeof v === "string" && v.length > 0) ||
        s.assurance !== "operator_asserted_unverified")
        throw new GbcError("failed_precondition", "archive has invalid scope metadata");
    return hash(JSON.stringify([s.backend, s.account_id, s.team_id, s.assurance]));
}
function botDir(id) {
    return `bots/${component(id)}`;
}
function sessionDir(a, s) {
    return `${botDir(a)}/sessions/${sessionComponent(s)}`;
}
function genDir(a, s, g) {
    return `${sessionDir(a, s)}/generations/${generation(g)}`;
}
function manifest(a, expected, create = false) {
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
        throw new GbcError("resource_exhausted", "archive session index bound exceeded");
    for (const x of m.sessions) {
        component(x.agent_id);
        sessionComponent(x.session_id);
    }
    if (expected &&
        ["backend", "account_id", "team_id", "assurance"].some((k) => m.scope?.[k] !== expected[k]))
        throw new GbcError("denied", "archive scope mismatch (backend/account/team); choose a separate root");
    return m;
}
export function entryRecord(e, agent, session, g, archiveScope) {
    const body = e.body;
    if (body != null && !(body instanceof Uint8Array))
        throw new GbcError("invalid_argument", "expected protobuf bytes, not guessed UTF-8");
    return {
        archive_scope_sha256: archiveScope,
        agent_id: agent,
        session_id: session,
        generation: g,
        seq: uint(e.seq),
        updated_seq: uint(e.updatedSeq),
        entry_id: e.entryId || undefined,
        entry_kind: String(e.entryKind ?? ""),
        body_base64: body == null ? undefined : Buffer.from(body).toString("base64"),
        body_omitted: Boolean(e.bodyOmitted),
        blob_hash: e.blobHash || undefined,
        raw: jsonSafe(e),
        wire_base64: e.toBinary
            ? Buffer.from(e.toBinary()).toString("base64")
            : undefined,
        untrusted: true,
        ...decodeBody(body, body == null && Boolean(e.bodyOmitted), String(e.entryKind ?? "")),
        ...(body != null ? { body_source: "observed_inline" } : {}),
    };
}
function parseEntries(text, agent, session, g, archiveScope) {
    const out = new Map();
    for (const line of (text ?? "").split("\n")) {
        if (!line)
            continue;
        const e = {
            ...JSON.parse(line),
            archive_scope_sha256: archiveScope,
        };
        if (e.agent_id !== agent ||
            e.session_id !== session ||
            e.generation !== g ||
            uint(e.seq) !== e.seq ||
            uint(e.updated_seq) !== e.updated_seq ||
            out.has(e.seq))
            throw new GbcError("failed_precondition", "corrupt or wrong-scope local entries");
        const { decoded: _decoded, decode_status: _status, decode_reason: _reason, encryption_status: _encryption, body_source: _bodySource, ...original } = e;
        out.set(e.seq, { ...original, ...decodeStored(e) });
    }
    return out;
}
function merge(out, e) {
    const old = out.get(e.seq);
    if (!old || BigInt(e.updated_seq) > BigInt(old.updated_seq)) {
        if (old && (e.body_omitted || e.body_base64 === undefined)) {
            // An omitted newer observation must not erase a previously available body.
            e.last_available_body =
                old.body_base64 !== undefined && !old.body_omitted
                    ? { updated_seq: old.updated_seq, body_base64: old.body_base64 }
                    : old.last_available_body;
        }
        if (old?.attachment_local) {
            const a = decodeStored(old).decoded?.attachment?.file_path, b = decodeStored(e).decoded?.attachment?.file_path;
            if (a !== undefined && a === b)
                e.attachment_local = old.attachment_local;
        }
        out.set(e.seq, e);
    }
    else if (e.updated_seq === old.updated_seq &&
        old.body_base64 === undefined &&
        e.body_base64 !== undefined)
        out.set(e.seq, e);
    // Missing/older entries never delete or overwrite newer local versions.
}
function fail(e) {
    // Never echo arbitrary RPC/error text (may contain signed URLs or secrets).
    const rpcCode = e?.code;
    const rpcCodes = {
        1: "canceled",
        3: "invalid_argument",
        4: "deadline_exceeded",
        5: "not_found",
        7: "permission_denied",
        8: "resource_exhausted",
        14: "unavailable",
        16: "unauthenticated",
    };
    if (!(e instanceof GbcError) &&
        typeof rpcCode === "number" &&
        rpcCodes[rpcCode])
        return failResult(rpcCodes[rpcCode], "sync read RPC failed; original error text suppressed to avoid leaking credentials/URLs", { retryable: rpcCode === 14 || rpcCode === 8 });
    const known = e instanceof GbcError;
    return failResult(known ? e.code : "sync_failed", known
        ? e.message
        : "sync/local IO failed; archive preserved; rerun from history head after resolving cause", { retryable: false, details: known ? e.details : undefined });
}
/** Shared CLI/MCP core. Normal read RPCs only, including opt-in store presign. No Watch or server writes. */
export class SyncOps {
    client;
    backend;
    simulated;
    fetchImpl;
    constructor(client, backend, simulated = false, fetchImpl = publicHttpsFetch) {
        this.client = client;
        this.backend = backend;
        this.simulated = simulated;
        this.fetchImpl = fetchImpl;
    }
    async result(fn, code) {
        try {
            const data = await fn();
            const result = okResult(data, { simulated: this.simulated, code });
            if (data?.partial === true)
                return {
                    ...result,
                    ok: false,
                    outcome: "known_failure",
                    code: "partial",
                    error: {
                        message: "Archive retained, but requested body hydration is partial; inspect per-entry hydration reasons.",
                    },
                };
            return result;
        }
        catch (e) {
            return { ...fail(e), simulated: this.simulated };
        }
    }
    pull(i) {
        return this.result(async () => {
            const identity = scope(this.backend, i);
            component(i.agentId);
            if (i.sessionId !== undefined)
                component(i.sessionId);
            if (!path.isAbsolute(i.dir))
                throw new GbcError("invalid_argument", "sync root must be absolute");
            const maxPages = bounded(i.maxPages, DEFAULTS.maxPages, 1000), maxBytes = bounded(i.maxBytes, DEFAULTS.maxBytes, 256 * 1024 * 1024), timeoutMs = bounded(i.timeoutMs, DEFAULTS.timeoutMs, 300000);
            const hydrate = i.hydrate ?? "off";
            if (hydrate !== "off" && hydrate !== "missing")
                throw new GbcError("invalid_argument", "hydrate must be off or missing");
            const maxHydrateRequests = bounded(i.maxHydrateRequests, 32, 256), hydrateMaxBytes = bounded(i.hydrateMaxBytes, 8 * 1024 * 1024, 64 * 1024 * 1024), hydrateMaxBodyBytes = bounded(i.hydrateMaxBodyBytes, 4 * 1024 * 1024, 4 * 1024 * 1024);
            if (i.dryRun)
                return {
                    dry_run: true,
                    scope: identity,
                    would_pull_agent: i.agentId,
                    session_id: i.sessionId ?? null,
                    no_rpc_or_files: true,
                    hydrate,
                };
            const a = new Archive(i.dir, true), release = a.lock();
            try {
                const m = manifest(a, identity, true);
                const deadline = Date.now() + timeoutMs;
                let pages = 0, bytes = 0;
                let apiRequests = 0;
                const call = async (method, req) => {
                    const ms = deadline - Date.now();
                    if (ms <= 0)
                        throw new GbcError("deadline_exceeded", "sync time budget exhausted; rerun from head");
                    const ac = new AbortController();
                    let timer;
                    try {
                        apiRequests++;
                        return await Promise.race([
                            this.client[method](req, { timeoutMs: ms, signal: ac.signal }),
                            new Promise((_, reject) => {
                                timer = setTimeout(() => {
                                    ac.abort();
                                    reject(new GbcError("deadline_exceeded", "sync time budget exhausted; rerun from head"));
                                }, ms);
                            }),
                        ]);
                    }
                    finally {
                        clearTimeout(timer);
                    }
                };
                let hydrateRequests = 0, hydrateSpent = 0, partial = false;
                const botRes = await call("listGrokBotAgents", {});
                const bot = (botRes.agents ?? []).find((b) => b.agentId === i.agentId || b.id === i.agentId);
                if (!bot)
                    throw new GbcError(botRes.truncated ? "lookup_incomplete" : "not_found", botRes.truncated
                        ? "agent list truncated; absence cannot establish nonexistence"
                        : "agent not returned by list RPC");
                const sessionsRes = await call("listGrokBotAgentSessions", {
                    agentId: i.agentId,
                });
                let sessions = sessionsRes.sessions ?? [];
                if (i.sessionId !== undefined)
                    sessions = sessions.filter((s) => s.sessionId === i.sessionId);
                if (i.sessionId !== undefined && sessions.length !== 1)
                    throw new GbcError("not_found", "explicit session not returned uniquely by session RPC");
                // The default conversation has empty session_id and is not returned by
                // ListGrokBotAgentSessions (live 2026-11-07); include it for agent-wide pulls.
                if (i.sessionId === undefined &&
                    !sessions.some((s) => s.sessionId === ""))
                    sessions.push({
                        agentId: i.agentId,
                        sessionId: "",
                        default_unlisted: true,
                    });
                if (sessions.length > 50)
                    throw new GbcError("resource_exhausted", "more than 50 sessions; select --session-id");
                const seenSessions = new Set();
                for (const s of sessions) {
                    sessionComponent(s.sessionId);
                    if (s.agentId !== i.agentId || seenSessions.has(s.sessionId))
                        throw new GbcError("failed_precondition", "invalid/duplicate session scope");
                    seenSessions.add(s.sessionId);
                }
                const botJson = JSON.stringify({
                    agent_id: i.agentId,
                    raw: jsonSafe(bot),
                    untrusted: true,
                }) + "\n";
                if (Buffer.byteLength(botJson) > maxBytes)
                    throw new GbcError("resource_exhausted", "bot metadata exceeds byte bound");
                a.atomic(`${botDir(i.agentId)}/bot.json`, botJson);
                const summaries = [];
                sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
                const rotation = Number.isInteger(m.next_session_index)
                    ? m.next_session_index % Math.max(1, sessions.length)
                    : 0;
                sessions = [
                    ...sessions.slice(rotation),
                    ...sessions.slice(0, rotation),
                ];
                const pageSize = bounded(i.pageSize, 100, 500);
                for (const [sessionIndex, s] of sessions.entries()) {
                    const sid = s.sessionId;
                    if (pages >= maxPages ||
                        bytes >= maxBytes ||
                        Date.now() >= deadline) {
                        summaries.push({
                            session_id: sid,
                            published: false,
                            pages: 0,
                            bytes: 0,
                            stop_reason: "command_budget_before_session",
                        });
                        continue;
                    }
                    const priorSession = a.json(`${sessionDir(i.agentId, sid)}/session.json`);
                    const priorG = priorSession?.current_generation;
                    let previous, priorText;
                    if (Number.isInteger(priorG)) {
                        const pg = genDir(i.agentId, sid, priorG);
                        previous = a.json(`${pg}/state.json`);
                        priorText = a.read(`${pg}/entries.jsonl`);
                        if (priorText === undefined ||
                            previous?.entries_sha256 !== hash(priorText))
                            previous = undefined;
                    }
                    const startPages = pages, startBytes = bytes;
                    // Budget-one calls alternate HEAD refresh and continuation BACKFILL.
                    const resumeOnly = previous?.next_phase === "backfill" &&
                        previous?.backfill_before_seq != null;
                    let backfillCursor = previous?.backfill_before_seq ?? undefined;
                    let reachedOldest = previous?.backfill_end_observed === true;
                    let isHead = !resumeOnly, headObserved = false, pageAccepted = false;
                    let g = resumeOnly ? priorG : undefined, before = resumeOnly
                        ? backfillCursor
                        : undefined, stop = "page_budget", fetched = new Map();
                    const pageMeta = [];
                    while (pages < maxPages &&
                        bytes < maxBytes &&
                        Date.now() < deadline) {
                        const res = await call("listGrokBotTranscriptEntries", {
                            agentId: i.agentId,
                            sessionId: sid,
                            limit: pageSize,
                            ...(g === undefined || g === 0 ? {} : { generation: g }),
                            ...(before === undefined ? {} : { beforeSeq: BigInt(before) }),
                        });
                        pages++;
                        const nextG = generation(res.generation);
                        if (g !== undefined && nextG !== g) {
                            stop = "generation_changed";
                            break;
                        }
                        g = nextG;
                        if (isHead && priorG !== g) {
                            backfillCursor = undefined;
                            reachedOldest = false;
                        }
                        const responseSize = Buffer.byteLength(JSON.stringify(jsonSafe(res)));
                        if (bytes + responseSize > maxBytes) {
                            stop = "byte_budget";
                            break;
                        }
                        const rows = (res.entries ?? []).map((e) => entryRecord(e, i.agentId, sid, g, scopeKey(m.scope)));
                        const size = Buffer.byteLength(rows.map((e) => JSON.stringify(e)).join("\n"));
                        if (bytes + Math.max(size, responseSize) > maxBytes) {
                            stop = "byte_budget";
                            break;
                        }
                        bytes += Math.max(size, responseSize);
                        const { entries: _entries, ...meta } = jsonSafe(res);
                        pageMeta.push({ before_seq: before ?? null, response: meta });
                        if (!rows.length) {
                            pageAccepted = true;
                            if (isHead)
                                headObserved = true;
                            if (!isHead || backfillCursor === undefined)
                                reachedOldest = true;
                            stop = "empty_page_unverified";
                            break;
                        }
                        let min;
                        for (const e of rows) {
                            const n = BigInt(e.seq);
                            min = min === undefined || n < min ? n : min;
                        }
                        if (before !== undefined &&
                            (min >= BigInt(before) ||
                                rows.some((e) => BigInt(e.seq) >= BigInt(before)))) {
                            stop = "cursor_no_progress_or_boundary_overlap";
                            break;
                        }
                        pageAccepted = true;
                        if (isHead)
                            headObserved = true;
                        for (const e of rows)
                            merge(fetched, e);
                        if (isHead) {
                            if (backfillCursor === undefined ||
                                BigInt(backfillCursor) > min)
                                backfillCursor = String(min);
                            before = backfillCursor;
                            isHead = false;
                            if (reachedOldest) {
                                stop = "head_refreshed_history_previously_observed";
                                break;
                            }
                        }
                        else {
                            before = String(min);
                            backfillCursor = before;
                        }
                        if (min === 0n) {
                            stop = "seq_zero_unverified";
                            break;
                        }
                        stop = "page_budget";
                    }
                    if (Date.now() >= deadline)
                        stop = "time_budget";
                    else if (bytes >= maxBytes)
                        stop = "byte_budget";
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
                        if (hydrate === "missing")
                            partial = true;
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
                    const gd = genDir(i.agentId, sid, g), oldText = a.read(`${gd}/entries.jsonl`);
                    const out = parseEntries(oldText, i.agentId, sid, g, scopeKey(m.scope));
                    const oldState = a.json(`${gd}/state.json`);
                    const recovered = oldText !== undefined &&
                        oldState?.entries_sha256 !== hash(oldText);
                    for (const e of fetched.values())
                        merge(out, e);
                    let hydration;
                    if (hydrate === "missing") {
                        const budget = {
                            bytes: 0,
                            maxBytes: Math.max(0, Math.min(maxBytes - bytes, hydrateMaxBytes - hydrateSpent)),
                            deadline,
                        };
                        hydration = await hydrateEntries([...out.values()], {
                            archive: a,
                            fetchImpl: this.fetchImpl,
                            call,
                            maxRequests: Math.max(0, maxHydrateRequests - hydrateRequests),
                            maxBodyBytes: hydrateMaxBodyBytes,
                            budget,
                            prioritySeqs: new Set(fetched.keys()),
                        });
                        hydrateRequests += hydration.requests;
                        hydrateSpent += budget.bytes;
                        bytes += budget.bytes;
                        // Decoder unsupported is counted separately and does NOT force exit 9.
                        if (hydration.failed > 0)
                            partial = true;
                        if (hydration.generation_changed) {
                            partial = true;
                            a.writeJson(`${sessionDir(i.agentId, sid)}/session.json`, {
                                agent_id: i.agentId,
                                session_id: sid,
                                current_generation: null,
                                sync_status: "generation_changed_during_body_read; repull required",
                                raw: jsonSafe(s),
                                untrusted: true,
                            });
                            summaries.push({
                                session_id: sid,
                                published: false,
                                stop_reason: "generation_changed_during_body_read",
                                hydration,
                            });
                            continue;
                        }
                    }
                    const readObject = (rel) => {
                        try {
                            const fd = fs.openSync(a.file(rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                            try {
                                const st = fs.fstatSync(fd);
                                if (st.nlink !== 1)
                                    return;
                                return fs.readFileSync(fd);
                            }
                            finally {
                                fs.closeSync(fd);
                            }
                        }
                        catch {
                            return;
                        }
                    };
                    const bodyCoverage = hydrationCoverage([...out.values()], readObject);
                    const text = [...out.values()]
                        .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
                        .map((e) => JSON.stringify(e))
                        .join("\n") + (out.size ? "\n" : "");
                    if (Buffer.byteLength(text) > 64 * 1024 * 1024)
                        throw new GbcError("resource_exhausted", "session archive exceeds 64MiB snapshot bound; sharding not implemented");
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
                        restart_policy: "alternating_head_and_backfill",
                        view: "retained_observations_not_current_mirror",
                        current_membership: "unknown; deletes not consumed",
                        head_refreshed_at_ms: headObserved
                            ? String(Date.now())
                            : (previous?.head_refreshed_at_ms ?? null),
                        backfill_before_seq: backfillCursor ?? null,
                        backfill_end_observed: reachedOldest,
                        next_phase: !pageAccepted
                            ? (previous?.next_phase ?? "head")
                            : reachedOldest
                                ? "head"
                                : resumeOnly
                                    ? "head"
                                    : "backfill",
                        session_pages: pages - startPages,
                        session_bytes: bytes - startBytes,
                        recovered_data_state_mismatch: recovered,
                        pages: pageMeta,
                        attachments: "references_only",
                        body_hydration_format: 1,
                        hydration_policy: hydrate,
                        body_coverage: bodyCoverage,
                        hydration,
                        body_partial: !!hydration &&
                            (hydration.failed > 0 || hydration.generation_changed),
                        decoder: DECODER,
                        decoded_entries: [...out.values()].filter((e) => e.decode_status === "decoded").length,
                        encryption: "per_entry; unknown unless validated plaintext JSON",
                        omitted_entries: [...out.values()].filter((e) => e.body_omitted)
                            .length,
                    };
                    if (Buffer.byteLength(JSON.stringify(state)) > 64 * 1024 * 1024)
                        throw new GbcError("resource_exhausted", "session state exceeds 64MiB bound");
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
                    if (!m.sessions.some((x) => x.agent_id === i.agentId && x.session_id === sid))
                        m.sessions.push({ agent_id: i.agentId, session_id: sid });
                    if (m.sessions.length > 10000)
                        throw new GbcError("resource_exhausted", "archive session index bound exceeded");
                    m.next_session_index =
                        (rotation + sessionIndex + 1) % Math.max(1, sessions.length);
                    a.writeJson("manifest.json", m);
                    summaries.push({
                        session_id: sid,
                        generation: g,
                        entries: out.size,
                        fetched_entries: fetched.size,
                        completeness: "unknown",
                        phase: resumeOnly ? "backfill" : "head_and_backfill",
                        backfill_before_seq: backfillCursor ?? null,
                        backfill_end_observed: reachedOldest,
                        pages: pages - startPages,
                        bytes: bytes - startBytes,
                        stop_reason: stop,
                        recovered,
                        body_coverage: bodyCoverage,
                        hydration,
                    });
                }
                return {
                    scope: identity,
                    pages,
                    bytes,
                    partial,
                    hydration_policy: hydrate,
                    hydrate_requests: hydrateRequests,
                    api_requests: apiRequests,
                    hydrate_bytes: hydrateSpent,
                    sessions: summaries,
                    note: "Retained observations, not a current or complete mirror. Body hydration is opt-in and version-bound; line coverage and body coverage are independent. No deletion, decryption or Watch. Attachments are separate. Pagination completeness remains unknown.",
                };
            }
            finally {
                release();
            }
        }, i.dryRun ? "dry_run" : undefined);
    }
    status(i) {
        return this.result(async () => {
            const a = new Archive(i.dir), m = manifest(a);
            const selected = this.selected(m, i);
            return {
                scope: m.scope,
                locked: a.read(".sync/lock") !== undefined,
                sessions: selected.map((x) => {
                    const local = a.json(`${sessionDir(x.agent_id, x.session_id)}/session.json`);
                    if (local?.current_generation === null)
                        return {
                            ...x,
                            generation: null,
                            consistent: false,
                            completeness: "unknown",
                            stop_reason: "generation_changed; repull required",
                        };
                    const gd = genDir(x.agent_id, x.session_id, generation(local?.current_generation));
                    const state = a.json(`${gd}/state.json`), text = a.read(`${gd}/entries.jsonl`);
                    return {
                        ...x,
                        generation: local.current_generation,
                        entries: state?.entries,
                        body_coverage: text !== undefined
                            ? hydrationCoverage([
                                ...parseEntries(text, x.agent_id, x.session_id, generation(local.current_generation), scopeKey(m.scope)).values(),
                            ], (rel) => {
                                try {
                                    const fd = fs.openSync(a.file(rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                                    try {
                                        if (fs.fstatSync(fd).nlink !== 1)
                                            return;
                                        return fs.readFileSync(fd);
                                    }
                                    finally {
                                        fs.closeSync(fd);
                                    }
                                }
                                catch {
                                    return;
                                }
                            })
                            : null,
                        body_hydration_format: state?.body_hydration_format ?? null,
                        body_partial: state?.body_partial ?? null,
                        stop_reason: state?.stop_reason,
                        completeness: "unknown",
                        consistent: text !== undefined && state?.entries_sha256 === hash(text),
                    };
                }),
                selected_sessions: selected.length,
                indexed_sessions: m.sessions.length,
            };
        });
    }
    selected(m, i) {
        if (i.sessionId && !i.agentId)
            throw new GbcError("invalid_argument", "session selector requires agent ID");
        if (i.agentId)
            component(i.agentId);
        if (i.sessionId)
            component(i.sessionId);
        const rows = m.sessions.filter((x) => (!i.agentId || x.agent_id === i.agentId) &&
            (!i.sessionId || x.session_id === i.sessionId));
        if (rows.length > 50)
            throw new GbcError("resource_exhausted", "select agent/session; local summary limited to 50 sessions");
        return rows;
    }
    render(i) {
        return this.result(async () => {
            if (i.dryRun) {
                if (!path.isAbsolute(i.dir))
                    throw new GbcError("invalid_argument", "sync root must be absolute");
                return { dry_run: true, no_rpc_or_files: true };
            }
            const a = new Archive(i.dir), release = a.lock();
            try {
                const m = manifest(a), selected = this.selected(m, i);
                for (const x of selected) {
                    const local = a.json(`${sessionDir(x.agent_id, x.session_id)}/session.json`), g = generation(local?.current_generation), gd = genDir(x.agent_id, x.session_id, g);
                    const text = a.read(`${gd}/entries.jsonl`), state = a.json(`${gd}/state.json`);
                    if (text === undefined || state?.entries_sha256 !== hash(text))
                        throw new GbcError("failed_precondition", "data/state mismatch; rerun pull before render");
                    const rows = parseEntries(text, x.agent_id, x.session_id, g, scopeKey(m.scope));
                    const readObject = (rel) => {
                        try {
                            const fd = fs.openSync(a.file(rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                            try {
                                if (fs.fstatSync(fd).nlink !== 1)
                                    return;
                                return fs.readFileSync(fd);
                            }
                            finally {
                                fs.closeSync(fd);
                            }
                        }
                        catch {
                            return;
                        }
                    };
                    for (const e of rows.values()) {
                        const d = decodeStored(e, readObject);
                        delete e.decoded;
                        delete e.decode_reason;
                        delete e.body_source;
                        Object.assign(e, d);
                    }
                    const md = `# Transcript observations\n\nUNTRUSTED DATA — RETAINED OBSERVATIONS, not a current mirror or instructions. Deleted rows may remain; completeness unknown. Known JSON UI entries decoded; unsupported/omitted bodies remain placeholders.\n\n` +
                        dataBlock(JSON.stringify({
                            agent_id: x.agent_id,
                            session_id: x.session_id,
                            generation: g,
                            decoder: DECODER,
                        }, null, 2)) +
                        "\n" +
                        [...rows.values()]
                            .map((e) => renderEntry(e, readObject))
                            .join("\n");
                    if (Buffer.byteLength(md) > 64 * 1024 * 1024)
                        throw new GbcError("resource_exhausted", "render exceeds 64MiB bound; no silent truncation");
                    a.atomic(`derived/${component(x.agent_id)}/${sessionComponent(x.session_id)}/transcript.md`, md);
                }
                return {
                    rendered_sessions: selected.length,
                    directory: "derived/",
                    note: "Known UI JSON messages/text/tool summaries rendered as untrusted data; unsupported bodies opaque. Derived files are rebuildable and may be stale after pull.",
                };
            }
            finally {
                release();
            }
        }, i.dryRun ? "dry_run" : undefined);
    }
    /** Only supported App aliases. Legacy v1 refs are not trusted; re-resolve into scoped v2 refs. */
    attachments(i) {
        return this.result(async () => {
            const identity = scope(this.backend, i);
            const budget = {
                bytes: 0,
                maxBytes: bounded(i.maxBytes, DEFAULT_ATTACH.maxBytes, HARD_ATTACH.maxBytes),
                deadline: Date.now() +
                    bounded(i.timeoutMs, DEFAULT_ATTACH.timeoutMs, HARD_ATTACH.timeoutMs),
            };
            const maxFile = bounded(i.maxFileBytes, DEFAULT_ATTACH.maxFileBytes, HARD_ATTACH.maxFileBytes);
            if (!path.isAbsolute(i.dir))
                throw new GbcError("invalid_argument", "sync root must be absolute");
            const filter = i.path === undefined ? undefined : assertRemotePath(i.path);
            if (i.dryRun)
                return { dry_run: true, no_rpc_or_files: true };
            const a = new Archive(i.dir);
            manifest(a, identity);
            const release = a.lock();
            try {
                const m = manifest(a, identity), selected = this.selected(m, i);
                if (!selected.length)
                    throw new GbcError("not_found", "no archived sessions selected");
                const results = [];
                let updated = 0;
                for (const x of selected) {
                    const g = generation(a.json(`${sessionDir(x.agent_id, x.session_id)}/session.json`)
                        ?.current_generation);
                    const gd = genDir(x.agent_id, x.session_id, g), state = a.json(`${gd}/state.json`), old = a.read(`${gd}/entries.jsonl`);
                    if (old === undefined || state?.entries_sha256 !== hash(old))
                        throw new GbcError("failed_precondition", "data/state mismatch; repull first");
                    const rows = parseEntries(old, x.agent_id, x.session_id, g, scopeKey(m.scope));
                    const refs = new Map();
                    for (const e of rows.values()) {
                        const d = decodeStored(e).decoded;
                        if (!d?.attachment)
                            continue;
                        let rp;
                        try {
                            rp = assertRemotePath(d.attachment.file_path);
                        }
                        catch {
                            results.push({
                                agent_id: x.agent_id,
                                session_id: x.session_id,
                                seq: e.seq,
                                status: "unsupported",
                                reason: "unsupported_attachment_reference",
                            });
                            continue;
                        }
                        if (filter !== undefined && rp !== filter)
                            continue;
                        refs.set(rp, [...(refs.get(rp) ?? []), e]);
                    }
                    for (const [rp, entries] of refs) {
                        const rr = refRel(x.agent_id, rp, x.session_id);
                        let previous = a.json(rr), checked;
                        if (previous?.status === "ok" &&
                            /^[a-f0-9]{64}$/.test(previous.content_sha256 ?? "") &&
                            previous.relative_path ===
                                objectRel(x.agent_id, previous.content_sha256)) {
                            try {
                                const fd = fs.openSync(a.file(previous.relative_path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                                try {
                                    const st = fs.fstatSync(fd);
                                    if (st.size <= maxFile && st.nlink === 1) {
                                        const h = (await import("node:crypto")).createHash("sha256"), buf = Buffer.alloc(65536);
                                        let n;
                                        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                                            if (Date.now() >= budget.deadline)
                                                throw new Error();
                                            h.update(buf.subarray(0, n));
                                        }
                                        if (h.digest("hex") === previous.content_sha256 &&
                                            st.size === previous.size_bytes)
                                            checked = previous;
                                    }
                                }
                                finally {
                                    fs.closeSync(fd);
                                }
                            }
                            catch {
                                checked = undefined;
                            }
                        }
                        let local;
                        try {
                            let complete = false;
                            for (let attempt = 0; attempt < 2; attempt++) {
                                const ms = budget.deadline - Date.now();
                                if (ms <= 0)
                                    throw new GbcError("deadline_exceeded", "attachment deadline");
                                const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
                                let res;
                                try {
                                    res = await Promise.race([
                                        this.client.resolveGrokBotAttachmentReads({
                                            agentId: x.agent_id,
                                            paths: [rp],
                                            ...(x.session_id ? { sessionId: x.session_id } : {}),
                                        }, { signal: ac.signal, timeoutMs: ms }),
                                        new Promise((_, reject) => ac.signal.addEventListener("abort", () => reject(new GbcError("deadline_exceeded", "attachment deadline")), { once: true })),
                                    ]);
                                }
                                finally {
                                    clearTimeout(timer);
                                }
                                if (!Array.isArray(res.reads) ||
                                    res.reads.length !== 1 ||
                                    res.reads[0].path !== rp)
                                    throw new GbcError("failed_precondition", "conflicting attachment resolution");
                                const accepted = acceptStoreRead(rp, res.reads[0], Date.now());
                                if (!accepted.ok) {
                                    local = {
                                        remote_path: rp,
                                        status: accepted.status,
                                        reason: accepted.reason,
                                        observed_at_ms: String(Date.now()),
                                        live_verified: false,
                                    };
                                    complete = true;
                                    break;
                                }
                                const store = accepted.store;
                                const sink = a.stage();
                                try {
                                    const transfer = await downloadToStage(store.url, {
                                        maxBytes: maxFile,
                                        expectedSize: store.size_bytes,
                                        budget,
                                        fetchImpl: this.fetchImpl,
                                        etag: checked?.etag,
                                        sink,
                                    });
                                    if (transfer.status === 403) {
                                        if (attempt === 0)
                                            continue;
                                        throw new GbcError("permission_denied", "attachment URL rejected after refresh");
                                    }
                                    if (transfer.status === 304) {
                                        if (!checked ||
                                            checked.etag !== store.etag ||
                                            checked.size_bytes !== store.size_bytes)
                                            throw new GbcError("failed_precondition", "304 metadata mismatch");
                                        local = {
                                            ...checked,
                                            reason: "not_modified",
                                            observed_at_ms: String(Date.now()),
                                            live_verified: false,
                                        };
                                    }
                                    else {
                                        const rel = objectRel(x.agent_id, transfer.digest);
                                        sink.commit(rel);
                                        local = {
                                            remote_path: rp,
                                            status: "ok",
                                            relative_path: rel,
                                            content_sha256: transfer.digest,
                                            size_bytes: transfer.size,
                                            etag: store.etag,
                                            content_type: store.content_type,
                                            observed_at_ms: String(Date.now()),
                                            live_verified: false,
                                        };
                                    }
                                    complete = true;
                                    break;
                                }
                                finally {
                                    sink.discard();
                                }
                            }
                            if (!complete)
                                throw new GbcError("unavailable", "attachment transfer incomplete");
                        }
                        catch (e) {
                            const red = redactAttachmentError(e);
                            local = {
                                remote_path: rp,
                                ...red,
                                observed_at_ms: String(Date.now()),
                                live_verified: false,
                            };
                        }
                        // Preserve old content address as historical, never claim it is the new current ref.
                        const historical = previous?.status === "ok" &&
                            previous.content_sha256 !== local.content_sha256
                            ? {
                                content_sha256: previous.content_sha256,
                                relative_path: previous.relative_path,
                            }
                            : previous?.historical;
                        a.writeJson(rr, {
                            ...local,
                            historical,
                            scope: identity,
                            agent_id: x.agent_id,
                            session_id: x.session_id,
                            downloader: ATTACHMENT_DOWNLOADER,
                        });
                        for (const e of entries)
                            e.attachment_local = local;
                        results.push({
                            agent_id: x.agent_id,
                            session_id: x.session_id,
                            ...local,
                            etag: undefined,
                        });
                    }
                    const text = [...rows.values()]
                        .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
                        .map((e) => JSON.stringify(e))
                        .join("\n") + (rows.size ? "\n" : "");
                    if (Buffer.byteLength(text) > 64 * 1024 * 1024)
                        throw new GbcError("resource_exhausted", "attachment archive exceeds 64MiB");
                    a.atomic(`${gd}/entries.jsonl`, text);
                    a.writeJson(`${gd}/state.json`, {
                        ...state,
                        entries_sha256: hash(text),
                        attachments: "on_demand_partial",
                        view: "retained_observations_not_current_mirror",
                    });
                    updated++;
                }
                const good = results.filter((r) => r.status === "ok").length, bad = results.length - good;
                if (bad)
                    throw new GbcError(good ? "partial" : "attachments_failed", "attachment results contain failures/unsupported references", {
                        details: {
                            results,
                            bytes_consumed: budget.bytes,
                            updated_sessions: updated,
                        },
                    });
                return {
                    results,
                    requested_paths: results.length,
                    bytes_consumed: budget.bytes,
                    updated_sessions: updated,
                    live_verified: false,
                };
            }
            finally {
                release();
            }
        }, i.dryRun ? "dry_run" : undefined);
    }
}
