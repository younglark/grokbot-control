import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { BotSummary, ChannelConnectionView } from "../dto/types.js";
/** Name/title pair as sent to (requested) or read back from (observed) the server. */
export type BotNameTitle = {
    name: string;
    title: string;
};
/**
 * Read-back comparison after a successful create/update.
 * `requested` fields are null on update when that field was not part of the patch.
 */
export type BotReadback = {
    requested: {
        name: string | null;
        title: string | null;
    };
    observed: BotNameTitle;
    /** True when any requested field differs from the read-back (e.g. title merged into name). */
    renamed_by_server: boolean;
    /** Fields whose read-back differs from the request. */
    changed_fields: Array<"name" | "title">;
    readback: {
        source: "ListGrokBotAgents";
        attempts: number;
    };
};
export type BotCreateData = BotReadback & {
    /** The bot as read back from ListGrokBotAgents (authoritative display name). */
    bot: BotSummary;
    agent_id: string;
    /** True when ifExists: "reuse" matched an existing bot; no create was sent. */
    existing: boolean;
    /** How the existing bot was matched (only when existing is true). */
    matched_by?: "agent_id" | "name" | "merged_name";
    /** Only under --dry-run. */
    would?: "create" | "reuse";
    note?: string;
};
export type BotIfExists = "reuse";
/**
 * Separator the server has been observed to use when it folds title into the display
 * name (issue #3: "Showrunner · 幕僚长"). Same as the mock in src/testing/mock-transport.ts.
 */
export declare const TITLE_MERGE_SEPARATOR = " \u00B7 ";
/** Display names an existing bot may carry for a create request: name, or "<name> · <title>". */
export declare function botNameForms(name: string, title?: string): string[];
export type BotUpdateData = BotReadback & {
    bot: BotSummary;
    note?: string;
};
export type BotOpsOptions = {
    simulated?: boolean;
    /**
     * Delays (ms) before read-back retries. Default [300, 900]: at most 3 list
     * reads, ~1.2s of sleeping, and never past READBACK_BUDGET_MS. Only "agent not
     * in a complete list" is retried; a found agent is final.
     */
    readbackDelaysMs?: number[];
};
export declare const READBACK_DELAYS_MS: readonly [300, 900];
export declare const READBACK_BUDGET_MS = 3000;
/** Observed (issue #3), not proven by client reverse engineering. */
export declare const TITLE_MERGE_NOTE = "The server has been observed to merge title into the display name (e.g. \"Showrunner \u00B7 \u5E55\u50DA\u957F\") and clear title; not guaranteed for every account. No client-side evidence for this in the App bundle.";
export type WriteOpts = {
    dryRun?: boolean;
    /** Required for delete: must equal agent_id. */
    confirm?: string;
    allowWrite?: boolean;
};
export declare class BotOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: BotOpsOptions);
    /**
     * Read one agent back from ListGrokBotAgents with short retries while it is
     * absent from a complete list. Returns found bot or the reason it was not
     * verified. Never throws.
     */
    private readBack;
    private wrapSim;
    /** Update/Delete RPC `id` is the numeric server id (App: serverId); accept agent_id UUID by resolving via list. */
    private serverId;
    list(opts?: {
        limit?: number;
        offset?: number;
    }): Promise<ResultEnvelope<{
        bots: BotSummary[];
        truncated: boolean;
        next?: string;
        hint?: string;
        channels: ChannelConnectionView[];
    }>>;
    /** No GetBot RPC — filter ListGrokBotAgents client-side (full server page, not the user-facing cap). */
    get(agentId: string): Promise<ResultEnvelope<{
        bot: BotSummary;
    }>>;
    /**
     * Lookup for ifExists: "reuse". ListGrokBotAgents has no name filter or idempotency
     * key, so this lists once and matches client-side. Never writes.
     */
    private findExisting;
    create(input: {
        name: string;
        description?: string;
        title?: string;
        agentId?: string;
        language?: string;
        kickstart?: boolean;
    }, write?: WriteOpts, opts?: {
        ifExists?: BotIfExists;
    }): Promise<ResultEnvelope<BotCreateData>>;
    update(agentId: string, patch: {
        name?: string;
        description?: string;
        title?: string;
    }, write?: WriteOpts): Promise<ResultEnvelope<BotUpdateData>>;
    delete(agentId: string, write?: WriteOpts): Promise<ResultEnvelope<{
        deleted: boolean;
        note: string;
    }>>;
    private fromErr;
}
export declare function compareReadback(requested: {
    name: string | null;
    title: string | null;
}, bot: BotSummary, attempts: number): BotReadback;
