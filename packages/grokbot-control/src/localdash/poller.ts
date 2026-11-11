import { LIMIT_MAX } from "../ops/limits.js";
import type { ControlPlane } from "../ops/plane.js";
import type { ComputerState } from "../ops/computer.js";
import type {
  DashboardFrame,
  ProgressStatus,
  SanitizedWhoami,
  SidebarSection,
  UsageStatusView,
} from "../dto/types.js";
import type { ResultEnvelope } from "../dto/result.js";
import { sanitizeWhoami } from "./sanitize.js";
import { buildBotRows, countRows, presentComputer } from "./view.js";

export const FRAME_SCHEMA = "1.0.0" as const;
export const UPSTREAM_INTERVAL_MS = 5_000;
export const USAGE_INTERVAL_MS = 60_000;
export const WHOAMI_INTERVAL_MS = 30_000;
const BACKOFF_CAP_MS = 60_000;

export type PollerListener = (frame: DashboardFrame) => void;

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
  private backoffMs = UPSTREAM_INTERVAL_MS;
  private refreshFailed = false;
  private loggedIn = false;
  private lastWhoami: SanitizedWhoami | undefined;
  private lastComputer: ComputerState | undefined;
  private lastUsage: UsageStatusView | undefined;
  private frame: DashboardFrame;
  private closed = false;

  constructor(private plane: ControlPlane) {
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

  browserConnected(): void {
    this.browsers += 1;
    this.publish({ ...this.frame, connection: { ...this.frame.connection, sse: "connected" } });
    this.arm();
    void this.refreshWhoami();
  }

  browserDisconnected(): void {
    this.browsers = Math.max(0, this.browsers - 1);
    if (this.browsers === 0) {
      this.disarmUpstream();
      this.publish({
        ...this.frame,
        connection: { ...this.frame.connection, sse: "idle" },
      });
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

  close(): void {
    this.closed = true;
    this.browsers = 0;
    this.disarmUpstream();
    if (this.whoamiTimer) clearTimeout(this.whoamiTimer);
    this.whoamiTimer = undefined;
    this.listeners.clear();
  }

  private arm(): void {
    if (this.closed) return;
    this.scheduleWhoami();
    if (this.canPollUpstream()) {
      void this.tickUpstream();
      if (!this.lastUsage) void this.refreshUsage();
    }
    this.scheduleUpstream();
    this.scheduleUsage();
  }

  private disarmUpstream(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
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
        if (!this.lastUsage) void this.refreshUsage();
        void this.tickUpstream();
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

    const botsOk = botsRes.ok && botsRes.data;
    const bots = botsOk ? botsRes.data!.bots : this.frame.bots.map((r) => r.bot);
    const truncated = Boolean(botsOk && (botsRes.data!.truncated || botsRes.data!.hint));
    const listHint = botsOk ? botsRes.data!.hint : this.frame.list_hint;

    let statuses: ProgressStatus[] = this.frame.bots.map((r) => r.status).filter(Boolean) as ProgressStatus[];
    if (botsOk) {
      const ids = bots.map((b) => b.agent_id).filter(Boolean);
      const st = await this.plane.progress.status(ids);
      if (this.isRefreshFailure(st)) {
        this.onRefreshFailure(firstError(st));
        return;
      }
      if (st.ok && st.data) statuses = st.data.statuses;
    }

    const rows = buildBotRows(bots, statuses);
    let computerFailed = !computerRes.ok;
    if (computerRes.ok && computerRes.data) this.lastComputer = computerRes.data;
    const sidebar: SidebarSection[] =
      sidebarRes.ok && sidebarRes.data ? sidebarRes.data.sections : this.frame.sidebar;

    const upstreamError = !botsOk || !sidebarRes.ok || computerFailed;
    if (upstreamError) {
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CAP_MS);
    } else {
      this.backoffMs = UPSTREAM_INTERVAL_MS;
    }

    const now = Date.now();
    this.publish({
      schema_version: FRAME_SCHEMA,
      at_ms: now,
      connection: {
        sse: this.browsers > 0 ? "connected" : "idle",
        last_successful_upstream_at_ms: botsOk && sidebarRes.ok && !computerFailed
          ? now
          : this.frame.connection.last_successful_upstream_at_ms,
        upstream: upstreamError ? "error" : "ok",
        ...(upstreamError
          ? { error: firstError(botsRes, computerRes, sidebarRes) }
          : {}),
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
      ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      ...(this.frame.usage_error ? { usage_error: this.frame.usage_error } : {}),
      ...(this.plane.simulated ? { simulated: true } : {}),
    });
  }

  private async loadUsage(): Promise<void> {
    if (!this.canPollUpstream()) return;
    const res = await this.plane.usage.status();
    if (this.isRefreshFailure(res)) {
      this.onRefreshFailure(firstError(res));
      return;
    }
    if (res.ok && res.data) {
      this.lastUsage = res.data;
      const next = { ...this.frame, usage: res.data };
      delete next.usage_error;
      this.publish(next);
    } else {
      this.publish({
        ...this.frame,
        usage_error: res.error?.message ?? "usage status failed",
        ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      });
    }
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
}

function firstError(...results: ResultEnvelope<unknown>[]): string | undefined {
  for (const r of results) {
    if (!r.ok) return r.error?.message ?? r.code;
  }
  return undefined;
}
