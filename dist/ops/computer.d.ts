import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
export declare const RESET_CONFIRM = "RESET_COMPUTER";
export type ComputerState = {
    state: string;
    state_code: number;
    image_update_available?: boolean;
    egress_tunnel_ownership?: boolean;
    image?: {
        registry_tag?: string;
        static_snapshot_path?: string;
    };
};
export type ComputerMigrationEvent = {
    phase: string;
    detail: string;
    at_ms: string;
    offset_key: string;
    operation_id: string;
};
export type ComputerResetOpts = {
    confirm?: string;
    hard?: boolean;
    wait?: boolean;
    timeoutSeconds?: number;
    dryRun?: boolean;
    allowWrite?: boolean;
};
export type ComputerResetWait = {
    requested: true;
    completed: boolean;
    status?: "done" | "failed";
    reason?: string;
    last_phase?: string;
    last_detail?: string;
    events: ComputerMigrationEvent[];
};
export type ComputerResetData = {
    started: boolean;
    operation_id: string;
    hard: boolean;
    preserve_data: false;
    tracking: "operation" | "untrackable";
    wait?: ComputerResetWait;
};
export declare class ComputerOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
    private sim;
    state(): Promise<ResultEnvelope<ComputerState>>;
    reset(opts?: ComputerResetOpts, signal?: AbortSignal): Promise<ResultEnvelope<ComputerResetData>>;
    private waitForMigration;
    private fromErr;
}
