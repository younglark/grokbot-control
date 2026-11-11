import { Activity, Hourglass, CircleHelp, CirclePause } from "lucide-react";
import { cn, CATEGORY_LABEL } from "@/lib/utils";
import type { BotRunCategory } from "@/types";

/** Shared presentation only; the backend remains the source of classification. */
export const STATUS_META = {
  running: { Icon: Activity, symbol: "activity", label: CATEGORY_LABEL.running, color: "text-status-running", badge: "bg-status-running/10 text-status-running", help: "运行中" },
  waiting: { Icon: Hourglass, symbol: "hourglass", label: CATEGORY_LABEL.waiting, color: "text-status-waiting", badge: "bg-status-waiting/10 text-status-waiting", help: "等待中" },
  unknown: { Icon: CircleHelp, symbol: "circle-help", label: CATEGORY_LABEL.unknown, color: "text-muted-foreground", badge: "bg-muted text-muted-foreground", help: "未知：尚无可用状态，不等于离线" },
  idle: { Icon: CirclePause, symbol: "circle-pause", label: CATEGORY_LABEL.idle, color: "text-muted-foreground", badge: "bg-muted text-muted-foreground", help: "空闲" },
} as const;

export function StatusIcon({ category, className }: { category: BotRunCategory; className?: string }) {
  const meta = STATUS_META[category];
  return <meta.Icon data-status-icon={category} data-status-symbol={meta.symbol} aria-hidden="true" className={cn("size-4 shrink-0",meta.color,className)}/>;
}
