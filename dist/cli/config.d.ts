import type { AuthKind, LoginMode } from "../auth/types.js";
import { ControlPlane } from "../ops/plane.js";
import type { MockState } from "../testing/mock-transport.js";
export type CliGlobal = {
    json: boolean;
    /** When true, success stdout is data only (no envelope). */
    plain: boolean;
    allowWrites: boolean;
    dryRun: boolean;
    baseUrl: string;
    authKind: AuthKind;
    /** Optional login URL preset from --login-mode or GBT_LOGIN_MODE; undefined means provider/env default (cli). */
    loginMode?: LoginMode;
    mock: boolean;
    trustBackend: boolean;
};
export declare function parseGlobals(argv: string[]): {
    globals: CliGlobal;
    rest: string[];
};
/**
 * Value flag lookup. `--x=value` always takes value verbatim (use this form for
 * values beginning with "-"). `--x value` form: a missing value or a next token
 * starting with "--" is a usage error (exit 2) — never swallow the next flag.
 */
export declare function flag(rest: string[], name: string): string | undefined;
export declare function hasFlag(rest: string[], name: string): boolean;
export declare function buildPlane(globals: CliGlobal): ControlPlane;
export declare function persistMockState(): void;
export declare function getMockState(): MockState | undefined;
