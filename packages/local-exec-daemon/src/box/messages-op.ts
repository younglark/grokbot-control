/** Box `messages-op` — static port of local-exec-daemon 0.79.3 (D: = daemon.formatted.cjs) and the Linux asar
 * `dist/local-exec-daemon/messages-worker.cjs` (W: = /tmp/exec-t155-evidence/messages-worker.formatted.cjs,
 * asar integrity sha256 b6f5c672…667b). Reachable Linux behaviour only; see docs/local-exec/evidence/box-messages-op.md.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod/v4";

// D:rk 97154–97177 (Pc = strict object, zc = iso datetime with offset, Jpe = int ≥ 1).
const zc = z.iso.datetime({ offset: true });
const limit = z.number().int().min(1).optional();
const before = z.strictObject({ date: zc, id: z.number().int() }).optional();
const sendBase = { kind: z.literal("send"), text: z.string(), service: z.enum(["iMessage", "SMS", "auto"]).optional() };
export const messagesOpSchema = z.union([
  z.strictObject({ kind: z.literal("find-chats"), displayName: z.string().optional(), handle: z.string().optional(), limit }),
  z.strictObject({ kind: z.literal("items"), chatGuid: z.string().optional(), limit, before }),
  z.strictObject({ kind: z.literal("search"), needle: z.string(), limit, before }),
  z.strictObject({ kind: z.literal("activity"), since: zc, until: zc.optional() }),
  z.strictObject({ ...sendBase, to: z.string() }),
  z.strictObject({ ...sendBase, chatId: z.string() }),
  z.strictObject({ kind: z.literal("check-permissions") }),
  z.strictObject({ kind: z.literal("fetch-attachment"), messageGuid: z.string(), attachmentGuid: z.string() }),
  z.strictObject({ kind: z.literal("find-contacts"), query: z.string().trim().min(1) }),
]);
export type MessagesOp = z.infer<typeof messagesOpSchema>;
/** D:rHt 97430–97435 Box frame (te = non-strict object: extra keys such as sendKey/draftCard are stripped). */
export const boxMessagesOpFrame = z.object({ kind: z.literal("messages-op"), requestId: z.string(), op: messagesOpSchema, approvalId: z.string().optional() });

/** D:z2 97405 */
export const UNSUPPORTED_FRAME = "This computer's local-exec daemon does not understand that request frame; update the desktop app.";
/** D:Kce/Gl 81180 */
export const CANCELLED_BEFORE_START = "Cancelled before it started on the user's computer.";
const H4 = "grokbot://app/v1/messages"; // D:h2.buildUrl("messages") 80491 / HDe 80100
/** D:o5 81184 */
export const MESSAGES_OFF = `Messages is turned off in the user's settings, so their Messages cannot be read or sent from here. Do not retry while it stays off. If the user wants this, ask them to turn it back on in [Messages](${H4}) (Connect Apps \u2192 Mac \u2192 Messages).`;
/** D:dFt/Qae 80544–80550 */
export const CAPABILITY_OFF: Record<"read" | "send", string> = {
  read: `The user turned off reading texts for Grok Bot on this Mac, so their Messages history, chats, and attachments cannot be read. Do not ask for Full Disk Access and do not retry while it stays off. Sending still works if it is on. If the task needs their texts, tell the user they can turn on Read Texts in [Messages](${H4}) (Connect Apps \u2192 Mac \u2192 Messages).`,
  send: `The user turned off sending texts for Grok Bot on this Mac, so nothing was sent. Do not retry while it stays off. If the task needs a text sent, tell the user they can turn on Send Texts in [Messages](${H4}) (Connect Apps \u2192 Mac \u2192 Messages), or offer them the text to send themselves.`,
};
/** D:oLe 80523 */
const REQUIRED: Record<MessagesOp["kind"], "read" | "send" | null> = {
  "check-permissions": null, "find-contacts": null, "find-chats": "read", items: "read", search: "read",
  activity: "read", "fetch-attachment": "read", send: "send",
};
/** D:iLe 80533 */
export function messagesCapabilities(enabled: boolean, caps: { read: boolean; send: boolean }) { return { read: enabled && caps.read, send: enabled && caps.send }; }
/** D:v6r 135858–135864 */
export function capabilityRefusal(kind: MessagesOp["kind"], caps: { read: boolean; send: boolean }): string | undefined {
  if (kind === "check-permissions") return undefined;
  if (!(caps.read || caps.send)) return MESSAGES_OFF;
  const r = REQUIRED[kind];
  if (!(r === null || caps[r])) return CAPABILITY_OFF[r];
  return undefined;
}

const PHONE = /^\+[1-9]\d{6,14}$/; // D:Aue 83490 / W:$t 4381
const WJT: Record<Exclude<MessagesOp["kind"], "send">, string> = { // D:Wjt 97324
  "find-chats": "Find Messages chats", items: "Read a Messages conversation", search: "Search Messages",
  activity: "Summarize Messages activity", "check-permissions": "Check Messages permissions",
  "fetch-attachment": "Fetch a Messages attachment", "find-contacts": "Find people in Contacts",
};
/** D:nk 97333 + Vjt 97317 / jjt / Hjt */
export function describeMessagesOp(t: MessagesOp): { action: "send-imessage" | "read-messages"; target: string; description: string; recipient?: string } {
  if (t.kind === "send") {
    const to = "to" in t ? t.to : undefined;
    const rec = to === undefined ? undefined : (PHONE.test(to.trim()) || to.trim().includes("@")) ? (to.trim().includes("@") ? to.trim().toLowerCase() : to.trim()) : undefined;
    return { action: "send-imessage", target: `${"to" in t ? t.to : t.chatId}\n${t.text}`, description: "Send a message", ...(rec === undefined ? {} : { recipient: rec }) };
  }
  return { action: "read-messages", target: t.kind === "find-contacts" ? "your Contacts" : "your Messages history", description: WJT[t.kind] };
}

/** D:Ed 83034 / W:ot 101 — sidecar app lookup. On a stock Linux install nothing matches. */
export function locateSidecar(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, moduleDir = __dirname): string | undefined {
  const r = [env.GROK_BOT_SIDECAR_APP ?? ""];
  const n = execPath.split(path.sep), s = n.findIndex(o => o.endsWith(".app"));
  if (s >= 0) {
    const o = path.join(n.slice(0, s + 1).join(path.sep), "Contents/Helpers");
    r.push(path.join(o, "Grok Bot Computer Use.app"), path.join(o, "Grok Bot Lab Computer Use.app"), path.join(o, "Grok Bot Orbit Computer Use.app"));
  }
  for (let o = moduleDir; ; o = path.dirname(o)) {
    r.push(path.join(o, "sand/dist/native/sidecar", "Grok Bot Dev Computer Use.app"));
    if (o === path.dirname(o)) break;
  }
  return r.find(p => fs.existsSync(p));
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/; // W:cs 5937
const CHAT_ID = /^[A-Za-z0-9._@;+-]+$/;           // W:ls 5938
/** Helper verb per op (W:Er 6061–6125 → Xe 6346): which sidecar RPC the worker would call first. */
const VERB: Record<MessagesOp["kind"], string> = {
  "find-chats": "snapshot-messages-db", items: "snapshot-messages-db", search: "snapshot-messages-db", activity: "snapshot-messages-db",
  "fetch-attachment": "snapshot-messages-db", send: "send-message", "check-permissions": "check-messages-permissions", "find-contacts": "find-contacts",
};
/** W:nd 6484 → Er. Without a sidecar every helper call fails in W:Hi 412 with `sidecar_missing`, which W:Ws 6312 keeps
 * (`Us` table). `send` validates (W:ps/hs 5965–5980) and writes the 0600 body file (W:ys 6000) before the helper call.
 */
export async function runMessagesOp(op: MessagesOp, sidecar: string | undefined = locateSidecar(), opts: { draftCard?: boolean } = {}): Promise<never> {
  if (op.kind === "send") {
    if (!op.text) throw new Error("send_text_empty");
    if ("chatId" in op) { if (!CHAT_ID.test(op.chatId)) throw new Error("send_chat_id_invalid"); }
    else if (!(PHONE.test(op.to) || EMAIL.test(op.to))) throw new Error("send_recipient_invalid");
    let dir: string | undefined;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "messages-mac-send-"));
      fs.writeFileSync(path.join(dir, "body.txt"), op.text, { mode: 0o600 });
    } catch (r) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      throw new Error("send_text_write_failed", { cause: r });
    }
    try { throw helperFailure(sidecar, VERB.send, opts.draftCard); }
    finally { fs.rmSync(dir!, { recursive: true, force: true }); }
  }
  throw helperFailure(sidecar, VERB[op.kind], opts.draftCard);
}
function helperFailure(sidecar: string | undefined, verb: string, draftCard?: boolean): Error {
  if (sidecar === undefined) {
    // W:js 6291–6303 + rd 6480–6486: the draft-card helper client logs every helper failure (Bs: quoted text elided, ≤500).
    if (draftCard === true) console.error(`[messages-worker] helper ${verb} failed: sidecar_missing`);
    return new Error("sidecar_missing");
  }
  // NOT ORIGINAL: a located sidecar means macOS helper RPC (W:Hi service.json / launch / socket), which this Linux port
  // does not implement. W:Ws's fallback name is used so the failure is explicit; documented as a gap.
  return new Error(`helper_${verb}_failed`);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared v_ messages path (D:v_.handle 135972–135983, handleMessagesOp 136044–136127, replayedSend/rememberSend/
// withSendKey 136272–136307, D6r/M6r/Bpt 136428–136448). Box and UC each own one executor (one v_ per provider).
export type ConsentVerdict = { kind: "allow" } | { kind: "ask" } | { kind: "refused"; reason: string };
export type MessagesOpRequest = { requestId: string; op: MessagesOp; approvalId?: string; sendKey?: string; draftCard?: true;
  authorization?: { kind: "approval" } };
export type MessagesFrame =
  | { kind: "messages-error"; requestId: string; error: string }
  | { kind: "messages-accepted"; requestId: string }
  | { kind: "messages-consent-result"; requestId: string; verdict: ConsentVerdict }
  | { kind: "messages-result"; requestId: string; result: unknown; timings?: { daemonMs: number; helperMs: number; sqliteMs?: number } };
export type MessagesDeps = {
  /** D:messagesCapabilities (z = iLe(...)); undefined → sLe {read:true,send:true} (D:80522). */
  capabilities?: () => { read: boolean; send: boolean } | undefined;
  /** D:isLocalUseBlocked → AUe. */
  isLocalUseBlocked?: (t: { approvalId?: string; authorization: { kind: "none" } | { kind: "approval" }; describes: ReturnType<typeof describeMessagesOp> }) => Promise<string | undefined>;
  /** D:decideLocalUse → Qce (UC only; Box passes none). */
  decideLocalUse?: (t: { approvalId: undefined; authorization: { kind: "none" }; describes: ReturnType<typeof describeMessagesOp> }) => Promise<ConsentVerdict>;
  sidecar?: () => string | undefined;
};
/** D:Wue 84657–84670 / JI 84683 */
export const MESSAGES_SEND_FAILURES = ["send_recipient_invalid", "send_chat_id_invalid", "send_target_ambiguous", "send_target_missing",
  "send_text_empty", "send_text_write_failed", "messages_automation_denied", "messages_addressing_failed", "sidecar_missing",
  "sidecar_not_running", "sidecar_unreachable", "sidecar_install_dir_missing", "sidecar_install_failed"];
/** D:qI 84686–84694 */
export const MESSAGES_DRAFT_CODES = ["messages_local_tools_disabled", "messages_local_tools_unapproved", "messages_disabled",
  "messages_send_cancelled", "messages_send_refused", "messages_local_exec_closing", "messages_local_exec_busy"];
/** D:A9 135894 / F5e 135896 */
export const UC_CLOSED_BEFORE_START = "The user's computer stopped serving requests before this one started. Retry it once the computer is back.";
export const UC_BUSY = "The user's computer is busy with other requests right now; try again shortly.";
let draftCodes: Map<string, string> | undefined;
/** D:Fpt 135897–135906 (texts → draft-card codes); Lpt 135907 falls back to messages_send_refused. */
export function draftCardCodes(never: string, ask: string): Map<string, string> {
  return draftCodes ??= new Map([[never, "messages_local_tools_disabled"], [ask, "messages_local_tools_unapproved"], [MESSAGES_OFF, "messages_disabled"],
    [CAPABILITY_OFF.send, "messages_disabled"], [CANCELLED_BEFORE_START, "messages_send_cancelled"],
    [UC_CLOSED_BEFORE_START, "messages_local_exec_closing"], [UC_BUSY, "messages_local_exec_busy"]]);
}
const FIFO_CAP = 64; // D:U5e
function cap<K, V>(m: Map<K, V>): void { while (m.size > FIFO_CAP) { const k = m.keys().next().value; if (k === undefined) return; m.delete(k); } } // D:$5e
const withId = <T extends { requestId: string }>(t: T, e: string): T => t.requestId === e ? t : { ...t, requestId: e }; // D:Bpt

export class MessagesExecutor {
  private finishedSends = new Map<string, { opJson: string; response: MessagesFrame }>();
  private sentByKey = new Map<string, { opJson: string; response: MessagesFrame }>();
  private sendKeyTail = new Map<string, Promise<void>>();
  constructor(private readonly deps: MessagesDeps, private readonly codes: Map<string, string>) {}
  private lpt(t: string): string { return this.codes.get(t) ?? "messages_send_refused"; }
  /** Called inside withInflight (owned by the provider). */
  async handle(e: MessagesOpRequest, entry: { cancelled: boolean }, emit: (f: MessagesFrame) => unknown): Promise<void> {
    await this.withSendKey(e.sendKey, async () => {
      const s = this.replayedSend(e);
      if (s !== undefined) { await emit(s); return; }
      await this.handleMessagesOp(e, entry, emit);
    });
  }
  private replayedSend(e: MessagesOpRequest): MessagesFrame | undefined {
    const r = JSON.stringify(e.op), n = this.finishedSends.get(e.requestId);
    if (n !== undefined && n.opJson === r) return withId(n.response, e.requestId);
    const s = e.sendKey === undefined ? undefined : this.sentByKey.get(e.sendKey);
    if (s !== undefined && s.opJson === r) return withId(s.response, e.requestId);
    return undefined;
  }
  private rememberSend(e: MessagesOpRequest, r: MessagesFrame): void {
    if (e.op.kind !== "send" || (r.kind !== "messages-result" && r.kind !== "messages-error" && r.kind !== "messages-consent-result")) return;
    const n = { opJson: JSON.stringify(e.op), response: r };
    this.finishedSends.set(e.requestId, n); cap(this.finishedSends);
    if (e.sendKey !== undefined && this.keyable(e, r)) { this.sentByKey.set(e.sendKey, n); cap(this.sentByKey); }
  }
  /** D:D6r 136436–136442 */
  private keyable(t: MessagesOpRequest, e: MessagesFrame): boolean {
    if (e.kind === "messages-result") return true;
    if (t.draftCard !== true || e.kind !== "messages-error") return false;
    return !MESSAGES_SEND_FAILURES.includes(e.error) && !MESSAGES_DRAFT_CODES.includes(e.error);
  }
  private async withSendKey(e: string | undefined, r: () => Promise<void>): Promise<void> {
    if (e === undefined) return r();
    const n = this.sendKeyTail.get(e) ?? Promise.resolve();
    let s = () => {};
    const o = new Promise<void>(a => { s = a; }), i = n.then(() => o);
    this.sendKeyTail.set(e, i); await n;
    try { await r(); } finally { s(); if (this.sendKeyTail.get(e) === i) this.sendKeyTail.delete(e); }
  }
  private async handleMessagesOp(e: MessagesOpRequest, r: { cancelled: boolean }, n: (f: MessagesFrame) => unknown): Promise<void> {
    const o = e.requestId;
    const i = async (m: MessagesFrame) => { this.rememberSend(e, m); await n(m); };
    const a = this.deps.decideLocalUse;
    const u = e.op.kind === "send" && !(e.approvalId !== undefined && e.approvalId.length > 0); // M6r
    const l = this.deps.capabilities?.() ?? { read: true, send: true };
    const f = capabilityRefusal(e.op.kind, l);
    if (f !== undefined) {
      if (u && a !== undefined) {
        await n({ kind: "messages-accepted", requestId: o });
        await i({ kind: "messages-consent-result", requestId: o, verdict: { kind: "refused", reason: f } });
      } else await n({ kind: "messages-error", requestId: o, error: e.draftCard === true ? this.lpt(f) : f });
      return;
    }
    let p: ConsentVerdict | undefined;
    if (u && a !== undefined) {
      await n({ kind: "messages-accepted", requestId: o });
      p = await a({ approvalId: undefined, authorization: { kind: "none" }, describes: describeMessagesOp(e.op) });
    }
    if (p !== undefined && p.kind !== "allow") { await i({ kind: "messages-consent-result", requestId: o, verdict: p }); return; }
    if (p === undefined) {
      const m = await this.deps.isLocalUseBlocked?.({
        approvalId: e.approvalId,
        authorization: e.draftCard === true && e.authorization !== undefined ? e.authorization : { kind: "none" },
        describes: describeMessagesOp(e.op),
      });
      if (m !== undefined) { await n({ kind: "messages-error", requestId: o, error: e.draftCard === true ? this.lpt(m) : m }); return; }
    }
    if (r.cancelled) { await i({ kind: "messages-error", requestId: o, error: e.draftCard === true ? "messages_send_cancelled" : CANCELLED_BEFORE_START }); return; }
    try {
      // messages-result (R6r/TJe/I6r) needs a working helper; unreachable on Linux (see docs).
      await runMessagesOp(e.op, (this.deps.sidecar ?? locateSidecar)(), { draftCard: e.draftCard === true });
    } catch (m) { await i({ kind: "messages-error", requestId: o, error: m instanceof Error ? m.message : String(m) }); }
  }
}
