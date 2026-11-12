import type { AgentTaskView, SubagentView, TimelineEntryView, TodoItemView } from "../dto/types.js";
export declare const EVIDENCE_SCHEMA: "1.0.0";
export declare const DEFAULT_EVIDENCE_BUDGET: {
    readonly maxEntities: 5000;
    readonly maxActivityVersions: 10000;
    readonly maxSerializedBytes: number;
};
export type EvidenceBudget = {
    maxEntities: number;
    maxActivityVersions: number;
    maxSerializedBytes: number;
};
export type SourceName = "status" | "tasks" | "subagents" | "todos" | "transcript";
export type SourceResult = "ok" | "error" | "paused" | "idle";
export type Presence = "in_snapshot" | "not_in_snapshot" | "outside_window";
export type HistoryCompleteness = "unknown" | "locally_truncated";
export type EvidenceKind = "snapshot_observation" | "source_event";
export type EntityKind = "task" | "subagent" | "todo" | "activity";
export type ViewStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown" | "idle";
export type EvictionReason = "stale_unconsumed_scope" | "oldest_unselected" | "budget_refused";
export type RefState = "resolved" | "unresolved_unknown_scope" | "unresolved_not_loaded" | "unresolved_conflict" | "unresolved_missing";
export type SourceObservation = {
    source: SourceName;
    last_successful_observed_at_ms?: number;
    result: SourceResult;
    error?: string;
    source_freshness: "unknown";
    paused?: boolean;
};
export type EvidenceGap = {
    kind: "outside_window" | "snapshot_missing" | "history_completeness_unknown" | "locally_truncated" | "evicted" | "budget_exhausted";
    scope_key: string;
    entity_key?: string;
    detail: string;
};
export type ObservedEntity = {
    entity_key: string;
    scope_key: string;
    kind: EntityKind;
    source_id?: string;
    entry_id?: string;
    seq?: string;
    generation?: number;
    generation_known: boolean;
    source_version: string;
    snapshot_revision: string;
    observed_at_ms: number;
    source_time_ms?: string;
    evidence_kind: EvidenceKind;
    presence: Presence;
    raw_status?: string;
    view_status: ViewStatus;
    title?: string;
    text?: string;
    tool_name?: string;
    selected?: boolean;
    last_accessed_at_ms: number;
    last_message_entry_id?: string;
    last_message_ref?: {
        state: RefState;
        entity_key?: string;
        detail: string;
    };
    subagent_ids?: string[];
    dependencies?: string[];
    account: string;
    agent_id: string;
    session_id?: string;
};
export type EvidenceEdge = {
    id: string;
    from: string;
    to: string;
    kind: "subagent_ids_ref" | "todo_dependency" | "entry_id_ref";
    label: string;
    dashed?: boolean;
    unresolved?: boolean;
    unresolved_detail?: string;
};
export type EntryIndexHit = {
    scope_key: string;
    entry_id: string;
    entity_keys: string[];
};
export type DashboardEvidence = {
    schema_version: typeof EVIDENCE_SCHEMA;
    agent_id: string;
    session_id?: string;
    account: string;
    at_ms: number;
    snapshot_revision: string;
    observations: SourceObservation[];
    entities: ObservedEntity[];
    edges: EvidenceEdge[];
    groups: {
        id: string;
        kind: "bot" | "plan" | "session_activity" | "unlinked" | "shared";
        label: string;
    }[];
    entry_index_conflicts: EntryIndexHit[];
    gaps: EvidenceGap[];
    history_completeness: HistoryCompleteness;
    budget: {
        entities: number;
        activity_versions: number;
        serialized_bytes: number;
        max_entities: number;
        max_activity_versions: number;
        max_serialized_bytes: number;
        evicted: number;
        refused: boolean;
    };
    notes: string[];
    truncated_payload?: boolean;
};
export declare function accountScope(label?: string): string;
export declare function botScopeKey(account: string, agentId: string): string;
export declare function transcriptScopeKey(account: string, agentId: string, sessionId: string, generation: number | undefined, generationKnown: boolean): string;
export declare function taskEntityKey(account: string, agentId: string, id: string): string;
export declare function subagentEntityKey(account: string, agentId: string, id: string): string;
export declare function todoEntityKey(account: string, agentId: string, id: string): string;
export declare function activityEntityKey(account: string, agentId: string, sessionId: string, generation: number | undefined, generationKnown: boolean, seq: string): string;
export declare function mapTaskViewStatus(raw?: string): ViewStatus;
export declare function mapTodoViewStatus(status: string): ViewStatus;
export declare function recordSourceResult(previous: SourceObservation | undefined, input: {
    source: SourceName;
    ok?: boolean;
    paused?: boolean;
    at: number;
    error?: string;
}): SourceObservation;
export type ResolveScope = {
    agent_id: string;
    session_id: string;
    generation?: number;
    generation_known?: boolean;
};
export declare class EvidenceStore {
    private budget;
    private readonly now;
    private entities;
    private observations;
    private entryIndex;
    private gaps;
    private revision;
    private evicted;
    private refused;
    constructor(budget?: EvidenceBudget, now?: () => number);
    snapshotRevision(): string;
    consumedScopeKeys(account: string, agentId: string, sessionIds: string[]): string[];
    getEntity(key: string): ObservedEntity | undefined;
    touch(key: string, at?: number): void;
    markSelected(key: string | undefined, selected: boolean): void;
    recordObservation(agentId: string, observation: SourceObservation): void;
    observation(agentId: string, source: SourceName): SourceObservation;
    ingestTasks(input: {
        account: string;
        agent_id: string;
        tasks: AgentTaskView[] | undefined;
        ok: boolean;
        error?: string;
        at: number;
    }): void;
    ingestSubagents(input: {
        account: string;
        agent_id: string;
        subagents: SubagentView[] | undefined;
        ok: boolean;
        error?: string;
        at: number;
    }): void;
    ingestTodos(input: {
        account: string;
        agent_id: string;
        todos: TodoItemView[] | undefined;
        ok: boolean;
        error?: string;
        at: number;
    }): void;
    ingestTranscript(input: {
        account: string;
        agent_id: string;
        session_id: string;
        generation?: number;
        generation_known: boolean;
        entries: TimelineEntryView[];
        ok: boolean;
        error?: string;
        at: number;
        locally_truncated?: boolean;
        paused?: boolean;
    }): void;
    /**
     * last_message_entry_id is a Bot-level field without a confirmed session/generation.
     * A does not guess the current session or scan other sessions to invent a scope.
     */
    resolveMessageRef(entryId: string | undefined, scope?: ResolveScope, account?: string): {
        state: RefState;
        entity_key?: string;
        detail: string;
    };
    buildEvidence(input: {
        account: string;
        agent_id: string;
        at?: number;
        session_ids?: string[];
        consumed_scope_keys?: string[];
        selected_key?: string;
        max_payload_bytes?: number;
    }): DashboardEvidence;
    private upsert;
    private markMissing;
    private indexEntry;
    private buildEdges;
    private enforceBudget;
    private pickVictim;
    private serializedBytes;
    private rememberGap;
    private nextRevision;
}
