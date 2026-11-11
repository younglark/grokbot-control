export type SanitizedWhoami = {
  kind: "cursor" | "xai";
  account_label?: string;
  logged_in: boolean;
  login_kind?: string;
  pending_login: boolean;
  static_token: boolean;
};

export type UsageStatusView = {
  current_period_start?: string;
  next_reset_at?: string;
  usage_percent?: number;
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
  unified_billing_url?: string;
  on_demand_dashboard_url?: string;
  notes: string[];
};

export type BotRunCategory = "running" | "waiting" | "idle" | "unknown";

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
};

export type ProgressStatus = {
  agent_id: string;
  is_running: boolean;
  session_id?: string;
  live?: {
    is_composing_message?: boolean;
    is_retrying?: boolean;
    awaiting?: unknown;
  };
};

export type DashboardBotRow = {
  bot: BotSummary;
  status?: ProgressStatus;
  category: BotRunCategory;
  waiting_reason?: string;
};

export type ComputerView = {
  state: string;
  state_code?: number;
  live_verified: false;
  stale: boolean;
  tone: "running" | "starting" | "hibernated" | "absent" | "unknown";
  label: string;
  note: string;
};

export type DashboardFrame = {
  schema_version: "1.0.0";
  at_ms: number;
  connection: {
    sse: "connected" | "idle";
    last_successful_upstream_at_ms?: number;
    upstream: "ok" | "error" | "idle" | "unauthenticated" | "auth_refresh_failed";
    error?: string;
  };
  auth: {
    logged_in: boolean;
    banner?: "login_required" | "auth_refresh_failed";
    whoami?: SanitizedWhoami;
  };
  computer: ComputerView;
  bots: DashboardBotRow[];
  counts: { total: number; running: number; waiting: number; unknown: number };
  list_truncated: boolean;
  list_hint?: string;
  sidebar: { id: string; name: string; agent_ids: string[] }[];
  usage?: UsageStatusView;
  usage_error?: string;
  simulated?: boolean;
};

export type FilterKey = "all" | "running" | "waiting" | "unknown";
