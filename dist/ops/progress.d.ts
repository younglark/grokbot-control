import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { ProgressStatus } from "../dto/types.js";
export declare class ProgressOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
    private sim;
    status(agentIds: string[]): Promise<ResultEnvelope<{
        statuses: ProgressStatus[];
    }>>;
    todos(agentId: string): Promise<ResultEnvelope<{
        todos: unknown[];
    }>>;
    tasks(agentId: string): Promise<ResultEnvelope<{
        tasks: unknown[];
    }>>;
    subagents(agentId: string): Promise<ResultEnvelope<{
        subagents: unknown[];
    }>>;
    interrupt(agentId: string, opts: {
        confirm?: string;
        reason?: string;
        sessionId?: string;
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<{
        had_active_run?: boolean;
        note: string;
    }>>;
    private fromErr;
}
