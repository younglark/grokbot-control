import { LIMIT_MAX } from "../ops/limits.js";
import type { ControlPlane } from "../ops/plane.js";
import type { ComputerState } from "../ops/computer.js";
import type {
  ChannelConnectionView,
  DashboardBotDetail,
  DashboardFocus,
  DashboardFrame,
  DashboardTimeline,
  ProgressStatus,
  SanitizedWhoami,
  SidebarSection,
  SourceFreshnessView,
  UsageBreakdownView,
  UsageStatusView,
} from "../dto/types.js";
import type { ResultEnvelope } from "../dto/result.js";
import { breakdownRowsForBot } from "../ops/usage.js";
import { sanitizeWhoami } from "./sanitize.js";
import { presentSessionView, SESSION_SWITCH_NOTE } from "./sessions.js";
import { sourceFreshness } from "./signals.js";
import { buildBotRows, countRows, presentComputer } from "./view.js";
import { accountScope, botScopeKey, EvidenceStore, type DashboardEvidence } from "./evidence.js";
import { aggregateDemands, shouldDropDemand, type ClientDemand } from "./demand.js";

export const FRAME_SCHEMA = "1.0.0" as const;
export const UPSTREAM_INTERVAL_MS = 5_000;
export const USAGE_INTERVAL_MS = 60_000;
export const WHOAMI_INTERVAL_MS = 30_000;
export const DETAIL_INTERVAL_MS = 10_000;
export const TIMELINE_ACTIVE_INTERVAL_MS = 5_000;
export const TIMELINE_IDLE_INTERVAL_MS = 20_000;
const BACKOFF_CAP_MS = 60_000;

export type DashboardPollerOptions = {
  detailIntervalMs?: number;
  timelineActiveIntervalMs?: number;
  timelineIdleIntervalMs?: number;
};

export type PollerListener = (frame: DashboardFrame) => void;
export type DetailListener = (detail: DashboardBotDetail) => void;
export type TimelineListener = (timeline: DashboardTimeline) => void;
export type EvidenceListener = (evidence: DashboardEvidence) => void;

type FocusRecord = ClientDemand & { agent_id: string };

/**
 * Shared cache + singleflight for the local `gbc dashboard` monitor.
 * This is local poll + SSE, not official WatchGrokBotTranscripts (that RPC is
 * not on the used surface and is not wired).
 */
export class DashboardPoller {
  private browsers = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private whoamiTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  private usageInflight: Promise<void> | undefined;
  private listeners = new Set<PollerListener>();
  private detailListeners = new Set<DetailListener>();
  private timelineListeners = new Set<TimelineListener>();
  private evidenceListeners = new Set<EvidenceListener>();
  private evidence = new EvidenceStore();
  private backoffMs = UPSTREAM_INTERVAL_MS;
  private refreshFailed = false;
  private loggedIn = false;
  private lastWhoami: SanitizedWhoami | undefined;
  private lastComputer: ComputerState | undefined;
  private lastUsage: UsageStatusView | undefined;
  private lastBreakdown: UsageBreakdownView | undefined;
  private breakdownError: string | undefined;
  private lastChannels: ChannelConnectionView[] = [];
  private sourceTimes = new Map<string, number>();
  private frame: DashboardFrame;
  private closed = false;
  private focuses = new Map<string, FocusRecord>();
  private details = new Map<string, DashboardBotDetail>();
  private timelines = new Map<string, DashboardTimeline>();
  private detailInflight = new Map<string, Promise<void>>();
  private timelineInflight = new Map<string, Promise<void>>();
  private detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private timelineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly detailIntervalMs: number;
  private readonly timelineActiveIntervalMs: number;
  private readonly timelineIdleIntervalMs: number;

  constructor(
    private plane: ControlPlane,
    opts: DashboardPollerOptions = {},
  ) {
    this.detailIntervalMs = opts.detailIntervalMs ?? DETAIL_INTERVAL_MS;
    this.timelineActiveIntervalMs = opts.timelineActiveIntervalMs ?? TIMELINE_ACTIVE_INTERVAL_MS;
    this.timelineIdleIntervalMs = opts.timelineIdleIntervalMs ?? TIMELINE_IDLE_INTERVAL_MS;
    this.frame = this.emptyFrame({
      sse: "idle",
      upstream: "idle",
    });
  }

  get current(): DashboardFrame {
    return this.frame;
  }

  subscribe(fn: PollerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeDetail(fn: DetailListener): () => void {
    this.detailListeners.add(fn);
    return () => this.detailListeners.delete(fn);
  }

  subscribeTimeline(fn: TimelineListener): () => void {
    this.timelineListeners.add(fn);
    return () => this.timelineListeners.delete(fn);
  }

  subscribeEvidence(fn: EvidenceListener): () => void {
    this.evidenceListeners.add(fn);
    return () => this.evidenceListeners.delete(fn);
  }

  browserConnected(_clientId?: string, _epoch?: string): void {
    this.browsers += 1;
    this.publish({ ...this.frame, connection: { ...this.frame.connection, sse: "connected" } });
    this.arm();
    void this.refreshWhoami();
  }

  browserDisconnected(clientId?: string, epoch?: string): void {
    if (clientId) {
      const existing = this.focuses.get(clientId);
      if (shouldDropDemand(existing, epoch)) this.focuses.delete(clientId);
    }
    this.browsers = Math.max(0, this.browsers - 1);
    if (this.browsers === 0) {
      this.focuses.clear();
      this.disarmUpstream();
      this.publish({
        ...this.frame,
        connection: { ...this.frame.connection, sse: "idle" },
      });
    } else {
      this.reconcileDetailLoops();
    }
  }

  /** Initial whoami (server start) without starting upstream polls. */
  async start(): Promise<void> {
    await this.refreshWhoami();
  }

  async refreshUsage(): Promise<void> {
    if (!this.loggedIn || this.refreshFailed) return;
    if (this.usageInflight) return this.usageInflight;
    this.usageInflight = this.loadUsage().finally(() => {
      this.usageInflight = undefined;
    });
    return this.usageInflight;
  }

  setFocus(input: DashboardFocus): void {
    const agent = input.agent_id?.trim();
    if (!agent) {
      this.focuses.delete(input.client_id);
      this.reconcileDetailLoops();
      return;
    }
    this.focuses.set(input.client_id, {
      client_id: input.client_id,
      connection_epoch: input.connection_epoch ?? "",
      agent_id: agent,
      ...(input.view_session_id ? { view_session_id: input.view_session_id } : {}),
      timeline_visible: Boolean(input.timeline_visible),
      graph_visible: Boolean(input.graph_visible),
    });
    this.reconcileDetailLoops();
  }

  getDetail(agentId: string, clientId?: string): DashboardBotDetail | undefined {
    const shared = this.details.get(agentId);
    if (!shared) return undefined;
    return this.decorateDetail(shared, clientId);
  }

  getEvidence(agentId: string, sessionId?: string): DashboardEvidence {
    const sessions = sessionId
      ? [sessionId]
      : [...this.focuses.values()]
          .filter((f) => f.agent_id === agentId)
          .map((f) => this.resolvedSession(f))
          .filter((id): id is string => Boolean(id));
    const uniqueSessions = [...new Set(sessions)];
    const account = accountScope();
    return {
      ...this.evidence.buildEvidence({
        account,
        agent_id: agentId,
        session_ids: uniqueSessions,
        consumed_scope_keys: this.evidence.consumedScopeKeys(account, agentId, uniqueSessions),
        max_payload_bytes: 1_048_576,
      }),
      ...(uniqueSessions.length === 1 ? { session_id: uniqueSessions[0] } : {}),
    };
  }

  getTimeline(agentId: string, sessionId?: string): DashboardTimeline | undefined {
    if (sessionId) return this.timelines.get(timelineKey(agentId, sessionId));
    for (const [key, value] of this.timelines) {
      if (key.startsWith(`${agentId}\0`)) return value;
    }
    return undefined;
  }

  close(): void {
    this.closed = true;
    this.browsers = 0;
    this.focuses.clear();
    this.disarmUpstream();
    if (this.whoamiTimer) clearTimeout(this.whoamiTimer);
    this.whoamiTimer = undefined;
    this.listeners.clear();
    this.detailListeners.clear();
    this.timelineListeners.clear();
    this.evidenceListeners.clear();
  }

  private arm(): void {
    if (this.closed) return;
    this.scheduleWhoami();
    if (this.canPollUpstream()) {
      void this.tickUpstream();
      if (!this.lastUsage && !this.lastBreakdown) void this.refreshUsage();
    }
    this.scheduleUpstream();
    this.scheduleUsage();
    this.reconcileDetailLoops();
  }

  private disarmUpstream(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
    this.clearDetailLoops();
  }

  private canPollUpstream(): boolean {
    return !this.closed && this.browsers > 0 && this.loggedIn && !this.refreshFailed;
  }

  private scheduleUpstream(delay = this.backoffMs): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.canPollUpstream()) return;
    this.timer = setTimeout(() => {
      void this.tickUpstream();
    }, delay);
  }

  private scheduleUsage(delay = USAGE_INTERVAL_MS): void {
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
    if (!this.canPollUpstream()) return;
    this.usageTimer = setTimeout(() => {
      void this.refreshUsage().finally(() => this.scheduleUsage());
    }, delay);
  }

  private scheduleWhoami(): void {
    if (this.whoamiTimer) clearTimeout(this.whoamiTimer);
    if (this.closed || this.browsers === 0) return;
    this.whoamiTimer = setTimeout(() => {
      void this.refreshWhoami().finally(() => this.scheduleWhoami());
    }, WHOAMI_INTERVAL_MS);
  }

  private async tickUpstream(): Promise<void> {
    if (!this.canPollUpstream()) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.loadUpstream()
      .catch(() => undefined)
      .finally(() => {
        this.inflight = undefined;
        this.scheduleUpstream(this.canPollUpstream() ? this.backoffMs : UPSTREAM_INTERVAL_MS);
      });
    return this.inflight;
  }

  private async refreshWhoami(): Promise<void> {
    try {
      const res = await this.plane.authOps.whoami();
      if (!res.ok || !res.data) {
        this.applyLoggedOut("login_required");
        return;
      }
      const who = sanitizeWhoami(res.data);
      const wasLoggedIn = this.loggedIn;
      this.lastWhoami = who;
      this.loggedIn = who.logged_in;
      if (!who.logged_in) {
        this.applyLoggedOut("login_required");
        return;
      }
      if (this.refreshFailed && who.logged_in) {
        // A later whoami still has a token; keep the refresh-failed banner
        // until a successful upstream read, but do not resume polling automatically
        // after a refresh failure (token rotation failed).
      }
      const auth = {
        logged_in: true,
        whoami: who,
        ...(this.refreshFailed ? { banner: "auth_refresh_failed" as const } : {}),
      };
      this.publish({ ...this.frame, auth });
      if (who.logged_in && !wasLoggedIn && !this.refreshFailed) {
        this.backoffMs = UPSTREAM_INTERVAL_MS;
        if (!this.lastUsage && !this.lastBreakdown) void this.refreshUsage();
        void this.tickUpstream();
        this.reconcileDetailLoops();
      }
    } catch {
      this.applyLoggedOut("login_required");
    }
  }

  private applyLoggedOut(banner: "login_required" | "auth_refresh_failed"): void {
    this.loggedIn = banner === "auth_refresh_failed" ? this.loggedIn : false;
    if (banner === "login_required") this.loggedIn = false;
    this.disarmUpstream();
    this.publish({
      ...this.frame,
      auth: {
        logged_in: false,
        banner,
        ...(this.lastWhoami ? { whoami: { ...this.lastWhoami, logged_in: false } } : {}),
      },
      connection: {
        ...this.frame.connection,
        upstream: banner === "auth_refresh_failed" ? "auth_refresh_failed" : "unauthenticated",
      },
    });
  }

  private async loadUpstream(): Promise<void> {
    if (!this.canPollUpstream()) return;
    const [botsRes, computerRes, sidebarRes] = await Promise.all([
      this.plane.bot.list({ limit: LIMIT_MAX, offset: 0 }),
      this.plane.computer.state(),
      this.plane.sidebar.list({ limit: LIMIT_MAX, offset: 0 }),
    ]);

    if (this.isRefreshFailure(botsRes) || this.isRefreshFailure(computerRes) || this.isRefreshFailure(sidebarRes)) {
      this.onRefreshFailure(firstError(botsRes, computerRes, sidebarRes));
      return;
    }

    const botsOk = Boolean(botsRes.ok && botsRes.data);
    const bots = botsOk ? botsRes.data!.bots : this.frame.bots.map((r) => r.bot);
    const truncated = Boolean(botsOk && (botsRes.data!.truncated || botsRes.data!.hint));
    const listHint = botsOk ? botsRes.data!.hint : this.frame.list_hint;
    if (botsOk) this.lastChannels = botsRes.data!.channels ?? [];
    const channels = this.lastChannels;

    let statuses: ProgressStatus[] = this.frame.bots.map((r) => r.status).filter(Boolean) as ProgressStatus[];
    let statusesAttempted = false;
    let statusesOk = false;
    let statusesError: string | undefined;
    if (botsOk) {
      const ids = bots.map((b) => b.agent_id).filter(Boolean);
      const st = await this.plane.progress.status(ids);
      if (this.isRefreshFailure(st)) {
        this.onRefreshFailure(firstError(st));
        return;
      }
      statusesAttempted = true;
      if (st.ok && st.data) {
        statuses = st.data.statuses;
        statusesOk = true;
      } else {
        statusesError = firstError(st) ?? "status failed";
      }
    }

    const rows = buildBotRows(bots, statuses, channels);
    let computerFailed = !computerRes.ok;
    if (computerRes.ok && computerRes.data) this.lastComputer = computerRes.data;
    const sidebar: SidebarSection[] =
      sidebarRes.ok && sidebarRes.data ? sidebarRes.data.sections : this.frame.sidebar;

    const now = Date.now();
    if (botsOk) this.sourceTimes.set("bots", now);
    if (statusesOk) this.sourceTimes.set("statuses", now);
    if (!computerFailed) this.sourceTimes.set("computer", now);
    if (sidebarRes.ok) this.sourceTimes.set("sidebar", now);

    const upstreamError = !botsOk || !sidebarRes.ok || computerFailed || (statusesAttempted && !statusesOk);
    if (upstreamError) {
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    } else {
      this.backoffMs = UPSTREAM_INTERVAL_MS;
    }

    const coreSources: SourceFreshnessView[] = [
      sourceFreshness({
        id: "bots",
        label: "Bot 列表",
        attempted: true,
        ok: botsOk,
        empty: botsOk && bots.length === 0,
        error: botsOk ? undefined : (firstError(botsRes) ?? "bot list failed"),
        stale: !botsOk && this.frame.bots.length > 0,
        last_successful_at_ms: this.sourceTimes.get("bots"),
      }),
      sourceFreshness({
        id: "statuses",
        label: "Bot 状态",
        attempted: statusesAttempted,
        ok: statusesOk,
        empty: statusesOk && statuses.length === 0,
        error: statusesError,
        stale: !statusesOk && statuses.length > 0,
        last_successful_at_ms: this.sourceTimes.get("statuses"),
      }),
      sourceFreshness({
        id: "computer",
        label: "共享电脑 / 沙箱",
        attempted: true,
        ok: !computerFailed,
        error: computerFailed ? (firstError(computerRes) ?? "computer state failed") : undefined,
        stale: computerFailed && Boolean(this.lastComputer),
        last_successful_at_ms: this.sourceTimes.get("computer"),
      }),
      sourceFreshness({
        id: "sidebar",
        label: "侧栏",
        attempted: true,
        ok: sidebarRes.ok,
        empty: Boolean(sidebarRes.ok && sidebarRes.data && sidebarRes.data.sections.length === 0),
        error: sidebarRes.ok ? undefined : (firstError(sidebarRes) ?? "sidebar failed"),
        stale: !sidebarRes.ok && this.frame.sidebar.length > 0,
        last_successful_at_ms: this.sourceTimes.get("sidebar"),
      }),
    ];

    this.publish({
      schema_version: FRAME_SCHEMA,
      at_ms: now,
      connection: {
        sse: this.browsers > 0 ? "connected" : "idle",
        last_successful_upstream_at_ms: !upstreamError
          ? now
          : this.frame.connection.last_successful_upstream_at_ms,
        upstream: upstreamError ? "error" : "ok",
        ...(upstreamError
          ? { error: firstError(botsRes, computerRes, sidebarRes) ?? statusesError }
          : {}),
        retrying: upstreamError,
        ...(upstreamError ? { retry_backoff_ms: this.backoffMs } : {}),
        sources: mergeSources(this.frame.connection.sources, coreSources),
      },
      auth: {
        logged_in: true,
        ...(this.lastWhoami ? { whoami: this.lastWhoami } : {}),
      },
      computer: presentComputer(this.lastComputer, {
        failed: computerFailed && !this.lastComputer,
        stale: computerFailed && Boolean(this.lastComputer),
      }),
      bots: rows,
      counts: countRows(rows),
      list_truncated: truncated,
      ...(listHint ? { list_hint: listHint } : {}),
      sidebar,
      ...(channels.length ? { channels } : {}),
      ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      ...(this.frame.usage_error ? { usage_error: this.frame.usage_error } : {}),
      ...(this.lastBreakdown ? { usage_breakdown: this.lastBreakdown } : {}),
      ...(this.breakdownError ? { usage_breakdown_error: this.breakdownError } : {}),
      ...(this.plane.simulated ? { simulated: true } : {}),
    });
    this.refreshOpenSessionViews();
  }

  private async loadUsage(): Promise<void> {
    if (!this.canPollUpstream()) return;
    const [res, breakdownRes] = await Promise.all([this.plane.usage.status(), this.plane.usage.breakdown()]);
    if (this.isRefreshFailure(res) || this.isRefreshFailure(breakdownRes)) {
      this.onRefreshFailure(firstError(res, breakdownRes));
      return;
    }
    const next: DashboardFrame = { ...this.frame };
    if (res.ok && res.data) {
      this.lastUsage = res.data;
      next.usage = res.data;
      delete next.usage_error;
    } else {
      next.usage_error = res.error?.message ?? "usage status failed";
      if (this.lastUsage) next.usage = this.lastUsage;
    }
    if (breakdownRes.ok && breakdownRes.data) {
      this.lastBreakdown = breakdownRes.data;
      this.breakdownError = undefined;
      next.usage_breakdown = breakdownRes.data;
      delete next.usage_breakdown_error;
    } else {
      this.breakdownError = breakdownRes.error?.message ?? "usage breakdown failed";
      next.usage_breakdown_error = this.breakdownError;
      if (this.lastBreakdown) next.usage_breakdown = this.lastBreakdown;
    }
    const usageNow = Date.now();
    if (res.ok && res.data) this.sourceTimes.set("usage", usageNow);
    if (breakdownRes.ok && breakdownRes.data) this.sourceTimes.set("usage_breakdown", usageNow);
    const usageEmpty =
      Boolean(breakdownRes.ok && breakdownRes.data && breakdownRes.data.kind === "empty");
    next.connection = {
      ...next.connection,
      sources: mergeSources(next.connection.sources, [
        sourceFreshness({
          id: "usage",
          label: "使用额度",
          attempted: true,
          ok: Boolean(res.ok && res.data),
          error: res.ok ? undefined : (res.error?.message ?? "usage status failed"),
          stale: !res.ok && Boolean(this.lastUsage),
          last_successful_at_ms: this.sourceTimes.get("usage"),
        }),
        sourceFreshness({
          id: "usage_breakdown",
          label: "用量明细",
          attempted: true,
          ok: Boolean(breakdownRes.ok && breakdownRes.data),
          empty: usageEmpty,
          error: breakdownRes.ok ? undefined : (breakdownRes.error?.message ?? "usage breakdown failed"),
          stale: !breakdownRes.ok && Boolean(this.lastBreakdown),
          last_successful_at_ms: this.sourceTimes.get("usage_breakdown"),
        }),
      ]),
    };
    this.publish(next);
    // Per-bot slices may have changed; refresh open details without waiting for the 10s tick.
    for (const agentId of this.focusedAgentIds()) {
      const cached = this.details.get(agentId);
      if (cached) this.publishDetail(this.withBreakdown(cached));
    }
  }

  private reconcileDetailLoops(): void {
    if (!this.canPollUpstream()) {
      this.clearDetailLoops();
      return;
    }
    const wantedAgents = this.focusedAgentIds();
    for (const agentId of wantedAgents) {
      if (!this.detailTimers.has(agentId) && !this.detailInflight.has(agentId)) {
        void this.tickDetail(agentId);
      }
      this.scheduleDetail(agentId);
    }
    for (const agentId of [...this.detailTimers.keys()]) {
      if (!wantedAgents.has(agentId)) {
        const t = this.detailTimers.get(agentId);
        if (t) clearTimeout(t);
        this.detailTimers.delete(agentId);
      }
    }
    this.reconcileTimelineLoops();
  }

  private scheduleDetail(agentId: string, delay = this.detailIntervalMs): void {
    const prev = this.detailTimers.get(agentId);
    if (prev) clearTimeout(prev);
    if (!this.canPollUpstream() || !this.focusedAgentIds().has(agentId)) {
      this.detailTimers.delete(agentId);
      return;
    }
    this.detailTimers.set(
      agentId,
      setTimeout(() => {
        void this.tickDetail(agentId);
      }, delay),
    );
  }

  private async tickDetail(agentId: string): Promise<void> {
    if (!this.canPollUpstream() || !this.focusedAgentIds().has(agentId)) return;
    const existing = this.detailInflight.get(agentId);
    if (existing) return existing;
    const work = this.loadDetail(agentId)
      .catch(() => undefined)
      .finally(() => {
        this.detailInflight.delete(agentId);
        this.scheduleDetail(agentId);
        this.reconcileTimelineLoops();
      });
    this.detailInflight.set(agentId, work);
    return work;
  }

  private async loadDetail(agentId: string): Promise<void> {
    const [sessionsRes, todosRes, tasksRes, subagentsRes] = await Promise.all([
      this.plane.session.list(agentId, { limit: LIMIT_MAX, offset: 0 }),
      this.plane.progress.todos(agentId),
      this.plane.progress.tasks(agentId),
      this.plane.progress.subagents(agentId),
    ]);
    if (
      this.isRefreshFailure(sessionsRes) ||
      this.isRefreshFailure(todosRes) ||
      this.isRefreshFailure(tasksRes) ||
      this.isRefreshFailure(subagentsRes)
    ) {
      this.onRefreshFailure(firstError(sessionsRes, todosRes, tasksRes, subagentsRes));
      return;
    }
    const previous = this.details.get(agentId);
    const sessions = sessionsRes.ok && sessionsRes.data ? sessionsRes.data.sessions : (previous?.sessions ?? []);
    const session_view = this.sharedSessionView(agentId, sessions);
    const notes = [SESSION_SWITCH_NOTE];
    const observedAt = Date.now();
    const anyOk = Boolean(
      (sessionsRes.ok && sessionsRes.data) ||
        (todosRes.ok && todosRes.data) ||
        (tasksRes.ok && tasksRes.data) ||
        (subagentsRes.ok && subagentsRes.data),
    );
    const detail: DashboardBotDetail = {
      agent_id: agentId,
      at_ms: observedAt,
      sessions,
      session_view,
      notes,
      ...(anyOk
        ? { last_successful_at_ms: observedAt }
        : previous?.last_successful_at_ms !== undefined
          ? { last_successful_at_ms: previous.last_successful_at_ms }
          : {}),
    };
    if (!sessionsRes.ok) {
      detail.sessions_error = sessionsRes.error?.message ?? sessionsRes.code ?? "sessions failed";
    }
    if (todosRes.ok && todosRes.data) detail.todos = todosRes.data.todos;
    else {
      detail.todos_error = todosRes.error?.message ?? todosRes.code ?? "todos failed";
      if (previous?.todos) detail.todos = previous.todos;
    }
    if (tasksRes.ok && tasksRes.data) detail.tasks = tasksRes.data.tasks;
    else {
      detail.tasks_error = tasksRes.error?.message ?? tasksRes.code ?? "tasks failed";
      if (previous?.tasks) detail.tasks = previous.tasks;
    }
    if (subagentsRes.ok && subagentsRes.data) detail.subagents = subagentsRes.data.subagents;
    else {
      detail.subagents_error = subagentsRes.error?.message ?? subagentsRes.code ?? "subagents failed";
      if (previous?.subagents) detail.subagents = previous.subagents;
    }
    const prevSource = (id: string) => previous?.sources?.find((s) => s.id === id);
    detail.sources = [
      sourceFreshness({
        id: "sessions",
        label: "会话",
        attempted: true,
        ok: Boolean(sessionsRes.ok && sessionsRes.data),
        empty: Boolean(sessionsRes.ok && sessionsRes.data && sessionsRes.data.sessions.length === 0),
        error: sessionsRes.ok ? undefined : (sessionsRes.error?.message ?? sessionsRes.code),
        stale: !sessionsRes.ok && (previous?.sessions?.length ?? 0) > 0,
        last_successful_at_ms: sessionsRes.ok ? observedAt : prevSource("sessions")?.last_successful_at_ms,
      }),
      sourceFreshness({
        id: "todos",
        label: "待办",
        attempted: true,
        ok: Boolean(todosRes.ok && todosRes.data),
        empty: Boolean(todosRes.ok && todosRes.data && todosRes.data.todos.length === 0),
        error: todosRes.ok ? undefined : (todosRes.error?.message ?? todosRes.code),
        stale: !todosRes.ok && (previous?.todos?.length ?? 0) > 0,
        last_successful_at_ms: todosRes.ok ? observedAt : prevSource("todos")?.last_successful_at_ms,
      }),
      sourceFreshness({
        id: "tasks",
        label: "任务项",
        attempted: true,
        ok: Boolean(tasksRes.ok && tasksRes.data),
        empty: Boolean(tasksRes.ok && tasksRes.data && tasksRes.data.tasks.length === 0),
        error: tasksRes.ok ? undefined : (tasksRes.error?.message ?? tasksRes.code),
        stale: !tasksRes.ok && (previous?.tasks?.length ?? 0) > 0,
        last_successful_at_ms: tasksRes.ok ? observedAt : prevSource("tasks")?.last_successful_at_ms,
      }),
      sourceFreshness({
        id: "subagents",
        label: "子代理",
        attempted: true,
        ok: Boolean(subagentsRes.ok && subagentsRes.data),
        empty: Boolean(subagentsRes.ok && subagentsRes.data && subagentsRes.data.subagents.length === 0),
        error: subagentsRes.ok ? undefined : (subagentsRes.error?.message ?? subagentsRes.code),
        stale: !subagentsRes.ok && (previous?.subagents?.length ?? 0) > 0,
        last_successful_at_ms: subagentsRes.ok ? observedAt : prevSource("subagents")?.last_successful_at_ms,
      }),
    ];
    const account = accountScope();
    this.evidence.ingestTodos({
      account,
      agent_id: agentId,
      todos: todosRes.ok && todosRes.data ? todosRes.data.todos : undefined,
      ok: todosRes.ok,
      error: todosRes.ok ? undefined : (todosRes.error?.message ?? todosRes.code),
      at: observedAt,
    });
    this.evidence.ingestTasks({
      account,
      agent_id: agentId,
      tasks: tasksRes.ok && tasksRes.data ? tasksRes.data.tasks : undefined,
      ok: tasksRes.ok,
      error: tasksRes.ok ? undefined : (tasksRes.error?.message ?? tasksRes.code),
      at: observedAt,
    });
    this.evidence.ingestSubagents({
      account,
      agent_id: agentId,
      subagents: subagentsRes.ok && subagentsRes.data ? subagentsRes.data.subagents : undefined,
      ok: subagentsRes.ok,
      error: subagentsRes.ok ? undefined : (subagentsRes.error?.message ?? subagentsRes.code),
      at: observedAt,
    });
    this.publishDetail(this.withBreakdown(detail));
    this.publishEvidence(agentId);
  }

  private withBreakdown(detail: DashboardBotDetail): DashboardBotDetail {
    const row = this.frame.bots.find((b) => b.bot.agent_id === detail.agent_id);
    const next = { ...detail };
    if (this.breakdownError && !this.lastBreakdown) {
      next.usage_breakdown_error = this.breakdownError;
      delete next.usage_breakdown;
      delete next.usage_breakdown_kind;
      return next;
    }
    const rows = breakdownRowsForBot(this.lastBreakdown, {
      agent_id: detail.agent_id,
      bot_id: row?.bot.id,
    });
    if (rows.length) {
      next.usage_breakdown = rows;
      next.usage_breakdown_kind = this.lastBreakdown?.kind;
      delete next.usage_breakdown_error;
    } else {
      delete next.usage_breakdown;
      delete next.usage_breakdown_kind;
      if (this.breakdownError) next.usage_breakdown_error = this.breakdownError;
      else delete next.usage_breakdown_error;
    }
    return next;
  }

  private refreshOpenSessionViews(): void {
    for (const agentId of new Set([...this.focusedAgentIds(), ...this.details.keys()])) {
      const cached = this.details.get(agentId);
      if (!cached) continue;
      const session_view = this.sharedSessionView(agentId, cached.sessions);
      if (JSON.stringify(session_view) !== JSON.stringify(cached.session_view)) {
        this.publishDetail(this.withBreakdown({ ...cached, session_view }));
      }
    }
    this.reconcileDetailLoops();
  }

  /** Shared detail carries Bot-level facts only; viewed session stays per client. */
  private sharedSessionView(agentId: string, sessions: DashboardBotDetail["sessions"]): DashboardBotDetail["session_view"] {
    const row = this.frame.bots.find((b) => b.bot.agent_id === agentId);
    return presentSessionView({
      sessions,
      statusSessionId: row?.status?.session_id,
      viewerSessionId: row?.bot.viewer_session_id || undefined,
    });
  }

  private decorateDetail(shared: DashboardBotDetail, clientId?: string): DashboardBotDetail {
    const row = this.frame.bots.find((b) => b.bot.agent_id === shared.agent_id);
    let requested: string | undefined;
    if (clientId) requested = this.focuses.get(clientId)?.view_session_id;
    else {
      const clients = [...this.focuses.values()].filter((f) => f.agent_id === shared.agent_id);
      if (clients.length === 1) requested = clients[0]?.view_session_id;
    }
    return {
      ...shared,
      session_view: presentSessionView({
        sessions: shared.sessions,
        statusSessionId: row?.status?.session_id,
        viewerSessionId: row?.bot.viewer_session_id || undefined,
        requestedViewId: requested,
      }),
    };
  }

  private resolvedSession(focus: FocusRecord): string | undefined {
    if (focus.view_session_id && this.sessionKnown(focus.agent_id, focus.view_session_id)) {
      return focus.view_session_id;
    }
    const shared = this.details.get(focus.agent_id);
    if (!shared) return focus.view_session_id;
    return presentSessionView({
      sessions: shared.sessions,
      statusSessionId: this.frame.bots.find((b) => b.bot.agent_id === focus.agent_id)?.status?.session_id,
      viewerSessionId: this.frame.bots.find((b) => b.bot.agent_id === focus.agent_id)?.bot.viewer_session_id || undefined,
      requestedViewId: focus.view_session_id,
    }).viewed_session_id;
  }

  private sessionKnown(agentId: string, sessionId: string): boolean {
    return Boolean(this.details.get(agentId)?.sessions.some((s) => s.session_id === sessionId));
  }

  private reconcileTimelineLoops(): void {
    if (!this.canPollUpstream()) {
      this.clearTimelineLoops();
      return;
    }
    const wanted = this.wantedTimelines();
    for (const [key, visible] of wanted) {
      const existing = this.timelines.get(key);
      if (!existing && !this.timelineInflight.has(key)) {
        // Initial fetch even if the timeline is off-screen; only the refresh loop pauses.
        void this.tickTimeline(key);
        continue;
      }
      if (!visible) {
        if (existing && !existing.paused) {
          const [agentId, sessionId] = splitTimelineKey(key);
          this.evidence.ingestTranscript({
            account: accountScope(),
            agent_id: agentId,
            session_id: sessionId,
            generation: existing.generation,
            generation_known: existing.generation_known,
            entries: existing.entries,
            ok: false,
            paused: true,
            at: Date.now(),
          });
          this.publishTimeline({ ...existing, paused: true, result: "paused", at_ms: Date.now() });
          this.publishEvidence(agentId);
        }
        const t = this.timelineTimers.get(key);
        if (t) clearTimeout(t);
        this.timelineTimers.delete(key);
        continue;
      }
      if (!this.timelineTimers.has(key) && !this.timelineInflight.has(key)) {
        void this.tickTimeline(key);
      } else {
        this.scheduleTimeline(key);
      }
    }
    for (const key of [...this.timelineTimers.keys()]) {
      if (!wanted.has(key) || wanted.get(key) === false) {
        const t = this.timelineTimers.get(key);
        if (t) clearTimeout(t);
        this.timelineTimers.delete(key);
      }
    }
  }

  private wantedTimelines(): Map<string, boolean> {
    const demands: ClientDemand[] = [...this.focuses.values()].map((focus) => ({
      ...focus,
      view_session_id: this.resolvedSession(focus),
    }));
    const agg = aggregateDemands(demands);
    const wanted = new Map<string, boolean>();
    for (const [key, demand] of agg.transcript) {
      wanted.set(key, demand.poll);
    }
    return wanted;
  }

  private timelineInterval(agentId: string): number {
    const row = this.frame.bots.find((b) => b.bot.agent_id === agentId);
    const active = row?.category === "running" || row?.category === "waiting";
    return active ? this.timelineActiveIntervalMs : this.timelineIdleIntervalMs;
  }

  private scheduleTimeline(key: string, delay?: number): void {
    const [agentId] = splitTimelineKey(key);
    const prev = this.timelineTimers.get(key);
    if (prev) clearTimeout(prev);
    const wanted = this.wantedTimelines();
    if (!this.canPollUpstream() || wanted.get(key) !== true) {
      this.timelineTimers.delete(key);
      return;
    }
    this.timelineTimers.set(
      key,
      setTimeout(() => {
        void this.tickTimeline(key);
      }, delay ?? this.timelineInterval(agentId)),
    );
  }

  private async tickTimeline(key: string): Promise<void> {
    const wanted = this.wantedTimelines();
    if (!this.canPollUpstream() || !wanted.has(key)) return;
    const existing = this.timelineInflight.get(key);
    if (existing) return existing;
    const work = this.loadTimeline(key)
      .catch(() => undefined)
      .finally(() => {
        this.timelineInflight.delete(key);
        if (this.wantedTimelines().get(key) === true) this.scheduleTimeline(key);
      });
    this.timelineInflight.set(key, work);
    return work;
  }

  private async loadTimeline(key: string): Promise<void> {
    const [agentId, sessionId] = splitTimelineKey(key);
    const interval = this.timelineInterval(agentId);
    const res = await this.plane.message.transcript({ agentId, sessionId });
    if (this.isRefreshFailure(res)) {
      this.onRefreshFailure(firstError(res));
      return;
    }
    const previous = this.timelines.get(key);
    const at = Date.now();
    if (res.ok && res.data) {
      const generationKnown = res.data.generation !== undefined && res.data.generation !== null;
      this.evidence.ingestTranscript({
        account: accountScope(),
        agent_id: agentId,
        session_id: sessionId,
        generation: generationKnown ? res.data.generation : undefined,
        generation_known: generationKnown,
        entries: res.data.entries,
        ok: true,
        at,
        locally_truncated: res.data.truncated,
      });
      this.publishTimeline({
        agent_id: agentId,
        session_id: sessionId,
        at_ms: at,
        ...(generationKnown ? { generation: res.data.generation } : {}),
        generation_known: generationKnown,
        entries: res.data.entries,
        truncated: res.data.truncated,
        paused: false,
        interval_ms: interval,
        note: res.data.note,
        result: "ok",
        source_freshness: "unknown",
        last_successful_observed_at_ms: at,
      });
      this.publishEvidence(agentId, sessionId);
    } else {
      this.evidence.ingestTranscript({
        account: accountScope(),
        agent_id: agentId,
        session_id: sessionId,
        generation: previous?.generation,
        generation_known: previous?.generation_known ?? false,
        entries: previous?.entries ?? [],
        ok: false,
        error: res.error?.message ?? res.code ?? "transcript failed",
        at,
      });
      this.publishTimeline({
        agent_id: agentId,
        session_id: sessionId,
        at_ms: at,
        ...(previous?.generation_known ? { generation: previous.generation } : {}),
        generation_known: previous?.generation_known ?? false,
        entries: previous?.entries ?? [],
        truncated: previous?.truncated ?? false,
        error: res.error?.message ?? res.code ?? "transcript failed",
        paused: false,
        interval_ms: interval,
        note: "成绩单读取失败，已保留上次结果（如有）。",
        result: "error",
        source_freshness: "unknown",
        last_successful_observed_at_ms: previous?.last_successful_observed_at_ms,
      });
      this.publishEvidence(agentId, sessionId);
    }
  }

  private focusedAgentIds(): Set<string> {
    return new Set([...this.focuses.values()].map((f) => f.agent_id));
  }

  private clearDetailLoops(): void {
    for (const t of this.detailTimers.values()) clearTimeout(t);
    this.detailTimers.clear();
    this.clearTimelineLoops();
  }

  private clearTimelineLoops(): void {
    for (const t of this.timelineTimers.values()) clearTimeout(t);
    this.timelineTimers.clear();
  }

  private isRefreshFailure(res: ResultEnvelope<unknown>): boolean {
    if (res.ok) return false;
    const code = res.code ?? "";
    if (code === "unauthenticated" || code === "auth" || code === "auth_revoked") return true;
    if (code.startsWith("auth_refresh_")) return true;
    return false;
  }

  private onRefreshFailure(message?: string): void {
    this.refreshFailed = true;
    this.disarmUpstream();
    this.publish({
      ...this.frame,
      auth: {
        logged_in: false,
        banner: "auth_refresh_failed",
        ...(this.lastWhoami ? { whoami: { ...this.lastWhoami, logged_in: false } } : {}),
      },
      connection: {
        ...this.frame.connection,
        upstream: "auth_refresh_failed",
        ...(message ? { error: message } : {}),
      },
    });
  }

  private emptyFrame(connection: DashboardFrame["connection"]): DashboardFrame {
    return {
      schema_version: FRAME_SCHEMA,
      at_ms: Date.now(),
      connection,
      auth: { logged_in: false, banner: "login_required" },
      computer: presentComputer(undefined, { failed: true }),
      bots: [],
      counts: { total: 0, running: 0, waiting: 0, unknown: 0 },
      list_truncated: false,
      sidebar: [],
      ...(this.plane.simulated ? { simulated: true } : {}),
    };
  }

  private publish(next: DashboardFrame): void {
    const sse: "connected" | "idle" = this.browsers > 0 ? "connected" : "idle";
    this.frame = { ...next, connection: { ...next.connection, sse } };
    for (const fn of this.listeners) {
      try {
        fn(this.frame);
      } catch {
        /* isolate a bad SSE client */
      }
    }
  }

  private publishDetail(detail: DashboardBotDetail): void {
    this.details.set(detail.agent_id, detail);
    for (const fn of this.detailListeners) {
      try {
        fn(detail);
      } catch {
        /* isolate */
      }
    }
  }

  private publishTimeline(timeline: DashboardTimeline): void {
    if (timeline.session_id) this.timelines.set(timelineKey(timeline.agent_id, timeline.session_id), timeline);
    for (const fn of this.timelineListeners) {
      try {
        fn(timeline);
      } catch {
        /* isolate */
      }
    }
  }

  private publishEvidence(agentId: string, sessionId?: string): void {
    const evidence = this.getEvidence(agentId, sessionId);
    for (const fn of this.evidenceListeners) {
      try {
        fn(evidence);
      } catch {
        /* isolate */
      }
    }
  }
}

function firstError(...results: ResultEnvelope<unknown>[]): string | undefined {
  for (const r of results) {
    if (!r.ok) return r.error?.message ?? r.code;
  }
  return undefined;
}

function timelineKey(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

function splitTimelineKey(key: string): [string, string] {
  const i = key.indexOf("\0");
  return [key.slice(0, i), key.slice(i + 1)];
}

function mergeSources(
  previous: SourceFreshnessView[] | undefined,
  updates: SourceFreshnessView[],
): SourceFreshnessView[] {
  const byId = new Map((previous ?? []).map((s) => [s.id, s]));
  for (const row of updates) byId.set(row.id, row);
  const order = ["bots", "statuses", "computer", "sidebar", "usage", "usage_breakdown"];
  const rest = [...byId.keys()].filter((id) => !order.includes(id)).sort();
  return [...order, ...rest].flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

