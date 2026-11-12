/**
 * Read a UTF-8 file named by a value flag (`--text-file`, `--description-file`).
 * Content is used verbatim: no trimming, newlines kept. `-` is a literal path,
 * not stdin. Missing path or unreadable file exits 2 (usage).
 * Returns undefined when the flag is absent.
 */
export declare function readTextFileFlag(rest: string[], name: string, example: string): string | undefined;
/** `--<x>` and `--<x>-file` are mutually exclusive (exit 2). */
export declare function exclusiveTextFlag(rest: string[], name: string, example: string): string | undefined;
