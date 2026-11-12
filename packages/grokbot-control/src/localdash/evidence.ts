import {
  decideSourceVersion,
  formatSourceVersion,
  sourceVersionFromUpdatedSeq,
  type SourceVersion,
} from "./uint64.js";
import type { AgentTaskView, SubagentView, TimelineEntryView, TodoItemView } from "../dto/types.js";

export const EVIDENCE_SCHEMA = "1.0.0" as const;

export const DEFAULT_EVIDENCE_BUDGET = {
  maxEntities: 5_000,
  maxActivityVersions: 10_000,
  maxSerializedBytes: 32 * 1024 * 1024,
} as const;

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
  last_message_ref?: { state: RefState; entity_key?: string; detail: string };
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
  groups: { id: string; kind: "bot" | "plan" | "session_activity" | "unlinked" | "shared"; label: string }[];
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

const EMPTY_OBS = (source: SourceName): SourceObservation => ({
  source,
  result: "idle",
  source_freshness: "unknown",
});

export function accountScope(label?: string): string {
  const trimmed = label?.trim();
  return trimmed ? `acct:${trimmed}` : "acct:local";
}

export function botScopeKey(account: string, agentId: string): string {
  return `${account}|agent:${agentId}`;
}

export function transcriptScopeKey(
  account: string,
  agentId: string,
  sessionId: string,
  generation: number | undefined,
  generationKnown: boolean,
): string {
  const gen = generationKnown && generation !== undefined ? String(generation) : "unknown-gen";
  return `${account}|agent:${agentId}|session:${sessionId}|generation:${gen}`;
}

export function taskEntityKey(account: string, agentId: string, id: string): string {
  return `task:${account}:${agentId}:${id}`;
}

export function subagentEntityKey(account: string, agentId: string, id: string): string {
  return `subagent:${account}:${agentId}:${id}`;
}

export function todoEntityKey(account: string, agentId: string, id: string): string {
  return `todo:${account}:${agentId}:${id}`;
}

export function activityEntityKey(
  account: string,
  agentId: string,
  sessionId: string,
  generation: number | undefined,
  generationKnown: boolean,
  seq: string,
): string {
  const gen = generationKnown && generation !== undefined ? String(generation) : "unknown-gen";
  return `activity:${account}:${agentId}:${sessionId}:${gen}:${seq}`;
}

export function mapTaskViewStatus(raw?: string): ViewStatus {
  if (!raw) return "unknown";
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (["cancelled", "canceled", "todo_status_cancelled"].includes(key)) return "cancelled";
  if (["failed", "error", "failure"].includes(key)) return "failed";
  if (["succeeded", "success", "completed", "done", "todo_status_completed"].includes(key)) {
    return "unknown";
  }
  if (["running", "in_progress", "working", "todo_status_in_progress"].includes(key)) return "running";
  if (["waiting", "needs_input", "pending", "todo_status_pending"].includes(key)) return "waiting";
  return "unknown";
}

export function mapTodoViewStatus(status: string): ViewStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "unknown";
  if (status === "in_progress") return "running";
  if (status === "pending") return "waiting";
  return "unknown";
}

export function recordSourceResult(
  previous: SourceObservation | undefined,
  input: { source: SourceName; ok?: boolean; paused?: boolean; at: number; error?: string },
): SourceObservation {
  const base: SourceObservation = previous ?? EMPTY_OBS(input.source);
  if (input.paused) {
    return { ...base, source: input.source, result: "paused", paused: true, source_freshness: "unknown" };
  }
  if (input.ok) {
    return {
      source: input.source,
      last_successful_observed_at_ms: input.at,
      result: "ok",
      source_freshness: "unknown",
      paused: false,
    };
  }
  return {
    ...base,
    source: input.source,
    result: "error",
    error: input.error,
    paused: false,
    source_freshness: "unknown",
  };
}

export type ResolveScope = { agent_id: string; session_id: string; generation?: number; generation_known?: boolean };

export class EvidenceStore {
  private entities = new Map<string, ObservedEntity>();
  private observations = new Map<string, Map<SourceName, SourceObservation>>();
  private entryIndex = new Map<string, Set<string>>();
  private gaps: EvidenceGap[] = [];
  private revision = 0;
  private evicted = 0;
  private refused = false;
  constructor(
    private budget: EvidenceBudget = DEFAULT_EVIDENCE_BUDGET,
    private readonly now: () => number = () => Date.now(),
  ) {}

  snapshotRevision(): string {
    return String(this.revision);
  }

  consumedScopeKeys(account: string, agentId: string, sessionIds: string[]): string[] {
    const sessions = new Set(sessionIds);
    const keys = new Set<string>([botScopeKey(account, agentId)]);
    for (const entity of this.entities.values()) {
      if (entity.agent_id !== agentId) continue;
      if (entity.kind === "activity" && entity.session_id && !sessions.has(entity.session_id)) continue;
      keys.add(entity.scope_key);
    }
    return [...keys];
  }

  getEntity(key: string): ObservedEntity | undefined {
    return this.entities.get(key);
  }

  touch(key: string, at = this.now()): void {
    const entity = this.entities.get(key);
    if (entity) entity.last_accessed_at_ms = at;
  }

  markSelected(key: string | undefined, selected: boolean): void {
    if (!key) return;
    const entity = this.entities.get(key);
    if (entity) entity.selected = selected;
  }

  recordObservation(agentId: string, observation: SourceObservation): void {
    const byAgent = this.observations.get(agentId) ?? new Map();
    byAgent.set(observation.source, observation);
    this.observations.set(agentId, byAgent);
  }

  observation(agentId: string, source: SourceName): SourceObservation {
    return this.observations.get(agentId)?.get(source) ?? EMPTY_OBS(source);
  }

  ingestTasks(input: {
    account: string;
    agent_id: string;
    tasks: AgentTaskView[] | undefined;
    ok: boolean;
    error?: string;
    at: number;
  }): void {
    const prev = this.observation(input.agent_id, "tasks");
    this.recordObservation(input.agent_id, recordSourceResult(prev, { source: "tasks", ok: input.ok, at: input.at, error: input.error }));
    if (!input.ok || !input.tasks) return;
    const scope = botScopeKey(input.account, input.agent_id);
    const seen = new Set<string>();
    for (const task of input.tasks) {
      const key = taskEntityKey(input.account, input.agent_id, task.id);
      seen.add(key);
      this.upsert({
        entity_key: key,
        scope_key: scope,
        kind: "task",
        source_id: task.id,
        source_version: "unknown",
        snapshot_revision: this.nextRevision(),
        observed_at_ms: input.at,
        source_time_ms: task.updated_at_ms,
        evidence_kind: "snapshot_observation",
        presence: "in_snapshot",
        raw_status: task.status,
        view_status: mapTaskViewStatus(task.status),
        title: task.name ?? task.id,
        text: task.description,
        last_accessed_at_ms: input.at,
        last_message_entry_id: task.last_message_entry_id,
        subagent_ids: task.subagent_ids,
        account: input.account,
        agent_id: input.agent_id,
        generation_known: false,
      });
    }
    this.markMissing(scope, "task", seen, input.at, "not_in_snapshot");
  }

  ingestSubagents(input: {
    account: string;
    agent_id: string;
    subagents: SubagentView[] | undefined;
    ok: boolean;
    error?: string;
    at: number;
  }): void {
    const prev = this.observation(input.agent_id, "subagents");
    this.recordObservation(
      input.agent_id,
      recordSourceResult(prev, { source: "subagents", ok: input.ok, at: input.at, error: input.error }),
    );
    if (!input.ok || !input.subagents) return;
    const scope = botScopeKey(input.account, input.agent_id);
    const seen = new Set<string>();
    for (const sub of input.subagents) {
      const key = subagentEntityKey(input.account, input.agent_id, sub.subagent_id);
      seen.add(key);
      this.upsert({
        entity_key: key,
        scope_key: scope,
        kind: "subagent",
        source_id: sub.subagent_id,
        source_version: "unknown",
        snapshot_revision: this.nextRevision(),
        observed_at_ms: input.at,
        source_time_ms: sub.started_at_ms,
        evidence_kind: "snapshot_observation",
        presence: "in_snapshot",
        view_status: "running",
        title: sub.title ?? sub.subagent_id,
        text: sub.subagent_type,
        last_accessed_at_ms: input.at,
        account: input.account,
        agent_id: input.agent_id,
        generation_known: false,
      });
    }
    this.markMissing(scope, "subagent", seen, input.at, "not_in_snapshot");
  }

  ingestTodos(input: {
    account: string;
    agent_id: string;
    todos: TodoItemView[] | undefined;
    ok: boolean;
    error?: string;
    at: number;
  }): void {
    const prev = this.observation(input.agent_id, "todos");
    this.recordObservation(input.agent_id, recordSourceResult(prev, { source: "todos", ok: input.ok, at: input.at, error: input.error }));
    if (!input.ok || !input.todos) return;
    const scope = botScopeKey(input.account, input.agent_id);
    const seen = new Set<string>();
    for (const todo of input.todos) {
      const key = todoEntityKey(input.account, input.agent_id, todo.id);
      seen.add(key);
      this.upsert({
        entity_key: key,
        scope_key: scope,
        kind: "todo",
        source_id: todo.id,
        source_version: "unknown",
        snapshot_revision: this.nextRevision(),
        observed_at_ms: input.at,
        evidence_kind: "snapshot_observation",
        presence: "in_snapshot",
        raw_status: todo.status,
        view_status: mapTodoViewStatus(todo.status),
        title: todo.content ?? todo.id,
        last_accessed_at_ms: input.at,
        dependencies: todo.dependencies,
        account: input.account,
        agent_id: input.agent_id,
        generation_known: false,
      });
    }
    this.markMissing(scope, "todo", seen, input.at, "not_in_snapshot");
  }

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
  }): void {
    const prev = this.observation(input.agent_id, "transcript");
    this.recordObservation(
      input.agent_id,
      recordSourceResult(prev, {
        source: "transcript",
        ok: input.ok,
        paused: input.paused,
        at: input.at,
        error: input.error,
      }),
    );
    if (!input.ok) return;
    const scope = transcriptScopeKey(
      input.account,
      input.agent_id,
      input.session_id,
      input.generation,
      input.generation_known,
    );
    const seen = new Set<string>();
    for (const entry of input.entries) {
      if (!entry.seq) continue;
      const key = activityEntityKey(
        input.account,
        input.agent_id,
        input.session_id,
        input.generation,
        input.generation_known,
        entry.seq,
      );
      seen.add(key);
      const version = sourceVersionFromUpdatedSeq(entry.updated_seq ?? (entry.source_version !== "unknown" ? entry.source_version : undefined));
      this.upsert({
        entity_key: key,
        scope_key: scope,
        kind: "activity",
        source_id: entry.seq,
        entry_id: entry.entry_id,
        seq: entry.seq,
        generation: input.generation_known ? input.generation : undefined,
        generation_known: input.generation_known,
        source_version: formatSourceVersion(version),
        snapshot_revision: this.nextRevision(),
        observed_at_ms: input.at,
        source_time_ms: entry.timestamp_ms,
        evidence_kind: "source_event",
        presence: "in_snapshot",
        raw_status: entry.tool_status,
        view_status: "unknown",
        title: entry.tool_name ?? entry.kind ?? entry.seq,
        text: entry.text,
        tool_name: entry.tool_name,
        last_accessed_at_ms: input.at,
        account: input.account,
        agent_id: input.agent_id,
        session_id: input.session_id,
      });
      if (entry.entry_id) this.indexEntry(scope, entry.entry_id, key);
    }
    this.markMissing(scope, "activity", seen, input.at, "outside_window");
    const completeness: HistoryCompleteness = input.locally_truncated ? "locally_truncated" : "unknown";
    this.rememberGap({
      kind: completeness === "locally_truncated" ? "locally_truncated" : "history_completeness_unknown",
      scope_key: scope,
      detail:
        completeness === "locally_truncated"
          ? "本地窗口截断；不表示服务端历史完整，也不表示被截断条目已删除。"
          : "历史完整性未知。truncated=false 只表示未触发本地截断，不证明服务历史完整。",
    });
  }

  /**
   * last_message_entry_id is a Bot-level field without a confirmed session/generation.
   * A does not guess the current session or scan other sessions to invent a scope.
   */
  resolveMessageRef(entryId: string | undefined, scope?: ResolveScope, account = "acct:local"): { state: RefState; entity_key?: string; detail: string } {
    if (!entryId) return { state: "unresolved_missing", detail: "没有 entry 引用" };
    if (!scope?.session_id || scope.generation_known === false && scope.generation === undefined) {
      return { state: "unresolved_unknown_scope", detail: "引用未解析／归属未知" };
    }
    const scopeKey = transcriptScopeKey(account, scope.agent_id, scope.session_id, scope.generation, scope.generation_known !== false && scope.generation !== undefined);
    const hits = [...(this.entryIndex.get(indexKey(scopeKey, entryId)) ?? [])];
    if (hits.length === 0) return { state: "unresolved_not_loaded", detail: "引用未加载" };
    if (hits.length > 1) return { state: "unresolved_conflict", detail: "引用冲突", entity_key: hits[0] };
    return { state: "resolved", entity_key: hits[0], detail: "entry_id 证据引用" };
  }

  buildEvidence(input: {
    account: string;
    agent_id: string;
    at?: number;
    session_ids?: string[];
    consumed_scope_keys?: string[];
    selected_key?: string;
    max_payload_bytes?: number;
  }): DashboardEvidence {
    const at = input.at ?? this.now();
    if (input.selected_key) this.touch(input.selected_key, at);
    const budgetState = this.enforceBudget(input.consumed_scope_keys ?? [], input.selected_key, at);
    const observations = (["status", "tasks", "subagents", "todos", "transcript"] as SourceName[]).map(
      (source) => this.observations.get(input.agent_id)?.get(source) ?? EMPTY_OBS(source),
    );
    const sessionSet = input.session_ids ? new Set(input.session_ids) : undefined;
    const entities = [...this.entities.values()].filter((entity) => {
      if (entity.agent_id !== input.agent_id) return false;
      if (entity.kind !== "activity" || !sessionSet) return true;
      return Boolean(entity.session_id && sessionSet.has(entity.session_id));
    });
    for (const entity of entities) {
      if (entity.kind === "task") {
        entity.last_message_ref = this.resolveMessageRef(entity.last_message_entry_id, undefined, input.account);
      }
    }
    const edges = this.buildEdges(entities, input.account);
    const conflicts: EntryIndexHit[] = [];
    for (const [key, set] of this.entryIndex) {
      if (set.size > 1) {
        const split = key.split("::");
        conflicts.push({ scope_key: split[0] ?? "", entry_id: split.slice(1).join("::"), entity_keys: [...set] });
      }
    }
    const groups = [
      { id: `group:bot:${input.agent_id}`, kind: "bot" as const, label: "Bot 级（显示分组，不是执行父节点）" },
      { id: `group:shared:${input.agent_id}`, kind: "shared" as const, label: "公共关联" },
      { id: `group:plan:${input.agent_id}`, kind: "plan" as const, label: "计划 todo" },
      { id: `group:unlinked:${input.agent_id}`, kind: "unlinked" as const, label: "未关联活动" },
      ...(input.session_ids ?? []).map((session) => ({
        id: `group:session:${input.agent_id}:${session}`,
        kind: "session_activity" as const,
        label: `会话活动 ${session}（会话不是 run）`,
      })),
    ];
    const gaps = this.gaps.filter((gap) => gap.scope_key.includes(input.agent_id) || gap.kind === "budget_exhausted" || gap.kind === "evicted");
    const payload: DashboardEvidence = {
      schema_version: EVIDENCE_SCHEMA,
      agent_id: input.agent_id,
      account: input.account,
      at_ms: at,
      snapshot_revision: this.snapshotRevision(),
      observations,
      entities,
      edges,
      groups,
      entry_index_conflicts: conflicts,
      gaps,
      history_completeness: gaps.some((g) => g.kind === "locally_truncated") ? "locally_truncated" : "unknown",
      budget: budgetState,
      notes: [
        "源时效未知：A 阶段未核验 upstream 新鲜度字段，抓取或 SSE 接收时间不是执行更新时间。",
        "没有通用 runId；task 是 Bot 级，不随所选 session 归属。",
        "truncated=false 不证明历史完整。",
      ],
    };
    const maxBytes = input.max_payload_bytes ?? 1024 * 1024;
    const serialized = JSON.stringify(payload);
    payload.budget.serialized_bytes = Buffer.byteLength(serialized, "utf8");
    if (payload.budget.serialized_bytes > maxBytes) {
      payload.entities = payload.entities.slice(0, Math.max(20, Math.floor(payload.entities.length / 2)));
      payload.truncated_payload = true;
      payload.gaps = [
        ...payload.gaps,
        { kind: "budget_exhausted", scope_key: botScopeKey(input.account, input.agent_id), detail: "图 SSE 载荷超过 1MiB 上限，已限长并显式标记。" },
      ];
      payload.budget.serialized_bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    }
    return payload;
  }

  private upsert(incoming: ObservedEntity): void {
    const existing = this.entities.get(incoming.entity_key);
    if (!existing) {
      this.entities.set(incoming.entity_key, incoming);
      return;
    }
    const decision = decideSourceVersion(
      existing.source_version === "unknown" ? { kind: "unknown" } : { kind: "known", value: existing.source_version },
      incoming.source_version === "unknown" ? { kind: "unknown" } : { kind: "known", value: incoming.source_version },
    );
    if (decision === "reject_older" || decision === "keep_existing_known") {
      existing.last_accessed_at_ms = incoming.last_accessed_at_ms;
      if (decision === "keep_existing_known") {
        existing.presence = incoming.presence;
        existing.observed_at_ms = incoming.observed_at_ms;
      }
      return;
    }
    const entryId = incoming.entry_id ?? existing.entry_id;
    this.entities.set(incoming.entity_key, {
      ...existing,
      ...incoming,
      entry_id: entryId,
      selected: existing.selected,
      last_accessed_at_ms: incoming.last_accessed_at_ms,
    });
  }

  private markMissing(scope: string, kind: EntityKind, seen: Set<string>, at: number, presence: Presence): void {
    for (const entity of this.entities.values()) {
      if (entity.scope_key !== scope || entity.kind !== kind) continue;
      if (seen.has(entity.entity_key)) continue;
      entity.presence = presence;
      entity.observed_at_ms = at;
      if (presence === "not_in_snapshot") {
        entity.view_status = "unknown";
        this.rememberGap({
          kind: "snapshot_missing",
          scope_key: scope,
          entity_key: entity.entity_key,
          detail: "本次未观测到／结束未知",
        });
      } else if (presence === "outside_window") {
        this.rememberGap({
          kind: "outside_window",
          scope_key: scope,
          entity_key: entity.entity_key,
          detail: "不在当前返回窗口，不能声称已删除。",
        });
      }
    }
  }

  private indexEntry(scope: string, entryId: string, entityKey: string): void {
    const key = indexKey(scope, entryId);
    const set = this.entryIndex.get(key) ?? new Set();
    set.add(entityKey);
    this.entryIndex.set(key, set);
  }

  private buildEdges(entities: ObservedEntity[], account: string): EvidenceEdge[] {
    const edges: EvidenceEdge[] = [];
    const byId = new Map(entities.map((entity) => [entity.entity_key, entity]));
    for (const entity of entities) {
      if (entity.kind === "task") {
        for (const subId of entity.subagent_ids ?? []) {
          const to = subagentEntityKey(account, entity.agent_id, subId);
          if (!byId.has(to) && !this.entities.has(to)) continue;
          edges.push({
            id: `edge:subagent:${entity.entity_key}:${to}`,
            from: entity.entity_key,
            to,
            kind: "subagent_ids_ref",
            label: "subagent_ids 引用",
          });
        }
        const ref = entity.last_message_ref;
        if (ref?.state === "resolved" && ref.entity_key) {
          edges.push({
            id: `edge:entry:${entity.entity_key}:${ref.entity_key}`,
            from: entity.entity_key,
            to: ref.entity_key,
            kind: "entry_id_ref",
            label: "entry_id 证据引用",
          });
        }
      }
      if (entity.kind === "todo") {
        for (const dep of entity.dependencies ?? []) {
          const to = todoEntityKey(account, entity.agent_id, dep);
          const exists = byId.has(to) || this.entities.has(to);
          edges.push({
            id: `edge:todo:${entity.entity_key}:${to}`,
            from: entity.entity_key,
            to,
            kind: "todo_dependency",
            label: "计划声明",
            dashed: true,
            unresolved: !exists,
            unresolved_detail: exists ? undefined : "计划依赖指向未知或不在范围内的 todo",
          });
        }
      }
    }
    return edges;
  }

  private enforceBudget(consumed: string[], selected: string | undefined, at: number): DashboardEvidence["budget"] {
    this.refused = false;
    const countActivity = () => [...this.entities.values()].filter((entity) => entity.kind === "activity").length;
    const over = () =>
      this.entities.size > this.budget.maxEntities ||
      countActivity() > this.budget.maxActivityVersions ||
      this.serializedBytes() > this.budget.maxSerializedBytes;
    while (over()) {
      const victim = this.pickVictim(consumed, selected);
      if (!victim) {
        this.refused = true;
        this.rememberGap({
          kind: "budget_exhausted",
          scope_key: "*",
          detail: "已达进程总预算，拒绝继续保留新证据；未将淘汰或拒绝伪装成成功结束。",
        });
        break;
      }
      this.entities.delete(victim.entity_key);
      this.evicted += 1;
      this.rememberGap({
        kind: "evicted",
        scope_key: victim.scope_key,
        entity_key: victim.entity_key,
        detail: `已按预算淘汰（${victim.entity_key}），不是成功或删除事件。`,
      });
    }
    return {
      entities: this.entities.size,
      activity_versions: countActivity(),
      serialized_bytes: this.serializedBytes(),
      max_entities: this.budget.maxEntities,
      max_activity_versions: this.budget.maxActivityVersions,
      max_serialized_bytes: this.budget.maxSerializedBytes,
      evicted: this.evicted,
      refused: this.refused,
    };
  }

  private pickVictim(consumed: string[], selected?: string): ObservedEntity | undefined {
    const consumedSet = new Set(consumed);
    const ranked = [...this.entities.values()].sort((a, b) => a.last_accessed_at_ms - b.last_accessed_at_ms);
    const unconsumed = ranked.find((entity) => !consumedSet.has(entity.scope_key) && entity.entity_key !== selected);
    if (unconsumed) return unconsumed;
    return ranked.find((entity) => !entity.selected && entity.entity_key !== selected);
  }

  private serializedBytes(): number {
    return Buffer.byteLength(JSON.stringify([...this.entities.values()]), "utf8");
  }

  private rememberGap(gap: EvidenceGap): void {
    const key = `${gap.kind}:${gap.scope_key}:${gap.entity_key ?? ""}`;
    this.gaps = [...this.gaps.filter((item) => `${item.kind}:${item.scope_key}:${item.entity_key ?? ""}` !== key), gap].slice(-400);
  }

  private nextRevision(): string {
    this.revision += 1;
    return String(this.revision);
  }
}

function indexKey(scope: string, entryId: string): string {
  return `${scope}::${entryId}`;
}
