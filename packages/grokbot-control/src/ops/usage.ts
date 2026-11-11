import type { DashboardServiceClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import {
  failResult,
  newRequestId,
  okResult,
  type ResultEnvelope,
} from "../dto/result.js";
import type { UsageStatusView } from "../dto/types.js";
import { GbcError } from "../errors.js";

/**
 * Read-only wrapper around official DashboardService.GetSandUsageStatus.
 * The local CLI command `gbc dashboard` uses this helper; it is not a general
 * DashboardService facade. Official write RPCs are never called here.
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

  /** Phase 1: empty GetSandUsageStatusRequest only. */
  async status(): Promise<ResultEnvelope<UsageStatusView>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getSandUsageStatus({});
      return this.sim(okResult(mapUsageStatus(res), { request_id }));
    } catch (e) {
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
    "usage_percent 的单位尚未 live 核实，界面只按原值展示并标注。",
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
    usage_percent_unit: "unverified",
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
