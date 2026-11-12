import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { SendDelivery, SendStatusView, SessionSource, TimelineEntryView, TranscriptEntryView } from "../dto/types.js";
/** Default cap for `message history` text; `--full` / `full: true` lifts it. */
export declare const HISTORY_TEXT_LIMIT = 2000;
export declare class MessageOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
    private sim;
    send(input: {
        agentId: string;
        /** Omit (or pass "") to use the default session; the RPC does not echo a session id back. */
        sessionId?: string;
        text: string;
        messageId?: string;
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<SendDelivery>>;
    status(input: {
        agentId: string;
        sessionId?: string;
        messageId: string;
    }): Promise<ResultEnvelope<SendStatusView>>;
    history(input: {
        agentId: string;
        /** Sent to ListGrokBotTranscriptEntries only when given; never guessed. */
        sessionId?: string;
        limit?: number;
        offset?: number;
        /** Return full decoded text instead of the default HISTORY_TEXT_LIMIT cap. */
        full?: boolean;
    }): Promise<ResultEnvelope<{
        entries: TranscriptEntryView[];
        generation?: number;
        session_id: string | null;
        session_source: SessionSource;
        text_limit: number | null;
        note: string;
        truncated: boolean;
        next?: string;
        hint?: string;
    }>>;
    /**
     * Dashboard/timeline helper: list transcript entries for one session and parse
     * message bodies with the existing history/transcript decoder. Ciphertext is
     * not decrypted. Does not send an unverified server-side limit.
     */
    transcript(input: {
        agentId: string;
        sessionId: string;
    }): Promise<ResultEnvelope<{
        entries: TimelineEntryView[];
        generation?: number;
        truncated: boolean;
        note: string;
    }>>;
    private fromErr;
}
