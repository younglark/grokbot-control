import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { SessionSummary } from "../dto/types.js";
import { GbcError } from "../errors.js";
import { mapSession } from "./map.js";

export class SessionOps {
  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  async list(agentId: string): Promise<ResultEnvelope<{ sessions: SessionSummary[] }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotAgentSessions({ agentId });
      return {
        ...okResult({ sessions: (res.sessions ?? []).map(mapSession) }, { request_id }),
        simulated: this.flags.simulated,
      };
    } catch (e) {
      const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
      return {
        ...failResult(err.code, err.message, {
          outcome: err.outcome,
          retryable: err.retryable,
          hint: err.hint,
          request_id,
        }),
        simulated: this.flags.simulated,
      };
    }
  }
}
