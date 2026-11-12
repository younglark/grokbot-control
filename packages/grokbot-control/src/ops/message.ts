import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type {
  SendDelivery,
  SendRefusal,
  SendStatusView,
  SessionSource,
  TimelineEntryView,
  TranscriptEntryView,
} from "../dto/types.js";
import { mapTimelineEntries } from "./transcript-map.js";
import { DELIVERY_NAMES, HARNESS_MODE_NAMES, SEND_STATUS_NAMES, enumView } from "./enum-names.js";
import { GbcError } from "../errors.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";

function requireWrite(allow: boolean | undefined, action: string) {
  if (!allow && process.env.GBT_ALLOW_WRITES !== "1") {
    throw new GbcError("denied", `refusing ${action}: host write authorization required`, { exitCode: 7, hint: "CLI: pass --allow-writes or GBT_ALLOW_WRITES=1. MCP: start gbc-mcp with --allow-writes or GBT_ALLOW_WRITES=1 (write tools are hidden by default). dry-run / dry_run does not call RPC." });
  }
}

/** GrokBotUserMessageDelivery.REFUSED (aiserver.v1, frozen schema). */
const DELIVERY_REFUSED = 4;
function optionalString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sessionView(sessionId: string | undefined): { session_id: string | null; session_source: SessionSource } {
  return sessionId
    ? { session_id: sessionId, session_source: "caller" }
    : { session_id: null, session_source: "default_unreported" };
}

function mapRefusal(raw: unknown): SendRefusal | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as { failureCode?: unknown; message?: unknown };
  return { failure_code: String(r.failureCode ?? ""), message: String(r.message ?? "") };
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
    /** Omit (or pass "") to use the default session; the RPC does not echo a session id back. */
    sessionId?: string;
    text: string;
    messageId?: string;
    dryRun?: boolean;
    allowWrite?: boolean;
  }): Promise<ResultEnvelope<SendDelivery>> {
    const request_id = newRequestId();
    const message_id = input.messageId || crypto.randomUUID();
    const session = sessionView(input.sessionId);
    if (input.dryRun) {
      return this.sim(
        okResult(
          {
            message_id,
            agent_id: input.agentId,
            ...session,
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
        sessionId: input.sessionId ?? "",
        messageId: message_id,
        text: input.text,
        sentAtMs: BigInt(Date.now()),
      });
      const delivery = enumView(DELIVERY_NAMES, res.delivery);
      const mode = enumView(HARNESS_MODE_NAMES, res.mode);
      const refusal = mapRefusal(res.refusal);
      const data: SendDelivery = {
        message_id,
        agent_id: input.agentId,
        ...session,
        dispatched: Boolean(res.dispatched),
        delivery: delivery.name,
        delivery_code: delivery.code,
        mode: mode.name,
        mode_code: mode.code,
        workflow_id: optionalString(res.workflowId),
        refusal,
        note: "delivery/acceptance only — NOT task or business success",
      };
      if (delivery.code === DELIVERY_REFUSED) {
        const reason = refusal?.message || refusal?.failure_code;
        const fail = failResult(
          "refused",
          `server refused the message (delivery=refused${reason ? `: ${reason}` : ""})`,
          {
            request_id,
            hint: "The message was not accepted. Check refusal.failure_code / refusal.message; do not retry blindly.",
            details: { refusal, workflow_id: data.workflow_id },
          },
        );
        return this.sim({ ...fail, data } as ResultEnvelope<SendDelivery>);
      }
      return this.sim(okResult(data, { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id, true);
    }
  }

  async status(input: {
    agentId: string;
    sessionId?: string;
    messageId: string;
  }): Promise<ResultEnvelope<SendStatusView>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getGrokBotSendStatus({
        agentId: input.agentId,
        sessionId: input.sessionId ?? "",
        messageId: input.messageId,
      });
      const status = enumView(SEND_STATUS_NAMES, res.status);
      return this.sim(
        okResult(
          {
            agent_id: input.agentId,
            ...sessionView(input.sessionId),
            message_id: input.messageId,
            status: status.name,
            status_code: status.code,
            echo_entry_id: optionalString(res.echoEntryId),
            rejection_code: optionalString(res.rejectionCode),
            accepted_at_ms: res.acceptedAtMs != null ? String(res.acceptedAtMs) : null,
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
    offset?: number;
  }): Promise<
    ResultEnvelope<{
      entries: TranscriptEntryView[];
      generation?: number;
      note: string;
      truncated: boolean;
      next?: string;
      hint?: string;
    }>
  > {
    const request_id = newRequestId();
    try {
      const limit = validateLimit(input.limit);
      const offset = validateOffset(input.offset);
      // NOTE: server-side `limit`/`session_id` are still not sent (semantics of 0 unverified); client caps.
      const res = await this.client.listGrokBotTranscriptEntries({
        agentId: input.agentId,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped = (res.entries ?? []).map((e: any) => {
        const id = e.id || e.entryId || e.entry_id;
        const preview =
          e.plaintext || e.text || e.preview ||
          (e.ciphertext || e.omitted ? undefined : undefined);
        return {
          entry_id: id,
          kind: String(e.entryKind ?? e.kind ?? e.type ?? ""),
          omitted: Boolean(e.bodyOmitted || e.omitted || e.ciphertext),
          preview: preview ? String(preview).slice(0, 200) : undefined,
          untrusted: true,
        } satisfies TranscriptEntryView;
      });
      const page = paginate<TranscriptEntryView>(mapped, limit, offset);
      return this.sim(
        okResult(
          {
            entries: page.items,
            generation: res.generation,
            note: "Ciphertext/omitted entries are not decrypted. Bodies marked untrusted.",
            truncated: page.truncated,
            next: page.next,
            hint: page.hint,
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  /**
   * Dashboard/timeline helper: list transcript entries for one session and parse
   * message bodies with the existing history/transcript decoder. Ciphertext is
   * not decrypted. Does not send an unverified server-side limit.
   */
  async transcript(input: {
    agentId: string;
    sessionId: string;
  }): Promise<
    ResultEnvelope<{
      entries: TimelineEntryView[];
      generation?: number;
      truncated: boolean;
      note: string;
    }>
  > {
    const request_id = newRequestId();
    try {
      const res = await this.client.listGrokBotTranscriptEntries({
        agentId: input.agentId,
        sessionId: input.sessionId,
      });
      const page = mapTimelineEntries(res.entries ?? []);
      return this.sim(
        okResult(
          {
            entries: page.entries,
            generation: res.generation,
            truncated: page.truncated,
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
