import type { ComputerState } from "../ops/computer.js";
import type {
  BotRunCategory,
  BotSummary,
  ChannelConnectionView,
  ComputerView,
  DashboardBotRow,
  ProgressStatus,
  SanitizedWhoami,
  WaitingSignalView,
} from "../dto/types.js";
import { waitingSignals } from "./signals.js";

/** computer.state is not live-verified. Unknown/stale must not use the running tone. */
export function presentComputer(
  state: ComputerState | undefined,
  opts?: { stale?: boolean; failed?: boolean },
): ComputerView {
  const stale = Boolean(opts?.stale);
  const failed = Boolean(opts?.failed);
  const unverified = "computer.state 未经实时核验。";
  if (failed || !state || stale) {
    const last = state?.state && state.state !== "unspecified" ? `上次记录：${stateLabel(state.state)}。` : "";
    return {
      state: "unknown",
      state_code: state?.state_code,
      live_verified: false,
      stale: stale || failed || !state,
      tone: "unknown",
      label: "未知",
      note: `${unverified}${last}未知或过期状态不会显示为「运行中」，也不等同于离线。`.trim(),
      ...(state?.image_update_available === undefined
        ? {}
        : { image_update_available: state.image_update_available }),
    };
  }
  const tone = toneFor(state.state);
  return {
    state: state.state,
    state_code: state.state_code,
    live_verified: false,
    stale: false,
    tone,
    label: stateLabel(state.state),
    note: unverified,
    ...(state.image_update_available === undefined
      ? {}
      : { image_update_available: state.image_update_available }),
  };
}

function toneFor(state: string): ComputerView["tone"] {
  if (state === "running") return "running";
  if (state === "starting") return "starting";
  if (state === "hibernated") return "hibernated";
  if (state === "absent") return "absent";
  return "unknown";
}

export function stateLabel(state: string): string {
  switch (state) {
    case "running":
      return "运行中（未实时核验）";
    case "starting":
      return "启动中（未实时核验）";
    case "hibernated":
      return "休眠（未实时核验）";
    case "absent":
      return "不存在（未实时核验）";
    case "unspecified":
    case "unknown":
      return "未知";
    default:
      return state.startsWith("unknown") ? "未知" : `${state}（未实时核验）`;
  }
}

export function waitingReason(status?: ProgressStatus): string | undefined {
  const signals = waitingSignals(status);
  if (!signals.length) return undefined;
  return signals
    .map((s) => {
      if (s.kind === "box_handoff") return s.label;
      return s.reason && s.kind !== "retrying" ? `${s.label}：${s.reason}` : s.label;
    })
    .join(" · ");
}

export function botCategory(status?: ProgressStatus): BotRunCategory {
  if (!status) return "unknown";
  if (status.is_running) return "running";
  if (waitingSignals(status).length || status.live?.awaiting?.observed) return "waiting";
  return "idle";
}

export function buildBotRows(
  bots: BotSummary[],
  statuses: ProgressStatus[],
  channels: ChannelConnectionView[] = [],
): DashboardBotRow[] {
  const byId = new Map(statuses.map((s) => [s.agent_id, s]));
  return bots.map((bot) => {
    const status = byId.get(bot.agent_id) ?? byId.get(bot.id);
    const category = botCategory(status);
    const reason = waitingReason(status);
    const signals: WaitingSignalView[] = waitingSignals(status);
    const botChannels = channels.filter(
      (c) => c.agent_id === bot.agent_id || c.agent_id === bot.id,
    );
    return {
      bot,
      ...(status ? { status } : {}),
      category,
      ...(reason ? { waiting_reason: reason } : {}),
      ...(signals.length ? { waiting_signals: signals } : {}),
      ...(botChannels.length ? { channels: botChannels } : {}),
    };
  });
}

export function countRows(rows: DashboardBotRow[]): {
  total: number;
  running: number;
  waiting: number;
  unknown: number;
} {
  const counts = { total: rows.length, running: 0, waiting: 0, unknown: 0 };
  for (const row of rows) {
    if (row.category === "running") counts.running += 1;
    else if (row.category === "waiting") counts.waiting += 1;
    else if (row.category === "unknown") counts.unknown += 1;
  }
  return counts;
}

export function whoamiSummary(w?: SanitizedWhoami): string {
  if (!w?.logged_in) return "未登录";
  const kind = w.kind === "xai" ? "xAI" : "Cursor";
  const how = w.static_token ? "static" : w.login_kind === "browser_deep_control" ? "browser" : w.login_kind;
  return how ? `${kind} · ${how}` : kind;
}

/** Can the usage chip draw a proportional bar? Never when the included limit is zero. */
export function canDrawUsageBar(usage: {
  usage_percent?: number;
  included_limit_zero: boolean;
  has_non_zero_included_limit: boolean;
}): boolean {
  return (
    !usage.included_limit_zero &&
    usage.has_non_zero_included_limit &&
    typeof usage.usage_percent === "number" &&
    Number.isFinite(usage.usage_percent)
  );
}

/** Format a usage_percent value that is already a percentage (21.781372 → "21.78%"). Never multiply by 100. */
export function formatUsagePercent(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 100) / 100;
  const text = rounded.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  return `${text}%`;
}

/** Convert a limit-share in ppm (parts per million) to the same percentage format as usage_percent. 225439 → "22.54%". */
export function formatUsagePpm(ppm: number): string | undefined {
  if (!Number.isFinite(ppm)) return undefined;
  return formatUsagePercent(ppm / 10_000);
}
