/** Read-only dashboard signal helpers. Never pass through raw awaiting/handoff objects. */
import { sanitizeAwaitingReason } from "./awaiting.js";
const SHORT_MAX = 80;
const HANDOFF_PREVIEW_MAX = 40;
const APPROVAL_RE = /needs[_-]?approval|pending[_-]?approval|\bapproval\b|\bapprove\b|审批|批准/i;
const INPUT_RE = /awaiting[_-]?user|waiting[_-]?for[_-]?(?:user|input)|user[_-]?input|needs[_-]?input|等待输入|需要输入/i;
const NORMAL_OUTCOMES = new Set([
    "ok",
    "success",
    "succeeded",
    "completed",
    "complete",
    "normal",
    "settled",
    "done",
]);
const ABNORMAL_OUTCOMES = new Set([
    "error",
    "failed",
    "failure",
    "aborted",
    "abort",
    "cancelled",
    "canceled",
    "timeout",
]);
const DENY_URL = /https?:\/\//i;
export function sanitizeShortText(raw, max = SHORT_MAX) {
    const base = sanitizeAwaitingReason(raw);
    if (!base)
        return undefined;
    if (DENY_URL.test(base))
        return undefined;
    if (base.length > max)
        return `${base.slice(0, max)}…`;
    return base;
}
export function classifyAwaitingReason(reason) {
    if (!reason)
        return "other";
    if (APPROVAL_RE.test(reason))
        return "approval";
    if (INPUT_RE.test(reason))
        return "input";
    return "other";
}
export function sanitizeActivity(raw) {
    if (raw == null || typeof raw !== "object")
        return undefined;
    const rec = raw;
    const kind = sanitizeShortText(rec.kind ?? rec.Kind);
    const tool = sanitizeShortText(rec.tool ?? rec.Tool);
    if (!kind && !tool)
        return undefined;
    return { ...(kind ? { kind } : {}), ...(tool ? { tool } : {}) };
}
export function sanitizeBoxHandoff(live) {
    if (live == null || typeof live !== "object")
        return undefined;
    const rec = live;
    const id = rec.boxHandoffRequestId ?? rec.box_handoff_request_id;
    const instruction = rec.boxHandoffInstruction ?? rec.box_handoff_instruction;
    const hasId = typeof id === "string" && id.trim().length > 0;
    const hasInstruction = typeof instruction === "string" && instruction.trim().length > 0;
    if (!hasId && !hasInstruction)
        return undefined;
    const view = { present: true, has_instruction: hasInstruction };
    if (hasInstruction) {
        const cleaned = sanitizeAwaitingReason(instruction);
        if (!cleaned || DENY_URL.test(cleaned)) {
            view.instruction_hidden = true;
        }
        else if (cleaned.length > HANDOFF_PREVIEW_MAX) {
            view.instruction_preview = `${cleaned.slice(0, HANDOFF_PREVIEW_MAX)}…`;
            view.instruction_hidden = true;
        }
        else {
            view.instruction_preview = cleaned;
        }
    }
    return view;
}
export function mapTurnSettlement(raw) {
    if (raw == null || typeof raw !== "object")
        return undefined;
    const rec = raw;
    const outcome = sanitizeShortText(rec.outcome);
    const settledRaw = rec.settledAtMs ?? rec.settled_at_ms;
    const settled_at_ms = settledRaw === undefined || settledRaw === null || settledRaw === "" ? undefined : String(settledRaw);
    if (!outcome && !settled_at_ms)
        return undefined;
    // turn_id: the App treats it as the sender's client nonce (= SendGrokBotUserMessage
    // message_id); static analysis only, see ops/message-wait.ts.
    const rawTurn = rec.turnId ?? rec.turn_id;
    const turn_id = typeof rawTurn === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(rawTurn) ? rawTurn : undefined;
    const view = {
        ...(outcome ? { outcome } : {}),
        ...(settled_at_ms ? { settled_at_ms } : {}),
        ...(turn_id ? { turn_id } : {}),
    };
    const flag = classifySettlementOutcome(outcome);
    if (flag !== undefined)
        view.settled_normally = flag;
    return view;
}
export function classifySettlementOutcome(outcome) {
    if (!outcome)
        return undefined;
    const key = outcome.trim().toLowerCase();
    if (NORMAL_OUTCOMES.has(key))
        return true;
    if (ABNORMAL_OUTCOMES.has(key))
        return false;
    return undefined;
}
export function waitingSignals(status) {
    const signals = [];
    const awaiting = status?.live?.awaiting;
    if (awaiting?.observed) {
        const kind = classifyAwaitingReason(awaiting.reason);
        const label = kind === "approval" ? "审批" : kind === "input" ? "等待输入" : "等待处理";
        signals.push({
            kind,
            label,
            ...(awaiting.reason ? { reason: awaiting.reason } : { reason: "等待／原因未知" }),
        });
    }
    const handoff = status?.live?.box_handoff;
    if (handoff?.present) {
        signals.push({
            kind: "box_handoff",
            label: "桌面交接",
            ...(handoff.instruction_preview ? { instruction_preview: handoff.instruction_preview } : {}),
            ...(handoff.instruction_hidden ? { instruction_hidden: true } : {}),
        });
    }
    if (status?.live?.is_retrying) {
        signals.push({ kind: "retrying", label: "正在重试" });
    }
    return signals;
}
export function sourceFreshness(input) {
    if (!input.attempted) {
        return {
            id: input.id,
            label: input.label,
            result: "idle",
            ...(input.last_successful_at_ms !== undefined
                ? { last_successful_at_ms: input.last_successful_at_ms }
                : {}),
        };
    }
    if (input.ok) {
        return {
            id: input.id,
            label: input.label,
            result: "ok",
            ...(input.empty ? { empty: true } : {}),
            ...(input.last_successful_at_ms !== undefined
                ? { last_successful_at_ms: input.last_successful_at_ms }
                : {}),
        };
    }
    return {
        id: input.id,
        label: input.label,
        result: "error",
        ...(input.stale ? { stale: true } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.last_successful_at_ms !== undefined
            ? { last_successful_at_ms: input.last_successful_at_ms }
            : {}),
    };
}
