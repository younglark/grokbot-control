import type { DashboardServiceClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import {
  failResult,
  newRequestId,
  okResult,
  type ResultEnvelope,
} from "../dto/result.js";
import type { UsageBreakdownKind, UsageBreakdownRow, UsageBreakdownView, UsageStatusView } from "../dto/types.js";
import { int64ToString } from "./map.js";
import { GbcError } from "../errors.js";

/**
 * Read-only wrapper around official DashboardService.GetSandUsageStatus.
 * The local CLI command `gbc dashboard` uses this helper; it is not a general
 * DashboardService facade. Official write RPCs are never called here.
 * GetGrokBotUsageBreakdown is called without enterprise_team_id; this wrapper
 * never invents a team id.
 */
export class UsageOps {
  constructor(
    private client: DashboardServiceClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  private sim<T>(r: ResultEnvelope<T>): ResultEnvelope<T> {
    if (this.flags.simulated) r.simulated = true;
    return r;
  }

  /** Empty GetSandUsageStatusRequest only. */
  async status(): Promise<ResultEnvelope<UsageStatusView>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getSandUsageStatus({});
      return this.sim(okResult(mapUsageStatus(res), { request_id }));
    } catch (e) {
      return this.fail(e, request_id);
    }
  }

  /**
   * Official GetGrokBotUsageBreakdown with an empty request (no team id).
   * Do not guess enterprise_team_id to reach spend/events.
   */
  async breakdown(): Promise<ResultEnvelope<UsageBreakdownView>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getGrokBotUsageBreakdown({});
      return this.sim(okResult(mapUsageBreakdown(res), { request_id }));
    } catch (e) {
      return this.fail(e, request_id);
    }
  }

  private fail(e: unknown, request_id: string): ResultEnvelope<never> {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
    return this.sim(
      failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
        details: err.details,
      }),
    );
  }
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

function onlyHttpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return HTTP_URL.test(s) ? s : undefined;
}

function timestampToIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  }
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = v as any;
  if (t.seconds === undefined && t.nanos === undefined) return undefined;
  const sec = Number(t.seconds ?? 0);
  const ns = Number(t.nanos ?? 0);
  if (!Number.isFinite(sec)) return undefined;
  return new Date(sec * 1000 + ns / 1e6).toISOString();
}

function billingBrandName(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") {
    return { 0: "unspecified", 1: "cursor", 2: "grok" }[v] ?? `unknown_${v}`;
  }
  const raw = String(v);
  return raw
    .toLowerCase()
    .replace(/^sand_billing_brand_/, "")
    .replace(/_/g, "-");
}

/** Map a GetSandUsageStatusResponse into a UI DTO. Never invents numbers or URLs. */
export function mapUsageStatus(raw: unknown): UsageStatusView {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (raw ?? {}) as any;
  const notes: string[] = [
    "usage_percent 是已经算好的百分比，界面按百分数展示，不再视为单位未核实。",
  ];
  const includedLimitZero = Boolean(r.includedLimitZero ?? r.included_limit_zero);
  const hasNonZero = Boolean(r.hasNonZeroIncludedLimit ?? r.has_non_zero_included_limit);
  if (includedLimitZero || !hasNonZero) {
    notes.push("包含额度上限为 0 或未提供非零上限：不绘制满额进度条。");
  }
  if (r.usesPooledEnterpriseAllowance ?? r.uses_pooled_enterprise_allowance) {
    notes.push("企业共享额度。若出现 ppm / 分摊占比，在核实前仅作标注，不当成已核实的上限份额。");
  }

  const usageRaw = r.usagePercent ?? r.usage_percent;
  const usagePercent =
    typeof usageRaw === "number" && Number.isFinite(usageRaw) ? usageRaw : undefined;

  const view: UsageStatusView = {
    usage_percent_unit: "percent",
    included_limit_zero: includedLimitZero,
    has_non_zero_included_limit: hasNonZero,
    has_available_usage: Boolean(r.hasAvailableUsage ?? r.has_available_usage),
    uses_pooled_enterprise_allowance: Boolean(
      r.usesPooledEnterpriseAllowance ?? r.uses_pooled_enterprise_allowance,
    ),
    is_team_seat: Boolean(r.isTeamSeat ?? r.is_team_seat),
    is_unified: Boolean(r.isUnified ?? r.is_unified),
    sand_trial_cancelable: Boolean(r.sandTrialCancelable ?? r.sand_trial_cancelable),
    account_merge_pausing_bots: Boolean(
      r.accountMergePausingBots ?? r.account_merge_pausing_bots,
    ),
    notes,
  };

  const period = timestampToIso(r.currentPeriodStart ?? r.current_period_start);
  if (period) view.current_period_start = period;
  const reset = timestampToIso(r.nextResetTimestampUtc ?? r.next_reset_timestamp_utc);
  if (reset) view.next_reset_at = reset;
  if (usagePercent !== undefined) view.usage_percent = usagePercent;

  const banked = r.availableBankedResetCount ?? r.available_banked_reset_count;
  if (banked != null && banked !== "") view.available_banked_reset_count = String(banked);

  const plan = r.cursorPlanName ?? r.cursor_plan_name;
  if (typeof plan === "string" && plan) view.cursor_plan_name = plan;
  const grok = r.grokPlanLabel ?? r.grok_plan_label;
  if (typeof grok === "string" && grok) view.grok_plan_label = grok;
  const included = r.includedUsageSuperGrokPlan ?? r.included_usage_super_grok_plan;
  if (typeof included === "string" && included) view.included_usage_super_grok_plan = included;
  const brand = billingBrandName(r.billingBrand ?? r.billing_brand);
  if (brand) view.billing_brand = brand;
  const trial = timestampToIso(r.sandTrialExpiresAt ?? r.sand_trial_expires_at);
  if (trial) view.sand_trial_expires_at = trial;

  const billing = onlyHttpUrl(r.unifiedBillingUrl ?? r.unified_billing_url);
  if (billing) view.unified_billing_url = billing;
  const onDemand = r.onDemandSettings ?? r.on_demand_settings;
  const onDemandUrl = onlyHttpUrl(onDemand?.dashboardUrl ?? onDemand?.dashboard_url);
  if (onDemandUrl) view.on_demand_dashboard_url = onDemandUrl;

  return view;
}

const USAGE_SOURCE: Record<string, string> = {
  "0": "unspecified",
  unspecified: "unspecified",
  grok_bot_usage_source_unspecified: "unspecified",
  "1": "user",
  user: "user",
  grok_bot_usage_source_user: "user",
  "2": "automation",
  automation: "automation",
  grok_bot_usage_source_automation: "automation",
  "3": "agent",
  agent: "agent",
  grok_bot_usage_source_agent: "agent",
  "4": "group",
  group: "group",
  grok_bot_usage_source_group: "group",
  "5": "other",
  other: "other",
  grok_bot_usage_source_other: "other",
};

function mapUsageSource(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  const key = String(v).trim().toLowerCase();
  if (USAGE_SOURCE[key]) return USAGE_SOURCE[key];
  if (typeof v === "number" && Number.isFinite(v)) return `unknown_${v}`;
  return `unknown_${key}`;
}

function mapCentsRow(raw: unknown): UsageBreakdownRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (raw ?? {}) as any;
  const row: UsageBreakdownRow = {};
  const day = int64ToString(r.dayMs ?? r.day_ms);
  if (day) row.day_ms = day;
  const source = mapUsageSource(r.source);
  if (source) row.source = source;
  const bot = r.botId ?? r.bot_id;
  if (typeof bot === "string" && bot) row.bot_id = bot;
  const cents = int64ToString(r.cents);
  if (cents) row.cents = cents;
  return row;
}

function mapPpmRow(raw: unknown): UsageBreakdownRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (raw ?? {}) as any;
  const row: UsageBreakdownRow = {};
  const day = int64ToString(r.dayMs ?? r.day_ms);
  if (day) row.day_ms = day;
  const source = mapUsageSource(r.source);
  if (source) row.source = source;
  const bot = r.botId ?? r.bot_id;
  if (typeof bot === "string" && bot) row.bot_id = bot;
  const ppm = r.ppm;
  if (typeof ppm === "number" && Number.isFinite(ppm)) row.ppm = ppm;
  else if (ppm != null && ppm !== "" && Number.isFinite(Number(ppm))) row.ppm = Number(ppm);
  return row;
}

function pickSplit(raw: unknown): { kind: UsageBreakdownKind; split: Record<string, unknown> | undefined } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (raw ?? {}) as any;
  if (r.billedCents ?? r.billed_cents) {
    return { kind: "billed_cents", split: r.billedCents ?? r.billed_cents };
  }
  if (r.weeklyLimitPpm ?? r.weekly_limit_ppm) {
    return { kind: "weekly_limit_ppm", split: r.weeklyLimitPpm ?? r.weekly_limit_ppm };
  }
  if (r.billingCyclePpm ?? r.billing_cycle_ppm) {
    return { kind: "billing_cycle_ppm", split: r.billingCyclePpm ?? r.billing_cycle_ppm };
  }
  // Connect oneof may also appear as breakdown: { case, value }
  const boxed = r.breakdown;
  if (boxed && typeof boxed === "object") {
    const c = boxed.case ?? boxed.oneofKind;
    const v = boxed.value ?? boxed;
    if (c === "billedCents" || c === "billed_cents") return { kind: "billed_cents", split: v };
    if (c === "weeklyLimitPpm" || c === "weekly_limit_ppm") return { kind: "weekly_limit_ppm", split: v };
    if (c === "billingCyclePpm" || c === "billing_cycle_ppm") return { kind: "billing_cycle_ppm", split: v };
  }
  return { kind: "empty", split: undefined };
}

/** Map a GetGrokBotUsageBreakdownResponse. Never invents a team id or currency. ppm is kept raw; the UI converts it to a percentage. */
export function mapUsageBreakdown(raw: unknown): UsageBreakdownView {
  const { kind, split } = pickSplit(raw);
  const notes: string[] = [
    "首次请求不传 enterprise_team_id；不会为获取企业支出或事件去猜测团队 id。",
  ];
  if (kind === "billed_cents") {
    notes.push("金额与币种尚未 live 核实，界面只按原值展示并标注。");
    notes.push("billed_cents 的币种与分位未核实，不当成已核实金额。");
  } else if (kind === "weekly_limit_ppm" || kind === "billing_cycle_ppm") {
    notes.push("ppm 是占限额的百万分比（1% = 10000 ppm）。界面按百分比展示，例如 225439 显示为 22.54%，不会把原始 ppm 整数直接写成百分数。");
  } else {
    notes.push("接口未返回 billed_cents / weekly_limit_ppm / billing_cycle_ppm 明细。");
  }
  const view: UsageBreakdownView = {
    kind,
    by_source: [],
    by_bot: [],
    notes,
    units: "unverified",
  };
  if (!split) return view;
  const start = int64ToString(split.periodStartMs ?? split.period_start_ms);
  if (start) view.period_start_ms = start;
  const end = int64ToString(split.periodEndMs ?? split.period_end_ms);
  if (end) view.period_end_ms = end;
  const bySource = split.bySource ?? split.by_source ?? [];
  const byBot = split.byBot ?? split.by_bot ?? [];
  const rowMap = kind === "billed_cents" ? mapCentsRow : mapPpmRow;
  if (Array.isArray(bySource)) view.by_source = bySource.map(rowMap);
  if (Array.isArray(byBot)) view.by_bot = byBot.map(rowMap);
  return view;
}

/** Rows in a breakdown whose bot_id matches this Bot (agent_id or bot id). */
export function breakdownRowsForBot(
  breakdown: UsageBreakdownView | undefined,
  ids: { agent_id?: string; bot_id?: string },
): UsageBreakdownRow[] {
  if (!breakdown) return [];
  const wanted = new Set([ids.agent_id, ids.bot_id].filter((x): x is string => Boolean(x)));
  if (!wanted.size) return [];
  return breakdown.by_bot.filter((r) => r.bot_id && wanted.has(r.bot_id));
}
