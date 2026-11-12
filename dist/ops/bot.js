import { GrokBotAgentHarnessKind } from "#proto-gen/aiserver";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, } from "../dto/result.js";
import { GbcError } from "../errors.js";
import { mapBot, mapChannelConnections } from "./map.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";
export const READBACK_DELAYS_MS = [300, 900];
export const READBACK_BUDGET_MS = 3000;
/** Observed (issue #3), not proven by client reverse engineering. */
export const TITLE_MERGE_NOTE = "The server has been observed to merge title into the display name (e.g. \"Showrunner · 幕僚长\") and clear title; not guaranteed for every account. No client-side evidence for this in the App bundle.";
function requireWrite(opts, action) {
    if (opts?.dryRun)
        return;
    if (!opts?.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
        throw new GbcError("denied", `refusing ${action}: pass allowWrite / --allow-writes or GBT_ALLOW_WRITES=1`, {
            exitCode: 7,
            hint: "Writes are explicit; dry-run is pure and does not call RPC.",
        });
    }
}
export class BotOps {
    client;
    flags;
    constructor(client, flags = {}) {
        this.client = client;
        this.flags = flags;
    }
    /**
     * Read one agent back from ListGrokBotAgents with short retries while it is
     * absent from a complete list. Returns found bot or the reason it was not
     * verified. Never throws.
     */
    async readBack(agentId) {
        const delays = this.flags.readbackDelaysMs ?? [...READBACK_DELAYS_MS];
        const started = Date.now();
        let attempts = 0;
        for (;;) {
            attempts += 1;
            let res;
            try {
                res = await this.client.listGrokBotAgents({});
            }
            catch (e) {
                const err = e instanceof GbcError ? e : mapConnectError(e, "");
                return { found: false, reason: "list_failed", attempts, error: err.message };
            }
            const bot = (res.agents ?? [])
                .map(mapBot)
                .find((b) => b.agent_id === agentId);
            if (bot)
                return { found: true, bot, attempts };
            if (res.truncated)
                return { found: false, reason: "truncated", attempts };
            const delay = delays[attempts - 1];
            if (delay === undefined || Date.now() - started + delay > READBACK_BUDGET_MS) {
                return { found: false, reason: "not_found", attempts };
            }
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    wrapSim(r) {
        if (this.flags.simulated)
            r.simulated = true;
        return r;
    }
    /** Update/Delete RPC `id` is the numeric server id (App: serverId); accept agent_id UUID by resolving via list. */
    async serverId(idOrAgentId) {
        if (/^\d+$/.test(idOrAgentId))
            return idOrAgentId;
        const res = await this.client.listGrokBotAgents({});
        const bot = (res.agents ?? [])
            .map(mapBot)
            .find((b) => b.agent_id === idOrAgentId);
        if (bot?.id)
            return bot.id;
        throw new GbcError(res.truncated ? "lookup_incomplete" : "not_found", res.truncated
            ? "agent list truncated; cannot resolve server id"
            : `bot ${idOrAgentId} not found; no write sent`, { exitCode: 5 });
    }
    async list(opts) {
        const request_id = newRequestId();
        try {
            const limit = validateLimit(opts?.limit);
            const offset = validateOffset(opts?.offset);
            const res = await this.client.listGrokBotAgents({});
            const all = (res.agents ?? []).map(mapBot);
            const page = paginate(all, limit, offset);
            const serverTruncated = Boolean(res.truncated);
            const truncated = page.truncated || serverTruncated;
            const hint = page.hint
                ?? (serverTruncated
                    ? "Server reported a truncated agent list; this page may be incomplete."
                    : undefined);
            const channels = mapChannelConnections(res);
            return this.wrapSim(okResult({
                bots: page.items,
                truncated,
                next: page.next,
                hint,
                channels,
            }, { request_id }));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
    }
    /** No GetBot RPC — filter ListGrokBotAgents client-side (full server page, not the user-facing cap). */
    async get(agentId) {
        const request_id = newRequestId();
        try {
            const res = await this.client.listGrokBotAgents({});
            const all = (res.agents ?? []).map(mapBot);
            const bot = all.find((b) => b.agent_id === agentId || b.id === agentId);
            if (bot)
                return this.wrapSim(okResult({ bot }, { request_id }));
            if (res.truncated) {
                return this.wrapSim(failResult("lookup_incomplete", `bot ${agentId} not in a truncated ListGrokBotAgents page; existence unknown`, {
                    request_id,
                    outcome: "unknown",
                    hint: "Server list was truncated; absence is not proof of non-existence.",
                }));
            }
            return this.wrapSim(failResult("not_found", `bot ${agentId} not found in ListGrokBotAgents`, {
                request_id,
                hint: "There is no GetGrokBotAgent RPC; get = list + filter.",
            }));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
    }
    async create(input, write) {
        const request_id = newRequestId();
        // Align with the App: 0.79.3 dist/electron-main/main-app.cjs (sha256 d54cc236…a268209,
        // line 1117) calls createGrokBotTemporalAgent({..., title: n.title ?? "", ...}); 0.79.4 is
        // the same. The App never substitutes name for a missing title (gbc did before 0.6.0).
        const title = input.title ?? "";
        const requested = { name: input.name, title };
        if (write?.dryRun) {
            const agent_id = input.agentId || "(dry-run-nonce)";
            return this.wrapSim(okResult({
                bot: {
                    agent_id,
                    id: "",
                    name: input.name,
                    description: input.description || "",
                    title,
                    harness: "TEMPORAL",
                    role: "",
                    kind: "",
                    viewer_session_id: "",
                },
                agent_id,
                requested,
                observed: { ...requested },
                renamed_by_server: false,
                changed_fields: [],
                readback: { source: "ListGrokBotAgents", attempts: 0 },
                note: `dry-run: no RPC sent; observed equals requested and cannot reveal a server-side rename. ${TITLE_MERGE_NOTE}`,
            }, { request_id, code: "dry_run" }));
        }
        let agentId;
        let created;
        try {
            requireWrite(write, "bot.create");
            agentId = input.agentId || crypto.randomUUID();
            // App Temporal path: CreateGrokBotTemporalAgent with CreateGrokBotAgentRequest fields.
            // Drift (visibility/teamId/botBuilderRequested) intentionally NOT sent — not in 0.78.4 Request.
            const res = await this.client.createGrokBotTemporalAgent({
                agentId,
                name: input.name,
                description: input.description ?? "",
                title,
                avatarShape: "circle",
                avatarColor: "#888888",
                harness: GrokBotAgentHarnessKind.TEMPORAL,
                kickstartRequested: input.kickstart ?? false,
                introductionSuppressed: !(input.kickstart ?? false),
                language: input.language,
            });
            created = mapBot(res.agent);
            agentId = created.agent_id || agentId;
        }
        catch (e) {
            return this.fromErr(e, request_id, true);
        }
        const rb = await this.readBack(agentId);
        if (!rb.found) {
            return this.wrapSim(failResult("create_unverified", `CreateGrokBotTemporalAgent succeeded but read-back ${readbackReason(rb.reason)}; display name unknown`, {
                request_id,
                outcome: "unknown",
                hint: `The bot was probably created. Reconcile with \`gbc bot get --agent-id ${agentId}\` before retrying; do not assume the requested name is the display name.`,
                details: {
                    agent_id: agentId,
                    write_sent: true,
                    requested,
                    create_response: { name: created.name, title: created.title },
                    readback: { source: "ListGrokBotAgents", attempts: rb.attempts, reason: rb.reason, error: rb.error },
                },
            }));
        }
        const cmp = compareReadback(requested, rb.bot, rb.attempts);
        return this.wrapSim(okResult({
            bot: rb.bot,
            agent_id: agentId,
            ...cmp,
            note: cmp.renamed_by_server ? TITLE_MERGE_NOTE : undefined,
        }, { request_id }));
    }
    async update(agentId, patch, write) {
        const request_id = newRequestId();
        const requested = { name: patch.name ?? null, title: patch.title ?? null };
        if (write?.dryRun) {
            return this.wrapSim(okResult({
                bot: {
                    agent_id: agentId,
                    id: agentId,
                    name: patch.name || "",
                    description: patch.description || "",
                    title: patch.title || "",
                    harness: "",
                    role: "",
                    kind: "",
                    viewer_session_id: "",
                },
                requested,
                observed: { name: patch.name ?? "", title: patch.title ?? "" },
                renamed_by_server: false,
                changed_fields: [],
                readback: { source: "ListGrokBotAgents", attempts: 0 },
                note: `dry-run: no RPC sent; cannot reveal a server-side rename. ${TITLE_MERGE_NOTE}`,
            }, { request_id, code: "dry_run" }));
        }
        let resolvedAgentId = agentId;
        let updated;
        try {
            requireWrite(write, "bot.update");
            const res = await this.client.updateGrokBotAgent({
                id: await this.serverId(agentId),
                name: patch.name,
                description: patch.description,
                title: patch.title,
                partialUpdate: true,
            });
            updated = mapBot(res.agent);
            // Numeric server id input: the response carries the agent_id used for read-back.
            if (/^\d+$/.test(agentId) && updated.agent_id)
                resolvedAgentId = updated.agent_id;
        }
        catch (e) {
            return this.fromErr(e, request_id, true);
        }
        const rb = await this.readBack(resolvedAgentId);
        if (!rb.found) {
            return this.wrapSim(failResult("update_unverified", `UpdateGrokBotAgent succeeded but read-back ${readbackReason(rb.reason)}; current name/title unknown`, {
                request_id,
                outcome: "unknown",
                hint: `Reconcile with \`gbc bot get --agent-id ${resolvedAgentId}\` before retrying.`,
                details: {
                    agent_id: resolvedAgentId,
                    write_sent: true,
                    requested,
                    update_response: { name: updated.name, title: updated.title },
                    readback: { source: "ListGrokBotAgents", attempts: rb.attempts, reason: rb.reason, error: rb.error },
                },
            }));
        }
        const cmp = compareReadback(requested, rb.bot, rb.attempts);
        return this.wrapSim(okResult({ bot: rb.bot, ...cmp, note: cmp.renamed_by_server ? TITLE_MERGE_NOTE : undefined }, { request_id }));
    }
    async delete(agentId, write) {
        const request_id = newRequestId();
        if (write?.dryRun) {
            return this.wrapSim(okResult({
                deleted: false,
                note: "dry-run: would call DeleteGrokBotAgent; sidebar cleanup unverified",
            }, { request_id, code: "dry_run" }));
        }
        if (write?.confirm !== agentId) {
            return this.wrapSim(failResult("denied", "delete requires --confirm=<agent_id> matching the resource", {
                request_id,
                hint: `gbc bot delete --agent-id ${agentId} --confirm=${agentId} --allow-writes`,
            }));
        }
        try {
            requireWrite(write, "bot.delete");
            await this.client.deleteGrokBotAgent({
                id: await this.serverId(agentId),
            });
            return this.wrapSim(okResult({
                deleted: true,
                note: "DeleteGrokBotAgent succeeded. Sidebar section cleanup after delete is unverified.",
            }, { request_id }));
        }
        catch (e) {
            if (e instanceof GbcError && e.code === "not_found")
                return this.wrapSim(okResult({
                    deleted: false,
                    note: "agent_id not present in complete ListGrokBotAgents; no delete RPC sent (already absent).",
                }, { request_id }));
            if (e instanceof GbcError)
                return this.fromErr(e, request_id, true);
            const mapped = mapConnectError(e, request_id, { write: true });
            // App treats NotFound as ok on delete.
            if (mapped.code === "not_found") {
                return this.wrapSim(okResult({
                    deleted: true,
                    note: "Delete NotFound normalized to ok (App behavior). Sidebar residual unverified.",
                }, { request_id }));
            }
            return this.fromErr(mapped, request_id, true);
        }
    }
    fromErr(e, request_id, write = false) {
        const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write });
        return this.wrapSim(failResult(err.code, err.message, {
            outcome: err.outcome,
            retryable: err.retryable,
            hint: err.hint,
            request_id,
            details: err.details,
        }));
    }
}
function readbackReason(reason) {
    switch (reason) {
        case "list_failed":
            return "failed (ListGrokBotAgents error)";
        case "truncated":
            return "was inconclusive (agent not in a truncated ListGrokBotAgents page)";
        default:
            return "did not find the agent after retries";
    }
}
export function compareReadback(requested, bot, attempts) {
    const observed = { name: bot.name, title: bot.title };
    const changed_fields = [];
    if (requested.name !== null && requested.name !== observed.name)
        changed_fields.push("name");
    if (requested.title !== null && requested.title !== observed.title)
        changed_fields.push("title");
    return {
        requested,
        observed,
        renamed_by_server: changed_fields.length > 0,
        changed_fields,
        readback: { source: "ListGrokBotAgents", attempts },
    };
}
