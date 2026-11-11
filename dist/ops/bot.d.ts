import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { BotSummary, ChannelConnectionView } from "../dto/types.js";
export type WriteOpts = {
    dryRun?: boolean;
    /** Required for delete: must equal agent_id. */
    confirm?: string;
    allowWrite?: boolean;
};
export declare class BotOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
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
    create(input: {
        name: string;
        description?: string;
        title?: string;
        agentId?: string;
        language?: string;
        kickstart?: boolean;
    }, write?: WriteOpts): Promise<ResultEnvelope<{
        bot: BotSummary;
        agent_id: string;
    }>>;
    update(agentId: string, patch: {
        name?: string;
        description?: string;
        title?: string;
    }, write?: WriteOpts): Promise<ResultEnvelope<{
        bot: BotSummary;
    }>>;
    delete(agentId: string, write?: WriteOpts): Promise<ResultEnvelope<{
        deleted: boolean;
        note: string;
    }>>;
    private fromErr;
}
