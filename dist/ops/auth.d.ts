import type { AuthProvider } from "../auth/types.js";
import { type ResultEnvelope } from "../dto/result.js";
export declare const AUTH_TIMEOUT_MAX_S = 900;
/** Shared CLI/MCP auth operations. Results never contain verifier/access/refresh tokens. */
export declare class AuthOps {
    private auth;
    private flags;
    constructor(auth: AuthProvider | undefined, flags?: {
        simulated?: boolean;
    });
    private guard;
    private run;
    whoami(): Promise<ResultEnvelope<never>> | Promise<{
        simulated: boolean | undefined;
        schema_version: typeof import("../dto/result.js").SCHEMA_VERSION;
        ok: boolean;
        outcome: import("../dto/result.js").Outcome;
        code: string;
        retryable: boolean;
        request_id: string;
        data?: import("../auth/types.js").WhoamiLocal | undefined;
        error?: {
            message: string;
            hint?: string;
            details?: unknown;
        };
    }>;
    begin(opts?: {
        loginMode?: string;
        redirectTarget?: string;
    }): Promise<ResultEnvelope<import("../auth/types.js").AuthBeginResult>>;
    /** Single poll; pending -> ok:false code auth_pending retryable (safe: read-only poll). */
    poll(): Promise<ResultEnvelope<import("../auth/types.js").AuthCompleteResult>>;
    complete(timeoutSeconds?: number, signal?: AbortSignal): Promise<ResultEnvelope<import("../auth/types.js").AuthCompleteResult>>;
    cancel(): Promise<ResultEnvelope<{
        had_pending: boolean;
    }>>;
    /**
     * Refresh credentials. Without force: may return refreshed:false / reason already_fresh
     * when the token is still outside the 5-minute early window (no network call).
     * With force: always attempts a network refresh (for verification / 401 recovery).
     */
    refresh(opts?: {
        force?: boolean;
    }): Promise<ResultEnvelope<import("../auth/types.js").RefreshResult>>;
    logout(): Promise<ResultEnvelope<{
        note: string;
        removed_credential: boolean;
        removed_pending: boolean;
    }>>;
}
