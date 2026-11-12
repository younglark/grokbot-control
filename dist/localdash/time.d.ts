/** Display timestamps in the dashboard owner's zone. Never invent a missing value. */
export declare const DASHBOARD_TIME_ZONE = "Asia/Shanghai";
export declare function formatShanghaiDateTime(ms: number | string | undefined): string | undefined;
/**
 * TodoItem.created_at / updated_at have no documented unit.
 * Format as a datetime only when the value is clearly epoch milliseconds.
 */
export declare function formatUnspecifiedEpoch(raw?: string): {
    text: string;
    assumed: "ms" | "unknown";
} | undefined;
