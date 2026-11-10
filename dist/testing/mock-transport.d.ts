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
export type MockState = {
    bots: Array<Record<string, unknown>>;
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
};
export declare function createEmptyMockState(): MockState;
export declare function createMockTransport(state: MockState): import("@connectrpc/connect").Transport;
