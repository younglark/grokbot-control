import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult } from "../dto/result.js";
import { GbcError } from "../errors.js";
import { SEND_STATUS_NAMES, enumView } from "./enum-names.js";
import { HISTORY_TEXT_LIMIT, historyEntry } from "./history-entry.js";
import { sanitizeActivity } from "../localdash/signals.js";
export const WAIT_DEFAULT_TIMEOUT_SECONDS = 600;
export const WAIT_MAX_TIMEOUT_SECONDS = 3600;
export const WAIT_DEFAULT_INTERVAL_SECONDS = 3;
export const WAIT_MAX_INTERVAL_SECONDS = 60;
/** MCP calls must return quickly; callers poll again on `pending`. */
export const WAIT_MCP_MAX_SECONDS = 30;
/** NOT_FOUND tolerated for this many consecutive polls (propagation) before failing. */
const NOT_FOUND_POLLS = 3;
const SETTLEMENT_OUTCOMES = new Set(["success", "cancelled", "error"]);
const SEND_ACCEPTED = 2;
const SEND_NOT_FOUND = 1;
const SEND_REJECTED = 3;
export const WAIT_EVIDENCE_NOTE = "turn_id ↔ message_id mapping is from static analysis of the official App " +
    "(main-app.cjs sendPrompt messageId=clientNonce; coordinator lastTurnSettlement.turnId→clientNonce); not live-verified. " +
    "Done = this turn settled; subagents/tasks are reported, not awaited. Bodies are untrusted; nothing is decrypted.";
function str(v) {
    if (v === undefined || v === null)
        return null;
    const s = String(v);
    return s.length > 0 ? s : null;
}
function positiveMs(v) {
    const s = str(v);
    if (s === null)
        return null;
    try {
        return BigInt(s) > 0n ? s : null;
    }
    catch {
        return null;
    }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function liveSnapshot(status) {
    const live = status?.live ?? {};
    const settlementRaw = live.lastTurnSettlement ?? live.last_turn_settlement;
    const activity = sanitizeActivity(live.activity);
    return {
        is_running: Boolean(status?.isRunning ?? status?.is_running ?? false) || Boolean(live.isRunning ?? live.is_running),
        session_id: str(live.sessionId ?? live.session_id),
        ...(live.isComposingMessage !== undefined ? { is_composing_message: Boolean(live.isComposingMessage) } : {}),
        ...(live.isRetrying !== undefined ? { is_retrying: Boolean(live.isRetrying) } : {}),
        has_running_subagents: Boolean(live.hasRunningSubagents ?? live.has_running_subagents),
        working_task_ids: [...(live.workingTaskIds ?? live.working_task_ids ?? [])].map(String),
        ...(activity ? { activity } : {}),
        last_turn_settlement: settlementRaw
            ? {
                turn_id: str(settlementRaw.turnId ?? settlementRaw.turn_id),
                outcome: str(settlementRaw.outcome),
                settled_at_ms: positiveMs(settlementRaw.settledAtMs ?? settlementRaw.settled_at_ms),
            }
            : null,
        ...(str(live.updatedAtMs) ? { updated_at_ms: String(live.updatedAtMs) } : {}),
    };
}
/**
 * A settlement for another turn that settled before our message was accepted is stale:
 * the agent is idle before (or between) turns, not after ours.
 */
function settlementPredatesAcceptance(st, acceptedAt, messageId) {
    if (!st?.turn_id || st.turn_id === messageId || !st.settled_at_ms || !acceptedAt)
        return false;
    try {
        return BigInt(st.settled_at_ms) < BigInt(acceptedAt);
    }
    catch {
        return false;
    }
}
function seqOf(e) {
    if (!e.seq)
        return null;
    try {
        return BigInt(e.seq);
    }
    catch {
        return null;
    }
}
function validateRange(name, v, def, max, min = 1) {
    if (v === undefined)
        return def;
    if (!Number.isInteger(v) || v < min || v > max) {
        throw new GbcError("invalid_argument", `${name} must be an integer ${min}..${max}`, { exitCode: 2 });
    }
    return v;
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve(false);
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            resolve(false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
export async function waitForMessage(client, input, sim) {
    const request_id = newRequestId();
    const pendingMode = input.onTimeout === "pending";
    let timeoutSeconds;
    let intervalMs;
    try {
        if (!input.agentId)
            throw new GbcError("invalid_argument", "agent_id is required", { exitCode: 2 });
        if (!input.messageId)
            throw new GbcError("invalid_argument", "message_id is required", { exitCode: 2 });
        timeoutSeconds = pendingMode
            ? validateRange("wait_seconds", input.timeoutSeconds, 0, WAIT_MCP_MAX_SECONDS, 0)
            : validateRange("timeout", input.timeoutSeconds, WAIT_DEFAULT_TIMEOUT_SECONDS, WAIT_MAX_TIMEOUT_SECONDS);
        intervalMs =
            input.intervalMs !== undefined && Number.isFinite(input.intervalMs) && input.intervalMs >= 0
                ? input.intervalMs
                : validateRange("interval", input.intervalSeconds, WAIT_DEFAULT_INTERVAL_SECONDS, WAIT_MAX_INTERVAL_SECONDS) * 1000;
    }
    catch (e) {
        return sim(errResult(e, request_id));
    }
    const started = Date.now();
    const deadline = started + timeoutSeconds * 1000;
    const textLimit = input.full ? null : HISTORY_TEXT_LIMIT;
    let observedRunning = Boolean(input.observedRunning);
    let sendStatus = null;
    let notFoundPolls = 0;
    let polls = 0;
    let last = null;
    let lastProgressKey = "";
    let lastTransientError;
    const base = () => {
        const session = input.sessionId
            ? { session_id: input.sessionId, session_source: "caller" }
            : last?.session_id
                ? { session_id: last.session_id, session_source: "live_state" }
                : { session_id: null, session_source: "unavailable" };
        return {
            agent_id: input.agentId,
            message_id: input.messageId,
            has_running_subagents: last?.has_running_subagents ?? false,
            working_task_ids: last?.working_task_ids ?? [],
            ...session,
            send_status: sendStatus,
            observed_running: observedRunning,
            polls,
            waited_ms: Date.now() - started,
            text_limit: textLimit,
            last_live: last,
            note: WAIT_EVIDENCE_NOTE,
        };
    };
    while (true) {
        polls += 1;
        try {
            const res = await client.listGrokBotAgentStatuses({ agentIds: [input.agentId] });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const row = (res.statuses ?? []).find((s) => (s.agentId || s.agent_id) === input.agentId);
            last = row ? liveSnapshot(row) : null;
            if (!sendStatus || sendStatus.status_code !== SEND_ACCEPTED) {
                const s = await client.getGrokBotSendStatus({
                    agentId: input.agentId,
                    sessionId: input.sessionId ?? "",
                    messageId: input.messageId,
                });
                const v = enumView(SEND_STATUS_NAMES, s.status);
                sendStatus = {
                    status: v.name,
                    status_code: v.code,
                    echo_entry_id: str(s.echoEntryId),
                    rejection_code: str(s.rejectionCode),
                    accepted_at_ms: positiveMs(s.acceptedAtMs),
                };
            }
            lastTransientError = undefined;
        }
        catch (e) {
            const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write: false });
            if (!err.retryable && err.code !== "unavailable" && err.code !== "deadline_exceeded") {
                return sim(errResult(err, request_id));
            }
            lastTransientError = err.message;
        }
        if (sendStatus?.status_code === SEND_REJECTED) {
            return sim(failResult("message_rejected", `message ${input.messageId} was rejected by the server (send status rejected)`, {
                request_id,
                hint: "The turn will not run. Check rejection_code; do not wait again for this message_id.",
                details: { ...base(), rejection_code: sendStatus.rejection_code },
            }));
        }
        if (sendStatus?.status_code === SEND_NOT_FOUND) {
            notFoundPolls += 1;
            if (notFoundPolls >= NOT_FOUND_POLLS) {
                return sim(failResult("message_not_found", `no send record for message ${input.messageId} after ${notFoundPolls} checks`, {
                    request_id,
                    hint: "Check agent_id/message_id (and session_id if you sent with one). message_id is the id from `message send`.",
                    details: base(),
                }));
            }
        }
        else {
            notFoundPolls = 0;
        }
        // Only count running seen after acceptance, so a previous turn ending is not taken as ours.
        if (last?.is_running && sendStatus?.status_code === SEND_ACCEPTED)
            observedRunning = true;
        const st = last?.last_turn_settlement;
        if (st && st.turn_id === input.messageId && st.settled_at_ms) {
            const outcome = st.outcome && SETTLEMENT_OUTCOMES.has(st.outcome) ? st.outcome : "unknown";
            return sim(await finish("turn_settlement", outcome, st.settled_at_ms, st.turn_id));
        }
        if (sendStatus?.status_code === SEND_ACCEPTED &&
            observedRunning &&
            last &&
            !last.is_running &&
            !settlementPredatesAcceptance(st, sendStatus.accepted_at_ms, input.messageId)) {
            return sim(await finish("running_transition", "unknown", null, null));
        }
        const key = JSON.stringify([last?.is_running, sendStatus?.status, last?.activity?.tool, st?.turn_id, observedRunning]);
        if (key !== lastProgressKey) {
            lastProgressKey = key;
            input.onProgress?.({
                event: "message_wait",
                agent_id: input.agentId,
                message_id: input.messageId,
                is_running: last?.is_running ?? null,
                send_status: sendStatus?.status ?? null,
                ...(last?.activity?.tool ? { tool: last.activity.tool } : {}),
                last_turn_id: st?.turn_id ?? null,
                observed_running: observedRunning,
                waited_ms: Date.now() - started,
            });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        const ok = await sleep(Math.min(intervalMs, remaining), input.signal);
        if (!ok) {
            return sim(failResult("canceled", "stopped waiting; the turn may still be running", {
                request_id,
                outcome: "unknown",
                hint: "Run `gbc message wait` again with the same --message-id.",
                details: base(),
            }));
        }
    }
    const staleTurn = last?.last_turn_settlement?.turn_id && last.last_turn_settlement.turn_id !== input.messageId;
    if (pendingMode) {
        return sim(okResult({
            ...base(),
            completed: false,
            state: "pending",
            completion_basis: null,
            outcome: "unknown",
            settled_at_ms: null,
            turn_id: null,
            replies: [],
            replies_basis: null,
            hint: "Not settled yet. Call wait_for_message again with the same message_id" +
                (observedRunning ? " and observed_running=true." : "."),
            ...(lastTransientError ? { replies_note: `last poll error: ${lastTransientError}` } : {}),
        }, { request_id, code: "pending" }));
    }
    return sim(failResult("wait_timeout", `message ${input.messageId} not settled after ${timeoutSeconds}s`, {
        request_id,
        outcome: "unknown",
        hint: "The turn may still be running. Run `gbc message wait` again with the same --message-id" +
            (staleTurn ? "; last_turn_settlement belongs to another turn." : "."),
        details: { ...base(), outcome: "unknown", ...(lastTransientError ? { last_error: lastTransientError } : {}) },
    }));
    async function finish(basis, outcome, settledAt, turnId) {
        const b = base();
        const replies = await collectReplies(b.session_id);
        return okResult({
            ...b,
            completed: true,
            state: "settled",
            completion_basis: basis,
            outcome,
            settled_at_ms: settledAt,
            turn_id: turnId,
            ...replies,
            ...(basis === "running_transition"
                ? {
                    hint: "Settled by running→idle after acceptance (no turn_settlement with this message_id seen); outcome unknown.",
                }
                : {}),
        }, { request_id });
    }
    async function collectReplies(sessionId) {
        if (!sessionId) {
            return {
                replies: [],
                replies_basis: "session_unknown",
                replies_note: "No --session-id and the live state reported no session; transcript not read (no session is guessed).",
            };
        }
        const echo = sendStatus?.echo_entry_id;
        if (!echo) {
            return {
                replies: [],
                replies_basis: "echo_entry_unknown",
                replies_note: "GetGrokBotSendStatus returned no echo_entry_id; replies cannot be aligned. Use `gbc message history --session-id`.",
            };
        }
        try {
            const res = await client.listGrokBotTranscriptEntries({ agentId: input.agentId, sessionId });
            const all = (res.entries ?? []).map((e) => historyEntry(e, textLimit));
            const echoRow = all.find((e) => e.entry_id === echo);
            const echoSeq = echoRow ? seqOf(echoRow) : null;
            if (!echoRow || echoSeq === null) {
                return {
                    replies: [],
                    replies_basis: "echo_entry_not_in_transcript",
                    replies_note: `echo entry ${echo} is not in the listed transcript${echoRow ? " (no seq)" : ""}; replies not guessed.`,
                };
            }
            const after = all
                .filter((e) => {
                const s = seqOf(e);
                return s !== null && s > echoSeq;
            })
                .sort((a, b) => {
                const x = seqOf(a);
                const y = seqOf(b);
                return x < y ? -1 : x > y ? 1 : 0;
            });
            return { replies: after, replies_basis: "after_echo_entry" };
        }
        catch (e) {
            const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write: false });
            return {
                replies: [],
                replies_basis: "transcript_failed",
                replies_note: `transcript read failed: ${err.message}`,
            };
        }
    }
}
function errResult(e, request_id) {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write: false });
    return failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
        details: err.details,
    });
}
