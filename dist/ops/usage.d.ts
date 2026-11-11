import type { DashboardServiceClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { UsageBreakdownRow, UsageBreakdownView, UsageStatusView } from "../dto/types.js";
/**
 * Read-only wrapper around official DashboardService.GetSandUsageStatus.
 * The local CLI command `gbc dashboard` uses this helper; it is not a general
 * DashboardService facade. Official write RPCs are never called here.
 * GetGrokBotUsageBreakdown is called without enterprise_team_id; this wrapper
 * never invents a team id.
 */
export declare class UsageOps {
    private client;
    private flags;
    constructor(client: DashboardServiceClient, flags?: {
        simulated?: boolean;
    });
    private sim;
    /** Empty GetSandUsageStatusRequest only. */
    status(): Promise<ResultEnvelope<UsageStatusView>>;
    /**
     * Official GetGrokBotUsageBreakdown with an empty request (no team id).
     * Do not guess enterprise_team_id to reach spend/events.
     */
    breakdown(): Promise<ResultEnvelope<UsageBreakdownView>>;
    private fail;
}
/** Map a GetSandUsageStatusResponse into a UI DTO. Never invents numbers or URLs. */
export declare function mapUsageStatus(raw: unknown): UsageStatusView;
/** Map a GetGrokBotUsageBreakdownResponse. Never invents a team id or currency. ppm is kept raw; the UI converts it to a percentage. */
export declare function mapUsageBreakdown(raw: unknown): UsageBreakdownView;
/** Rows in a breakdown whose bot_id matches this Bot (agent_id or bot id). */
export declare function breakdownRowsForBot(breakdown: UsageBreakdownView | undefined, ids: {
    agent_id?: string;
    bot_id?: string;
}): UsageBreakdownRow[];
