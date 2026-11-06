import type { BotSummary, ProgressStatus, SessionSummary, SidebarSection } from "../dto/types.js";

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
          awaiting: live.awaiting,
          working_task_ids: live.workingTaskIds || live.working_task_ids,
        }
      : undefined,
  };
}
