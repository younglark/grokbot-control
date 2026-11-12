import type { TimelineEntryView } from "../dto/types.js";
/** Map one listGrokBotTranscriptEntries row into a sanitized timeline DTO. */
export declare function mapTimelineEntry(raw: any): TimelineEntryView;
export declare function mapTimelineEntries(raw: unknown, cap?: number): {
    entries: TimelineEntryView[];
    truncated: boolean;
};
