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
export type ComputerWakeOpts = {
    wait?: boolean;
    timeoutSeconds?: number;
    dryRun?: boolean;
    allowWrite?: boolean;
    /** Test hook: GetSandBoxRunState poll interval while waiting (default 3000ms). */
    pollIntervalMs?: number;
};
/**
 * Non-secret subset of a run state. EnsureSandBoxResponse also carries
 * credentials and endpoints (network_token, exec_daemon_auth_token,
 * gateway_token, *_port_token, vnc_url, gateway_url, exec_daemon_url,
 * fork_vnc_base_url, cluster/tenant/pod ids). None of those are ever copied.
 */
export type ComputerWakeRunState = {
    state: string;
    state_code: number;
    image_update_available?: boolean;
};
export type ComputerWakeAction = "wake" | "already_running" | "already_starting" | "would_wake" | "would_skip" | "would_refuse";
export type ComputerWakeData = {
    action: ComputerWakeAction;
    /** True only when EnsureSandBox was dispatched. */
    write_sent: boolean;
    rpc: "EnsureSandBox";
    /** Exact EnsureSandBoxRequest sent (or that would be sent): no fields set, no extra headers. */
    request: Record<string, never>;
    before: ComputerState;
    /** run_state/image_update_available from EnsureSandBoxResponse only (whitelist). */
    ensure_response?: ComputerWakeRunState;
    /** Last GetSandBoxRunState read-back (absent for dry-run). */
    after?: ComputerState;
    running: boolean;
    wait?: {
        requested: true;
        completed: boolean;
        polls: number;
        timeout_seconds: number;
    };
    evidence: "static_inference_not_live_verified";
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
    /**
     * Non-destructive wake of the shared computer (issue #5).
     *
     * Evidence (docs/protocol/computer-wake-0.79.4.md): the official App wakes a
     * hibernated computer through `connect()` -> `EnsureSandBox({})` with neither
     * `wake` nor `supports_asleep_box` set; `wake:false` / `supports_asleep_box:true`
     * are the App's non-waking probes. The App's optional `x-sand-box-park` header
     * is driven by App feature gates and is NOT sent here. Not live-verified.
     *
     * Never calls RecreateSandBox / ForceRecreateSandBox / EnsureSandBoxWindow, and
     * never copies credentials or URLs from EnsureSandBoxResponse.
     */
    wake(opts?: ComputerWakeOpts, signal?: AbortSignal): Promise<ResultEnvelope<ComputerWakeData>>;
    private waitForMigration;
    private fromErr;
}
