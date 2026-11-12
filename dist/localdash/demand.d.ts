/** Per-client demand aggregation for the local dashboard poller. */
export type TranscriptDemandKey = string;
export type ClientDemand = {
    client_id: string;
    connection_epoch: string;
    agent_id?: string;
    view_session_id?: string;
    graph_visible: boolean;
    timeline_visible: boolean;
};
export type DemandAggregate = {
    detailAgents: string[];
    /** Transcript fetches to keep in flight, keyed by agent\0session. */
    transcript: Map<TranscriptDemandKey, {
        agent_id: string;
        session_id: string;
        poll: boolean;
    }>;
};
export declare function transcriptDemandKey(agentId: string, sessionId: string): TranscriptDemandKey;
export declare function parseTranscriptDemandKey(key: TranscriptDemandKey): [string, string];
/**
 * Session choice stays at the client. Bot-level detail is shared by agent.
 * Graph and timeline consumers union their needs: a visible graph keeps
 * transcript polling even when the activity list is hidden.
 */
export declare function aggregateDemands(clients: Iterable<ClientDemand>): DemandAggregate;
/** Drop a client's demand only when the closing connection epoch still owns it. */
export declare function shouldDropDemand(existing: Pick<ClientDemand, "connection_epoch"> | undefined, closingEpoch: string | undefined): boolean;
