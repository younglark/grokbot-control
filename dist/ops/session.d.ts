import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { SessionSummary } from "../dto/types.js";
export declare class SessionOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
    list(agentId: string, opts?: {
        limit?: number;
        offset?: number;
    }): Promise<ResultEnvelope<{
        sessions: SessionSummary[];
        truncated: boolean;
        next?: string;
        hint?: string;
    }>>;
}
