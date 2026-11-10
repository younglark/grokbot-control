/** Stable CLI/MCP envelope. schema_version only increases; fields only add. */
export const SCHEMA_VERSION = "1.0.0";
export function newRequestId() {
    return crypto.randomUUID();
}
export function okResult(data, opts) {
    return {
        schema_version: SCHEMA_VERSION,
        ok: true,
        outcome: "known_success",
        code: opts?.code ?? "ok",
        retryable: false,
        request_id: opts?.request_id ?? newRequestId(),
        data,
        simulated: opts?.simulated,
    };
}
export function failResult(code, message, opts) {
    return {
        schema_version: SCHEMA_VERSION,
        ok: false,
        outcome: opts?.outcome ?? "known_failure",
        code,
        retryable: opts?.retryable ?? false,
        request_id: opts?.request_id ?? newRequestId(),
        error: { message, hint: opts?.hint, details: opts?.details },
        simulated: opts?.simulated,
    };
}
