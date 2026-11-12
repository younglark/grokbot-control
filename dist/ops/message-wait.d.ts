/**
 * `message wait` (issue #2): poll ListGrokBotAgentStatuses until the turn started by a
 * SendGrokBotUserMessage settles, then return the transcript entries after its echo.
 *
 * Completion evidence (static analysis of the official 0.79.4 App, NOT live-verified):
 * - electron-main/main-app.cjs (prettier copy ~L132981, `sendPrompt`): the App sends
 *   `messageId: o.clientNonce` in SendGrokBotUserMessage.
 * - node-agent-coordinator/main.cjs (prettier copy L9312-9318, `$Q`): the coordinator maps
 *   `live.lastTurnSettlement` to `{ clientNonce: e.turnId, outcome, settledAtMs }`, i.e. it
 *   treats GrokBotTurnSettlement.turn_id as the client nonce (= our message_id).
 * - Same file L6920 (`Yu`, aliased `mV` at L7170): the only accepted outcomes are
 *   "success" | "cancelled" | "error"; others are dropped (settled_at_ms must be > 0).
 * Identical lines exist in the 0.79.3 coordinator.
 *
 * Fallback (no turn_id match observed): GetGrokBotSendStatus is ACCEPTED, the agent was
 * seen running at least once after acceptance during this wait, and is now not running,
 * and the visible settlement (if any) is not another turn's that predates acceptance.
 * is_running=false alone is never treated as done (the turn may not have started yet).
 */
import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { TranscriptEntryView } from "../dto/types.js";
export declare const WAIT_DEFAULT_TIMEOUT_SECONDS = 600;
export declare const WAIT_MAX_TIMEOUT_SECONDS = 3600;
export declare const WAIT_DEFAULT_INTERVAL_SECONDS = 3;
export declare const WAIT_MAX_INTERVAL_SECONDS = 60;
/** MCP calls must return quickly; callers poll again on `pending`. */
export declare const WAIT_MCP_MAX_SECONDS = 30;
export declare const WAIT_EVIDENCE_NOTE: string;
export type WaitOutcome = "success" | "cancelled" | "error" | "unknown";
export type CompletionBasis = "turn_settlement" | "running_transition";
export type RepliesBasis = "after_echo_entry" | "echo_entry_unknown" | "echo_entry_not_in_transcript" | "session_unknown" | "transcript_failed";
export type WaitLiveSnapshot = {
    is_running: boolean;
    session_id: string | null;
    is_composing_message?: boolean;
    is_retrying?: boolean;
    has_running_subagents: boolean;
    working_task_ids: string[];
    activity?: {
        kind?: string;
        tool?: string;
    };
    last_turn_settlement: {
        turn_id: string | null;
        outcome: string | null;
        settled_at_ms: string | null;
    } | null;
    updated_at_ms?: string;
};
export type WaitSendStatus = {
    status: string;
    status_code: number;
    echo_entry_id: string | null;
    rejection_code: string | null;
    accepted_at_ms: string | null;
};
export type MessageWaitData = {
    agent_id: string;
    message_id: string;
    completed: boolean;
    /** "settled" when done; "pending" only from the MCP short wait. */
    state: "settled" | "pending";
    completion_basis: CompletionBasis | null;
    outcome: WaitOutcome;
    settled_at_ms: string | null;
    turn_id: string | null;
    has_running_subagents: boolean;
    working_task_ids: string[];
    session_id: string | null;
    session_source: "caller" | "live_state" | "unavailable";
    send_status: WaitSendStatus | null;
    observed_running: boolean;
    polls: number;
    waited_ms: number;
    replies: TranscriptEntryView[];
    replies_basis: RepliesBasis | null;
    replies_note?: string;
    text_limit: number | null;
    last_live: WaitLiveSnapshot | null;
    note: string;
    hint?: string;
};
export type MessageWaitInput = {
    agentId: string;
    messageId: string;
    sessionId?: string;
    timeoutSeconds?: number;
    intervalSeconds?: number;
    /** Test/SDK override of the poll interval in ms (takes precedence over intervalSeconds). */
    intervalMs?: number;
    full?: boolean;
    /** "fail" (CLI/SDK default): timeout → wait_timeout exit 10. "pending": MCP short wait. */
    onTimeout?: "fail" | "pending";
    /** Carry-over from a previous `pending` result (MCP is stateless between calls). */
    observedRunning?: boolean;
    onProgress?: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
};
export declare function liveSnapshot(status: any): WaitLiveSnapshot;
export declare function waitForMessage(client: GrokBotClient, input: MessageWaitInput, sim: <T>(r: ResultEnvelope<T>) => ResultEnvelope<T>): Promise<ResultEnvelope<MessageWaitData>>;
