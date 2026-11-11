import { decodeBody } from "../sync/decode.js";
import { int64ToString } from "../ops/map.js";
import { formatSourceVersion, sourceVersionFromUpdatedSeq, uint64ToString } from "../localdash/uint64.js";
function asBytes(v) {
    if (v == null)
        return undefined;
    if (v instanceof Uint8Array)
        return v;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(v))
        return v;
    if (typeof v === "string") {
        if (v.startsWith("{") || v.startsWith("["))
            return new TextEncoder().encode(v);
        if (v.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v)) {
            const buf = Buffer.from(v, "base64");
            if (buf.toString("base64") === v)
                return buf;
        }
        return undefined;
    }
    if (Array.isArray(v) && v.every((n) => typeof n === "number"))
        return Uint8Array.from(v);
    if (typeof v === "object" && v !== null && "data" in v) {
        const data = v.data;
        if (Array.isArray(data) && data.every((n) => typeof n === "number"))
            return Uint8Array.from(data);
    }
    return undefined;
}
/** Map one listGrokBotTranscriptEntries row into a sanitized timeline DTO. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapTimelineEntry(raw) {
    const omitted = Boolean(raw?.bodyOmitted ?? raw?.body_omitted ?? raw?.omitted);
    const kind = String(raw?.entryKind ?? raw?.entry_kind ?? raw?.kind ?? "");
    const body = asBytes(raw?.body);
    const decoded = decodeBody(body, omitted, kind);
    const view = {
        decode_status: decoded.decode_status,
        untrusted: true,
        source_version: "unknown",
    };
    const id = raw?.entryId ?? raw?.entry_id ?? raw?.id;
    if (typeof id === "string" && id)
        view.entry_id = id;
    const seq = uint64ToString(raw?.seq) ?? int64ToString(raw?.seq);
    if (seq)
        view.seq = seq;
    const updated = uint64ToString(raw?.updatedSeq ?? raw?.updated_seq);
    if (updated)
        view.updated_seq = updated;
    view.source_version = formatSourceVersion(sourceVersionFromUpdatedSeq(updated));
    if (kind)
        view.kind = kind;
    if (decoded.decode_reason)
        view.decode_reason = decoded.decode_reason;
    const d = decoded.decoded;
    if (d) {
        if (d.kind)
            view.kind = d.kind;
        if (d.timestamp_ms)
            view.timestamp_ms = d.timestamp_ms;
        if (d.role)
            view.role = d.role;
        if (typeof d.text === "string")
            view.text = d.text;
        if (d.tool_name)
            view.tool_name = d.tool_name;
        if (d.tool_status)
            view.tool_status = d.tool_status;
        if (d.attachment?.file_name)
            view.attachment_name = d.attachment.file_name;
        else if (d.attachment?.file_path)
            view.attachment_name = d.attachment.file_path;
    }
    return view;
}
const DEFAULT_CAP = 200;
export function mapTimelineEntries(raw, cap = DEFAULT_CAP) {
    const list = Array.isArray(raw) ? raw.map(mapTimelineEntry) : [];
    if (list.length <= cap)
        return { entries: list, truncated: false };
    return { entries: list.slice(-cap), truncated: true };
}
