import { type BodyDecode, type Hydration } from "./decode.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { GrokBotClient } from "../connect/client.js";
import { type AttachmentLocal, type FetchFn } from "./attachments.js";
export type Scope = {
    backend: string;
    account_id: string;
    team_id: string;
    assurance: "operator_asserted_unverified";
};
export type PullInput = {
    dir: string;
    agentId: string;
    sessionId?: string;
    accountId: string;
    teamId: string;
    acknowledgeUnverifiedScope: boolean;
    dryRun?: boolean;
    pageSize?: number;
    hydrate?: "off" | "missing";
    maxHydrateRequests?: number;
    hydrateMaxBytes?: number;
    hydrateMaxBodyBytes?: number;
    maxPages?: number;
    maxBytes?: number;
    timeoutMs?: number;
};
export type LocalInput = {
    dir: string;
    agentId?: string;
    sessionId?: string;
    dryRun?: boolean;
};
export type AttachmentsInput = LocalInput & {
    accountId: string;
    teamId: string;
    acknowledgeUnverifiedScope: boolean;
    /** Optional exact remote file_path filter (not a local path). */
    path?: string;
    maxBytes?: number;
    maxFileBytes?: number;
    timeoutMs?: number;
};
export declare const DEFAULTS: {
    maxPages: number;
    maxBytes: number;
    timeoutMs: number;
};
export declare function jsonSafe(value: any): any;
export type Entry = {
    archive_scope_sha256?: string;
    agent_id: string;
    session_id: string;
    generation: number;
    seq: string;
    updated_seq: string;
    entry_id?: string;
    entry_kind: string;
    body_base64?: string;
    body_omitted: boolean;
    blob_hash?: string;
    last_available_body?: {
        updated_seq: string;
        body_base64: string;
    };
    decode_status: BodyDecode["decode_status"];
    decode_reason?: string;
    encryption_status: BodyDecode["encryption_status"];
    decoded?: BodyDecode["decoded"];
    raw: unknown;
    wire_base64?: string;
    untrusted: true;
    attachment_local?: AttachmentLocal;
    hydration?: Hydration;
    body_source?: BodyDecode["body_source"];
};
export declare function entryRecord(e: any, agent: string, session: string, g: number, archiveScope?: string): Entry;
/** Shared CLI/MCP core. Normal read RPCs only, including opt-in store presign. No Watch or server writes. */
export declare class SyncOps {
    private client;
    private backend;
    private simulated;
    private fetchImpl;
    constructor(client: GrokBotClient, backend: string, simulated?: boolean, fetchImpl?: FetchFn);
    private result;
    pull(i: PullInput): Promise<ResultEnvelope>;
    status(i: LocalInput): Promise<ResultEnvelope>;
    private selected;
    render(i: LocalInput): Promise<ResultEnvelope>;
    /** Only supported App aliases. Legacy v1 refs are not trusted; re-resolve into scoped v2 refs. */
    attachments(i: AttachmentsInput): Promise<ResultEnvelope>;
}
