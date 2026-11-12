/** Stable CLI/MCP envelope. schema_version only increases; fields only add. */
export declare const SCHEMA_VERSION: "1.0.0";
export type Outcome = "known_success" | "known_failure" | "unknown";
export type ResultEnvelope<T = unknown> = {
    schema_version: typeof SCHEMA_VERSION;
    ok: boolean;
    outcome: Outcome;
    code: string;
    retryable: boolean;
    request_id: string;
    data?: T;
    error?: {
        message: string;
        hint?: string;
        details?: unknown;
    };
    /** When true, response came from explicit mock/sim transport — never claim live. */
    simulated?: boolean;
};
export declare function newRequestId(): string;
export declare function okResult<T>(data: T, opts?: {
    request_id?: string;
    simulated?: boolean;
    code?: string;
}): ResultEnvelope<T>;
export declare function failResult(code: string, message: string, opts?: {
    outcome?: Outcome;
    retryable?: boolean;
    hint?: string;
    request_id?: string;
    details?: unknown;
    simulated?: boolean;
}): ResultEnvelope<never>;
