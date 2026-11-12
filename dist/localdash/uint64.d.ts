/** Unsigned decimal integer helpers. Never coerce uint64 through Number. */
export declare function isUint64String(value: string): boolean;
/** Normalize a decimal string, preserving a single zero. */
export declare function normalizeUint64(value: string): string | undefined;
/**
 * Convert a protobuf uint64 / int64-like value to a decimal string.
 * Values already past Number.MAX_SAFE_INTEGER as a JS number are rejected.
 */
export declare function uint64ToString(value: unknown): string | undefined;
/** Compare two unsigned decimal strings. Undefined if either is not a uint64. */
export declare function compareUint64(a: string, b: string): number | undefined;
export type SourceVersion = {
    kind: "known";
    value: string;
} | {
    kind: "unknown";
};
export declare function sourceVersionFromUpdatedSeq(updatedSeq: string | undefined): SourceVersion;
export declare function formatSourceVersion(version: SourceVersion): string;
export type VersionDecision = "apply" | "idempotent" | "reject_older" | "keep_existing_known";
/** Local snapshotRevision must never be used as a stand-in for sourceVersion. */
export declare function decideSourceVersion(existing: SourceVersion, incoming: SourceVersion): VersionDecision;
