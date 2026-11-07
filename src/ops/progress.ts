import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { ProgressStatus } from "../dto/types.js";
import { GbcError } from "../errors.js";
import { mapStatus } from "./map.js";

export class ProgressOps {
  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  private sim<T>(r: ResultEnvelope<T>) {
    if (this.flags.simulated) r.simulated = true;
    return r;
  }

  async status(agentIds: string[]): Promise<ResultEnvelope<{ statuses: ProgressStatus[] }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotAgentStatuses({ agentIds });
      return this.sim(okResult({ statuses: (res.statuses ?? []).map(mapStatus) }, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async todos(agentId: string): Promise<ResultEnvelope<{ todos: unknown[] }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotAgentTodos({ agentId });
      return this.sim(okResult({ todos: res.todos ?? [] }, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async tasks(agentId: string): Promise<ResultEnvelope<{ tasks: unknown[] }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotAgentTasks({ agentId });
      return this.sim(okResult({ tasks: res.tasks ?? [] }, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async subagents(agentId: string): Promise<ResultEnvelope<{ subagents: unknown[] }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotSubagents({ agentId });
      return this.sim(okResult({ subagents: res.subagents ?? [] }, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async interrupt(
    agentId: string,
    opts: { confirm?: string; reason?: string; sessionId?: string; dryRun?: boolean; allowWrite?: boolean },
  ): Promise<ResultEnvelope<{ had_active_run?: boolean; note: string }>> {
    const request_id = newRequestId();
    if (opts.dryRun) {
      return this.sim(
        okResult(
          { note: "dry-run: would InterruptGrokBotAgentRun (MCP cancel ≠ this)" },
          { request_id, code: "dry_run" },
        ),
      );
    }
    if (opts.confirm !== agentId) {
      return this.sim(failResult("denied", "interrupt requires --confirm=<agent_id>", { request_id }));
    }
    if (!opts.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
      return this.sim(failResult("denied", "need --allow-writes", { request_id }));
    }
    try {
      const res = await this.client.interruptGrokBotAgentRun({
        agentId,
        reason: opts.reason ?? "gbc interrupt",
        sessionId: opts.sessionId,
      });
      return this.sim(
        okResult(
          {
            had_active_run: res.hadActiveRun,
            note: "InterruptGrokBotAgentRun invoked. Canceling an MCP/CLI HTTP request does NOT call this.",
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id, true);
    }
  }

  private fromErr(e: unknown, request_id: string, write = false): ResultEnvelope<never> {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write });
    return this.sim(
      failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
      }),
    );
  }
}
