import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { AgentTaskView, ProgressStatus, SubagentView, TodoItemView } from "../dto/types.js";
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
        todos: TodoItemView[];
    }>>;
    tasks(agentId: string): Promise<ResultEnvelope<{
        tasks: AgentTaskView[];
    }>>;
    subagents(agentId: string): Promise<ResultEnvelope<{
        subagents: SubagentView[];
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
