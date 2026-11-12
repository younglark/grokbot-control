/** A-phase awaiting sanitizer: whitelist a short reason, never pass through the raw object. */

export const AWAITING_REASON_MAX = 200;

const DENY =
  /(?:authorization|password|secret|token|cookie|bearer|api[_-]?key|private[_-]?key|set-cookie)/i;

export type SanitizedAwaiting = {
  observed: true;
  reason?: string;
  reason_unknown?: true;
};

export function sanitizeAwaitingReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  if (DENY.test(trimmed)) return undefined;
  if (trimmed.length > AWAITING_REASON_MAX) return trimmed.slice(0, AWAITING_REASON_MAX);
  return trimmed;
}

/** Extract a safe waiting record. Presence can be true even when the reason is unknown. */
export function sanitizeAwaiting(raw: unknown): SanitizedAwaiting | undefined {
  if (raw == null || raw === false) return undefined;
  if (typeof raw === "string") {
    const reason = sanitizeAwaitingReason(raw);
    return reason ? { observed: true, reason } : { observed: true, reason_unknown: true };
  }
  if (typeof raw === "object") {
    const record = raw as { reason?: unknown; Reason?: unknown };
    const reason = sanitizeAwaitingReason(
      typeof record.reason === "string"
        ? record.reason
        : typeof record.Reason === "string"
          ? record.Reason
          : undefined,
    );
    return reason ? { observed: true, reason } : { observed: true, reason_unknown: true };
  }
  return { observed: true, reason_unknown: true };
}

export function awaitingDisplay(awaiting?: SanitizedAwaiting): string | undefined {
  if (!awaiting) return undefined;
  return awaiting.reason ?? "等待／原因未知";
}
