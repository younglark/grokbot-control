/** Display timestamps in the dashboard owner's zone. Never invent a missing value. */
export const DASHBOARD_TIME_ZONE = "Asia/Shanghai";
export function formatShanghaiDateTime(ms) {
    if (ms === undefined || ms === null || ms === "")
        return undefined;
    const n = typeof ms === "number" ? ms : Number(ms);
    if (!Number.isFinite(n))
        return undefined;
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
    }
    catch {
        return undefined;
    }
}
/**
 * TodoItem.created_at / updated_at have no documented unit.
 * Format as a datetime only when the value is clearly epoch milliseconds.
 */
export function formatUnspecifiedEpoch(raw) {
    if (raw === undefined || raw === "")
        return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n))
        return { text: String(raw), assumed: "unknown" };
    if (n >= 1_000_000_000_000 && n <= 9_999_999_999_999) {
        const text = formatShanghaiDateTime(n);
        return text
            ? { text: `${text}，按毫秒时间戳解读`, assumed: "ms" }
            : { text: `${raw}（单位未标明）`, assumed: "unknown" };
    }
    return { text: `${raw}（单位未标明）`, assumed: "unknown" };
}
