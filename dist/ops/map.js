import { sanitizeAwaiting } from "../localdash/awaiting.js";
import { mapTurnSettlement, sanitizeActivity, sanitizeBoxHandoff, sanitizeShortText } from "../localdash/signals.js";
/** int64 from protobuf JSON/TS may be bigint | string | number — normalize to string. */
export function int64ToString(v) {
    if (v === undefined || v === null)
        return undefined;
    return String(v);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapBot(a) {
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
export function mapSection(s) {
    return {
        id: s.id || "",
        name: s.name || "",
        agent_ids: [...(s.agentIds || s.agent_ids || [])],
    };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSession(s) {
    return {
        agent_id: s.agentId || s.agent_id || "",
        session_id: s.sessionId || s.session_id || "",
        kind: String(s.kind ?? ""),
        created_at_ms: int64ToString(s.createdAtMs ?? s.created_at_ms),
        updated_at_ms: int64ToString(s.updatedAtMs ?? s.updated_at_ms),
        last_activity_at_ms: int64ToString(s.lastActivityAtMs ?? s.last_activity_at_ms),
    };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapStatus(s) {
    const live = s.live;
    const activity = live ? sanitizeActivity(live.activity ?? live.Activity) : undefined;
    const settlement = live ? mapTurnSettlement(live.lastTurnSettlement ?? live.last_turn_settlement) : undefined;
    const handoff = live ? sanitizeBoxHandoff(live) : undefined;
    const updated = live ? int64ToString(live.updatedAtMs ?? live.updated_at_ms) : undefined;
    const staleAfter = live ? int64ToString(live.staleAfterMs ?? live.stale_after_ms) : undefined;
    const client = mapClientActivity(s.client ?? s.Client);
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
                ...(activity ? { activity } : {}),
                ...(settlement ? { last_turn_settlement: settlement } : {}),
                ...(handoff ? { box_handoff: handoff } : {}),
                ...(updated ? { updated_at_ms: updated } : {}),
                ...(staleAfter ? { stale_after_ms: staleAfter } : {}),
            }
            : undefined,
        ...(client ? { client } : {}),
    };
}
export function mapClientActivity(raw) {
    if (raw == null || typeof raw !== "object")
        return undefined;
    const rec = raw;
    const last = int64ToString(rec.lastActivityAtMs ?? rec.last_activity_at_ms);
    const unreadRaw = rec.unreadCount ?? rec.unread_count;
    const threadsRaw = rec.unreadThreadCount ?? rec.unread_thread_count;
    const unread = unreadRaw == null || unreadRaw === "" ? undefined : Number(unreadRaw);
    const threads = threadsRaw == null || threadsRaw === "" ? undefined : Number(threadsRaw);
    const view = {};
    if (last)
        view.last_activity_at_ms = last;
    if (unread != null && Number.isFinite(unread))
        view.unread_count = unread;
    if (threads != null && Number.isFinite(threads))
        view.unread_thread_count = threads;
    return Object.keys(view).length ? view : undefined;
}
const TEAMS_STATE_BY_CODE = [
    "unspecified",
    "not_connected",
    "connected",
    "app_created",
    "pending_admin_approval",
    "installed",
    "update_pending",
    "removed_in_teams",
    "removed",
    "unsupported_harness",
    "not_published",
    "unavailable",
    "provisioning",
];
function normalizeTeamsInstallState(raw) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return TEAMS_STATE_BY_CODE[raw] ?? "unknown";
    }
    const text = String(raw ?? "")
        .trim()
        .toLowerCase()
        .replace(/^grok_bot_teams_install_state_/, "");
    if (!text)
        return "unspecified";
    if (TEAMS_STATE_BY_CODE.includes(text) || text === "unknown")
        return text;
    return "unknown";
}
function teamsConnectionView(stateKey) {
    switch (stateKey) {
        case "connected":
            return { connected: true, state: "connected", label: "已连接" };
        case "installed":
            return { connected: true, state: "connected", label: "已安装" };
        case "update_pending":
            return { connected: true, state: "connected", label: "已连接（待更新）" };
        case "not_connected":
            return { connected: false, state: "not_connected", label: "未连接" };
        case "pending_admin_approval":
            return { connected: false, state: "pending", label: "待管理员审批" };
        case "provisioning":
            return { connected: false, state: "pending", label: "开通中" };
        case "app_created":
            return { connected: false, state: "other", label: "应用已创建" };
        case "removed_in_teams":
            return { connected: false, state: "removed", label: "已在 Teams 移除" };
        case "removed":
            return { connected: false, state: "removed", label: "已移除" };
        case "unavailable":
        case "unsupported_harness":
        case "not_published":
            return { connected: false, state: "unavailable", label: "不可用" };
        case "unspecified":
        case "unknown":
            return { connected: false, state: "unknown", label: "未知" };
        default:
            return { connected: false, state: "unknown", label: "未知" };
    }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSlackConnection(raw) {
    const agent_id = String(raw?.agentId ?? raw?.agent_id ?? "").trim();
    if (!agent_id)
        return undefined;
    const connected = Boolean(raw.connected);
    const pending = raw.pendingAdminApproval ?? raw.pending_admin_approval;
    const denied = raw.approvalDenied ?? raw.approval_denied;
    const removed = raw.removedInSlack ?? raw.removed_in_slack;
    const unreachable = raw.appUnreachable ?? raw.app_unreachable;
    let state = connected ? "connected" : "not_connected";
    let label = connected ? "已连接" : "未连接";
    if (removed) {
        state = "removed";
        label = "已在 Slack 移除";
    }
    else if (denied) {
        state = "unavailable";
        label = "审批已拒绝";
    }
    else if (pending) {
        state = "pending";
        label = "待管理员审批";
    }
    else if (unreachable) {
        state = "unavailable";
        label = "应用不可达";
    }
    else if (!connected && (raw.unavailableReason || raw.unavailable_reason)) {
        state = "unavailable";
        label = "不可用";
    }
    // Unknown is never painted as connected; a bare missing connected flag stays not_connected.
    const workspace = sanitizeShortText(raw.workspaceName ?? raw.workspace_name, 80);
    return {
        agent_id,
        channel: "slack",
        connected: connected && state === "connected",
        state,
        label,
        ...(workspace ? { workspace_or_tenant: workspace } : {}),
    };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapTeamsConnection(raw) {
    const agent_id = String(raw?.agentId ?? raw?.agent_id ?? "").trim();
    if (!agent_id)
        return undefined;
    const mapped = teamsConnectionView(normalizeTeamsInstallState(raw.installState ?? raw.install_state));
    const tenant = sanitizeShortText(raw.tenantDisplayName ?? raw.tenant_display_name, 80);
    return {
        agent_id,
        channel: "teams",
        ...mapped,
        ...(tenant ? { workspace_or_tenant: tenant } : {}),
    };
}
export function mapChannelConnections(res) {
    const slack = res.slackConnections ?? res.slack_connections ?? [];
    const teams = res.teamsConnections ?? res.teams_connections ?? [];
    const rows = [];
    if (Array.isArray(slack)) {
        for (const item of slack) {
            const row = mapSlackConnection(item);
            if (row)
                rows.push(row);
        }
    }
    if (Array.isArray(teams)) {
        for (const item of teams) {
            const row = mapTeamsConnection(item);
            if (row)
                rows.push(row);
        }
    }
    return rows;
}
const TODO_STATUS = {
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
export function mapTodoStatus(v) {
    if (v == null || v === "")
        return "unspecified";
    const key = String(v).trim().toLowerCase().replace(/\s+/g, "_");
    return TODO_STATUS[key] ?? "unknown";
}
/** Map a native TodoItem. Items without an id are dropped by the caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapTodo(t) {
    const id = String(t?.id ?? "").trim();
    if (!id)
        return undefined;
    const view = { id, status: mapTodoStatus(t.status) };
    if (typeof t.content === "string" && t.content)
        view.content = t.content;
    const created = int64ToString(t.createdAt ?? t.created_at);
    if (created)
        view.created_at = created;
    const updated = int64ToString(t.updatedAt ?? t.updated_at);
    if (updated)
        view.updated_at = updated;
    const deps = t.dependencies;
    if (Array.isArray(deps) && deps.length) {
        view.dependencies = deps.map((d) => String(d)).filter(Boolean);
    }
    return view;
}
/** Map a native GrokBotAgentTask. Items without an id are dropped by the caller. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapTask(t) {
    const id = String(t?.id ?? "").trim();
    if (!id)
        return undefined;
    const view = { id };
    if (typeof t.name === "string" && t.name)
        view.name = t.name;
    if (typeof t.description === "string" && t.description)
        view.description = t.description;
    if (typeof t.status === "string" && t.status)
        view.status = t.status;
    const updated = int64ToString(t.updatedAtMs ?? t.updated_at_ms);
    if (updated)
        view.updated_at_ms = updated;
    const last = int64ToString(t.lastMessageAtMs ?? t.last_message_at_ms);
    if (last)
        view.last_message_at_ms = last;
    const lastId = t.lastMessageEntryId ?? t.last_message_entry_id;
    if (typeof lastId === "string" && lastId)
        view.last_message_entry_id = lastId;
    const subs = t.subagentIds ?? t.subagent_ids;
    if (Array.isArray(subs) && subs.length) {
        view.subagent_ids = subs.map((d) => String(d)).filter(Boolean);
    }
    if (t.followed === true)
        view.followed = true;
    const files = t.fileCount ?? t.file_count;
    if (files != null && files !== "" && Number.isFinite(Number(files)))
        view.file_count = Number(files);
    return view;
}
/** Map a native GrokBotRunningSubagent. Items without a subagent_id are dropped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSubagent(s) {
    const id = String(s?.subagentId ?? s?.subagent_id ?? "").trim();
    if (!id)
        return undefined;
    const view = { subagent_id: id };
    const typ = s.subagentType ?? s.subagent_type;
    if (typeof typ === "string" && typ)
        view.subagent_type = typ;
    if (typeof s.title === "string" && s.title)
        view.title = s.title;
    const started = int64ToString(s.startedAtMs ?? s.started_at_ms);
    if (started)
        view.started_at_ms = started;
    const fresh = int64ToString(s.freshUntilMs ?? s.fresh_until_ms);
    if (fresh)
        view.fresh_until_ms = fresh;
    return view;
}
export function mapTodos(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map(mapTodo).filter((x) => Boolean(x));
}
export function mapTasks(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map(mapTask).filter((x) => Boolean(x));
}
export function mapSubagents(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map(mapSubagent).filter((x) => Boolean(x));
}
