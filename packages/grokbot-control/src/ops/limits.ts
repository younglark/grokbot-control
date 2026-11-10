import { GbcError } from "../errors.js";

/** Documented list caps (CLI/MCP/SDK share these). */
export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 1000;

export type ListPageMeta = {
  truncated: boolean;
  next?: string;
  hint?: string;
};

/**
 * Client-side window over an already-fetched list. `next` is a 0-based offset
 * that can be passed back as `offset` / `--offset`.
 */
export function paginate<T>(
  all: T[],
  limit: number,
  offset = 0,
): { items: T[] } & ListPageMeta {
  const start = offset < 0 ? 0 : offset;
  const items = all.slice(start, start + limit);
  const truncated = start + items.length < all.length;
  const next = truncated ? String(start + items.length) : undefined;
  const hint = truncated
    ? `Showing ${items.length} of ${all.length} starting at offset ${start}. Pass a higher limit (max ${LIMIT_MAX}) or offset=${next}.`
    : undefined;
  return { items, truncated, next, hint };
}

/**
 * Validate a list limit. undefined -> default. Anything not a positive integer
 * <= LIMIT_MAX throws invalid_argument (exit 2) — never silently empty.
 */
export function validateLimit(v: unknown, max = LIMIT_MAX): number {
  if (v === undefined || v === null) return LIMIT_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
    throw new GbcError(
      "invalid_argument",
      `limit must be an integer in 1..${max} (got: ${String(v)})`,
      {
        exitCode: 2,
        hint: `pass limit in 1..${max} (CLI: --limit=50; MCP: limit=50)`,
      },
    );
  }
  return v;
}

/** Validate a 0-based list offset. undefined -> 0. */
export function validateOffset(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new GbcError(
      "invalid_argument",
      `offset must be an integer >= 0 (got: ${String(v)})`,
      {
        exitCode: 2,
        hint: "pass offset >= 0 (CLI: --offset=0; MCP: offset=0)",
      },
    );
  }
  return v;
}

/** Parse a CLI string limit strictly (digits only). */
export function parseCliLimit(raw: string | undefined, max = LIMIT_MAX): number {
  if (raw === undefined) return LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw)) {
    throw new GbcError("usage", `--limit must be an integer in 1..${max} (got: "${raw}")`, {
      exitCode: 2,
      hint: `gbc ... --limit=50`,
    });
  }
  return validateLimit(Number(raw), max);
}

/** Parse a CLI string offset strictly (digits only). */
export function parseCliOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new GbcError("usage", `--offset must be an integer >= 0 (got: "${raw}")`, {
      exitCode: 2,
      hint: "gbc ... --offset=0",
    });
  }
  return validateOffset(Number(raw));
}
