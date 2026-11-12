/** Documented list caps (CLI/MCP/SDK share these). */
export declare const LIMIT_DEFAULT = 50;
export declare const LIMIT_MAX = 1000;
export type ListPageMeta = {
    truncated: boolean;
    next?: string;
    hint?: string;
};
/**
 * Client-side window over an already-fetched list. `next` is a 0-based offset
 * that can be passed back as `offset` / `--offset`.
 */
export declare function paginate<T>(all: T[], limit: number, offset?: number): {
    items: T[];
} & ListPageMeta;
/**
 * Validate a list limit. undefined -> default. Anything not a positive integer
 * <= LIMIT_MAX throws invalid_argument (exit 2) — never silently empty.
 */
export declare function validateLimit(v: unknown, max?: number): number;
/** Validate a 0-based list offset. undefined -> 0. */
export declare function validateOffset(v: unknown): number;
/** Parse a CLI string limit strictly (digits only). */
export declare function parseCliLimit(raw: string | undefined, max?: number): number;
/** Parse a CLI string offset strictly (digits only). */
export declare function parseCliOffset(raw: string | undefined): number;
