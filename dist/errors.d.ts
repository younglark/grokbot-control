import type { Outcome } from "./dto/result.js";
/** Mapped application error with exit-code semantics. */
export declare class GbcError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly outcome: Outcome;
    readonly hint?: string;
    readonly details?: unknown;
    readonly exitCode: number;
    constructor(code: string, message: string, opts?: {
        retryable?: boolean;
        outcome?: Outcome;
        hint?: string;
        details?: unknown;
        exitCode?: number;
    });
}
export declare function mapExitCode(code: string, outcome?: Outcome, retryable?: boolean): number;
/** CLI exit codes (documented in --help; meanings must not change). */
export declare const EXIT: {
    readonly SUCCESS: 0;
    readonly ERROR: 1;
    readonly USAGE: 2;
    readonly AUTH: 4;
    readonly NOT_FOUND: 5;
    readonly CONFLICT: 6;
    readonly DENIED: 7;
    readonly RETRYABLE: 8;
    readonly FAILURE: 9;
    readonly UNKNOWN: 10;
};
