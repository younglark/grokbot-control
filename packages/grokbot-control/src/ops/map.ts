import type { AgentTaskView, BotSummary, ProgressStatus, SessionSummary, SidebarSection, SubagentView, TodoItemView, TodoStatusView } from "../dto/types.js";
import { sanitizeAwaiting } from "../localdash/awaiting.js";

/** int64 from protobuf JSON/TS may be bigint | string | number — normalize to string. */
export function int64ToString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapBot(a: any): BotSummary {
  return {
    agent_id: a.agentId || a.agent_id || a.id || "",
    id: a.id || "",
    name: a.name || "",
    description: a.description || "",
    title: a.title || "",
    harness: String(a.harness ?? ""),
    role: a.role || "",
    kind: String(a.kind ?? ""),
    viewer_session_id: a.viewerSessionId || a.viewer_session_id || "",
    created_at_ms: int64ToString(a.createdAtMs ?? a.created_at_ms),
    updated_at_ms: int64ToString(a.updatedAtMs ?? a.updated_at_ms),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSection(s: any): SidebarSection {
  return {
    id: s.id || "",
    name: s.name || "",
    agent_ids: [...(s.agentIds || s.agent_ids || [])],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSession(s: any): SessionSummary {
  return {
    agent_id: s.agentId || s.agent_id || "",
    session_id: s.sessionId || s.session_id || "",
    kind: String(s.kind ?? ""),
    created_at_ms: int64ToString(s.createdAtMs ?? s.created_at_ms),
    updated_at_ms: int64ToString(s.updatedAtMs ?? s.updated_at_ms),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapStatus(s: any): ProgressStatus {
  const live = s.live;
  return {
    agent_id: s.agentId || s.agent_id || "",
    is_running: Boolean(s.isRunning ?? s.is_running ?? live?.isRunning),
    session_id: live?.sessionId || live?.session_id,
    live: live
      ? {
          is_composing_message: live.isComposingMessage ?? live.is_composing_message,
          is_retrying: live.isRetrying ?? live.is_retrying,
          awaiting: sanitizeAwaiting(live.awaiting ?? live.Awaiting),
          working_task_ids: live.workingTaskIds || live.working_task_ids,
        }
      : undefined,
  };
}


const TODO_STATUS: Record<string, TodoStatusView> = {
  "0": "unspecified",
  unspecified: "unspecified",
  todo_status_unspecified: "unspecified",
  "1": "pending",
  pending: "pending",
  todo_status_pending: "pending",
  "2": "in_progress",
  in_progress: "in_progress",
  inprogress: "in_progress",
  todo_status_in_progress: "in_progress",
  "3": "completed",
  completed: "completed",
  todo_status_completed: "completed",
  "4": "cancelled",
  cancelled: "cancelled",
  canceled: "cancelled",
  todo_status_cancelled: "cancelled",
  todo_status_canceled: "cancelled",
};

export function mapTodoStatus(v: unknown): TodoStatusView {
  if (v == null || v === "") return "unspecified";
  const key = String(v).trim().toLowerCase().replace(/\s+/g, "_");
  return TODO_STATUS[key] ?? "unknown";
}

/** Map a native TodoItem. Items without an id are dropped by the caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapTodo(t: any): TodoItemView | undefined {
  const id = String(t?.id ?? "").trim();
  if (!id) return undefined;
  const view: TodoItemView = { id, status: mapTodoStatus(t.status) };
  if (typeof t.content === "string" && t.content) view.content = t.content;
  const created = int64ToString(t.createdAt ?? t.created_at);
  if (created) view.created_at = created;
  const updated = int64ToString(t.updatedAt ?? t.updated_at);
  if (updated) view.updated_at = updated;
  const deps = t.dependencies;
  if (Array.isArray(deps) && deps.length) {
    view.dependencies = deps.map((d: unknown) => String(d)).filter(Boolean);
  }
  return view;
}

/** Map a native GrokBotAgentTask. Items without an id are dropped by the caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapTask(t: any): AgentTaskView | undefined {
  const id = String(t?.id ?? "").trim();
  if (!id) return undefined;
  const view: AgentTaskView = { id };
  if (typeof t.name === "string" && t.name) view.name = t.name;
  if (typeof t.description === "string" && t.description) view.description = t.description;
  if (typeof t.status === "string" && t.status) view.status = t.status;
  const updated = int64ToString(t.updatedAtMs ?? t.updated_at_ms);
  if (updated) view.updated_at_ms = updated;
  const last = int64ToString(t.lastMessageAtMs ?? t.last_message_at_ms);
  if (last) view.last_message_at_ms = last;
  const lastId = t.lastMessageEntryId ?? t.last_message_entry_id;
  if (typeof lastId === "string" && lastId) view.last_message_entry_id = lastId;
  const subs = t.subagentIds ?? t.subagent_ids;
  if (Array.isArray(subs) && subs.length) {
    view.subagent_ids = subs.map((d: unknown) => String(d)).filter(Boolean);
  }
  if (t.followed === true) view.followed = true;
  const files = t.fileCount ?? t.file_count;
  if (files != null && files !== "" && Number.isFinite(Number(files))) view.file_count = Number(files);
  return view;
}

/** Map a native GrokBotRunningSubagent. Items without a subagent_id are dropped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSubagent(s: any): SubagentView | undefined {
  const id = String(s?.subagentId ?? s?.subagent_id ?? "").trim();
  if (!id) return undefined;
  const view: SubagentView = { subagent_id: id };
  const typ = s.subagentType ?? s.subagent_type;
  if (typeof typ === "string" && typ) view.subagent_type = typ;
  if (typeof s.title === "string" && s.title) view.title = s.title;
  const started = int64ToString(s.startedAtMs ?? s.started_at_ms);
  if (started) view.started_at_ms = started;
  const fresh = int64ToString(s.freshUntilMs ?? s.fresh_until_ms);
  if (fresh) view.fresh_until_ms = fresh;
  return view;
}

export function mapTodos(raw: unknown): TodoItemView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapTodo).filter((x): x is TodoItemView => Boolean(x));
}

export function mapTasks(raw: unknown): AgentTaskView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapTask).filter((x): x is AgentTaskView => Boolean(x));
}

export function mapSubagents(raw: unknown): SubagentView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapSubagent).filter((x): x is SubagentView => Boolean(x));
}
