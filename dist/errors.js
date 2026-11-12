/** Mapped application error with exit-code semantics. */
export class GbcError extends Error {
    code;
    retryable;
    outcome;
    hint;
    details;
    exitCode;
    constructor(code, message, opts) {
        super(message);
        this.name = "GbcError";
        this.code = code;
        this.retryable = opts?.retryable ?? false;
        this.outcome = opts?.outcome ?? "known_failure";
        this.hint = opts?.hint;
        this.details = opts?.details;
        this.exitCode = opts?.exitCode ?? mapExitCode(code, opts?.outcome, opts?.retryable);
    }
}
export function mapExitCode(code, outcome, retryable) {
    if (outcome === "unknown")
        return 10;
    if (retryable)
        return 8;
    switch (code) {
        case "usage":
        case "invalid_argument":
            return 2;
        case "unauthenticated":
        case "auth":
            return 4;
        case "not_found":
        case "message_not_found":
            return 5;
        case "conflict":
        case "sidebar_conflict":
        case "ambiguous_match":
            return 6;
        case "denied":
        case "refused":
        case "message_rejected":
        case "permission_denied":
        case "failed_precondition":
            return 7;
        case "unavailable":
        case "deadline_exceeded":
            return 8;
        case "unsupported":
            return 9;
        case "ok":
            return 0;
        default:
            return 9;
    }
}
/** CLI exit codes (documented in --help; meanings must not change). */
export const EXIT = {
    SUCCESS: 0,
    ERROR: 1,
    USAGE: 2,
    AUTH: 4,
    NOT_FOUND: 5,
    CONFLICT: 6,
    DENIED: 7,
    RETRYABLE: 8,
    FAILURE: 9,
    UNKNOWN: 10,
};
