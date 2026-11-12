import type { TranscriptEntryView } from "../dto/types.js";
/** Default cap for `message history` / `message wait` text; `--full` / `full: true` lifts it. */
export declare const HISTORY_TEXT_LIMIT = 2000;
/** Cut by code points so a surrogate pair is never split. */
export declare function clip(text: string, max: number): {
    text: string;
    cut: boolean;
    chars: number;
};
/** One transcript row in the `message history` shape (shared by `message wait`). */
export declare function historyEntry(raw: any, textLimit: number | null): TranscriptEntryView;
