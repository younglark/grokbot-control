/** Unsigned decimal integer helpers. Never coerce uint64 through Number. */

const UINT64_RE = /^[0-9]+$/;

export function isUint64String(value: string): boolean {
  return UINT64_RE.test(value);
}

/** Normalize a decimal string, preserving a single zero. */
export function normalizeUint64(value: string): string | undefined {
  if (!isUint64String(value)) return undefined;
  const stripped = value.replace(/^0+(?=\d)/, "");
  return stripped;
}

/**
 * Convert a protobuf uint64 / int64-like value to a decimal string.
 * Values already past Number.MAX_SAFE_INTEGER as a JS number are rejected.
 */
export function uint64ToString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") {
    if (value < 0n) return undefined;
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return normalizeUint64(trimmed);
  }
  if (typeof value === "object" && "toString" in (value as object)) {
    const text = String((value as { toString: () => string }).toString());
    return normalizeUint64(text);
  }
  return undefined;
}

/** Compare two unsigned decimal strings. Undefined if either is not a uint64. */
export function compareUint64(a: string, b: string): number | undefined {
  const left = normalizeUint64(a);
  const right = normalizeUint64(b);
  if (left === undefined || right === undefined) return undefined;
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export type SourceVersion = { kind: "known"; value: string } | { kind: "unknown" };

export function sourceVersionFromUpdatedSeq(updatedSeq: string | undefined): SourceVersion {
  if (updatedSeq === undefined) return { kind: "unknown" };
  const value = normalizeUint64(updatedSeq);
  if (value === undefined) return { kind: "unknown" };
  return { kind: "known", value };
}

export function formatSourceVersion(version: SourceVersion): string {
  return version.kind === "known" ? version.value : "unknown";
}

export type VersionDecision = "apply" | "idempotent" | "reject_older" | "keep_existing_known";

/** Local snapshotRevision must never be used as a stand-in for sourceVersion. */
export function decideSourceVersion(existing: SourceVersion, incoming: SourceVersion): VersionDecision {
  if (existing.kind === "known" && incoming.kind === "known") {
    const cmp = compareUint64(incoming.value, existing.value);
    if (cmp === undefined) return "keep_existing_known";
    if (cmp > 0) return "apply";
    if (cmp === 0) return "idempotent";
    return "reject_older";
  }
  if (existing.kind === "known" && incoming.kind === "unknown") return "keep_existing_known";
  if (existing.kind === "unknown" && incoming.kind === "known") return "apply";
  return "apply";
}
