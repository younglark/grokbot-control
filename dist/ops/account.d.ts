import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { BotOps, WriteOpts } from "./bot.js";
import type { ComputerOps, ComputerResetData } from "./computer.js";
/** Intent token for `account cleanup`. Bind the approved inventory with `--plan`. */
export declare const ACCOUNT_CLEANUP_CONFIRM = "ACCOUNT_CLEANUP";
export declare const ACCOUNT_CLEANUP_WARNINGS: readonly ["This deletes only the listed personal bots you own, then recreates the shared computer with preserve_data=false.", "This is not a full account reset. It does not cancel a subscription, delete the account, or claim to clear sessions, connectors, Library, skills/routines, or all cloud data.", "Side effects of DeleteGrokBotAgent and RecreateSandBox are not live-verified. The flow is not a transaction; already-deleted bots cannot be undone by this tool.", "Computer reset cannot be canceled after it starts. Do not start another reset while one may still be running."];
export type CleanupSkipReason = "missing_server_id" | "ownership_unknown" | "not_owner" | "team" | "shared" | "group_access" | "room";
export type CleanupTarget = {
    id: string;
    agent_id: string;
    name: string;
};
export type CleanupSkipped = {
    id: string;
    agent_id: string;
    name: string;
    reason: CleanupSkipReason;
};
export type CleanupDeleteResult = CleanupTarget & {
    ok: boolean;
    code?: string;
    message?: string;
    outcome?: string;
};
export type AccountCleanupOpts = WriteOpts & {
    confirm?: string;
    /** Fingerprint from a preview of this exact target list. */
    plan?: string;
    hard?: boolean;
    wait?: boolean;
    timeoutSeconds?: number;
};
export type AccountCleanupData = {
    preview: boolean;
    fingerprint: string;
    confirm_token: typeof ACCOUNT_CLEANUP_CONFIRM;
    listed: number;
    delete_count: number;
    skip_count: number;
    targets: CleanupTarget[];
    skipped: CleanupSkipped[];
    warnings: string[];
    deletes?: CleanupDeleteResult[];
    deleted?: number;
    stopped_before_reset?: boolean;
    stop_reason?: string;
    residual?: CleanupTarget[];
    unexpected?: CleanupTarget[];
    computer?: ComputerResetData;
    recovery_hint?: string;
};
export declare function planFingerprint(targets: CleanupTarget[]): string;
/** Classify one ListGrokBotAgents row. Missing ownership fields are not guessed. */
export declare function classifyListedAgent(rawUnknown: unknown): CleanupTarget | CleanupSkipped;
export declare class AccountCleanupOps {
    private client;
    private bot;
    private computer;
    private flags;
    constructor(client: GrokBotClient, bot: BotOps, computer: ComputerOps, flags?: {
        simulated?: boolean;
    });
    private sim;
    cleanup(opts?: AccountCleanupOpts, signal?: AbortSignal): Promise<ResultEnvelope<AccountCleanupData>>;
    private loadInventory;
    private incomplete;
    private fromErr;
}
