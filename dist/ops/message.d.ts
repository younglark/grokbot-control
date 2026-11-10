import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { SendDelivery, SendStatusView, TranscriptEntryView } from "../dto/types.js";
export declare class MessageOps {
    private client;
    private flags;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
    private sim;
    send(input: {
        agentId: string;
        sessionId: string;
        text: string;
        messageId?: string;
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<SendDelivery>>;
    status(input: {
        agentId: string;
        sessionId: string;
        messageId: string;
    }): Promise<ResultEnvelope<SendStatusView>>;
    history(input: {
        agentId: string;
        limit?: number;
        offset?: number;
    }): Promise<ResultEnvelope<{
        entries: TranscriptEntryView[];
        generation?: number;
        note: string;
        truncated: boolean;
        next?: string;
        hint?: string;
    }>>;
    private fromErr;
}
