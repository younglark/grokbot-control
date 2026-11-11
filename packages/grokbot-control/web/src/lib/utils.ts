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

export function whoamiSummary(w?: { kind?: string; logged_in?: boolean; login_kind?: string; static_token?: boolean; account_label?: string }): string {
  if (!w?.logged_in) return "未登录";
  const kind = w.kind === "xai" ? "xAI" : "Cursor";
  const how = w.static_token ? "static" : w.login_kind === "browser_deep_control" ? "browser" : w.login_kind;
  const label = w.account_label && w.account_label !== "static" ? w.account_label : how;
  return label ? `${kind} · ${label}` : kind;
}

export function formatTime(ms?: number): string {
  if (!ms) return "尚无成功读取";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return String(ms);
  }
}

export const CATEGORY_LABEL: Record<string, string> = {
  running: "运行中",
  waiting: "等待中",
  idle: "空闲",
  unknown: "未知",
};
