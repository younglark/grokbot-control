/** Per-client demand aggregation for the local dashboard poller. */
export function transcriptDemandKey(agentId, sessionId) {
    return `${agentId}\0${sessionId}`;
}
export function parseTranscriptDemandKey(key) {
    const idx = key.indexOf("\0");
    if (idx < 0)
        return [key, ""];
    return [key.slice(0, idx), key.slice(idx + 1)];
}
/**
 * Session choice stays at the client. Bot-level detail is shared by agent.
 * Graph and timeline consumers union their needs: a visible graph keeps
 * transcript polling even when the activity list is hidden.
 */
export function aggregateDemands(clients) {
    const detail = new Set();
    const transcript = new Map();
    for (const client of clients) {
        const agent = client.agent_id?.trim();
        if (!agent)
            continue;
        detail.add(agent);
        const session = client.view_session_id?.trim();
        if (!session)
            continue;
        const poll = Boolean(client.graph_visible || client.timeline_visible);
        const key = transcriptDemandKey(agent, session);
        const prev = transcript.get(key);
        transcript.set(key, { agent_id: agent, session_id: session, poll: Boolean(prev?.poll || poll) });
    }
    return { detailAgents: [...detail], transcript };
}
/** Drop a client's demand only when the closing connection epoch still owns it. */
export function shouldDropDemand(existing, closingEpoch) {
    if (!existing)
        return false;
    if (!closingEpoch)
        return true;
    return existing.connection_epoch === closingEpoch;
}
