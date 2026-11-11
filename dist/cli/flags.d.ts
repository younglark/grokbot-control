export type FlagSpec = {
    values: string[];
    switches: string[];
};
/** Per-command flags (noun + verb). Globals are consumed before this check. */
export declare const COMMAND_FLAGS: Record<string, Record<string, FlagSpec>>;
export declare const GLOBAL_FLAGS: string[];
export declare function levenshtein(a: string, b: string): number;
export declare function closestName(got: string, allowed: string[]): string | undefined;
/**
 * Reject unknown or misplaced flags with exit 2 and a close-name hint.
 * `rest` is argv after globals: [noun, verb, ...flags].
 */
export declare function assertCommandFlags(noun: string, verb: string, rest: string[]): void;
/** After parseGlobals, a leftover leading flag is not a noun. */
export declare function assertNoLeadingFlag(rest: string[]): void;
