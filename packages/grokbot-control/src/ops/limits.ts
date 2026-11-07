import { GbcError } from "../errors.js";

/** Documented list caps (CLI/MCP/SDK share these). */
export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 1000;

/**
 * Validate a list limit. undefined -> default. Anything not a positive integer
 * <= LIMIT_MAX throws invalid_argument (exit 2) — never silently empty.
 */
export function validateLimit(v: unknown, max = LIMIT_MAX): number {
  if (v === undefined || v === null) return LIMIT_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) {
    throw new GbcError("invalid_argument", `limit must be an integer in 1..${max} (got: ${String(v)})`, {
      exitCode: 2,
      hint: `pass --limit=<1..${max}>`,
    });
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
