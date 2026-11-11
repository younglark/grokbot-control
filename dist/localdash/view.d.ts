import type { ComputerState } from "../ops/computer.js";
import type { BotRunCategory, BotSummary, ChannelConnectionView, ComputerView, DashboardBotRow, ProgressStatus, SanitizedWhoami } from "../dto/types.js";
/** computer.state is not live-verified. Unknown/stale must not use the running tone. */
export declare function presentComputer(state: ComputerState | undefined, opts?: {
    stale?: boolean;
    failed?: boolean;
}): ComputerView;
export declare function stateLabel(state: string): string;
export declare function waitingReason(status?: ProgressStatus): string | undefined;
export declare function botCategory(status?: ProgressStatus): BotRunCategory;
export declare function buildBotRows(bots: BotSummary[], statuses: ProgressStatus[], channels?: ChannelConnectionView[]): DashboardBotRow[];
export declare function countRows(rows: DashboardBotRow[]): {
    total: number;
    running: number;
    waiting: number;
    unknown: number;
};
export declare function whoamiSummary(w?: SanitizedWhoami): string;
/** Can the usage chip draw a proportional bar? Never when the included limit is zero. */
export declare function canDrawUsageBar(usage: {
    usage_percent?: number;
    included_limit_zero: boolean;
    has_non_zero_included_limit: boolean;
}): boolean;
/** Format a usage_percent value that is already a percentage (21.781372 → "21.78%"). Never multiply by 100. */
export declare function formatUsagePercent(value: number): string | undefined;
/** Convert a limit-share in ppm (parts per million) to the same percentage format as usage_percent. 225439 → "22.54%". */
export declare function formatUsagePpm(ppm: number): string | undefined;
