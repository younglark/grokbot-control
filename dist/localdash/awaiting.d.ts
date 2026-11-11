/** A-phase awaiting sanitizer: whitelist a short reason, never pass through the raw object. */
export declare const AWAITING_REASON_MAX = 200;
export type SanitizedAwaiting = {
    observed: true;
    reason?: string;
    reason_unknown?: true;
};
export declare function sanitizeAwaitingReason(raw: unknown): string | undefined;
/** Extract a safe waiting record. Presence can be true even when the reason is unknown. */
export declare function sanitizeAwaiting(raw: unknown): SanitizedAwaiting | undefined;
export declare function awaitingDisplay(awaiting?: SanitizedAwaiting): string | undefined;
