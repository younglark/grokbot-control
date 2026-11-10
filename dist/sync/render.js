import { decodeStored } from "./decode.js";
/** Indented Markdown code, not HTML/links/instructions. Escape terminal control/bidi codes. */
export function dataBlock(s) {
    const safe = s
        .replace(/\r\n/g, "\n")
        .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return (safe
        .split("\n")
        .map((line) => "    " + line)
        .join("\n") + "\n");
}
function display(d) {
    const meta = {
        kind: d.kind,
        body_id: d.body_id,
        role: d.role,
        role_source: d.role_source,
        timestamp_ms: d.timestamp_ms,
        tool_name: d.tool_name,
        tool_status: d.tool_status,
        attachment: d.attachment,
        suppressed: d.suppressed,
    };
    let out = dataBlock(JSON.stringify(meta, null, 2)) + "\n";
    if (d.timestamp_ms !== undefined)
        out +=
            "Timestamp: " +
                new Date(Number(d.timestamp_ms)).toLocaleString("sv-SE", {
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                }) +
                " (Asia/Shanghai)\n\n";
    if (d.text !== undefined)
        out +=
            (d.kind === "tool-call"
                ? "Tool summary (not a complete tool result):\n\n"
                : "Text:\n\n") +
                dataBlock(d.text) +
                "\n";
    return out;
}
export function renderEntry(e, readObject) {
    // Do not trust cached decoded fields or body.seq/session fields for source scope/order.
    const b = decodeStored(e, readObject);
    let out = `## seq ${e.seq}\n\n` +
        dataBlock(JSON.stringify({
            entry_id: e.entry_id,
            entry_kind: e.entry_kind,
            updated_seq: e.updated_seq,
            decode_status: b.decode_status,
            decode_reason: b.decode_reason,
            encryption_status: b.encryption_status,
            blob_hash: e.blob_hash,
            body_source: b.body_source,
            hydration: e.hydration
                ? {
                    status: e.hydration.status,
                    source: e.hydration.source,
                    reason: e.hydration.reason,
                    content_sha256: e.hydration.content_sha256,
                    context: e.hydration.context,
                }
                : undefined,
        }, null, 2)) +
        "\n";
    out += b.decoded
        ? display(b.decoded)
        : `[${b.decode_status}; ${b.decode_reason ?? "body unavailable"}; encryption unknown]\n\n`;
    if (e.attachment_local) {
        out +=
            "Local attachment ref (untrusted metadata; not a URL):\n\n" +
                dataBlock(JSON.stringify({
                    status: e.attachment_local.status,
                    relative_path: e.attachment_local.relative_path,
                    content_sha256: e.attachment_local.content_sha256,
                    size_bytes: e.attachment_local.size_bytes,
                    content_type: e.attachment_local.content_type,
                    reason: e.attachment_local.reason,
                    remote_path: e.attachment_local.remote_path,
                }, null, 2)) +
                "\n";
    }
    if (e.last_available_body &&
        (b.decode_status === "omitted" || b.decode_status === "absent")) {
        const prior = decodeStored({
            ...e,
            body_omitted: false,
            body_base64: e.last_available_body.body_base64,
        });
        // Version is data, not a heading/path, and cannot overwrite the current observation.
        out +=
            "### Earlier available body (NOT current revision)\n\n" +
                dataBlock(JSON.stringify({ updated_seq: e.last_available_body.updated_seq })) +
                "\n";
        out += prior.decoded
            ? display(prior.decoded)
            : `[${prior.decode_status}; earlier body unavailable to decoder]\n\n`;
    }
    return out;
}
