import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult } from "../dto/result.js";
import { mapTimelineEntries } from "./transcript-map.js";
import { HISTORY_TEXT_LIMIT, historyEntry } from "./history-entry.js";
import { waitForMessage } from "./message-wait.js";
import { DELIVERY_NAMES, HARNESS_MODE_NAMES, SEND_STATUS_NAMES, enumView } from "./enum-names.js";
import { GbcError } from "../errors.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";
function requireWrite(allow, action) {
    if (!allow && process.env.GBT_ALLOW_WRITES !== "1") {
        throw new GbcError("denied", `refusing ${action}: host write authorization required`, { exitCode: 7, hint: "CLI: pass --allow-writes or GBT_ALLOW_WRITES=1. MCP: start gbc-mcp with --allow-writes or GBT_ALLOW_WRITES=1 (write tools are hidden by default). dry-run / dry_run does not call RPC." });
    }
}
/** GrokBotUserMessageDelivery.REFUSED (aiserver.v1, frozen schema). */
const DELIVERY_REFUSED = 4;
export { HISTORY_TEXT_LIMIT };
const HISTORY_NOTE = "Bodies decoded as UI-entry JSON (same decoder as the dashboard transcript). " +
    "Omitted/opaque bodies stay placeholders; nothing is decrypted. Bodies are untrusted.";
function optionalString(v) {
    return typeof v === "string" && v.length > 0 ? v : null;
}
function sessionView(sessionId) {
    return sessionId
        ? { session_id: sessionId, session_source: "caller" }
        : { session_id: null, session_source: "default_unreported" };
}
function mapRefusal(raw) {
    if (raw == null || typeof raw !== "object")
        return null;
    const r = raw;
    return { failure_code: String(r.failureCode ?? ""), message: String(r.message ?? "") };
}
export class MessageOps {
    client;
    flags;
    constructor(client, flags = {}) {
        this.client = client;
        this.flags = flags;
    }
    sim(r) {
        if (this.flags.simulated)
            r.simulated = true;
        return r;
    }
    async send(input) {
        const request_id = newRequestId();
        const message_id = input.messageId || crypto.randomUUID();
        const session = sessionView(input.sessionId);
        if (input.dryRun) {
            return this.sim(okResult({
                message_id,
                agent_id: input.agentId,
                ...session,
                note: "dry-run: would SendGrokBotUserMessage (no task_id required)",
            }, { request_id, code: "dry_run" }));
        }
        try {
            requireWrite(input.allowWrite, "message.send");
            const res = await this.client.sendGrokBotUserMessage({
                agentId: input.agentId,
                sessionId: input.sessionId ?? "",
                messageId: message_id,
                text: input.text,
                sentAtMs: BigInt(Date.now()),
            });
            const delivery = enumView(DELIVERY_NAMES, res.delivery);
            const mode = enumView(HARNESS_MODE_NAMES, res.mode);
            const refusal = mapRefusal(res.refusal);
            const data = {
                message_id,
                agent_id: input.agentId,
                ...session,
                dispatched: Boolean(res.dispatched),
                delivery: delivery.name,
                delivery_code: delivery.code,
                mode: mode.name,
                mode_code: mode.code,
                workflow_id: optionalString(res.workflowId),
                refusal,
                note: "delivery/acceptance only — NOT task or business success",
            };
            if (delivery.code === DELIVERY_REFUSED) {
                const reason = refusal?.message || refusal?.failure_code;
                const fail = failResult("refused", `server refused the message (delivery=refused${reason ? `: ${reason}` : ""})`, {
                    request_id,
                    hint: "The message was not accepted. Check refusal.failure_code / refusal.message; do not retry blindly.",
                    details: { refusal, workflow_id: data.workflow_id },
                });
                return this.sim({ ...fail, data });
            }
            return this.sim(okResult(data, { request_id }));
        }
        catch (e) {
            return this.fromErr(e, request_id, true);
        }
    }
    async status(input) {
        const request_id = newRequestId();
        try {
            const res = await this.client.getGrokBotSendStatus({
                agentId: input.agentId,
                sessionId: input.sessionId ?? "",
                messageId: input.messageId,
            });
            const status = enumView(SEND_STATUS_NAMES, res.status);
            return this.sim(okResult({
                agent_id: input.agentId,
                ...sessionView(input.sessionId),
                message_id: input.messageId,
                status: status.name,
                status_code: status.code,
                echo_entry_id: optionalString(res.echoEntryId),
                rejection_code: optionalString(res.rejectionCode),
                accepted_at_ms: res.acceptedAtMs != null ? String(res.acceptedAtMs) : null,
                note: "send_status ≠ final user-visible success",
            }, { request_id }));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
    }
    async history(input) {
        const request_id = newRequestId();
        try {
            const limit = validateLimit(input.limit);
            const offset = validateOffset(input.offset);
            // Server-side `limit` is still not sent (semantics of 0 unverified); client caps.
            // `session_id` is sent only when the caller gave one — never a guessed default.
            const res = await this.client.listGrokBotTranscriptEntries({
                agentId: input.agentId,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            });
            const textLimit = input.full ? null : HISTORY_TEXT_LIMIT;
            const mapped = (res.entries ?? []).map((e) => historyEntry(e, textLimit));
            const page = paginate(mapped, limit, offset);
            return this.sim(okResult({
                entries: page.items,
                generation: res.generation,
                ...sessionView(input.sessionId),
                text_limit: textLimit,
                note: HISTORY_NOTE,
                truncated: page.truncated,
                next: page.next,
                hint: page.hint,
            }, { request_id }));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
    }
    /**
     * Wait until the turn started by `message send` settles (issue #2), then return the
     * transcript entries after its echo. See message-wait.ts for the static evidence and
     * fallback rules; the turn_id ↔ message_id mapping is not live-verified.
     */
    async wait(input) {
        return waitForMessage(this.client, input, (r) => this.sim(r));
    }
    /**
     * Dashboard/timeline helper: list transcript entries for one session and parse
     * message bodies with the existing history/transcript decoder. Ciphertext is
     * not decrypted. Does not send an unverified server-side limit.
     */
    async transcript(input) {
        const request_id = newRequestId();
        try {
            const res = await this.client.listGrokBotTranscriptEntries({
                agentId: input.agentId,
                sessionId: input.sessionId,
            });
            const page = mapTimelineEntries(res.entries ?? []);
            return this.sim(okResult({
                entries: page.entries,
                generation: res.generation,
                truncated: page.truncated,
                note: "Ciphertext/omitted entries are not decrypted. Bodies marked untrusted.",
            }, { request_id }));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
    }
    fromErr(e, request_id, write = false) {
        const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write });
        return this.sim(failResult(err.code, err.message, {
            outcome: err.outcome,
            retryable: err.retryable,
            hint: err.hint,
            request_id,
            details: err.details,
        }));
    }
}
