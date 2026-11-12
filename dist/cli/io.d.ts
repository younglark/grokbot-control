import type { ResultEnvelope } from "../dto/result.js";
export type OutputMode = {
    /** When true, success stdout is r.data only. */
    plain: boolean;
    /** Compact JSON (no pretty indent). */
    compact: boolean;
};
/** Same object shape on TTY and pipes: full envelope, unless --plain. */
export declare function outputMode(globals: {
    json: boolean;
    plain: boolean;
}, isTTY: boolean): OutputMode;
export declare function writeOut(data: unknown, compact: boolean): void;
export declare function writeErrJson(data: unknown): void;
export declare function emitResult(r: ResultEnvelope, mode: OutputMode): number;
export declare function usageExit(message: string, hint?: string): never;
export declare function catchToExit(e: unknown, _mode?: OutputMode | boolean): number;
