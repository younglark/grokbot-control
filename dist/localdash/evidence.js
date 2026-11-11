import { decideSourceVersion, formatSourceVersion, sourceVersionFromUpdatedSeq, } from "./uint64.js";
export const EVIDENCE_SCHEMA = "1.0.0";
export const DEFAULT_EVIDENCE_BUDGET = {
    maxEntities: 5_000,
    maxActivityVersions: 10_000,
    maxSerializedBytes: 32 * 1024 * 1024,
};
const EMPTY_OBS = (source) => ({
    source,
    result: "idle",
    source_freshness: "unknown",
});
export function accountScope(label) {
    const trimmed = label?.trim();
    return trimmed ? `acct:${trimmed}` : "acct:local";
}
export function botScopeKey(account, agentId) {
    return `${account}|agent:${agentId}`;
}
export function transcriptScopeKey(account, agentId, sessionId, generation, generationKnown) {
    const gen = generationKnown && generation !== undefined ? String(generation) : "unknown-gen";
    return `${account}|agent:${agentId}|session:${sessionId}|generation:${gen}`;
}
export function taskEntityKey(account, agentId, id) {
    return `task:${account}:${agentId}:${id}`;
}
export function subagentEntityKey(account, agentId, id) {
    return `subagent:${account}:${agentId}:${id}`;
}
export function todoEntityKey(account, agentId, id) {
    return `todo:${account}:${agentId}:${id}`;
}
export function activityEntityKey(account, agentId, sessionId, generation, generationKnown, seq) {
    const gen = generationKnown && generation !== undefined ? String(generation) : "unknown-gen";
    return `activity:${account}:${agentId}:${sessionId}:${gen}:${seq}`;
}
export function mapTaskViewStatus(raw) {
    if (!raw)
        return "unknown";
    const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
    if (["cancelled", "canceled", "todo_status_cancelled"].includes(key))
        return "cancelled";
    if (["failed", "error", "failure"].includes(key))
        return "failed";
    if (["succeeded", "success", "completed", "done", "todo_status_completed"].includes(key)) {
        return "unknown";
    }
    if (["running", "in_progress", "working", "todo_status_in_progress"].includes(key))
        return "running";
    if (["waiting", "needs_input", "pending", "todo_status_pending"].includes(key))
        return "waiting";
    return "unknown";
}
export function mapTodoViewStatus(status) {
    if (status === "cancelled")
        return "cancelled";
    if (status === "completed")
        return "unknown";
    if (status === "in_progress")
        return "running";
    if (status === "pending")
        return "waiting";
    return "unknown";
}
export function recordSourceResult(previous, input) {
    const base = previous ?? EMPTY_OBS(input.source);
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
export class EvidenceStore {
    budget;
    now;
    entities = new Map();
    observations = new Map();
    entryIndex = new Map();
    gaps = [];
    revision = 0;
    evicted = 0;
    refused = false;
    constructor(budget = DEFAULT_EVIDENCE_BUDGET, now = () => Date.now()) {
        this.budget = budget;
        this.now = now;
    }
    snapshotRevision() {
        return String(this.revision);
    }
    consumedScopeKeys(account, agentId, sessionIds) {
        const sessions = new Set(sessionIds);
        const keys = new Set([botScopeKey(account, agentId)]);
        for (const entity of this.entities.values()) {
            if (entity.agent_id !== agentId)
                continue;
            if (entity.kind === "activity" && entity.session_id && !sessions.has(entity.session_id))
                continue;
            keys.add(entity.scope_key);
        }
        return [...keys];
    }
    getEntity(key) {
        return this.entities.get(key);
    }
    touch(key, at = this.now()) {
        const entity = this.entities.get(key);
        if (entity)
            entity.last_accessed_at_ms = at;
    }
    markSelected(key, selected) {
        if (!key)
            return;
        const entity = this.entities.get(key);
        if (entity)
            entity.selected = selected;
    }
    recordObservation(agentId, observation) {
        const byAgent = this.observations.get(agentId) ?? new Map();
        byAgent.set(observation.source, observation);
        this.observations.set(agentId, byAgent);
    }
    observation(agentId, source) {
        return this.observations.get(agentId)?.get(source) ?? EMPTY_OBS(source);
    }
    ingestTasks(input) {
        const prev = this.observation(input.agent_id, "tasks");
        this.recordObservation(input.agent_id, recordSourceResult(prev, { source: "tasks", ok: input.ok, at: input.at, error: input.error }));
        if (!input.ok || !input.tasks)
            return;
        const scope = botScopeKey(input.account, input.agent_id);
        const seen = new Set();
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
    ingestSubagents(input) {
        const prev = this.observation(input.agent_id, "subagents");
        this.recordObservation(input.agent_id, recordSourceResult(prev, { source: "subagents", ok: input.ok, at: input.at, error: input.error }));
        if (!input.ok || !input.subagents)
            return;
        const scope = botScopeKey(input.account, input.agent_id);
        const seen = new Set();
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
    ingestTodos(input) {
        const prev = this.observation(input.agent_id, "todos");
        this.recordObservation(input.agent_id, recordSourceResult(prev, { source: "todos", ok: input.ok, at: input.at, error: input.error }));
        if (!input.ok || !input.todos)
            return;
        const scope = botScopeKey(input.account, input.agent_id);
        const seen = new Set();
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
    ingestTranscript(input) {
        const prev = this.observation(input.agent_id, "transcript");
        this.recordObservation(input.agent_id, recordSourceResult(prev, {
            source: "transcript",
            ok: input.ok,
            paused: input.paused,
            at: input.at,
            error: input.error,
        }));
        if (!input.ok)
            return;
        const scope = transcriptScopeKey(input.account, input.agent_id, input.session_id, input.generation, input.generation_known);
        const seen = new Set();
        for (const entry of input.entries) {
            if (!entry.seq)
                continue;
            const key = activityEntityKey(input.account, input.agent_id, input.session_id, input.generation, input.generation_known, entry.seq);
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
            if (entry.entry_id)
                this.indexEntry(scope, entry.entry_id, key);
        }
        this.markMissing(scope, "activity", seen, input.at, "outside_window");
        const completeness = input.locally_truncated ? "locally_truncated" : "unknown";
        this.rememberGap({
            kind: completeness === "locally_truncated" ? "locally_truncated" : "history_completeness_unknown",
            scope_key: scope,
            detail: completeness === "locally_truncated"
                ? "本地窗口截断；不表示服务端历史完整，也不表示被截断条目已删除。"
                : "历史完整性未知。truncated=false 只表示未触发本地截断，不证明服务历史完整。",
        });
    }
    /**
     * last_message_entry_id is a Bot-level field without a confirmed session/generation.
     * A does not guess the current session or scan other sessions to invent a scope.
     */
    resolveMessageRef(entryId, scope, account = "acct:local") {
        if (!entryId)
            return { state: "unresolved_missing", detail: "没有 entry 引用" };
        if (!scope?.session_id || scope.generation_known === false && scope.generation === undefined) {
            return { state: "unresolved_unknown_scope", detail: "引用未解析／归属未知" };
        }
        const scopeKey = transcriptScopeKey(account, scope.agent_id, scope.session_id, scope.generation, scope.generation_known !== false && scope.generation !== undefined);
        const hits = [...(this.entryIndex.get(indexKey(scopeKey, entryId)) ?? [])];
        if (hits.length === 0)
            return { state: "unresolved_not_loaded", detail: "引用未加载" };
        if (hits.length > 1)
            return { state: "unresolved_conflict", detail: "引用冲突", entity_key: hits[0] };
        return { state: "resolved", entity_key: hits[0], detail: "entry_id 证据引用" };
    }
    buildEvidence(input) {
        const at = input.at ?? this.now();
        if (input.selected_key)
            this.touch(input.selected_key, at);
        const budgetState = this.enforceBudget(input.consumed_scope_keys ?? [], input.selected_key, at);
        const observations = ["status", "tasks", "subagents", "todos", "transcript"].map((source) => this.observations.get(input.agent_id)?.get(source) ?? EMPTY_OBS(source));
        const sessionSet = input.session_ids ? new Set(input.session_ids) : undefined;
        const entities = [...this.entities.values()].filter((entity) => {
            if (entity.agent_id !== input.agent_id)
                return false;
            if (entity.kind !== "activity" || !sessionSet)
                return true;
            return Boolean(entity.session_id && sessionSet.has(entity.session_id));
        });
        for (const entity of entities) {
            if (entity.kind === "task") {
                entity.last_message_ref = this.resolveMessageRef(entity.last_message_entry_id, undefined, input.account);
            }
        }
        const edges = this.buildEdges(entities, input.account);
        const conflicts = [];
        for (const [key, set] of this.entryIndex) {
            if (set.size > 1) {
                const split = key.split("::");
                conflicts.push({ scope_key: split[0] ?? "", entry_id: split.slice(1).join("::"), entity_keys: [...set] });
            }
        }
        const groups = [
            { id: `group:bot:${input.agent_id}`, kind: "bot", label: "Bot 级（显示分组，不是执行父节点）" },
            { id: `group:shared:${input.agent_id}`, kind: "shared", label: "公共关联" },
            { id: `group:plan:${input.agent_id}`, kind: "plan", label: "计划 todo" },
            { id: `group:unlinked:${input.agent_id}`, kind: "unlinked", label: "未关联活动" },
            ...(input.session_ids ?? []).map((session) => ({
                id: `group:session:${input.agent_id}:${session}`,
                kind: "session_activity",
                label: `会话活动 ${session}（会话不是 run）`,
            })),
        ];
        const gaps = this.gaps.filter((gap) => gap.scope_key.includes(input.agent_id) || gap.kind === "budget_exhausted" || gap.kind === "evicted");
        const payload = {
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
    upsert(incoming) {
        const existing = this.entities.get(incoming.entity_key);
        if (!existing) {
            this.entities.set(incoming.entity_key, incoming);
            return;
        }
        const decision = decideSourceVersion(existing.source_version === "unknown" ? { kind: "unknown" } : { kind: "known", value: existing.source_version }, incoming.source_version === "unknown" ? { kind: "unknown" } : { kind: "known", value: incoming.source_version });
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
    markMissing(scope, kind, seen, at, presence) {
        for (const entity of this.entities.values()) {
            if (entity.scope_key !== scope || entity.kind !== kind)
                continue;
            if (seen.has(entity.entity_key))
                continue;
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
            }
            else if (presence === "outside_window") {
                this.rememberGap({
                    kind: "outside_window",
                    scope_key: scope,
                    entity_key: entity.entity_key,
                    detail: "不在当前返回窗口，不能声称已删除。",
                });
            }
        }
    }
    indexEntry(scope, entryId, entityKey) {
        const key = indexKey(scope, entryId);
        const set = this.entryIndex.get(key) ?? new Set();
        set.add(entityKey);
        this.entryIndex.set(key, set);
    }
    buildEdges(entities, account) {
        const edges = [];
        const byId = new Map(entities.map((entity) => [entity.entity_key, entity]));
        for (const entity of entities) {
            if (entity.kind === "task") {
                for (const subId of entity.subagent_ids ?? []) {
                    const to = subagentEntityKey(account, entity.agent_id, subId);
                    if (!byId.has(to) && !this.entities.has(to))
                        continue;
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
    enforceBudget(consumed, selected, at) {
        this.refused = false;
        const countActivity = () => [...this.entities.values()].filter((entity) => entity.kind === "activity").length;
        const over = () => this.entities.size > this.budget.maxEntities ||
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
    pickVictim(consumed, selected) {
        const consumedSet = new Set(consumed);
        const ranked = [...this.entities.values()].sort((a, b) => a.last_accessed_at_ms - b.last_accessed_at_ms);
        const unconsumed = ranked.find((entity) => !consumedSet.has(entity.scope_key) && entity.entity_key !== selected);
        if (unconsumed)
            return unconsumed;
        return ranked.find((entity) => !entity.selected && entity.entity_key !== selected);
    }
    serializedBytes() {
        return Buffer.byteLength(JSON.stringify([...this.entities.values()]), "utf8");
    }
    rememberGap(gap) {
        const key = `${gap.kind}:${gap.scope_key}:${gap.entity_key ?? ""}`;
        this.gaps = [...this.gaps.filter((item) => `${item.kind}:${item.scope_key}:${item.entity_key ?? ""}` !== key), gap].slice(-400);
    }
    nextRevision() {
        this.revision += 1;
        return String(this.revision);
    }
}
function indexKey(scope, entryId) {
    return `${scope}::${entryId}`;
}
