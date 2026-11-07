import { createHash } from "node:crypto";
/** Static 0.79.3 evidence: node-agent-coordinator Tt -> JSON.parse(h.decode(body))
 * -> _b/Are discriminated UI-entry validator. See docs/protocol/transcript-body-0.79.3.md.
 * A deliberately strict subset, NOT arbitrary UTF-8, protobuf guessing or decryption.
 */
export const DECODER = "grokbot-ui-entry-json/0.79.3-subset-v1";
export const BODY_DECODE_MAX = 4 * 1024 * 1024;
export const SUPPORTED_KINDS = [
  "message",
  "send-message",
  "tool-call",
  "notice",
  "user-attachment",
] as const;
export type DecodedBody = {
  format: typeof DECODER;
  kind: (typeof SUPPORTED_KINDS)[number];
  body_id: string;
  role?: string;
  role_source?: "body.role" | "ui-kind";
  timestamp_ms?: string;
  text?: string;
  message_type?: "text" | "attachment";
  tool_name?: string;
  tool_status?: string;
  attachment?: { file_path: string; file_name?: string };
  suppressed?: boolean;
};
export type BodyDecode = {
  decode_status: "decoded" | "opaque" | "absent" | "omitted";
  decode_reason?: string;
  encryption_status: "unknown" | "plaintext_json";
  decoded?: DecodedBody;
  body_source?: "observed_inline" | "hydrated_omitted" | "hydrated_blob";
};
export type Hydration = {
  format_version: 1;
  status: "fetched" | "error";
  binding: string;
  source: "omitted_list" | "blob";
  context: {
    archive_scope_sha256: string;
    agent_id: string;
    session_id: string;
    generation: number;
    seq: string;
    updated_seq: string;
    entry_id?: string;
  };
  observed_at_ms: string;
  reason?: string;
  body_base64?: string;
  content_sha256?: string;
  object_rel?: string;
  remote_blob_ref?: string;
  /** Attempts for this binding; deterministic failures set retry:"never". */
  attempts?: number;
  retry?: "never" | "retryable";
  /** Meta/wire only — body bytes live in object_rel, not duplicated here. */
  reread?: {
    raw: unknown;
    wire_base64?: string;
    object_rel?: string;
    content_sha256?: string;
  };
};
export type ObjectReader = (rel: string) => Buffer | undefined;
type StoredInput = {
  archive_scope_sha256?: string;
  body_base64?: string;
  body_omitted: boolean;
  entry_kind: string;
  agent_id?: string;
  session_id?: string;
  generation?: number;
  seq?: string;
  updated_seq?: string;
  entry_id?: string;
  blob_hash?: string;
  hydration?: Hydration;
};
export function hydrationBinding(e: StoredInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        e.archive_scope_sha256,
        e.agent_id,
        e.session_id,
        e.generation,
        e.seq,
        e.updated_seq,
        e.entry_id ?? null,
        e.entry_kind,
        e.blob_hash ?? null,
        e.body_omitted,
        e.body_base64 ?? null,
      ]),
    )
    .digest("hex");
}
export function verifiedHydratedBytes(
  e: StoredInput,
  readObject?: ObjectReader,
): Buffer | undefined {
  const h = e.hydration;
  if (
    !h ||
    h.format_version !== 1 ||
    h.status !== "fetched" ||
    h.binding !== hydrationBinding(e) ||
    !/^[0-9a-f]{64}$/.test(h.content_sha256 ?? "")
  )
    return;
  const c = h.context;
  if (
    !c ||
    typeof e.archive_scope_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(e.archive_scope_sha256) ||
    c.archive_scope_sha256 !== e.archive_scope_sha256 ||
    c.agent_id !== e.agent_id ||
    c.session_id !== e.session_id ||
    c.generation !== e.generation ||
    c.seq !== e.seq ||
    c.updated_seq !== e.updated_seq ||
    c.entry_id !== e.entry_id
  )
    return;
  if (h.source !== "omitted_list" && h.source !== "blob") return;
  if (h.object_rel !== `bodies/objects/sha256-${h.content_sha256}`) return;
  // Canonical copy is the content-addressed object; body_base64 is legacy/optional.
  if (readObject) {
    try {
      const b = readObject(h.object_rel);
      if (
        b &&
        b.byteLength <= BODY_DECODE_MAX &&
        createHash("sha256").update(b).digest("hex") === h.content_sha256
      )
        return b;
    } catch {
      return;
    }
  }
  if (typeof h.body_base64 !== "string") return;
  if (h.body_base64.length > Math.ceil(BODY_DECODE_MAX / 3) * 4) return;
  const b = Buffer.from(h.body_base64, "base64");
  if (
    b.byteLength > BODY_DECODE_MAX ||
    b.toString("base64") !== h.body_base64 ||
    createHash("sha256").update(b).digest("hex") !== h.content_sha256
  )
    return;
  return b;
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const optionalString = (v: unknown) => v === undefined || typeof v === "string";
function opaque(reason: string): BodyDecode {
  return {
    decode_status: "opaque",
    encryption_status: "unknown",
    decode_reason: reason,
  };
}

export function decodeBody(
  body: Uint8Array | undefined,
  omitted: boolean,
  outerKind: string,
): BodyDecode {
  if (omitted)
    return { decode_status: "omitted", encryption_status: "unknown" };
  if (body === undefined)
    return { decode_status: "absent", encryption_status: "unknown" };
  if (body.byteLength > BODY_DECODE_MAX) return opaque("decoder_size_limit");
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return opaque("not_valid_utf8_json");
  }
  if (
    !object(v) ||
    typeof v.id !== "string" ||
    !v.id.length ||
    v.id.length > 1024 ||
    typeof v.kind !== "string"
  )
    return opaque("invalid_ui_entry_schema");
  if (!(SUPPORTED_KINDS as readonly string[]).includes(v.kind))
    return opaque("unsupported_ui_kind");
  // UI uses the JSON discriminator; mismatching nonempty outer metadata is conservatively refused.
  if (outerKind && outerKind !== v.kind)
    return opaque("outer_inner_kind_mismatch");
  const d: DecodedBody = {
    format: DECODER,
    kind: v.kind as DecodedBody["kind"],
    body_id: v.id,
  };
  const t = v.timestampMs;
  if (
    typeof t === "number" &&
    Number.isSafeInteger(t) &&
    t >= 0 &&
    t <= 8640000000000000
  )
    d.timestamp_ms = String(t);
  switch (d.kind) {
    case "message":
      if (typeof v.content !== "string" || !optionalString(v.role))
        return opaque("invalid_ui_entry_schema");
      d.text = v.content;
      if (typeof v.role === "string") {
        d.role = v.role;
        d.role_source = "body.role";
      }
      if (v.suppressed !== undefined && v.suppressed !== null)
        d.suppressed = true;
      break;
    case "send-message":
      if (!object(v.message)) return opaque("invalid_ui_entry_schema");
      if (v.message.type === "attachment") {
        if (
          typeof v.message.url !== "string" ||
          !optionalString(v.message.file_name)
        )
          return opaque("invalid_ui_entry_schema");
        d.message_type = "attachment";
        d.attachment = {
          file_path: v.message.url,
          ...(typeof v.message.file_name === "string"
            ? { file_name: v.message.file_name }
            : {}),
        };
        d.role = "assistant";
        d.role_source = "ui-kind";
        break;
      }
      if (v.message.type !== "text")
        return opaque("unsupported_send_message_type");
      if (typeof v.message.content !== "string")
        return opaque("invalid_ui_entry_schema");
      d.message_type = "text";
      d.text = v.message.content;
      d.role = "assistant";
      d.role_source = "ui-kind";
      break;
    case "tool-call":
      if (
        typeof v.name !== "string" ||
        !(v.summary === null || optionalString(v.summary)) ||
        !(v.status === null || optionalString(v.status))
      )
        return opaque("invalid_ui_entry_schema");
      d.tool_name = v.name;
      if (typeof v.summary === "string") d.text = v.summary;
      if (typeof v.status === "string") d.tool_status = v.status;
      break;
    case "notice":
      if (typeof v.text !== "string") return opaque("invalid_ui_entry_schema");
      d.text = v.text;
      break;
    case "user-attachment":
      if (typeof v.file_path !== "string" || !optionalString(v.file_name))
        return opaque("invalid_ui_entry_schema");
      d.attachment = {
        file_path: v.file_path,
        ...(typeof v.file_name === "string" ? { file_name: v.file_name } : {}),
      };
      d.role = "user";
      d.role_source = "ui-kind";
      break;
  }
  return {
    decode_status: "decoded",
    encryption_status: "plaintext_json",
    decoded: d,
  };
}
/** Offline re-render also upgrades archives written before the decoder existed. */
export function decodeStored(
  e: StoredInput,
  readObject?: ObjectReader,
): BodyDecode {
  // Inline observation always wins, even if cached hydration was supplied.
  if (e.body_base64 === undefined) {
    const recovered = verifiedHydratedBytes(e, readObject);
    if (recovered)
      return {
        ...decodeBody(recovered, false, e.entry_kind),
        body_source:
          e.hydration!.source === "blob" ? "hydrated_blob" : "hydrated_omitted",
      };
    if (
      e.hydration &&
      (e.hydration.status === "fetched" || e.hydration.format_version !== 1)
    )
      return opaque("invalid_stored_hydration");
  }
  if (e.body_omitted && e.body_base64 === undefined)
    return decodeBody(undefined, true, e.entry_kind);
  if (e.body_base64 === undefined)
    return decodeBody(undefined, false, e.entry_kind);
  if (typeof e.body_base64 !== "string") return opaque("invalid_stored_base64");
  if (e.body_base64.length > Math.ceil(BODY_DECODE_MAX / 3) * 4)
    return opaque("decoder_size_limit");
  if (
    e.body_base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(e.body_base64)
  )
    return opaque("invalid_stored_base64");
  const bytes = Buffer.from(e.body_base64, "base64");
  if (bytes.toString("base64") !== e.body_base64)
    return opaque("invalid_stored_base64");
  return {
    ...decodeBody(bytes, false, e.entry_kind),
    body_source: "observed_inline",
  };
}
