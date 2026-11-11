import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult } from "../dto/result.js";
import { GbcError } from "../errors.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";
function requireWrite(allow, action) {
    if (!allow && process.env.GBT_ALLOW_WRITES !== "1") {
        throw new GbcError("denied", `refusing ${action}: host write authorization required`, { exitCode: 7, hint: "CLI: pass --allow-writes or GBT_ALLOW_WRITES=1. MCP: start gbc-mcp with --allow-writes or GBT_ALLOW_WRITES=1 (write tools are hidden by default). dry-run / dry_run does not call RPC." });
    }
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
        if (input.dryRun) {
            return this.sim(okResult({
                message_id,
                agent_id: input.agentId,
                session_id: input.sessionId,
                note: "dry-run: would SendGrokBotUserMessage (no task_id required)",
            }, { request_id, code: "dry_run" }));
        }
        try {
            requireWrite(input.allowWrite, "message.send");
            const res = await this.client.sendGrokBotUserMessage({
                agentId: input.agentId,
                sessionId: input.sessionId,
                messageId: message_id,
                text: input.text,
                sentAtMs: BigInt(Date.now()),
            });
            return this.sim(okResult({
                message_id,
                agent_id: input.agentId,
                session_id: input.sessionId,
                dispatched: res.dispatched,
                delivery: String(res.delivery ?? ""),
                note: "delivery/acceptance only — NOT task or business success",
            }, { request_id }));
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
                sessionId: input.sessionId,
                messageId: input.messageId,
            });
            return this.sim(okResult({
                agent_id: input.agentId,
                session_id: input.sessionId,
                message_id: input.messageId,
                status: String(res.status ?? ""),
                rejection_code: res.rejectionCode,
                accepted_at_ms: res.acceptedAtMs != null ? String(res.acceptedAtMs) : undefined,
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
            // NOTE: server-side `limit`/`session_id` are still not sent (semantics of 0 unverified); client caps.
            const res = await this.client.listGrokBotTranscriptEntries({
                agentId: input.agentId,
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mapped = (res.entries ?? []).map((e) => {
                const id = e.id || e.entryId || e.entry_id;
                const preview = e.plaintext || e.text || e.preview ||
                    (e.ciphertext || e.omitted ? undefined : undefined);
                return {
                    entry_id: id,
                    kind: String(e.entryKind ?? e.kind ?? e.type ?? ""),
                    omitted: Boolean(e.bodyOmitted || e.omitted || e.ciphertext),
                    preview: preview ? String(preview).slice(0, 200) : undefined,
                    untrusted: true,
                };
            });
            const page = paginate(mapped, limit, offset);
            return this.sim(okResult({
                entries: page.items,
                generation: res.generation,
                note: "Ciphertext/omitted entries are not decrypted. Bodies marked untrusted.",
                truncated: page.truncated,
                next: page.next,
                hint: page.hint,
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
