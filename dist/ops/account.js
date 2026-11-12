import { createHash } from "node:crypto";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, } from "../dto/result.js";
import { GbcError } from "../errors.js";
import { RESET_CONFIRM } from "./computer.js";
/** Intent token for `account cleanup`. Bind the approved inventory with `--plan`. */
export const ACCOUNT_CLEANUP_CONFIRM = "ACCOUNT_CLEANUP";
export const ACCOUNT_CLEANUP_WARNINGS = [
    "This deletes only the listed personal bots you own, then recreates the shared computer with preserve_data=false.",
    "This is not a full account reset. It does not cancel a subscription, delete the account, or claim to clear sessions, connectors, Library, skills/routines, or all cloud data.",
    "Side effects of DeleteGrokBotAgent and RecreateSandBox are not live-verified. The flow is not a transaction; already-deleted bots cannot be undone by this tool.",
    "Computer reset cannot be canceled after it starts. Do not start another reset while one may still be running.",
];
export function planFingerprint(targets) {
    const lines = [...targets]
        .map((t) => `${t.id}\t${t.agent_id}`)
        .sort();
    return createHash("sha256")
        .update(`account-cleanup-v1\n${lines.join("\n")}\n`)
        .digest("hex");
}
function optionalBool(value) {
    if (value === true || value === false)
        return value;
    return undefined;
}
function enumToken(value) {
    if (value == null || value === "")
        return "";
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    return String(value).toUpperCase().replace(/-/g, "_");
}
function hasTeamId(value) {
    if (value == null || value === "")
        return false;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n !== 0;
}
function isTeamVisibility(value) {
    const t = enumToken(value);
    return t === "2" || t.endsWith("_VISIBILITY_TEAM") || t === "TEAM";
}
function isGroupAccess(value) {
    const t = enumToken(value);
    return t === "2" || t.endsWith("_VIEWER_ACCESS_GROUP") || t === "GROUP";
}
function isTeamAccess(value) {
    const t = enumToken(value);
    return t === "3" || t.endsWith("_VIEWER_ACCESS_TEAM") || t === "TEAM";
}
function isRoomKind(value) {
    const t = enumToken(value);
    return t === "2" || t.endsWith("_KIND_ROOM") || t === "ROOM";
}
function rawText(raw, ...keys) {
    for (const key of keys) {
        const v = raw[key];
        if (v != null && String(v).length > 0)
            return String(v);
    }
    return "";
}
/** Classify one ListGrokBotAgents row. Missing ownership fields are not guessed. */
export function classifyListedAgent(rawUnknown) {
    const raw = (rawUnknown ?? {});
    const id = rawText(raw, "id");
    const agent_id = rawText(raw, "agentId", "agent_id") || id;
    const name = rawText(raw, "name");
    const base = { id, agent_id, name };
    if (!id)
        return { ...base, reason: "missing_server_id" };
    if (isRoomKind(raw.kind))
        return { ...base, reason: "room" };
    const owner = optionalBool(raw.viewerIsOwner ?? raw.viewer_is_owner);
    if (owner === undefined)
        return { ...base, reason: "ownership_unknown" };
    if (owner === false)
        return { ...base, reason: "not_owner" };
    if (hasTeamId(raw.teamId ?? raw.team_id) ||
        isTeamVisibility(raw.visibility) ||
        isTeamAccess(raw.viewerAccess ?? raw.viewer_access) ||
        optionalBool(raw.teamDefaultForViewer ?? raw.team_default_for_viewer) === true) {
        return { ...base, reason: "team" };
    }
    if (optionalBool(raw.sharedWithOthers ?? raw.shared_with_others) === true) {
        return { ...base, reason: "shared" };
    }
    if (isGroupAccess(raw.viewerAccess ?? raw.viewer_access)) {
        return { ...base, reason: "group_access" };
    }
    return base;
}
function isTarget(row) {
    return !("reason" in row);
}
function inventoryFromAgents(agents) {
    const targets = [];
    const skipped = [];
    for (const agent of agents) {
        const row = classifyListedAgent(agent);
        if (isTarget(row))
            targets.push(row);
        else
            skipped.push(row);
    }
    targets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.agent_id.localeCompare(b.agent_id)));
    return {
        listed: agents.length,
        targets,
        skipped,
        fingerprint: planFingerprint(targets),
    };
}
function sameTarget(a, b) {
    return a.id === b.id && a.agent_id === b.agent_id;
}
function previewData(inv, extra) {
    return {
        preview: extra?.preview ?? true,
        fingerprint: inv.fingerprint,
        confirm_token: ACCOUNT_CLEANUP_CONFIRM,
        listed: inv.listed,
        delete_count: inv.targets.length,
        skip_count: inv.skipped.length,
        targets: inv.targets,
        skipped: inv.skipped,
        warnings: [...ACCOUNT_CLEANUP_WARNINGS],
        ...extra,
    };
}
export class AccountCleanupOps {
    client;
    bot;
    computer;
    flags;
    constructor(client, bot, computer, flags = {}) {
        this.client = client;
        this.bot = bot;
        this.computer = computer;
        this.flags = flags;
    }
    sim(r) {
        if (this.flags.simulated)
            r.simulated = true;
        return r;
    }
    async cleanup(opts = {}, signal) {
        const request_id = newRequestId();
        let inv;
        try {
            inv = await this.loadInventory();
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
        if (opts.dryRun) {
            return this.sim(okResult(previewData(inv), { request_id, code: "dry_run" }));
        }
        const hint = `gbc account cleanup --dry-run  first, then ` +
            `gbc --allow-writes account cleanup --confirm=${ACCOUNT_CLEANUP_CONFIRM} --plan=${inv.fingerprint}`;
        if (opts.confirm !== ACCOUNT_CLEANUP_CONFIRM) {
            return this.sim(failResult("denied", `cleanup requires --confirm=${ACCOUNT_CLEANUP_CONFIRM}`, {
                request_id,
                hint,
                details: previewData(inv),
            }));
        }
        if (!opts.plan) {
            return this.sim(failResult("denied", "cleanup requires --plan=<fingerprint> from a preview of this exact target list", { request_id, hint, details: previewData(inv) }));
        }
        if (opts.plan !== inv.fingerprint) {
            return this.sim(failResult("denied", "approved plan does not match the current deletable bot list; no writes sent", {
                request_id,
                hint: "Re-run --dry-run and confirm the new fingerprint. A changed list is never deleted under an old plan.",
                details: previewData(inv, { stop_reason: "plan_mismatch" }),
            }));
        }
        if (!opts.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
            return this.sim(failResult("denied", "refusing account.cleanup: pass --allow-writes or GBT_ALLOW_WRITES=1", {
                request_id,
                hint: "Preview with --dry-run (no RPC writes). Real cleanup is destructive and is not a transaction.",
                details: previewData(inv),
            }));
        }
        const deletes = [];
        for (const target of inv.targets) {
            if (signal?.aborted) {
                return this.incomplete(request_id, inv, deletes, "canceled", "canceled", "unknown", "Cleanup stopped before reset. Already-deleted bots cannot be undone by this tool.");
            }
            const result = await this.bot.delete(target.id, {
                confirm: target.id,
                allowWrite: true,
            });
            if (result.ok && result.data) {
                deletes.push({
                    ...target,
                    ok: true,
                    code: result.code,
                    message: result.data.note,
                });
                continue;
            }
            deletes.push({
                ...target,
                ok: false,
                code: result.code,
                message: result.error?.message,
                outcome: result.outcome,
            });
            const outcome = result.outcome === "unknown" ? "unknown" : "known_failure";
            return this.incomplete(request_id, inv, deletes, result.code || "cleanup_incomplete", result.error?.message
                ? `delete stopped at ${target.id}: ${result.error.message}`
                : `delete stopped at ${target.id}`, outcome, "Cleanup stopped before computer reset. Already-deleted bots cannot be undone; inspect each delete result and do not retry an unknown write blindly.");
        }
        let after;
        try {
            after = await this.loadInventory();
        }
        catch (e) {
            const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
            return this.incomplete(request_id, inv, deletes, err.code, `post-delete list failed: ${err.message}`, err.outcome === "unknown" || err.retryable ? "unknown" : "known_failure", "Deletes finished but the follow-up list failed; computer reset was not started. Do not retry unknown writes blindly. Check `gbc bot list`.");
        }
        const plannedIds = new Set(inv.targets.map((t) => t.id));
        const residual = after.targets.filter((t) => plannedIds.has(t.id) || inv.targets.some((p) => sameTarget(p, t)));
        const unexpected = after.targets.filter((t) => !plannedIds.has(t.id));
        if (residual.length > 0) {
            return this.incomplete(request_id, inv, deletes, "cleanup_incomplete", "planned bots still present after delete; computer reset was not started", "known_failure", "Do not start computer reset or extra deletes automatically. Re-list with `gbc bot list` and inspect residual targets.", { residual, unexpected });
        }
        if (unexpected.length > 0) {
            return this.incomplete(request_id, inv, deletes, "cleanup_incomplete", "new deletable personal bots appeared after delete; computer reset was not started and they were not deleted", "known_failure", "Re-run --dry-run if you want a new plan. This tool will not delete bots that were not in the approved list.", { residual, unexpected });
        }
        const reset = await this.computer.reset({
            confirm: RESET_CONFIRM,
            allowWrite: true,
            hard: Boolean(opts.hard),
            wait: Boolean(opts.wait),
            timeoutSeconds: opts.timeoutSeconds,
        }, signal);
        const base = previewData(inv, {
            preview: false,
            deletes,
            deleted: deletes.filter((d) => d.ok).length,
            stopped_before_reset: false,
        });
        if (!reset.ok) {
            return this.sim({
                ...reset,
                data: undefined,
                error: {
                    message: reset.error?.message ?? "computer reset did not complete",
                    hint: reset.error?.hint ??
                        "Bots in the approved plan were deleted. Computer reset did not complete; this is not retried automatically. Check `gbc computer state`.",
                    details: {
                        ...base,
                        computer: reset.data ?? reset.error?.details,
                        recovery_hint: "Approved bot deletes already happened and cannot be undone. Inspect `gbc computer state` before considering another reset. A wait timeout or unknown reset outcome is not retried automatically.",
                    },
                },
            });
        }
        return this.sim(okResult({
            ...base,
            computer: reset.data,
        }, { request_id }));
    }
    async loadInventory() {
        const res = await this.client.listGrokBotAgents({});
        if (res.truncated) {
            throw new GbcError("lookup_incomplete", "ListGrokBotAgents was truncated; refusing cleanup because the inventory may be incomplete", {
                outcome: "unknown",
                hint: "A truncated list is not treated as the full account. No deletes or computer reset were sent.",
            });
        }
        return inventoryFromAgents(res.agents ?? []);
    }
    incomplete(request_id, inv, deletes, code, message, outcome, recovery_hint, extra) {
        const deleted = deletes.filter((d) => d.ok).length;
        return this.sim(failResult(code, message, {
            request_id,
            outcome,
            retryable: false,
            hint: recovery_hint,
            details: previewData(inv, {
                preview: false,
                deletes,
                deleted,
                stopped_before_reset: true,
                stop_reason: code,
                recovery_hint,
                ...extra,
            }),
        }));
    }
    fromErr(e, request_id) {
        const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
        return this.sim(failResult(err.code, err.message, {
            outcome: err.outcome,
            retryable: err.retryable,
            hint: err.hint,
            request_id,
            details: err.details,
        }));
    }
}
