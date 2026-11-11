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

export type WaitingKind = "approval" | "input" | "box_handoff" | "retrying" | "other";

export type WaitingSignalView = {
  kind: WaitingKind;
  label: string;
  reason?: string;
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
    awaiting?: { observed: true; reason?: string; reason_unknown?: true };
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

export type ChannelConnectionView = {
  agent_id: string;
  channel: ChannelKind;
  connected: boolean;
  state: ChannelConnectionState;
  label: string;
  workspace_or_tenant?: string;
};

export type SourceFreshnessView = {
  id: string;
  label: string;
  result: "ok" | "error" | "idle";
  empty?: boolean;
  stale?: boolean;
  last_successful_at_ms?: number;
  error?: string;
};

export type DashboardBotRow = {
  bot: BotSummary;
  status?: ProgressStatus;
  category: BotRunCategory;
  waiting_reason?: string;
  waiting_signals?: WaitingSignalView[];
  channels?: ChannelConnectionView[];
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
    retrying?: boolean;
    retry_backoff_ms?: number;
    sources?: SourceFreshnessView[];
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
  usage_breakdown?: UsageBreakdownView;
  usage_breakdown_error?: string;
  channels?: ChannelConnectionView[];
  simulated?: boolean;
};

export type FilterKey = "all" | "running" | "waiting" | "unknown";

export type TodoStatusView = "pending" | "in_progress" | "completed" | "cancelled" | "unspecified" | "unknown";

export type TodoItemView = {
  id: string;
  content?: string;
  status: TodoStatusView;
  created_at?: string;
  updated_at?: string;
  dependencies?: string[];
};

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

export type SubagentView = {
  subagent_id: string;
  subagent_type?: string;
  title?: string;
  started_at_ms?: string;
  fresh_until_ms?: string;
};

export type TimelineEntryView = {
  entry_id?: string;
  seq?: string;
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

export type UsageBreakdownKind = "billed_cents" | "weekly_limit_ppm" | "billing_cycle_ppm" | "empty";

export type UsageBreakdownRow = {
  day_ms?: string;
  source?: string;
  bot_id?: string;
  cents?: string;
  /** Raw ppm integer; share of the limit in parts per million (1% = 10000 ppm). */
  ppm?: number;
};

export type UsageBreakdownView = {
  kind: UsageBreakdownKind;
  period_start_ms?: string;
  period_end_ms?: string;
  by_source: UsageBreakdownRow[];
  by_bot: UsageBreakdownRow[];
  notes: string[];
  units: "unverified";
};

export type SessionSummary = {
  agent_id: string;
  session_id: string;
  kind: string;
  created_at_ms?: string;
  updated_at_ms?: string;
  last_activity_at_ms?: string;
};

export type SessionViewState = {
  current_session_id?: string;
  current_session_source: "status" | "viewer_session" | "none";
  viewed_session_id?: string;
  switch_available: boolean;
  switch_error?: string;
  note: string;
};

export type DashboardBotDetail = {
  agent_id: string;
  at_ms: number;
  last_successful_at_ms?: number;
  sessions: SessionSummary[];
  sessions_error?: string;
  session_view: SessionViewState;
  todos?: TodoItemView[];
  todos_error?: string;
  tasks?: AgentTaskView[];
  tasks_error?: string;
  subagents?: SubagentView[];
  subagents_error?: string;
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

export type SourceObservation = {
  source: "status" | "tasks" | "subagents" | "todos" | "transcript";
  last_successful_observed_at_ms?: number;
  result: "ok" | "error" | "paused" | "idle";
  source_freshness: "unknown";
  error?: string;
  paused?: boolean;
};

export type ObservedEntity = {
  entity_key: string;
  scope_key: string;
  kind: "task" | "subagent" | "todo" | "activity";
  source_id: string;
  entry_id?: string;
  seq?: string;
  generation?: number;
  generation_known: boolean;
  source_version: string;
  snapshot_revision: string;
  observed_at_ms: number;
  source_time_ms?: string;
  evidence_kind: "snapshot_observation" | "source_event";
  presence: "in_snapshot" | "not_in_snapshot" | "outside_window";
  raw_status?: string;
  view_status: "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown" | "idle";
  title?: string;
  text?: string;
  tool_name?: string;
  last_accessed_at_ms: number;
  selected?: boolean;
  last_message_entry_id?: string;
  last_message_ref?: { state: string; entity_key?: string; detail: string };
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

export type EvidenceGap = {
  kind: string;
  scope_key: string;
  entity_key?: string;
  detail: string;
};

export type DashboardEvidence = {
  schema_version: "1.0.0";
  agent_id: string;
  session_id?: string;
  account: string;
  at_ms: number;
  snapshot_revision: string;
  observations: SourceObservation[];
  entities: ObservedEntity[];
  edges: EvidenceEdge[];
  groups: { id: string; kind: string; label: string }[];
  entry_index_conflicts: { scope_key: string; entry_id: string; entity_keys: string[] }[];
  gaps: EvidenceGap[];
  history_completeness: "unknown" | "locally_truncated";
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
