import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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

export function formatBreakdownShare(row: { cents?: string; ppm?: number }, kind?: string): string {
  if (kind === "billed_cents" || row.cents != null) return `${row.cents ?? "—"}（单位未核实）`;
  if (row.ppm != null) return formatUsagePpm(row.ppm) ?? "—";
  return "—";
}

export function whoamiSummary(w?: { kind?: string; logged_in?: boolean; login_kind?: string; static_token?: boolean; account_label?: string }): string {
  if (!w?.logged_in) return "未登录";
  const kind = w.kind === "xai" ? "xAI" : "Cursor";
  const how = w.static_token ? "static" : w.login_kind === "browser_deep_control" ? "browser" : w.login_kind;
  const label = w.account_label && w.account_label !== "static" ? w.account_label : how;
  return label ? `${kind} · ${label}` : kind;
}

export const DASHBOARD_TIME_ZONE = "Asia/Shanghai";

export function formatShanghaiDateTime(ms?: number | string): string | undefined {
  if (ms === undefined || ms === null || ms === "") return undefined;
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n)) return undefined;
  try {
    const text = new Intl.DateTimeFormat("zh-CN", {
      timeZone: DASHBOARD_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(n));
    return `${text}（上海时间）`;
  } catch {
    return undefined;
  }
}

export function formatTime(ms?: number): string {
  if (!ms) return "尚无成功读取";
  return formatShanghaiDateTime(ms) ?? String(ms);
}

/** Todo created_at / updated_at have no documented unit. */
export function formatUnspecifiedEpoch(raw?: string): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  if (n >= 1_000_000_000_000 && n <= 9_999_999_999_999) {
    const text = formatShanghaiDateTime(n);
    return text ? `${text}，按毫秒时间戳解读` : `${raw}（单位未标明）`;
  }
  return `${raw}（单位未标明）`;
}

export const CATEGORY_LABEL: Record<string, string> = {
  running: "运行中",
  waiting: "等待中",
  idle: "空闲",
  unknown: "未知",
};
