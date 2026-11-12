import { type ObjectReader } from "./decode.js";
import type { Entry } from "./core.js";
/** Indented Markdown code, not HTML/links/instructions. Escape terminal control/bidi codes. */
export declare function dataBlock(s: string): string;
export declare function renderEntry(e: Entry, readObject?: ObjectReader): string;
