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
  last_activity_at_ms?: string;
};

export type SanitizedAwaiting = {
  observed: true;
  reason?: string;
  reason_unknown?: true;
};

export type WaitingKind = "approval" | "input" | "box_handoff" | "retrying" | "other";

export type WaitingSignalView = {
  kind: WaitingKind;
  label: string;
  reason?: string;
  /** Collapsed one-line preview; never the full original instruction. */
  instruction_preview?: string;
  instruction_hidden?: boolean;
};

export type LiveActivityView = {
  kind?: string;
  tool?: string;
};

export type TurnSettlementView = {
  outcome?: string;
  settled_at_ms?: string;
  /** Set only when the outcome token is a known normal/abnormal value. */
  settled_normally?: boolean;
};

export type BoxHandoffView = {
  present: true;
  has_instruction: boolean;
  instruction_preview?: string;
  instruction_hidden?: boolean;
};

export type ClientActivityView = {
  last_activity_at_ms?: string;
  unread_count?: number;
  unread_thread_count?: number;
};

export type ProgressStatus = {
  agent_id: string;
  is_running: boolean;
  session_id?: string;
  live?: {
    is_composing_message?: boolean;
    is_retrying?: boolean;
    /** Whitelisted waiting record only; never the raw awaiting object. */
    awaiting?: SanitizedAwaiting;
    working_task_ids?: string[];
    activity?: LiveActivityView;
    last_turn_settlement?: TurnSettlementView;
    box_handoff?: BoxHandoffView;
    updated_at_ms?: string;
    stale_after_ms?: string;
  };
  client?: ClientActivityView;
};

export type ChannelKind = "slack" | "teams";

export type ChannelConnectionState =
  | "connected"
  | "not_connected"
  | "pending"
  | "removed"
  | "unavailable"
  | "unknown"
  | "other";

/** Sanitized channel row from ListGrokBotAgents. Never includes install/reinstall URLs. */
export type ChannelConnectionView = {
  agent_id: string;
  channel: ChannelKind;
  /** True only for confirmed connected/installed states. Unknown is never true. */
  connected: boolean;
  state: ChannelConnectionState;
  label: string;
  workspace_or_tenant?: string;
};

export type SourceFreshnessView = {
  id: string;
  label: string;
  result: "ok" | "error" | "idle";
  /** Set only after a successful read of an empty list. Never used for a failed read. */
  empty?: boolean;
  stale?: boolean;
  last_successful_at_ms?: number;
  error?: string;
};

/**
 * Where `session_id` came from. `SendGrokBotUserMessage` / `GetGrokBotSendStatus`
 * never return a session id, so an omitted caller value stays unknown.
 */
export type SessionSource = "caller" | "default_unreported";

/** aiserver.v1.GrokBotHarnessRefusal, as returned by SendGrokBotUserMessage. */
export type SendRefusal = { failure_code: string; message: string };

export type SendDelivery = {
  message_id: string;
  agent_id: string;
  /** Caller-supplied session id, or null when the default session was used. */
  session_id: string | null;
  session_source: SessionSource;
  dispatched?: boolean;
  /** GrokBotUserMessageDelivery name (lower snake), e.g. "accepted_temporal"; "unknown" if not in the schema. */
  delivery?: string;
  delivery_code?: number;
  /** GrokBotTemporalHarnessMode name (lower snake), e.g. "live". */
  mode?: string;
  mode_code?: number;
  workflow_id?: string | null;
  refusal?: SendRefusal | null;
  /** Delivery/acceptance only — NOT task/business success. */
  note: string;
};

export type SendStatusView = {
  agent_id: string;
  message_id: string;
  session_id: string | null;
  session_source: SessionSource;
  /** GrokBotSendStatus name (lower snake), e.g. "accepted"; "unknown" if not in the schema. */
  status: string;
  status_code: number;
  echo_entry_id: string | null;
  rejection_code: string | null;
  accepted_at_ms: string | null;
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
 * `usage_percent` is already a percentage (21.781372 means about 21.78%).
 * Do not invent numbers or billing URLs, and do not multiply by 100.
 */
export type UsageStatusView = {
  current_period_start?: string;
  next_reset_at?: string;
  usage_percent?: number;
  /** Confirmed as a precomputed percentage; format in the UI, do not rescale. */
  usage_percent_unit: "percent";
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
  waiting_signals?: WaitingSignalView[];
  channels?: ChannelConnectionView[];
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
  retrying?: boolean;
  retry_backoff_ms?: number;
  sources?: SourceFreshnessView[];
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
  usage_breakdown?: UsageBreakdownView;
  usage_breakdown_error?: string;
  /** Sanitized Slack/Teams connection rows from ListGrokBotAgents; no install URLs. */
  channels?: ChannelConnectionView[];
  simulated?: boolean;
};


/** Native agent todo (ListGrokBotAgentTodos / agent.v1.TodoItem). */
export type TodoStatusView =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "unspecified"
  | "unknown";

export type TodoItemView = {
  id: string;
  content?: string;
  status: TodoStatusView;
  /** Raw proto int64; unit not assumed. */
  created_at?: string;
  updated_at?: string;
  dependencies?: string[];
};

/** Native agent task (ListGrokBotAgentTasks / GrokBotAgentTask). */
export type AgentTaskView = {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  updated_at_ms?: string;
  last_message_at_ms?: string;
  last_message_entry_id?: string;
  subagent_ids?: string[];
  followed?: boolean;
  file_count?: number;
};

/** Running subagent (ListGrokBotSubagents / GrokBotRunningSubagent). */
export type SubagentView = {
  subagent_id: string;
  subagent_type?: string;
  title?: string;
  started_at_ms?: string;
  fresh_until_ms?: string;
};

/**
 * Parsed transcript / history entry for the local dashboard timeline.
 * Bodies come from the existing history/transcript SDK decoder; ciphertext is not decrypted.
 * `text` is untrusted model/user content.
 */
export type TimelineEntryView = {
  entry_id?: string;
  seq?: string;
  /** Outer protobuf updated_seq; missing becomes source_version "unknown". */
  updated_seq?: string;
  source_version: string;
  kind?: string;
  timestamp_ms?: string;
  role?: string;
  text?: string;
  tool_name?: string;
  tool_status?: string;
  attachment_name?: string;
  decode_status: "decoded" | "opaque" | "absent" | "omitted";
  decode_reason?: string;
  untrusted: true;
};

export type UsageBreakdownKind =
  | "billed_cents"
  | "weekly_limit_ppm"
  | "billing_cycle_ppm"
  | "empty";

export type UsageBreakdownRow = {
  day_ms?: string;
  source?: string;
  bot_id?: string;
  /** Raw cents integer as string; currency/scale unverified. */
  cents?: string;
  /** Raw ppm integer; this is a share of the limit in parts per million (1% = 10000 ppm). */
  ppm?: number;
};

/**
 * Read-only view of official GetGrokBotUsageBreakdown (DashboardService).
 * The first call must omit enterprise_team_id; never invent a team id.
 * Amount and currency remain unverified. ppm is a parts-per-million share of the limit.
 */
export type UsageBreakdownView = {
  kind: UsageBreakdownKind;
  period_start_ms?: string;
  period_end_ms?: string;
  by_source: UsageBreakdownRow[];
  by_bot: UsageBreakdownRow[];
  notes: string[];
  units: "unverified";
};

/**
 * Local transcript-view session selection. This is not an official session-switch
 * write RPC and is not the default critical path until separately accepted.
 */
export type SessionViewState = {
  current_session_id?: string;
  current_session_source: "status" | "viewer_session" | "none";
  viewed_session_id?: string;
  switch_available: boolean;
  switch_error?: string;
  note: string;
};

/** Per-Bot detail payload (sessions / todos / tasks / subagents / optional per-bot usage). */
export type DashboardBotDetail = {
  agent_id: string;
  at_ms: number;
  /** Last time at least one detail source succeeded. Omitted until then. */
  last_successful_at_ms?: number;
  sessions: SessionSummary[];
  sessions_error?: string;
  session_view: SessionViewState;
  /** Present only after a successful list; never invent todos. */
  todos?: TodoItemView[];
  todos_error?: string;
  tasks?: AgentTaskView[];
  tasks_error?: string;
  subagents?: SubagentView[];
  subagents_error?: string;
  /** by_bot rows whose bot_id matches this Bot; omitted when none. */
  usage_breakdown?: UsageBreakdownRow[];
  usage_breakdown_kind?: UsageBreakdownKind;
  usage_breakdown_error?: string;
  sources?: SourceFreshnessView[];
  notes: string[];
};

export type DashboardTimeline = {
  agent_id: string;
  session_id?: string;
  at_ms: number;
  /** Present only when the source actually returned a generation; omission is not 0. */
  generation?: number;
  generation_known: boolean;
  entries: TimelineEntryView[];
  truncated: boolean;
  error?: string;
  paused: boolean;
  interval_ms: number;
  note: string;
  last_successful_observed_at_ms?: number;
  result: "ok" | "error" | "paused" | "idle";
  source_freshness: "unknown";
};

export type DashboardFocus = {
  client_id: string;
  connection_epoch?: string;
  agent_id?: string;
  view_session_id?: string;
  timeline_visible: boolean;
  graph_visible?: boolean;
};

