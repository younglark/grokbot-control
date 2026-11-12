export declare const ATTACHMENT_DOWNLOADER = "resolve-attachment-reads/0.79.3-ondemand-v1";
export declare const DEFAULT_ATTACH: {
    readonly maxFileBytes: number;
    readonly maxBytes: number;
    readonly timeoutMs: 30000;
    readonly resolveBatch: 8;
};
export declare const HARD_ATTACH: {
    readonly maxFileBytes: number;
    readonly maxBytes: number;
    readonly timeoutMs: 300000;
    readonly resolveBatch: 32;
    readonly pathBytes: 4096;
};
export type AttachmentLocalStatus = "ok" | "not_in_store" | "no_storage" | "error" | "skipped";
export type AttachmentLocal = {
    remote_path: string;
    status: AttachmentLocalStatus;
    relative_path?: string;
    content_sha256?: string;
    size_bytes?: number;
    content_type?: string;
    etag?: string;
    reason?: string;
    observed_at_ms: string;
    live_verified: false;
};
export declare function assertRemotePath(value: string): string;
export declare function pathKey(remotePath: string): string;
export declare function objectRel(agentId: string, sha256: string): string;
export declare function refRel(agentId: string, remotePath: string, sessionId?: string): string;
export declare function mapOutcome(outcome: unknown): AttachmentLocalStatus | "store";
export type ResolvedStore = {
    remote_path: string;
    url: string;
    expires_at_ms?: number;
    content_type?: string;
    size_bytes?: number;
    etag?: string;
};
/** Validate STORE read without exposing the URL to callers' logs. */
export declare function acceptStoreRead(remotePath: string, read: any, nowMs: number): {
    ok: true;
    store: ResolvedStore;
} | {
    ok: false;
    status: AttachmentLocalStatus;
    reason: string;
};
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type TransferBudget = {
    bytes: number;
    maxBytes: number;
    deadline: number;
};
/** Stream directly into a private staging sink. Failed network bytes count too. */
export declare function downloadToStage(url: string, opts: {
    maxBytes: number;
    expectedSize?: number;
    budget: TransferBudget;
    fetchImpl: FetchFn;
    etag?: string;
    sink: {
        write(bytes: Uint8Array): void;
        discard(): void;
    };
}): Promise<{
    status: number;
    digest?: string;
    size?: number;
}>;
export declare function sha256Hex(data: Uint8Array): string;
export declare function redactAttachmentError(e: unknown): {
    status: AttachmentLocalStatus;
    reason: string;
};
