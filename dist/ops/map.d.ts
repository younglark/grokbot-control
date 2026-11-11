import type { AgentTaskView, BotSummary, ChannelConnectionView, ClientActivityView, ProgressStatus, SessionSummary, SidebarSection, SubagentView, TodoItemView, TodoStatusView } from "../dto/types.js";
/** int64 from protobuf JSON/TS may be bigint | string | number — normalize to string. */
export declare function int64ToString(v: unknown): string | undefined;
export declare function mapBot(a: any): BotSummary;
export declare function mapSection(s: any): SidebarSection;
export declare function mapSession(s: any): SessionSummary;
export declare function mapStatus(s: any): ProgressStatus;
export declare function mapClientActivity(raw: unknown): ClientActivityView | undefined;
export declare function mapSlackConnection(raw: any): ChannelConnectionView | undefined;
export declare function mapTeamsConnection(raw: any): ChannelConnectionView | undefined;
export declare function mapChannelConnections(res: {
    slackConnections?: unknown;
    slack_connections?: unknown;
    teamsConnections?: unknown;
    teams_connections?: unknown;
}): ChannelConnectionView[];
export declare function mapTodoStatus(v: unknown): TodoStatusView;
/** Map a native TodoItem. Items without an id are dropped by the caller. */
export declare function mapTodo(t: any): TodoItemView | undefined;
/** Map a native GrokBotAgentTask. Items without an id are dropped by the caller. */
export declare function mapTask(t: any): AgentTaskView | undefined;
/** Map a native GrokBotRunningSubagent. Items without a subagent_id are dropped. */
export declare function mapSubagent(s: any): SubagentView | undefined;
export declare function mapTodos(raw: unknown): TodoItemView[];
export declare function mapTasks(raw: unknown): AgentTaskView[];
export declare function mapSubagents(raw: unknown): SubagentView[];
