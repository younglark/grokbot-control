import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { SendDelivery, SendStatusView, TranscriptEntryView } from "../dto/types.js";
import { GbcError } from "../errors.js";
import { validateLimit } from "./limits.js";

function requireWrite(allow: boolean | undefined, action: string) {
  if (!allow && process.env.GBT_ALLOW_WRITES !== "1") {
    throw new GbcError("denied", `refusing ${action}: need --allow-writes / GBT_ALLOW_WRITES=1`, { exitCode: 7 });
  }
}

export class MessageOps {
  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  private sim<T>(r: ResultEnvelope<T>) {
    if (this.flags.simulated) r.simulated = true;
    return r;
  }

  async send(input: {
    agentId: string;
    sessionId: string;
    text: string;
    messageId?: string;
    dryRun?: boolean;
    allowWrite?: boolean;
  }): Promise<ResultEnvelope<SendDelivery>> {
    const request_id = newRequestId();
    const message_id = input.messageId || crypto.randomUUID();
    if (input.dryRun) {
      return this.sim(
        okResult(
          {
            message_id,
            agent_id: input.agentId,
            session_id: input.sessionId,
            note: "dry-run: would SendGrokBotUserMessage (no task_id required)",
          },
          { request_id, code: "dry_run" },
        ),
      );
    }
    try {
      requireWrite(input.allowWrite, "message.send");
      const res = await this.client.sendGrokBotUserMessage({
        agentId: input.agentId,
        sessionId: input.sessionId,
        messageId: message_id,
        text: input.text,
        sentAtMs: BigInt(Date.now()),
      });
      return this.sim(
        okResult(
          {
            message_id,
            agent_id: input.agentId,
            session_id: input.sessionId,
            dispatched: res.dispatched,
            delivery: String(res.delivery ?? ""),
            note: "delivery/acceptance only — NOT task or business success",
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id, true);
    }
  }

  async status(input: {
    agentId: string;
    sessionId: string;
    messageId: string;
  }): Promise<ResultEnvelope<SendStatusView>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getGrokBotSendStatus({
        agentId: input.agentId,
        sessionId: input.sessionId,
        messageId: input.messageId,
      });
      return this.sim(
        okResult(
          {
            agent_id: input.agentId,
            session_id: input.sessionId,
            message_id: input.messageId,
            status: String(res.status ?? ""),
            rejection_code: res.rejectionCode,
            accepted_at_ms: res.acceptedAtMs != null ? String(res.acceptedAtMs) : undefined,
            note: "send_status ≠ final user-visible success",
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async history(input: {
    agentId: string;
    limit?: number;
  }): Promise<ResultEnvelope<{ entries: TranscriptEntryView[]; generation?: number; note: string }>> {
    const request_id = newRequestId();
    try {
      const limit = validateLimit(input.limit);
      // NOTE: server-side `limit`/`session_id` are still not sent (semantics of 0 unverified); client caps.
      const res = await this.client.listGrokBotTranscriptEntries({
        agentId: input.agentId,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = (res.entries ?? []).slice(0, limit).map((e: any) => {
        const id = e.id || e.entryId || e.entry_id;
        const preview =
          e.plaintext || e.text || e.preview ||
          (e.ciphertext || e.omitted ? undefined : undefined);
        return {
          entry_id: id,
          kind: String(e.kind ?? e.type ?? ""),
          omitted: Boolean(e.omitted || e.ciphertext),
          preview: preview ? String(preview).slice(0, 200) : undefined,
          untrusted: true,
        } satisfies TranscriptEntryView;
      });
      return this.sim(
        okResult(
          {
            entries,
            generation: res.generation,
            note: "Ciphertext/omitted entries are not decrypted. Bodies marked untrusted.",
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id);
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
        details: err.details,
      }),
    );
  }
}
