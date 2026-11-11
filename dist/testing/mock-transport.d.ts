import type { SidebarSection } from "../dto/types.js";
export type MockSandboxState = {
    state: number;
    imageUpdateAvailable?: boolean;
    image?: {
        registryTag?: string;
        staticSnapshotPath?: string;
    };
    recreateStarted?: boolean;
    recreateReason?: string;
    operationId?: string;
    migrationPhases?: Array<{
        phase: number;
        detail?: string;
    }>;
};
export type MockUsageFixture = "normal" | "near_exhausted" | "exhausted" | "unlimited" | "enterprise_shared" | "failure";
export type MockBreakdownFixture = "cents_by_source" | "cents_by_bot" | "ppm_weekly" | "ppm_billing" | "empty" | "failure";
export type MockCallCounts = {
    listGrokBotAgents: number;
    listGrokBotAgentStatuses: number;
    getSandBoxRunState: number;
    getGrokBotUserRuntimeSettings: number;
    getSandUsageStatus: number;
    getGrokBotUsageBreakdown: number;
    listGrokBotAgentTodos: number;
    listGrokBotAgentTasks: number;
    listGrokBotSubagents: number;
    listGrokBotAgentSessions: number;
    listGrokBotTranscriptEntries: number;
};
export type MockState = {
    bots: Array<Record<string, unknown>>;
    /** Official GetSandUsageStatus fixture for the local `gbc dashboard` monitor. */
    usageFixture?: MockUsageFixture;
    /** Official GetGrokBotUsageBreakdown fixture. */
    breakdownFixture?: MockBreakdownFixture;
    /** Last GetGrokBotUsageBreakdown request (to assert no team id). */
    lastUsageBreakdownRequest?: unknown;
    callCounts?: MockCallCounts;
    sections: SidebarSection[];
    /** Force next sidebar update to conflict. */
    forceSidebarConflict?: boolean;
    /** Drop next write response (simulate unknown). */
    dropNextWrite?: boolean;
    messages: Array<Record<string, unknown>>;
    statuses: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    todos: unknown[];
    tasks: unknown[];
    subagents: unknown[];
    transcript: unknown[];
    sandbox: MockSandboxState;
    slackConnections?: Array<Record<string, unknown>>;
    teamsConnections?: Array<Record<string, unknown>>;
    /** Test hook: next transcript reads throw. */
    failTranscript?: boolean;
    /** Test hooks: force the named read RPC to fail. */
    failListAgents?: boolean;
    failStatuses?: boolean;
    failSandbox?: boolean;
    failTodos?: boolean;
    failTasks?: boolean;
    failSessions?: boolean;
    /** Test hook: override the synthetic generation. */
    transcriptGeneration?: number;
    /** When true, ListGrokBotAgents returns truncated=true (incomplete inventory). */
    listTruncated?: boolean;
    /** Recorded write RPCs (delete / recreate / force-recreate). */
    writeCalls?: Array<{
        method: string;
        req: unknown;
    }>;
    /** Per-server-id delete hook: throw instead of removing the bot. */
    deleteErrorById?: Record<string, "permission" | "unknown">;
    /** Delete RPC succeeds but the bot is left in the list (residual). */
    retainAfterDeleteIds?: string[];
    /** Owned bots appended to later lists after at least one delete write. */
    afterDeleteInjectBots?: Array<Record<string, unknown>>;
};
export declare function createEmptyMockState(): MockState;
export declare function emptyCallCounts(): MockCallCounts;
/** Synthetic GetSandUsageStatus responses. Numbers are fixtures, not live data. */
export declare function usageFixtureResponse(name: MockUsageFixture): Record<string, unknown>;
/** Synthetic GetGrokBotUsageBreakdown responses. Numbers are fixtures, not live data. */
export declare function usageBreakdownFixtureResponse(name: MockBreakdownFixture): Record<string, unknown>;
export declare function createMockTransport(state: MockState): import("@connectrpc/connect").Transport;
