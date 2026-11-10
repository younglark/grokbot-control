import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { SessionSummary } from "../dto/types.js";
import { GbcError } from "../errors.js";
import { mapSession } from "./map.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";

export class SessionOps {
  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  async list(
    agentId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<
    ResultEnvelope<{
      sessions: SessionSummary[];
      truncated: boolean;
      next?: string;
      hint?: string;
    }>
  > {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotAgentSessions({ agentId });
      const page = paginate<SessionSummary>(
        (res.sessions ?? []).map(mapSession),
        validateLimit(opts?.limit),
        validateOffset(opts?.offset),
      );
      return {
        ...okResult(
          {
            sessions: page.items,
            truncated: page.truncated,
            next: page.next,
            hint: page.hint,
          },
          { request_id },
        ),
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
