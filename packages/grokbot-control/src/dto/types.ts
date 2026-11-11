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


/** Sanitized whoami for the local `gbc dashboard` page (no tokens or paths). */
export type SanitizedWhoami = {
  kind: "cursor" | "xai";
  account_label?: string;
  logged_in: boolean;
  login_kind?: string;
  pending_login: boolean;
  static_token: boolean;
};

/**
 * Read-only view of official GetSandUsageStatus (DashboardService).
 * `usage_percent` units are unverified; do not invent numbers or billing URLs.
 */
export type UsageStatusView = {
  current_period_start?: string;
  next_reset_at?: string;
  usage_percent?: number;
  /** Units have not been live-verified; UI must label this. */
  usage_percent_unit: "unverified";
  included_limit_zero: boolean;
  has_non_zero_included_limit: boolean;
  has_available_usage: boolean;
  available_banked_reset_count?: string;
  uses_pooled_enterprise_allowance: boolean;
  is_team_seat: boolean;
  is_unified: boolean;
  cursor_plan_name?: string;
  grok_plan_label?: string;
  included_usage_super_grok_plan?: string;
  billing_brand?: string;
  sand_trial_expires_at?: string;
  sand_trial_cancelable: boolean;
  account_merge_pausing_bots: boolean;
  /** Present only when the official response included a URL; never concatenated. */
  unified_billing_url?: string;
  /** Present only when on_demand_settings.dashboard_url was a real URL. */
  on_demand_dashboard_url?: string;
  notes: string[];
};

export type BotRunCategory = "running" | "waiting" | "idle" | "unknown";

export type DashboardBotRow = {
  bot: BotSummary;
  status?: ProgressStatus;
  category: BotRunCategory;
  waiting_reason?: string;
};

export type ComputerView = {
  /** Raw ComputerOps state string, or "unknown" when missing/failed/stale. */
  state: string;
  state_code?: number;
  /** computer.state is not live-verified. */
  live_verified: false;
  stale: boolean;
  /** UI tone; "unknown" and stale must not be painted as green running. */
  tone: "running" | "starting" | "hibernated" | "absent" | "unknown";
  label: string;
  note: string;
  image_update_available?: boolean;
};

export type DashboardAuthView = {
  logged_in: boolean;
  banner?: "login_required" | "auth_refresh_failed";
  whoami?: SanitizedWhoami;
};

export type DashboardConnectionView = {
  sse: "connected" | "idle";
  last_successful_upstream_at_ms?: number;
  upstream: "ok" | "error" | "idle" | "unauthenticated" | "auth_refresh_failed";
  error?: string;
};

/** Frame pushed over SSE / used as the shared poller cache. No secrets. */
export type DashboardFrame = {
  schema_version: "1.0.0";
  at_ms: number;
  connection: DashboardConnectionView;
  auth: DashboardAuthView;
  computer: ComputerView;
  bots: DashboardBotRow[];
  counts: { total: number; running: number; waiting: number; unknown: number };
  list_truncated: boolean;
  list_hint?: string;
  sidebar: SidebarSection[];
  usage?: UsageStatusView;
  usage_error?: string;
  simulated?: boolean;
};
