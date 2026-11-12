import { readFileSync } from "node:fs";
import { flag, hasFlag } from "./config.js";
import { usageExit } from "./io.js";
/**
 * Read a UTF-8 file named by a value flag (`--text-file`, `--description-file`).
 * Content is used verbatim: no trimming, newlines kept. `-` is a literal path,
 * not stdin. Missing path or unreadable file exits 2 (usage).
 * Returns undefined when the flag is absent.
 */
export function readTextFileFlag(rest, name, example) {
    if (!hasFlag(rest, name))
        return undefined;
    const file = flag(rest, name);
    if (!file)
        usageExit(`${name} requires a path`, example);
    try {
        return readFileSync(file, "utf8");
    }
    catch (err) {
        usageExit(`cannot read ${name}: ${err.message}`);
    }
}
/** `--<x>` and `--<x>-file` are mutually exclusive (exit 2). */
export function exclusiveTextFlag(rest, name, example) {
    const fileFlag = `${name}-file`;
    if (hasFlag(rest, name) && hasFlag(rest, fileFlag)) {
        usageExit(`pass either ${name} or ${fileFlag}, not both`, example);
    }
    return hasFlag(rest, fileFlag)
        ? readTextFileFlag(rest, fileFlag, example)
        : flag(rest, name);
}
