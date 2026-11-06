import { GrokBotAgentHarnessKind } from "#proto-gen/aiserver";
import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { BotSummary } from "../dto/types.js";
import { GbcError } from "../errors.js";
import { mapBot } from "./map.js";

export type WriteOpts = {
  dryRun?: boolean;
  /** Required for delete: must equal agent_id. */
  confirm?: string;
  allowWrite?: boolean;
};

function requireWrite(opts: WriteOpts | undefined, action: string) {
  if (opts?.dryRun) return;
  if (!opts?.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
    throw new GbcError(
      "denied",
      `refusing ${action}: pass allowWrite / --allow-writes or GBT_ALLOW_WRITES=1`,
      { exitCode: 7, hint: "Writes are explicit; dry-run is pure and does not call RPC." },
    );
  }
}

export class BotOps {
  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  private wrapSim<T>(r: ResultEnvelope<T>): ResultEnvelope<T> {
    if (this.flags.simulated) r.simulated = true;
    return r;
  }

  async list(opts?: { limit?: number }): Promise<ResultEnvelope<{ bots: BotSummary[]; truncated: boolean }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotAgents({});
      const all = (res.agents ?? []).map(mapBot);
      const limit = opts?.limit ?? 50;
      const truncated = Boolean(res.truncated) || all.length > limit;
      return this.wrapSim(
        okResult(
          {
            bots: all.slice(0, limit),
            truncated,
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  /** No GetBot RPC — filter ListGrokBotAgents client-side. */
  async get(agentId: string): Promise<ResultEnvelope<{ bot: BotSummary }>> {
    const listed = await this.list({ limit: 10_000 });
    if (!listed.ok || !listed.data) return listed as ResultEnvelope<never>;
    const bot = listed.data.bots.find((b) => b.agent_id === agentId || b.id === agentId);
    if (!bot) {
      return this.wrapSim(
        failResult("not_found", `bot ${agentId} not found in ListGrokBotAgents`, {
          request_id: listed.request_id,
          hint: "There is no GetGrokBotAgent RPC; get = list + filter.",
        }),
      );
    }
    return this.wrapSim(okResult({ bot }, { request_id: listed.request_id }));
  }

  async create(input: {
    name: string;
    description?: string;
    title?: string;
    agentId?: string;
    language?: string;
    kickstart?: boolean;
  }, write?: WriteOpts): Promise<ResultEnvelope<{ bot: BotSummary; agent_id: string }>> {
    const request_id = newRequestId();
    if (write?.dryRun) {
      return this.wrapSim(
        okResult(
          {
            bot: {
              agent_id: input.agentId || "(dry-run-nonce)",
              id: "",
              name: input.name,
              description: input.description || "",
              title: input.title || input.name,
              harness: "TEMPORAL",
              role: "",
              kind: "",
              viewer_session_id: "",
            },
            agent_id: input.agentId || "(dry-run-nonce)",
          },
          { request_id, code: "dry_run" },
        ),
      );
    }
    try {
      requireWrite(write, "bot.create");
      const agentId = input.agentId || crypto.randomUUID();
      // App Temporal path: CreateGrokBotTemporalAgent with CreateGrokBotAgentRequest fields.
      // Drift (visibility/teamId/botBuilderRequested) intentionally NOT sent — not in 0.78.4 Request.
      const res = await this.client.createGrokBotTemporalAgent({
        agentId,
        name: input.name,
        description: input.description ?? "",
        title: input.title ?? input.name,
        avatarShape: "circle",
        avatarColor: "#888888",
        harness: GrokBotAgentHarnessKind.TEMPORAL,
        kickstartRequested: input.kickstart ?? false,
        introductionSuppressed: !(input.kickstart ?? false),
        language: input.language,
      });
      const bot = mapBot(res.agent);
      return this.wrapSim(okResult({ bot, agent_id: bot.agent_id || agentId }, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async update(
    agentId: string,
    patch: { name?: string; description?: string; title?: string },
    write?: WriteOpts,
  ): Promise<ResultEnvelope<{ bot: BotSummary }>> {
    const request_id = newRequestId();
    if (write?.dryRun) {
      return this.wrapSim(okResult({ bot: { agent_id: agentId, id: agentId, name: patch.name || "", description: patch.description || "", title: patch.title || "", harness: "", role: "", kind: "", viewer_session_id: "" } }, { request_id, code: "dry_run" }));
    }
    try {
      requireWrite(write, "bot.update");
      const res = await this.client.updateGrokBotAgent({
        id: agentId,
        name: patch.name,
        description: patch.description,
        title: patch.title,
        partialUpdate: true,
      });
      return this.wrapSim(okResult({ bot: mapBot(res.agent) }, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async delete(agentId: string, write?: WriteOpts): Promise<ResultEnvelope<{ deleted: boolean; note: string }>> {
    const request_id = newRequestId();
    if (write?.dryRun) {
      return this.wrapSim(
        okResult(
          { deleted: false, note: "dry-run: would call DeleteGrokBotAgent; sidebar cleanup unverified" },
          { request_id, code: "dry_run" },
        ),
      );
    }
    if (write?.confirm !== agentId) {
      return this.wrapSim(
        failResult("denied", "delete requires --confirm=<agent_id> matching the resource", {
          request_id,
          hint: `gbc bot delete --agent-id ${agentId} --confirm=${agentId} --allow-writes`,
        }),
      );
    }
    try {
      requireWrite(write, "bot.delete");
      await this.client.deleteGrokBotAgent({ id: agentId });
      return this.wrapSim(
        okResult(
          {
            deleted: true,
            note: "DeleteGrokBotAgent succeeded. Sidebar section cleanup after delete is unverified.",
          },
          { request_id },
        ),
      );
    } catch (e) {
      const mapped = mapConnectError(e, request_id);
      // App treats NotFound as ok on delete.
      if (mapped.code === "not_found") {
        return this.wrapSim(
          okResult(
            {
              deleted: true,
              note: "Delete NotFound normalized to ok (App behavior). Sidebar residual unverified.",
            },
            { request_id },
          ),
        );
      }
      return this.fromErr(e, request_id);
    }
  }

  private fromErr(e: unknown, request_id: string): ResultEnvelope<never> {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
    return this.wrapSim(
      failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
        details: err.details,
      }),
    );
  }
}
