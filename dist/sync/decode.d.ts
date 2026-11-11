/** Static 0.79.3 evidence: node-agent-coordinator Tt -> JSON.parse(h.decode(body))
 * -> _b/Are discriminated UI-entry validator. See docs/protocol/transcript-body-0.79.3.md.
 * A deliberately strict subset, NOT arbitrary UTF-8, protobuf guessing or decryption.
 */
export declare const DECODER = "grokbot-ui-entry-json/0.79.3-subset-v1";
export declare const BODY_DECODE_MAX: number;
export declare const SUPPORTED_KINDS: readonly ["message", "send-message", "tool-call", "notice", "user-attachment"];
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
    attachment?: {
        file_path: string;
        file_name?: string;
    };
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
export declare function hydrationBinding(e: StoredInput): string;
export declare function verifiedHydratedBytes(e: StoredInput, readObject?: ObjectReader): Buffer | undefined;
export declare function decodeBody(body: Uint8Array | undefined, omitted: boolean, outerKind: string): BodyDecode;
/** Offline re-render also upgrades archives written before the decoder existed. */
export declare function decodeStored(e: StoredInput, readObject?: ObjectReader): BodyDecode;
export {};
