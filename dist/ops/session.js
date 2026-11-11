import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult } from "../dto/result.js";
import { GbcError } from "../errors.js";
import { mapSession } from "./map.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";
export class SessionOps {
    client;
    flags;
    constructor(client, flags = {}) {
        this.client = client;
        this.flags = flags;
    }
    async list(agentId, opts) {
        const request_id = newRequestId();
        try {
            const res = await this.client.listGrokBotAgentSessions({ agentId });
            const page = paginate((res.sessions ?? []).map(mapSession), validateLimit(opts?.limit), validateOffset(opts?.offset));
            return {
                ...okResult({
                    sessions: page.items,
                    truncated: page.truncated,
                    next: page.next,
                    hint: page.hint,
                }, { request_id }),
                simulated: this.flags.simulated,
            };
        }
        catch (e) {
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
