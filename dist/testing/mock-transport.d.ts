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
    /** EnsureSandBox (wake): keep the computer hibernated (wake not honoured). */
    wakeStaysHibernated?: boolean;
    /** EnsureSandBox (wake): GetSandBoxRunState reads that still report starting (default 1). */
    wakeReadsUntilRunning?: number;
    /** Internal: remaining starting reads after a simulated wake. */
    wakePendingReads?: number;
};
/**
 * Fake credential values returned by the mock EnsureSandBox. Tests assert none of
 * these ever reach stdout, stderr, MCP results, or error details.
 */
export declare const MOCK_ENSURE_SECRETS: {
    readonly networkToken: "FAKE-network-token-6f1c";
    readonly execDaemonAuthToken: "FAKE-exec-daemon-auth-token-91ab";
    readonly execDaemonUrl: "https://exec-daemon.fake-secret.invalid/x";
    readonly vncUrl: "https://vnc.fake-secret.invalid/?token=FAKE-vnc";
    readonly gatewayUrl: "https://gateway.fake-secret.invalid/";
    readonly gatewayToken: "FAKE-gateway-token-3d2e";
    readonly forkVncBaseUrl: "https://fork-vnc.fake-secret.invalid/";
    readonly gatewayPortToken: "FAKE-gateway-port-token-77";
    readonly egressTunnelPortToken: "FAKE-egress-port-token-88";
    readonly forkVncPortToken: "FAKE-fork-vnc-port-token-99";
    readonly cluster: "fake-cluster-secret";
    readonly tenantId: "fake-tenant-secret";
    readonly podId: "fake-pod-secret";
    readonly terminalsFolder: "/fake/terminals-secret";
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
    /** Test hook: SendGrokBotUserMessage response (e.g. { dispatched: false, delivery: 4, refusal }). */
    sendResponse?: Record<string, unknown>;
    /** Test hook: GetGrokBotSendStatus response. */
    sendStatusResponse?: Record<string, unknown>;
    /**
     * Test hook for `message wait`: GetGrokBotSendStatus responses served in order; the last
     * one repeats. Wins over sendStatusResponse.
     */
    sendStatusSequence?: Array<Record<string, unknown>>;
    /**
     * Test hook for `message wait`: per-agent ListGrokBotAgentStatuses rows served in order
     * (simulate running → settled, lastTurnSettlement, hasRunningSubagents…); the last repeats.
     */
    statusSequence?: Record<string, Array<Record<string, unknown>>>;
    /** Last ListGrokBotTranscriptEntries request as seen by the server (after wire decode). */
    lastTranscriptRequest?: {
        agentId: string;
        sessionId: string;
        limit: number;
    };
    /** Test hook: override the synthetic generation. */
    transcriptGeneration?: number;
    /** When true, ListGrokBotAgents returns truncated=true (incomplete inventory). */
    listTruncated?: boolean;
    /** Last EnsureSandBox request and headers seen by the mock server. */
    lastEnsureRequest?: {
        req: unknown;
        parkHeader: string | null;
    };
    /** Recorded write RPCs (delete / recreate / force-recreate / ensure). */
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
    /**
     * Simulate the server behaviour observed in issue #3: on create/update with a
     * non-empty title, store name as "<name> · <title>" and clear title.
     */
    mergeTitleIntoName?: boolean;
    /**
     * Simulate read-after-write lag: a newly created agent is hidden from the next
     * N ListGrokBotAgents calls. Use Infinity to keep it hidden forever.
     */
    createVisibilityDelayLists?: number;
    /** Per-agent remaining hidden list reads (managed by the mock). */
    hiddenAgentLists?: Record<string, number>;
    /** Fail ListGrokBotAgents only after this many more successful calls (then fail until cleared). */
    failListAgentsAfter?: number;
    /** Number of UpdateGrokBotUserRuntimeSettings calls received (sidebar writes). */
    sidebarWrites?: number;
    /** Number of CreateGrokBotTemporalAgent calls received. */
    createCalls?: number;
};
export declare function createEmptyMockState(): MockState;
export declare function emptyCallCounts(): MockCallCounts;
/** Synthetic GetSandUsageStatus responses. Numbers are fixtures, not live data. */
export declare function usageFixtureResponse(name: MockUsageFixture): Record<string, unknown>;
/** Synthetic GetGrokBotUsageBreakdown responses. Numbers are fixtures, not live data. */
export declare function usageBreakdownFixtureResponse(name: MockBreakdownFixture): Record<string, unknown>;
export declare function createMockTransport(state: MockState): import("@connectrpc/connect").Transport;
