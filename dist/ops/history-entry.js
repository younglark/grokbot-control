import { mapTimelineEntry } from "./transcript-map.js";
/** Default cap for `message history` / `message wait` text; `--full` / `full: true` lifts it. */
export const HISTORY_TEXT_LIMIT = 2000;
const PREVIEW_LIMIT = 200;
/** Cut by code points so a surrogate pair is never split. */
export function clip(text, max) {
    const cps = Array.from(text);
    if (cps.length <= max)
        return { text, cut: false, chars: cps.length };
    return { text: cps.slice(0, max).join(""), cut: true, chars: cps.length };
}
/** One transcript row in the `message history` shape (shared by `message wait`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function historyEntry(raw, textLimit) {
    const t = mapTimelineEntry(raw);
    const view = {
        ...(t.entry_id ? { entry_id: t.entry_id } : {}),
        ...(t.seq ? { seq: t.seq } : {}),
        ...(t.updated_seq ? { updated_seq: t.updated_seq } : {}),
        ...(t.kind ? { kind: t.kind } : {}),
        ...(t.role ? { role: t.role } : {}),
        ...(t.timestamp_ms ? { timestamp_ms: t.timestamp_ms } : {}),
        omitted: t.decode_status === "omitted",
        decode_status: t.decode_status,
        ...(t.decode_reason ? { decode_reason: t.decode_reason } : {}),
        untrusted: true,
    };
    if (typeof t.text === "string") {
        view.preview = clip(t.text, PREVIEW_LIMIT).text;
        if (textLimit == null)
            view.text = t.text;
        else {
            const c = clip(t.text, textLimit);
            view.text = c.text;
            if (c.cut) {
                view.text_truncated = true;
                view.text_chars = c.chars;
            }
        }
    }
    if (t.tool_name)
        view.tool_name = t.tool_name;
    if (t.tool_status)
        view.tool_status = t.tool_status;
    if (t.attachment_name)
        view.attachment_name = t.attachment_name;
    return view;
}
