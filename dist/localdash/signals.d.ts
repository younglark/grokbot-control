/** Read-only dashboard signal helpers. Never pass through raw awaiting/handoff objects. */
import type { BoxHandoffView, LiveActivityView, ProgressStatus, SourceFreshnessView, TurnSettlementView, WaitingKind, WaitingSignalView } from "../dto/types.js";
export declare function sanitizeShortText(raw: unknown, max?: number): string | undefined;
export declare function classifyAwaitingReason(reason?: string): Exclude<WaitingKind, "box_handoff" | "retrying">;
export declare function sanitizeActivity(raw: unknown): LiveActivityView | undefined;
export declare function sanitizeBoxHandoff(live: unknown): BoxHandoffView | undefined;
export declare function mapTurnSettlement(raw: unknown): TurnSettlementView | undefined;
export declare function classifySettlementOutcome(outcome?: string): boolean | undefined;
export declare function waitingSignals(status?: ProgressStatus): WaitingSignalView[];
export declare function sourceFreshness(input: {
    id: string;
    label: string;
    ok?: boolean;
    attempted?: boolean;
    empty?: boolean;
    error?: string;
    last_successful_at_ms?: number;
    stale?: boolean;
}): SourceFreshnessView;
