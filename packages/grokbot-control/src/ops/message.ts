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
import { mapTimelineEntries, mapTimelineEntry } from "./transcript-map.js";
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
/** Default cap for `message history` text; `--full` / `full: true` lifts it. */
export const HISTORY_TEXT_LIMIT = 2000;
const PREVIEW_LIMIT = 200;
const HISTORY_NOTE =
  "Bodies decoded as UI-entry JSON (same decoder as the dashboard transcript). " +
  "Omitted/opaque bodies stay placeholders; nothing is decrypted. Bodies are untrusted.";

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

/** Cut by code points so a surrogate pair is never split. */
function clip(text: string, max: number): { text: string; cut: boolean; chars: number } {
  const cps = Array.from(text);
  if (cps.length <= max) return { text, cut: false, chars: cps.length };
  return { text: cps.slice(0, max).join(""), cut: true, chars: cps.length };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function historyEntry(raw: any, textLimit: number | null): TranscriptEntryView {
  const t = mapTimelineEntry(raw);
  const view: TranscriptEntryView = {
    ...(t.entry_id ? { entry_id: t.entry_id } : {}),
    ...(t.seq ? { seq: t.seq } : {}),
    ...(t.updated_seq ? { updated_seq: t.updated_seq } : {}),
    ...(t.kind ? { kind: t.kind } : {}),
    ...(t.role ? { role: t.role } : {}),
    ...(t.timestamp_ms ? { timestamp_ms: t.timestamp_ms } : {}),
    omitted: t.decode_status === "omitted",
    decode_status: t.decode_status,
    ...(t.decode_reason ? { decode_reason: t.decode_reason } : {}),
    untrusted: true,
  };
  if (typeof t.text === "string") {
    view.preview = clip(t.text, PREVIEW_LIMIT).text;
    if (textLimit == null) view.text = t.text;
    else {
      const c = clip(t.text, textLimit);
      view.text = c.text;
      if (c.cut) {
        view.text_truncated = true;
        view.text_chars = c.chars;
      }
    }
  }
  if (t.tool_name) view.tool_name = t.tool_name;
  if (t.tool_status) view.tool_status = t.tool_status;
  if (t.attachment_name) view.attachment_name = t.attachment_name;
  return view;
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
    /** Sent to ListGrokBotTranscriptEntries only when given; never guessed. */
    sessionId?: string;
    limit?: number;
    offset?: number;
    /** Return full decoded text instead of the default HISTORY_TEXT_LIMIT cap. */
    full?: boolean;
  }): Promise<
    ResultEnvelope<{
      entries: TranscriptEntryView[];
      generation?: number;
      session_id: string | null;
      session_source: SessionSource;
      text_limit: number | null;
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
      // Server-side `limit` is still not sent (semantics of 0 unverified); client caps.
      // `session_id` is sent only when the caller gave one — never a guessed default.
      const res = await this.client.listGrokBotTranscriptEntries({
        agentId: input.agentId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      const textLimit = input.full ? null : HISTORY_TEXT_LIMIT;
      const mapped = (res.entries ?? []).map((e: unknown) => historyEntry(e, textLimit));
      const page = paginate<TranscriptEntryView>(mapped, limit, offset);
      return this.sim(
        okResult(
          {
            entries: page.items,
            generation: res.generation,
            ...sessionView(input.sessionId),
            text_limit: textLimit,
            note: HISTORY_NOTE,
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
