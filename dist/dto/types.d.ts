/** Public stable DTOs (not raw protobuf dumps). */
export type BotSummary = {
    agent_id: string;
    id: string;
    name: string;
    description: string;
    title: string;
    harness: string;
    role: string;
    kind: string;
    viewer_session_id: string;
    created_at_ms?: string;
    updated_at_ms?: string;
};
export type SidebarSection = {
    id: string;
    name: string;
    agent_ids: string[];
};
export type SessionSummary = {
    agent_id: string;
    session_id: string;
    kind: string;
    created_at_ms?: string;
    updated_at_ms?: string;
};
export type ProgressStatus = {
    agent_id: string;
    is_running: boolean;
    session_id?: string;
    live?: {
        is_composing_message?: boolean;
        is_retrying?: boolean;
        awaiting?: unknown;
        working_task_ids?: string[];
    };
};
export type SendDelivery = {
    message_id: string;
    agent_id: string;
    session_id: string;
    dispatched?: boolean;
    delivery?: string;
    /** Delivery/acceptance only — NOT task/business success. */
    note: string;
};
export type SendStatusView = {
    agent_id: string;
    message_id: string;
    session_id: string;
    status?: string;
    rejection_code?: string;
    accepted_at_ms?: string;
    note: string;
};
export type TranscriptEntryView = {
    /** Opaque / partial — ciphertext or omitted bodies are not decrypted. */
    entry_id?: string;
    kind?: string;
    omitted?: boolean;
    preview?: string;
    untrusted?: boolean;
};
