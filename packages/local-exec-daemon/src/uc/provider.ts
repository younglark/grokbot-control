import { trace } from "../trace";
import { loadSettings, loadSettingsSync } from "../settings";
import { HttpStatusError, type ReplyQueue } from "../transport/replies";
import { UcReplyLanes } from "./reply-lanes";
import { prepareDownload, writeUploadFile, UC_FILE_CHUNK_BYTES } from "./file-source";
import { aiToolConfigDirsFromEnv, describeAiToolDiscovery, discoverAiToolBytes, isAiToolSource, type AiToolConfigDirs, type AiToolSource } from "./ai-tool-discovery";
import { requestError } from "../exec/handlers";
import * as crypto from "node:crypto";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as http from "node:http";
import * as https from "node:https";
import { backendClientFromEnv, clientHeaders, type BackendClient } from "../state/connection-exchange";
import { describeError } from "../box/provider";
/** D:s9r 177840 */
export const UC_AGENT_TIMEOUT_MS = 5_000;
/** D:e9r / t9r 177836–177837 */
export const UC_WATCH_CONNECT_IDLE_MS = 35_000;
export const UC_RECONNECT_INITIAL_MS = 1_000; // Q8r D:177834
const UC_RECONNECT_MAX_MS = 60_000; // X1t D:177835
const UC_SILENT_RENEWAL_INITIAL_MS = 2_000; // r9r D:177838
const UC_CHANNEL_RETRY_MS = 10_000; // Q1t D:177841
const UC_NETWORK_RENEWAL_COOLDOWN_MS = 30_000; // n9r D:177839
const UC_BACKEND_RETURN_JITTER_MS = 2_000; // g8r D:176381
const UC_WATCH_SILENCE_MS = 15_000;
import { GrokBotService } from "../generated/svc_aiserver.v1.GrokBotService_connect";
import { GrokBotUserComputerQueuedRequest, GrokBotUserComputerRequestFrame,
  GrokBotUserComputerResponseFrame, GrokBotUserComputerHello,
  GrokBotUserComputerClientMessage, GrokBotUserComputerControlMessage,
  GrokBotUserComputerMessagesError, GrokBotUserComputerFileError, GrokBotUserComputerFile, GrokBotUserComputerMessagesAccepted,
  GrokBotUserComputerMessagesConsentResult, GrokBotUserComputerMessagesConsentVerdict, GrokBotUserComputerMessagesResult,
  GrokBotUserComputerLocalToolAccepted, GrokBotUserComputerLocalToolPermissionPending, GrokBotUserComputerLocalToolResult,
  SubmitGrokBotUserComputerResponsesRequest } from "../generated/aiserver.v1_pb";
import {
  lastAllocatedExecIdOrZero,
  cancelRequest,
  dispatchExec,
  type Emit,
  type ExecFrameOut,
} from "../exec/handlers";
import {
  decodeExecServerMessageJson,
  encodeExecClientControlMessageJson,
  encodeExecClientMessageJson,
  execServerMessageToRecord,
  isExecServerDecodeError,
} from "../exec/exec-codec";
import type { PermissionMode } from "../settings";
import { isSupervised } from "../state/discovery";
import { dataRootFromEnv } from "../util";
import { approvalsPathFor, authorizationOf, describeExec, execRefusal, downloadRefusal, uploadRefusal, discoverAiToolRefusal, retireApproval, retirementsPathFor, type Authorization } from "./approvals";
import type { UserComputerHello, UserComputerTransport } from "./types";
import { ASK_MSG, NEVER_MSG } from "../exec/handlers";
import { messagesSettings } from "../settings";
import { decideExecLocalUse, standingGrantsPathFor } from "./approvals";
import { draftCardCodes, locateSidecar, messagesCapabilities, MessagesExecutor, messagesOpSchema, type MessagesOpRequest } from "../box/messages-op";
import { fileTooLarge } from "./file-source";
import { ComputerUse, createDeviceTools, handleLocalTool, helloLocalToolCapabilities, localToolsSnapshot, type DeviceTools, type LocalToolCall } from "./local-tools";

export type ResolvedUcChannel = { backendUrl: string; machineId: string; credential: string };
export type UcProviderOptions = {
  backendUrl: string;
  machineId: string;
  credential: string;
  root: string;
  permission: PermissionMode;
  hello: Omit<UserComputerHello, "supervised"> & { supervised?: boolean };
  onInflight?: (n: number) => void;
  /** Max poll limit (official default-ish). */
  pollLimit?: number;
  random?: () => number;
  /** D:178321 options.createClient (t.createServerClient): replaces E9r when given. */
  createClient?: (baseUrl: string) => Client<typeof GrokBotService>;
  accountScope?: string;
  /** D:L179387–179395: live scope lookup, not the construction-time credential snapshot. */
  resolveChannel?: () => Promise<ResolvedUcChannel | null>;
  /** D:187322–187325: CLAUDE_CONFIG_DIR / CODEX_HOME captured once at start. */
  aiToolConfigDirs?: AiToolConfigDirs;
  /** Test hook for D:Ed 83034 (sidecar lookup); default locateSidecar(). */
  sidecar?: () => string | undefined;
  /** D:Ve client: t.client (eke(env, "desktop").backend); default derived from process.env. */
  client?: BackendClient;
  /** D:lgt q = t.deviceTools ?? Ppt({log: _c}) (179247), shared by every UC provider; default: Linux Ppt. */
  deviceTools?: DeviceTools;
  /** D:onLoopEvent (179404): connected / disconnected{reason} / channel-missing. */
  onLoopEvent?: (e: { kind: "connected" } | { kind: "disconnected"; reason: string } | { kind: "channel-missing" } | { kind: "renewed"; cause: string }) => void;
};

const requestKinds = Object.fromEntries(GrokBotUserComputerRequestFrame.fields.list().map(f => [f.localName, f.no]));

// Only business mapping remains here. Field numbers, oneof and int64 are runtime-owned.
export type Queued = { id: string; requestId: string; kind: number; serverMessage: Record<string, unknown>; parseError?: string;
  /** Exec: D v9r (L178863) approvalId + c5 authorization; retire-approval: approvalId. */
  approvalId?: string; authorization?: Authorization; path?: string; bytes?: Uint8Array; source?: AiToolSource;
  /** D:v9r messagesOp 178909–178926 */
  messages?: MessagesOpRequest;
  /** D:v9r localTool 178927–178938 */
  localTool?: LocalToolCall;
  /** D:v9r→undefined (178512–178516): never admitted; w9r reply (178785) when frame.requestId is non-empty, else none. */
  unsupported?: { reply?: ExecFrameOut } };
const UNSUPPORTED_FRAME = "This computer's local-exec daemon does not understand that request frame; update the desktop app."; // D:z2
export function parseQueued(item: GrokBotUserComputerQueuedRequest): Queued {
  const id = item.id;
  const frame = item.frame;
  const requestId = frame?.requestId || id;
  try {
    if (!id || !frame?.frame.case) throw new Error("invalid request oneof");
    const kind = GrokBotUserComputerRequestFrame.fields.list().find(f => f.localName === frame.frame.case)!.no;
    let serverMessage: Record<string, unknown> = {};
    if (frame.frame.case === "retireApproval") {
      return { id, requestId, kind, serverMessage, approvalId: frame.frame.value.approvalId };
    }
    if (frame.frame.case === "download") {
      const value = frame.frame.value;
      return { id, requestId, kind, serverMessage, path: value.path, approvalId: value.approvalId, authorization: authorizationOf(value) };
    }
    if (frame.frame.case === "upload") {
      const value = frame.frame.value;
      return { id, requestId, kind, serverMessage, path: value.path, bytes: value.data, approvalId: value.approvalId, authorization: authorizationOf(value) };
    }
    if (frame.frame.case === "discoverAiTool") {
      // D:v9r 178897–178906: only QP sources map; anything else is the w9r file-error (178789–178790).
      const value = frame.frame.value;
      if (!isAiToolSource(value.source)) {
        return { id, requestId, kind, serverMessage, unsupported: frame.requestId.length > 0 ? { reply: { kind: "file-error", requestId: frame.requestId, error: UNSUPPORTED_FRAME } } : {} };
      }
      return { id, requestId, kind, serverMessage, source: value.source, approvalId: value.approvalId, authorization: authorizationOf(value) };
    }
    if (frame.frame.case === "putFileToUrl" || frame.frame.case === "getFileFromUrl") {
      // D:v9r 178890–178892 returns undefined → w9r default (178791–178792): control throw{id:0, z2}; not admitted.
      return { id, requestId, kind, serverMessage, unsupported: frame.requestId.length > 0
        ? { reply: { kind: "control", requestId: frame.requestId, message: { throw: { id: 0, error: UNSUPPORTED_FRAME } } } } : {} };
    }
    if (frame.frame.case === "localTool") {
      const v = frame.frame.value;
      return { id, requestId, kind, serverMessage, localTool: { toolId: v.toolId, inputJson: v.inputJson, conversationId: v.conversationId, approvalId: v.approvalId } };
    }
    if (frame.frame.case === "messagesOp") {
      // D:v9r 178909–178926: AJe = rk.safeParse(tn(opJson)); failure → undefined → w9r messages-error z2 (178787–178788).
      const value = frame.frame.value;
      let raw: unknown; try { raw = JSON.parse(value.opJson); } catch { raw = undefined; }
      const op = messagesOpSchema.safeParse(raw);
      if (!op.success) {
        return { id, requestId, kind, serverMessage, unsupported: frame.requestId.length > 0 ? { reply: { kind: "messages-error", requestId: frame.requestId, error: UNSUPPORTED_FRAME } } : {} };
      }
      const sendKey = typeof value.sendKey === "string" && value.sendKey.length > 0 ? value.sendKey : undefined; // T9r
      return { id, requestId, kind, serverMessage, approvalId: value.approvalId, messages: {
        requestId, op: op.data, approvalId: value.approvalId,
        ...(sendKey === undefined ? {} : { sendKey }),
        ...(value.draftCard === true ? { draftCard: true as const } : {}),
        ...(value.draftCard === true && value.authorizedByApproval ? { authorization: { kind: "approval" as const } } : {}),
      } };
    }
    if (frame.frame.case === "exec") {
      const value = frame.frame.value;
      const meta = { approvalId: value.approvalId, authorization: authorizationOf(value) };
      // Official: ExecServerMessage.fromJsonString(serverMessageJson, { ignoreUnknownFields: true }).
      const decoded = decodeExecServerMessageJson(value.serverMessageJson);
      serverMessage = execServerMessageToRecord(decoded);
      return { id, requestId, kind, serverMessage, ...meta };
    }
    return { id, requestId, kind, serverMessage };
  } catch (error) {
    const parseError = isExecServerDecodeError(error)
      ? (error as Error).message
      : error instanceof Error && error.message === "invalid request oneof"
        ? "This computer's local-exec daemon does not understand that request frame; update the desktop app."
        : "Malformed local-exec request frame";
    return { id, requestId, kind: 0, serverMessage: {}, parseError };
  }
}
/** D:Y_ 178966 / 179080–179097: a file payload is split into j2 (1 MiB) chunks with seq 0.. and last on the final one. */
function responseFrames(frame: ExecFrameOut): GrokBotUserComputerResponseFrame[] {
  if (frame.kind !== "file" || frame.bytes === undefined || frame.bytes.length <= UC_FILE_CHUNK_BYTES) return [responseFrame(frame)];
  const n = frame.bytes, out: GrokBotUserComputerResponseFrame[] = [];
  for (let o = 0, i = 0; o < n.length; o += UC_FILE_CHUNK_BYTES, i += 1) {
    const a = Math.min(o + UC_FILE_CHUNK_BYTES, n.length);
    out.push(new GrokBotUserComputerResponseFrame({ requestId: frame.requestId,
      frame: { case: "file", value: new GrokBotUserComputerFile({ data: n.slice(o, a), seq: i, last: a === n.length }) } }));
  }
  return out;
}
function responseFrame(frame: ExecFrameOut): GrokBotUserComputerResponseFrame {
  const result = new GrokBotUserComputerResponseFrame({requestId: frame.requestId});
  if (frame.kind === "client") {
    // Outer payload remains messageJson string; inner body is schema-validated when possible.
    result.frame = {case: "client", value: new GrokBotUserComputerClientMessage({
      messageJson: encodeExecClientMessageJson(frame.message),
    })};
  } else if (frame.kind === "control") {
    result.frame = {case: "control", value: new GrokBotUserComputerControlMessage({
      messageJson: encodeExecClientControlMessageJson(frame.message),
      cwdState: frame.cwdState,
    })};
  } else if (frame.kind === "messages-error") result.frame = {case: "messagesError", value: new GrokBotUserComputerMessagesError({error: frame.error})};
  else if (frame.kind === "messages-accepted") result.frame = { case: "messagesAccepted", value: new GrokBotUserComputerMessagesAccepted() };
  else if (frame.kind === "messages-consent-result") {
    // D:I9r 178950–178959: allow→STANDING, ask→ASK, refused→REFUSED (+reason).
    const V = GrokBotUserComputerMessagesConsentVerdict, v = frame.verdict;
    result.frame = { case: "messagesConsentResult", value: new GrokBotUserComputerMessagesConsentResult({
      verdict: v.kind === "allow" ? V.STANDING : v.kind === "ask" ? V.ASK : V.REFUSED, ...(v.kind === "refused" ? { reason: v.reason } : {}) }) };
  } else if (frame.kind === "messages-result") {
    // D:Y_ 179001–179014: result JSON above K_ (8 MiB) becomes messages-error Od(n, K_).
    const n = JSON.stringify(frame.result);
    if (n.length > 8 * 1024 * 1024) return responseFrame({ kind: "messages-error", requestId: frame.requestId, error: fileTooLarge(n.length, 8 * 1024 * 1024) });
    result.frame = { case: "messagesResult", value: new GrokBotUserComputerMessagesResult({ resultJson: n, ...frame.timings }) };
  }
  else if (frame.kind === "local-tool-accepted") result.frame = { case: "localToolAccepted", value: new GrokBotUserComputerLocalToolAccepted(frame.permissionGranted === true ? { permissionGranted: true } : {}) };
  else if (frame.kind === "local-tool-permission-pending") result.frame = { case: "localToolPermissionPending", value: new GrokBotUserComputerLocalToolPermissionPending(frame.reason === undefined ? {} : { reason: frame.reason }) };
  else if (frame.kind === "local-tool-result") {
    const o = frame.outcome, K = 8 * 1024 * 1024, mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
    // D:Y_ 179062–179070: a done output above K_ becomes failed PJe.
    if (o.status === "done" && o.outputJson.length > K) return responseFrame({ kind: "local-tool-result", requestId: frame.requestId, outcome: { status: "failed",
      error: `The computer-use reply is ${mib(o.outputJson.length)}, which exceeds Grok Bot's ${mib(K)} limit for one reply from the user's computer. Capture a smaller area, such as one app window instead of the whole display.` } });
    // D:R9r 178942–178956
    const v = o.status === "done" ? { status: "done", outputJson: o.outputJson } : o.status === "failed" ? { status: "failed", error: o.error }
      : o.status === "needs_permission" ? (o.error === undefined ? { status: "needs_permission" } : { status: "needs_permission", error: o.error })
      : { status: "ask", outputJson: JSON.stringify({ bundleId: o.app.bundleId, appName: o.app.appName }) };
    result.frame = { case: "localToolResult", value: new GrokBotUserComputerLocalToolResult(v) };
  }
  else if (frame.kind === "file-error") result.frame = {case: "fileError", value: new GrokBotUserComputerFileError({error: frame.error})};
  else if (frame.kind === "file") {
    // D:Y_ 179080–179091: upload success / empty payload → one empty last chunk at seq 0.
    const bytes = frame.bytes;
    if (bytes === undefined || bytes.length === 0) {
      result.frame = { case: "file", value: new GrokBotUserComputerFile({ data: new Uint8Array(), seq: 0, last: true }) };
    } else {
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      result.frame = { case: "file", value: new GrokBotUserComputerFile({ data: owned, seq: 0, last: true }) };
    }
  }
  return result;
}
function authError(error: unknown): boolean {
  // D:sgt 178782: only Unauthenticated rejects a credential (PermissionDenied is an ordinary failure).
  return error instanceof ConnectError && error.code === Code.Unauthenticated;
}

/**
 * UserComputer ConnectRPC transport (P2 skeleton).
 * Speaks Watch/Poll/Submit/Withdraw against a lab fake peer or compatible backend.
 */
/** Official h9r / m9r / A9 (daemon.formatted.cjs L177855–177856, L135894–135895, L178589–178599). */
export const UC_BACKLOG_STALE_MS = 15_000;
export const UC_BACKLOG_NUDGE_MS = 5_000;
export const UC_BACKLOG_CLOSED_BEFORE_START =
  "The user's computer stopped serving requests before this one started. Retry it once the computer is back.";
/** Official keepAliveTick interval c9r (L177956 / L177848 area). */
export const UC_KEEPALIVE_INTERVAL_MS = 500;
/** Official rgt / _9r (daemon.formatted.cjs L177859–177860). */
export const UC_INFLIGHT_MAX = 8;
/**
 * Official keepalive constants (daemon.formatted.cjs L177848–177854, L97389, L177276):
 * l9r admit→first due 1s; u9r heard→next due 3s; d9r keepalive submit deadline 3s;
 * f9r ResourceExhausted pause 5s; p9r batching window 1.5s; E0 stuck-submit cutoff 120s; X7e 256 ids.
 */
export const UC_KEEPALIVE_ADMIT_MS = 1_000;
export const UC_KEEPALIVE_HEARD_MS = 3_000;
export const UC_KEEPALIVE_SUBMIT_DEADLINE_MS = 3_000;
export const UC_KEEPALIVE_EXHAUSTED_PAUSE_MS = 5_000;
export const UC_KEEPALIVE_WINDOW_MS = 1_500;
export const UC_KEEPALIVE_STUCK_SUBMIT_MS = 120_000;
export const UC_KEEPALIVE_MAX_IDS = 256;
/** Official S9r: safety poll cadence while the Watch is connected. */
export const UC_SAFETY_POLL_MS = 30_000;
export const UC_DATA_SUBMIT_DEADLINE_MS = 120_000;
/**
 * Bound for deferred closing replies (busy / cancelled-before-start / drained / parse error).
 * Official holds every closing reply in per-request reply lanes with no cap (oee.push, D:L177276ff)
 * and therefore ACKs every polled item. With a FIFO queue whose head only advances on ACK, a control
 * message (cancel) behind K polled-but-unACKable items is reachable only once those K closing replies
 * are held: no-ACK-then-drop + bounded memory ⇒ some K beyond which a control waits for the reply lane
 * to recover. A closing reply is small and fixed-shape (requestId + a shared constant text), so it is
 * held compactly and budgeted by bytes (1/8 of the 8 MiB lane) and count, instead of by a small count.
 */
export const UC_PENDING_CLOSINGS_MAX = 8192;
/** Official tgt (D:L177848). */
export const UC_POLL_LIMIT = 64;
export const UC_PENDING_CLOSINGS_MAX_BYTES = 1 << 20;
/** Accounted cost of one deferred closing reply: requestId (UTF-16) + fixed object overhead. */
export function closingCost(requestId: string): number { return 96 + 2 * requestId.length; }

/** Official Kce (daemon.formatted.cjs L81192). */
export const UC_CANCELLED_BEFORE_START = "Cancelled before it started on the user's computer.";

/** Official A9r: if any eligible id is due, send every eligible id due within the window, earliest first. */
export function selectKeepAliveIds(dueAt: Map<string, number>, eligible: Set<string>, now: number): string[] {
  const e = [...dueAt].filter(([id]) => eligible.has(id));
  if (!e.some(([, d]) => d <= now)) return [];
  return e.filter(([, d]) => d <= now + UC_KEEPALIVE_WINDOW_MS).sort(([, a], [, b]) => a - b)
    .slice(0, UC_KEEPALIVE_MAX_IDS).map(([id]) => id);
}
export const UC_BACKLOG_MAX = 64;
export const UC_BUSY_TEXT =
  "The user's computer is busy with other requests right now; try again shortly.";

const BACKEND_DOWN_HTTP = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]); // S8r D:176382
const BACKEND_DOWN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENETDOWN",
  "ENETRESET", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]); // _8r D:176383–176396
/** D:un/j7t 78659–78671: first /^E[A-Z_]+$/ code along the cause chain. */
function errnoCode(t: unknown): string | undefined {
  const seen = new Set<unknown>();
  for (let n: any = t; n != null && typeof n === "object" && !seen.has(n); n = n.cause) {
    seen.add(n);
    if (typeof n.code === "string" && /^E[A-Z_]+$/.test(n.code)) return n.code;
  }
  return undefined;
}
/** D:w8r 176402–176416: was this failure the backend being unreachable/down? (qi = this port's deadline errors are not thrown by Watch.) */
export function backendLooksDown(t: unknown): boolean {
  if (t instanceof TypeError && t.message === "fetch failed") return true;
  if (t instanceof ConnectError) {
    const m = /^HTTP (\d{3})$/.exec(t.rawMessage)?.[1];
    if (m !== undefined) return BACKEND_DOWN_HTTP.has(Number(m));
  }
  const e = errnoCode(t);
  return e !== undefined ? BACKEND_DOWN_CODES.has(e) : t instanceof ConnectError && t.code === Code.Unavailable;
}
/** D:v1t 176417–176450 */
export function createBackendReturn(random: () => number = Math.random) {
  let down = false;
  let slot: { controller: AbortController; wake: NodeJS.Timeout | null } | null = null;
  return {
    noteFailure(e: unknown) { down = backendLooksDown(e); },
    noteSilence() { down = true; },
    noteAnswered() { down = false; },
    get down() { return down; },
    arm() {
      if (slot?.wake) clearTimeout(slot.wake);
      const o = { controller: new AbortController(), wake: null as NodeJS.Timeout | null };
      slot = o;
      return { signal: o.controller.signal, dispose: () => { if (o.wake) clearTimeout(o.wake); o.wake = null; if (slot === o) slot = null; } };
    },
    noteBackendReturn() {
      const o = slot;
      if (!down || o === null || o.wake !== null || o.controller.signal.aborted) return;
      const i = random() * UC_BACKEND_RETURN_JITTER_MS;
      if (i <= 0) { o.controller.abort(); return; }
      o.wake = setTimeout(() => o.controller.abort(), i); o.wake.unref();
    },
  };
}

export class UserComputerProvider implements UserComputerTransport {
  private closed = false;
  private stopped = false;
  private closing = false;
  private watchStopped = false;
  private closeDrained = false;
  private onPollIdle?: () => void;
  private onInflightDrained?: () => void;
  /** D:abortController — the running Watch's own controller (undefined between Watches). */
  private abortController?: AbortController;
  /** D:pollAbort — the in-flight poll's controller; renew() aborts it. */
  private pollAbort?: AbortController;
  private renewRequested = false;
  private networkRenewalHold?: { dispose(): void };
  private networkChangeDeferred = false;
  /** Injectable for tests (original passes options.random to the jittered policies). */
  private readonly random = (): number => (this.opts.random ?? Math.random)();
  /** D:v1t 176417–176450 */
  readonly backendReturn = createBackendReturn(() => this.random());
  private presenceToken = crypto.randomBytes(16).toString("hex");
  private pendingAcks: string[] = [];
  private seen = new Set<string>();
  private inflight = 0;
  private pollBusy = false;
  private replies?: ReplyQueue | UcReplyLanes;
  private backlog: Queued[] = [];
  private active = new Set<string>();
  private activeJobs = new Set<Promise<void>>();
  private pollAgain = false;
  private pollTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;
  /** Official keepAliveDueAt / cancelledIds / keepAlivePausedUntil / proven (Watch `connected` seen). */
  readonly keepAliveDueAt = new Map<string, number>();
  private cancelledIds = new Set<string>();
  private keepAlivePausedUntil = 0;
  private keepAliveSending = false;
  private proven = false;
  private pendingClosings: ExecFrameOut[] = [];
  private pendingClosingBytes = 0;
  /** Some polled item was left unacknowledged because its closing reply could not be held. */
  private unackedWaiting = false;
  private announcedStanding?: string;
  /** Official lastPolledAt (monotonic in daemon; wall clock here). */
  lastPolledAt = 0;
  /**
   * Fixed for the provider's lifetime (official keeps it in the per-scope descriptor and closes/recreates
   * the provider when it changes, D:L179352). Taken only from the local credential record, never from a request.
   */
  get serverAuthoritative(): boolean { return this.opts.hello.serverAuthoritative === true; }
  /** Official getStanding (D:L179397): undefined under serverAuthoritative → hello.standing "" (L178209). */
  private standingFor(permission: PermissionMode): string { return this.serverAuthoritative ? "" : permission; }
  /** In-flight retire-approval writes (no inflight slot, no reply; official startRequest without E7). */
  private retireJobs = new Set<Promise<void>>();
  private channel: { backendUrl: string; machineId: string; credential: string } | null =
    null;

  private client: Client<typeof GrokBotService>;
  private readonly aiToolConfigDirs: AiToolConfigDirs;
  constructor(private readonly opts: UcProviderOptions) {
    this.aiToolConfigDirs = opts.aiToolConfigDirs ?? aiToolConfigDirsFromEnv();
    this.client = this.makeClient(opts.backendUrl);
  }
  /**
   * D:E9r 179040–179055 (renewConnection): Connect over HTTP/1.1 with a keep-alive agent (timeout s9r = 5 s) and an
   * interceptor that sets every mb(client) header (D:79034) on every request of this client (Watch, Poll, Submit,
   * keepalive, withdraw). L1t (D:177268) sets no read/write limit, so connect's defaults apply
   * (VQ = P7e = 0xFFFFFFFF, D:174740–174748).
   */
  private makeClient(baseUrl: string): Client<typeof GrokBotService> {
    if (this.opts.createClient) return this.opts.createClient(baseUrl); // D:renewConnection 178321 options.createClient
    const headers = clientHeaders(this.opts.client ??= backendClientFromEnv());
    const agentOpts = { keepAlive: true, timeout: UC_AGENT_TIMEOUT_MS };
    return createClient(GrokBotService, createConnectTransport({
      baseUrl, httpVersion: "1.1", useBinaryFormat: true,
      nodeOptions: { agent: URL.parse(baseUrl)?.protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts) },
      interceptors: [next => req => { for (const [k, v] of Object.entries(headers)) req.header.set(k, v); return next(req); }],
    }));
  }

  async start(): Promise<void> {
    const supervised = this.opts.hello.supervised ?? (await isSupervised());
    const hello: UserComputerHello = {
      ...this.opts.hello,
      supervised,
      standing: this.opts.hello.standing || "always",
      serverAuthoritative: this.opts.hello.serverAuthoritative ?? false,
    };
    this.channel = {
      backendUrl: this.opts.backendUrl.replace(/\/$/, ""),
      machineId: this.opts.machineId,
      credential: this.opts.credential,
    };
    // Official reply lanes + flush/submit retry (oee, L177276; flush/submit L178671–178760): see reply-lanes.ts.
    this.replies = new UcReplyLanes({
      canFlush: () => !!this.channel && this.proven && !this.closed && !this.closing,
      send: async (frames, signal) => {
        const ch = this.channel!;
        // Frames carry no authority: machineId/credential come from the current channel at each attempt.
        const request = new SubmitGrokBotUserComputerResponsesRequest({ machineId: ch.machineId, credential: ch.credential, frames });
        let res;
        // Official dataDeadline E0 = 120s per attempt (daemon.formatted.cjs L97389, L177954).
        try { res = await this.client.submitGrokBotUserComputerResponses(request, {timeoutMs: UC_DATA_SUBMIT_DEADLINE_MS, signal}); }
        catch (error) {
          // Channel fencing: a rejection of a credential that has since been rotated is retried on the
          // current channel instead of closing it (official rejectCredential checks channel identity).
          if (authError(error)) throw new HttpStatusError(401, ch);
          throw error;
        }
        this.noteHeard(frames.map(f => f.requestId));
        const accepted = res.acceptedCount;
        // Official successful Submit is terminal even when the machine rejected some frames.
        if (accepted < frames.length) console.error(
          `[user-computer-provider] server accepted ${accepted} of ${frames.length} response frames; the rest were not queued for this machine`,
        );
      },
      // Fenced where the failure is set: a stale channel's 401 never closes a channel that rotated in between.
      // D:submit 178734: `if (o) return (replies.requeue(n), rejectCredential(e), 0)` — no pause: the flush loop
      // re-checks `channel/proven` (canFlush) and stops when the channel that sent the batch is still current.
      reject: (e) => { this.rejectCredential((e.epoch as { credential: string } | undefined) ?? null); return false; },
      isCancelled: (id) => this.cancelledIds.has(id),
    });
    this.lastPolledAt = Date.now();
    // Official polls on Watch connected / notify / heartbeat plus a 30 s safety poll (S9r, D:L177858,
    // L177943, L178389–178403). A former 250 ms poll setInterval here put extra timer wake-ups next
    // to the 500 ms keepalive tick: instrumented offline runs showed ours' tick timers firing earlier
    // (mean +0.30 ms vs official +0.47…0.57 ms per tick), so the 6th tick after a heard keepalive
    // (due exactly +3000 ms) sometimes missed by <1 ms and slipped one tick (+500 ms).
    this.pollTimer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, UC_SAFETY_POLL_MS);
    // Official keepAliveTick (~500ms) runs superviseBacklog then sendKeepAlives.
    // Official hc/yre tick is serial: the next tick is scheduled UC_KEEPALIVE_INTERVAL_MS after the
    // previous tick (including its keepalive submit) completes, not on a fixed grid.
    const tick = async (): Promise<void> => {
      if (this.closed) return;
      try { this.flushClosings(); this.superviseBacklog(); await this.sendKeepAlives(); } catch { /* tick failures never stop the loop */ }
      if (!this.closed) this.keepAliveTimer = setTimeout(() => void tick(), UC_KEEPALIVE_INTERVAL_MS);
    };
    this.keepAliveTimer = setTimeout(() => void tick(), UC_KEEPALIVE_INTERVAL_MS);
    // D:178223–178289 runLoop counters: e = reconnect attempt (reset on connected), r = silent-renewal attempt.
    let e = 1, r = 0;
    while (!this.closed && !this.watchStopped) {
      let liveChannel: ResolvedUcChannel | null = null;
      try { liveChannel = await this.resolveChannel(); }
      catch { console.error("[user-computer-provider] channel resolve failed"); }
      if (liveChannel === null) {
        this.channel = null; this.proven = false; this.abandonWork();
        this.opts.onLoopEvent?.({ kind: "channel-missing" });
        await this.loopSleep(UC_CHANNEL_RETRY_MS); // D:178241 sleep(channelRetry, 1): Q1t = 10 s, not woken by backend return
        continue;
      }
      // D:178243–178244: (channel === undefined || !ngt(channel, n)) && (channel = n, renewConnection(n), proven = false)
      this.applyResolvedChannel(liveChannel);
      if (this.closed || this.watchStopped) break;
      hello.standing = this.standingFor((await loadSettings()).permission);
      hello.serverAuthoritative = this.opts.hello.serverAuthoritative;
      this.announcedStanding = hello.standing;
      // D:watch 178367–178376: localTools() is read before every Watch and shapes the hello capabilities.
      const lt = await localToolsSnapshot(this.computerUse, this.deviceTools);
      if (this.closed || this.watchStopped) break;
      this.helloedLocalTools = JSON.stringify(lt);
      hello.capabilities = this.withLocalToolCapabilities(hello.capabilities, lt);
      const reason = await this.watchLoop(hello, () => { e = 1; this.backendReturn.noteAnswered(); });
      if (reason === "stall" || reason === "silent") this.backendReturn.noteSilence(); // D:178259
      this.opts.onLoopEvent?.({ kind: "disconnected", reason });
      if (this.closed || this.watchStopped) break;
      // D:178267–178286 per-reason branches.
      r = reason !== "silent" ? 0 : (this.watchHeardAfterConnected ? 1 : r + 1);
      if (reason === "lifetime") continue;
      if (reason === "network-change") { this.renew(liveChannel, reason); continue; }
      if (reason === "silent") {
        this.renew(liveChannel, reason); // D:178314 renew → pollAbort + renewConnection (fresh E9r client)
        await this.sleepUnlessBackendReturns(this.random() * Math.min(UC_RECONNECT_MAX_MS, UC_SILENT_RENEWAL_INITIAL_MS * 2 ** (r - 1))); // silentRenewalBackoff, jitter "full"
        continue;
      }
      if (reason === "unauthorized") {
        // D:178278–178283: channel = undefined, proven = false, e = 1, sleep(channelRetry, 1) (Q1t = 10 s, not
        // woken by a backend return). The next pass re-resolves the scope and, since channel is undefined, applies
        // it again (new client) — a rotated credential is picked up there; the same one is retried.
        this.channel = null; this.proven = false; e = 1;
        await this.loopSleep(UC_CHANNEL_RETRY_MS);
        continue;
      }
      await this.sleepUnlessBackendReturns(Math.min(UC_RECONNECT_MAX_MS, UC_RECONNECT_INITIAL_MS * 2 ** (e - 1))); // reconnectBackoff, no jitter
      e += 1;
    }
    clearInterval(this.pollTimer);
    clearTimeout(this.keepAliveTimer);
  }

  private resolveChannel(): Promise<ResolvedUcChannel | null> {
    return this.opts.resolveChannel ? this.opts.resolveChannel() : Promise.resolve(this.channel ?? {
      backendUrl: this.opts.backendUrl, machineId: this.opts.machineId, credential: this.opts.credential,
    });
  }
  private applyResolvedChannel(next: ResolvedUcChannel): boolean {
    const old = this.channel;
    if (old && old.backendUrl === next.backendUrl && old.machineId === next.machineId && old.credential === next.credential) return false;
    this.client = this.makeClient(next.backendUrl);
    this.channel = next;
    this.proven = false;
    this.rehello();
    return true;
  }
  /** D:L178180–178220: re-resolve a current scope; missing channel abandons work. */
  async rehelloIfChanged(): Promise<void> {
    if (this.channel !== null) {
      const next = await this.resolveChannel();
      if (next === null) {
        this.channel = null; this.proven = false; this.abandonWork(); this.rehello(); return; // D:178185–178191
      }
      if (this.applyResolvedChannel(next)) return;
    }
    const standing = this.standingFor((await loadSettings()).permission);
    // D:rehelloWhenInputsChanged 178209–178219: localTools() (device refresh) is read on every check once helloed.
    const lt = this.helloedLocalTools === undefined ? undefined : JSON.stringify(await localToolsSnapshot(this.computerUse, this.deviceTools));
    if ((this.announcedStanding !== undefined && this.announcedStanding !== standing) || (lt !== undefined && lt !== this.helloedLocalTools)) {
      this.announcedStanding = standing;
      this.rehello();
    }
  }

  /** Same-machine, same-scope rotation resumes the SAME reply/ack/task state. */
  updateChannel(next: { backendUrl: string; machineId: string; credential: string; accountScope?: string; serverAuthoritative?: boolean }): boolean {
    if (!this.channel || this.closed || next.machineId !== this.opts.machineId || next.accountScope !== this.opts.accountScope || next.backendUrl.replace(/\/$/, "") !== this.opts.backendUrl.replace(/\/$/, "")) return false;
    // A serverAuthoritative change (either direction) is not a rotation: the caller closes this provider and
    // creates a new one (official D:L179352). Never mutate the mode in place.
    if ((next.serverAuthoritative === true) !== this.serverAuthoritative) return false;
    if (next.credential === this.channel.credential) return false;
    // Test/compat entry (production rotates through resolveChannel/rehelloIfChanged). Like the !ngt branch of
    // rehelloWhenInputsChanged (D:178193–178199) minus renewConnection: same backendUrl, so the client is kept.
    this.channel = { ...this.channel, credential: next.credential };
    this.proven = false;
    this.rehello();
    return true;
  }

  // Interface compatibility with earlier stub signature
  async startWithChannel(
    _channel: { backendUrl: string; machineId: string; credential: string },
    _hello: UserComputerHello,
  ): Promise<void> {
    return this.start();
  }

  beginShutdown(): void {
    this.closed = true; clearInterval(this.pollTimer); clearTimeout(this.keepAliveTimer); this.abortController?.abort(); this.loopWake.abort(); this.networkRenewalHold?.dispose();
  }
  /** D:L178009–178025. Reentrant close returns immediately; it does not join the first close. */
  async stop(options: { withdrawPresence?: boolean } = {}): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.stopped = true; // existing pending-approval guard; do not spawn after close starts
    const withdraw = options.withdrawPresence === true ? this.stopWatchingAndWithdraw() : Promise.resolve();
    clearTimeout(this.keepAliveTimer);
    clearInterval(this.pollTimer);
    if (this.replies instanceof UcReplyLanes) this.replies.pauseForClose();
    this.abandonWork();
    if (this.pollBusy) await this.awaitSettledOnClose("the in-flight poll", done => { this.onPollIdle = done; });
    this.onPollIdle = undefined;
    if (this.active.size > 0) await this.awaitSettledOnClose("in-flight requests", done => { this.onInflightDrained = done; });
    this.onInflightDrained = undefined;
    await this.drainOnClose();
    this.closed = true;
    this.networkRenewalHold?.dispose(); // D:178021
    this.abortController?.abort(); this.loopWake.abort();
    await withdraw;
  }

  private async stopWatchingAndWithdraw(): Promise<void> {
    // D:L178027–178049: begin withdrawal BEFORE poll/inflight/flush drain; await it last.
    this.watchStopped = true;
    this.abortController?.abort(); this.loopWake.abort();
    const ch = this.channel;
    if (!ch) return;
    try {
      await this.client.withdrawGrokBotUserComputerPresence({
        machineId: ch.machineId, credential: ch.credential, presenceToken: this.presenceToken,
      }, { timeoutMs: 750 }); // g9r
    } catch { /* original reports failure but close still completes */
      console.error("[user-computer-provider] presence withdraw failed");
    }
  }

  private abandonWork(): void {
    const pending = this.backlog;
    this.backlog = [];
    for (const q of pending) void Promise.resolve(this.emit(this.closingFrame(q, UC_BACKLOG_CLOSED_BEFORE_START)))
      .catch(() => console.error("[user-computer-provider] abandoned backlog reply failed"));
    for (const id of this.active) cancelRequest(id);
  }

  private async awaitSettledOnClose(label: string, register: (done: () => void) => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await new Promise<void>(resolve => {
      register(resolve);
      timer = setTimeout(() => { console.error(`[user-computer-provider] close gave up waiting for ${label}`); resolve(); }, 10_000); // ok
    });
    clearTimeout(timer);
  }

  private async drainOnClose(): Promise<void> {
    if (this.replies instanceof UcReplyLanes) {
      const replies = this.replies;
      replies.dropStreams();
      if (replies.flushing) await this.awaitSettledOnClose("the in-progress flush", done => { void replies.waitForIdle().then(done); });
      const ch = this.channel, client = this.client;
      if (ch && this.proven) await replies.drainOnClose(async frames => {
        await client.submitGrokBotUserComputerResponses({ machineId: ch.machineId, credential: ch.credential, frames }, { timeoutMs: 10_000 });
      });
    } else {
      // Compatibility for pre-lanes transports/test doubles, not the production start path.
      await this.replies?.drain();
      this.replies?.stop();
    }
    this.closeDrained = true;
  }

  private bump(delta: number): void {
    this.inflight += delta;
    this.opts.onInflight?.(this.inflight);
  }

  private emit: Emit = (frame) => this.queueSubmit([frame]);

  private queueSubmit(frames: ExecFrameOut[]): Promise<void> {
    const ch = this.channel;
    if (frames.length === 0 || !this.replies || (!ch && !(this.replies instanceof UcReplyLanes))) return Promise.resolve();
    // Lane envelopes are decoded to frames only; missing channel must not discard abandonWork's terminal.
    return this.replies.enqueue(Buffer.from(new SubmitGrokBotUserComputerResponsesRequest({
      machineId: ch?.machineId ?? "", credential: ch?.credential ?? "", frames: frames.flatMap(responseFrames),
    }).toBinary()), frames.map(f => f.requestId));
  }

  async pollOnce(): Promise<void> {
    if (this.pollBusy) { this.pollAgain = true; return; }
    // Official keeps polling at capacity/backpressure so cancel + superviseBacklog nudge stay live.
    // D:pollOnce 178448–178455: channel/client/proven/closed/closing.
    if (this.closed || this.closing || !this.proven || !this.channel) return;
    this.pollBusy = true;
    const acks = this.pendingAcks.splice(0);
    const pollChannel = this.channel;
    let polled = false;
    try {
      const ch = pollChannel;
      const liveStanding = this.standingFor((await loadSettings()).permission);
      if (this.announcedStanding !== undefined && liveStanding !== this.announcedStanding) {
        // Re-announce policy by replacing only the Watch connection, never tasks.
        this.announcedStanding = liveStanding;
        this.rehello();
      }
      // Continue polling at capacity: cancel controls must remain reachable.
      // D:178458–178481: pollAbort lets renew() abandon this poll; an aborted poll requeues its acks and asks again.
      const pa = new AbortController(); this.pollAbort = pa;
      let res;
      try {
        res = await this.client.pollGrokBotUserComputerRequests({
          machineId: ch.machineId, credential: ch.credential, ackIds: acks,
          // Official tgt=64 on every poll regardless of local capacity (D:L177848, L178474).
          limit: this.opts.pollLimit ?? UC_POLL_LIMIT,
        }, {timeoutMs: 10_000, signal: pa.signal}); // original controlDeadline ok
      } catch (error) {
        if (pa.signal.aborted) { this.pendingAcks.unshift(...acks); this.pollAgain = true; return; }
        throw error;
      } finally { if (this.pollAbort === pa) this.pollAbort = undefined; }
      if (this.channel !== pollChannel || !this.proven) { this.pendingAcks.unshift(...acks); return; } // D:178484
      const queued = res.requests.map(parseQueued).filter(q => q.id);
      trace("poll-items", { n: queued.length, rids: queued.map(q => q.requestId.slice(0, 16)) });
      // Only forget queue ids after the peer confirms receipt of prior acks.
      acks.forEach(id => this.seen.delete(id));
      for (const q of queued) {
        if (this.seen.has(q.id)) continue;
        // Capacity is checked before ack/admission. Cancel controls bypass backlog.
        this.seen.add(q.id); this.pendingAcks.push(q.id);
        if (q.unsupported) { if (q.unsupported.reply && !this.storeClosingFrame(q.unsupported.reply)) this.unack(q); continue; }
        if (q.parseError) { if (!this.storeClosingFrame({ kind: "control", requestId: q.requestId, message: { throw: { error: q.parseError } } })) this.unack(q); continue; }
        if (q.kind === requestKinds.retireApproval) {
          // Official (D:L178509–178555, v_.handle L135964, wUe L81351): ACKed like any item, not E7 → no keepalive,
          // no inflight slot, no busy/backlog; persisted under the per-file lock; NO reply frame of any kind.
          this.startRetire(q.approvalId ?? "");
          continue;
        }
        if (q.kind === requestKinds.cancel) {
          // Official (D:L178526–178535, Gl/Kce): each cancelled backlog entry gets a closing error.
          const dropped = this.backlog.filter(x => x.requestId === q.requestId);
          // No room to hold their closing replies: leave the cancel unacknowledged (redelivered by the
          // next poll) instead of dropping terminal frames of already-acknowledged backlog work.
          // Reserve against the ACTUAL closing frames (their real requestId cost), all or nothing:
          // only when every terminal frame can be held are the backlog removal and the cancel ACK
          // committed; otherwise nothing is removed and the cancel stays unACKed (redelivered).
          const closings = dropped.map(d => this.closingFrame(d, UC_CANCELLED_BEFORE_START));
          if (!this.canHoldClosings(closings)) { this.unack(q); continue; }
          this.cancelledIds.add(q.requestId);
          this.backlog = this.backlog.filter(x => x.requestId !== q.requestId);
          // Official replies.drop(requestId) + submitAbort when the in-flight batch is all cancelled.
          // D:178521–178526 drops old replies/aborts the cancelled submit BEFORE executor cancellation.
          // Cancellation may synchronously enqueue its terminal: dropping afterwards would erase it.
          if (typeof this.replies?.drop === 'function') this.replies.drop(id => id === q.requestId, id => this.cancelledIds.has(id));
          cancelRequest(q.requestId);
          // D:handleCancel 136353–136364: cancelled flag + entry.cancel() (local-tool abort).
          const lt = this.localToolEntries.get(q.requestId); if (lt) { lt.cancelled = true; lt.cancel(); }
          for (const f of closings) if (!this.storeClosingFrame(f)) throw new Error("reserved closing reply not held");
          continue;
        }
        // D:L178543–178546: a poll already in flight when close starts ACKs and closes new exec work.
        if (this.closing) {
          await this.emit(this.closingFrame(q, UC_BACKLOG_CLOSED_BEFORE_START));
          continue;
        }
        // Promote before admit (official startRequest.finally pulls while inflight<8,
        // D:L178576–178583). Same-poll recoveries with replies.available must free
        // backlog slots before the busy check — otherwise a recovered lane falsely
        // busy-rejects while active still has room.
        this.runBacklog();
        // Official busy: inflight>=8 && backlog>=64 (D:L178548–178552).
        // Lab compensation (NOT claimed equivalent): if backlog is still full after
        // promote — including reply-stall where runBacklog cannot move work —
        // refuse so backlog never grows past 64.
        if (this.backlog.length >= UC_BACKLOG_MAX) {
          // The queue item is acknowledged only once its busy reply is held (lane or bounded deferral);
          // otherwise it stays unacknowledged and the server redelivers it on a later poll.
          if (!this.storeClosing(q, UC_BUSY_TEXT)) this.unack(q);
          continue;
        }
        // Official startRequest suppresses an already-inflight requestId with
        // no additional result; queue-id ack remains separate. Pending backlog
        // entries are not a durable request-id dedup ledger.
        if (this.active.has(q.requestId)) continue;
        this.noteAdmitted(q.requestId);
        this.backlog.push(q); this.runBacklog();
      }
      // A previously saturated reply lane may have recovered with no new jobs.
      this.runBacklog();
      this.lastPolledAt = Date.now(); polled = true;
    } catch (e) {
      this.pendingAcks.unshift(...acks);
      if (authError(e)) this.rejectCredential(pollChannel);
      // Failed poll never re-executes an admitted request.
    } finally {
      this.pollBusy = false;
      this.onPollIdle?.();
      if (this.closeDrained) void this.drainOnClose();
      // Official pollOnce loops at once while acks are pending or the page was full
      // (D:L178459–178557), so a burst (e.g. 64 cancels) is drained in back-to-back polls, not one
      // page per safety-poll tick. Only once the provider loop is running (pollTimer).
      const drain = polled && this.pollTimer !== undefined && !this.closed && !this.closing && this.pendingAcks.length > 0;
      if (!this.closing && (this.pollAgain || drain)) { this.pollAgain = false; setTimeout(() => void this.pollOnce().catch(() => undefined), drain ? 0 : 25); }
    }
  }
  /**
   * Official superviseBacklog (daemon.formatted.cjs L178589–178599):
   * age > 15s → drain backlog with A9 closing text; age >= 5s → nudge poll.
   * Exposed for regressions (clock injectable via nowMs).
   */
  superviseBacklog(nowMs = Date.now()): void {
    if (this.backlog.length === 0 || this.closed || this.closing) return; // D:178589
    if (this.lastPolledAt <= 0) return;
    const age = nowMs - this.lastPolledAt;
    if (age > UC_BACKLOG_STALE_MS) {
      // Items whose closing reply cannot be held yet stay in the backlog (still held and keepalived)
      // and are drained on a later tick.
      const drained = this.backlog.splice(0, this.backlog.length);
      for (const q of drained) if (!this.storeClosing(q, UC_BACKLOG_CLOSED_BEFORE_START)) this.backlog.push(q);
    } else if (age >= UC_BACKLOG_NUDGE_MS) {
      void this.pollOnce().catch(() => undefined);
    }
  }

  noteAdmitted(requestId: string, now = performance.now()): void {
    this.keepAliveDueAt.set(requestId, now + UC_KEEPALIVE_ADMIT_MS);
  }
  noteHeard(requestIds: Iterable<string>, now = performance.now()): void {
    for (const id of requestIds) this.keepAliveDueAt.set(id, now + UC_KEEPALIVE_HEARD_MS);
  }
  private heldRequestIds(): Set<string> {
    const held = new Set<string>(this.active);
    for (const q of this.backlog) held.add(q.requestId);
    for (const id of this.replies?.requestIds() ?? []) held.add(id);
    for (const id of this.replies?.submitting ?? []) held.add(id);
    for (const f of this.pendingClosings) held.add(f.requestId);
    return held;
  }
  /** Official keepAliveEligibleIds: backlog, queued replies, and a submitting batch unless stuck ≥120s; minus cancelled. Running requests with nothing queued are not eligible. */
  keepAliveEligibleIds(now: number): Set<string> {
    const out = new Set<string>();
    for (const q of this.backlog) out.add(q.requestId);
    const submitting = this.replies?.submitting ?? [];
    const stuck = submitting.length > 0 && now - (this.replies?.submittingSince ?? now) >= UC_KEEPALIVE_STUCK_SUBMIT_MS;
    const stuckIds = new Set(stuck ? submitting : []);
    for (const id of this.replies?.requestIds() ?? []) if (!stuckIds.has(id)) out.add(id);
    if (!stuck) for (const id of submitting) out.add(id);
    // Deferred closing replies are queued replies not yet in the lane (official: replies.requestIds()).
    for (const f of this.pendingClosings) out.add(f.requestId);
    for (const id of this.cancelledIds) out.delete(id);
    return out;
  }
  /** Official sendKeepAlives (daemon.formatted.cjs L178625–178661): messagesAccepted frames only. */
  async sendKeepAlives(now = performance.now()): Promise<string[]> {
    const ch = this.channel;
    if (!ch || !this.proven || this.closed || this.closing || this.keepAliveSending) return [];
    const held = this.heldRequestIds();
    for (const id of [...this.keepAliveDueAt.keys()]) if (!held.has(id)) this.keepAliveDueAt.delete(id);
    for (const id of [...this.cancelledIds]) if (!held.has(id)) this.cancelledIds.delete(id);
    if (now < this.keepAlivePausedUntil) return [];
    const ids = selectKeepAliveIds(this.keepAliveDueAt, this.keepAliveEligibleIds(now), now);
    if (ids.length === 0) return [];
    this.keepAliveSending = true;
    try {
      await this.client.submitGrokBotUserComputerResponses(new SubmitGrokBotUserComputerResponsesRequest({
        machineId: ch.machineId, credential: ch.credential,
        frames: ids.map(requestId => new GrokBotUserComputerResponseFrame({ requestId,
          frame: { case: "messagesAccepted", value: new GrokBotUserComputerMessagesAccepted() } })),
      }), { timeoutMs: UC_KEEPALIVE_SUBMIT_DEADLINE_MS });
      this.noteHeard(ids);
    } catch (error) {
      if (authError(error)) this.rejectCredential(ch);
      else if (error instanceof ConnectError && error.code === Code.ResourceExhausted) {
        this.keepAlivePausedUntil = performance.now() + UC_KEEPALIVE_EXHAUSTED_PAUSE_MS;
      }
    } finally { this.keepAliveSending = false; }
    return ids;
  }

  /**
   * Closing replies (busy / cancelled-before-start / backlog drained / parse error / unsupported).
   * A closing reply is either held by the reply lane (`offer`, sync) or, while the lane is full, by a
   * bounded deferral list retried in order from the keepalive tick. If neither can hold it the caller
   * keeps the work retryable (queue item left unacknowledged, backlog item kept, job retries):
   * a terminal frame is never dropped after its queue item was acknowledged.
   */
  private closingFrame(q: Queued, error: string): ExecFrameOut {
    if ([requestKinds.upload, requestKinds.download, requestKinds.discoverAiTool].includes(q.kind)) return { kind: "file-error", requestId: q.requestId, error };
    // D:zl 136457–136464: draft-card messages-op closing errors use the Fpt code (fallback: the text itself).
    // D:zl 136465–136470: local-tool closing → local-tool-result failed.
    if (q.kind === requestKinds.localTool) return { kind: "local-tool-result", requestId: q.requestId, outcome: { status: "failed", error } };
    if (q.kind === requestKinds.messagesOp) return { kind: "messages-error", requestId: q.requestId,
      error: q.messages?.draftCard === true ? (draftCardCodes(NEVER_MSG, ASK_MSG).get(error) ?? error) : error };
    return { kind: "control", requestId: q.requestId, message: { throw: { id: 0, error } } };
  }
  private storeClosing(q: Queued, error: string): boolean { return this.storeClosingFrame(this.closingFrame(q, error)); }
  /** Same as storeClosing (name kept for regressions/probes); returns whether the reply is held. */
  private emitClosing(q: Queued, error: string): boolean { return this.storeClosing(q, error); }
  private storeClosingFrame(frame: ExecFrameOut): boolean {
    if (this.closed) return false;
    if (!this.pendingClosings.length && this.offerFrame(frame)) return true;
    if (this.closingRoom() <= 0 || this.pendingClosingBytes + closingCost(frame.requestId) > UC_PENDING_CLOSINGS_MAX_BYTES) return false;
    this.deferClosing(frame); return true;
  }
  /** True iff the deferral alone (lane not counted) can hold every frame by count and actual byte cost. */
  private canHoldClosings(frames: ExecFrameOut[]): boolean {
    if (this.closed) return false;
    const bytes = this.pendingClosings.reduce((n, f) => n + closingCost(f.requestId), 0) + frames.reduce((n, f) => n + closingCost(f.requestId), 0);
    return this.pendingClosings.length + frames.length <= UC_PENDING_CLOSINGS_MAX && bytes <= UC_PENDING_CLOSINGS_MAX_BYTES;
  }
  private deferClosing(frame: ExecFrameOut): void { this.pendingClosings.push(frame); this.pendingClosingBytes += closingCost(frame.requestId); }
  /** Free deferral slots (the lane itself may hold more; this is the guaranteed part). */
  private closingRoom(): number {
    // Recomputed from the list so tests/probes that replace it stay consistent.
    this.pendingClosingBytes = this.pendingClosings.reduce((n, f) => n + closingCost(f.requestId), 0);
    return Math.max(0, Math.min(UC_PENDING_CLOSINGS_MAX - this.pendingClosings.length,
      Math.floor((UC_PENDING_CLOSINGS_MAX_BYTES - this.pendingClosingBytes) / closingCost("x".repeat(64)))));
  }
  private offerFrame(frame: ExecFrameOut): boolean {
    const ch = this.channel; const r = this.replies;
    if (!r || (!ch && !(r instanceof UcReplyLanes))) return false;
    if (typeof r.offer === "function") return r.offer(Buffer.from(new SubmitGrokBotUserComputerResponsesRequest({
      machineId: ch?.machineId ?? "", credential: ch?.credential ?? "", frames: responseFrames(frame) }).toBinary()), [frame.requestId]);
    // Minimal stubs without offer(): fall back to emit; a rejection re-defers (bounded).
    let p: Promise<void>;
    try { p = Promise.resolve(this.emit(frame)); } catch (e) { p = Promise.reject(e); }
    p.catch(() => { if (!this.closed && this.closingRoom() > 0) this.deferClosing(frame); });
    return true;
  }
  /** Leave a polled queue item unacknowledged so the server redelivers it. */
  private unack(q: Queued): void {
    this.unackedWaiting = true;
    this.seen.delete(q.id);
    const i = this.pendingAcks.lastIndexOf(q.id); if (i >= 0) this.pendingAcks.splice(i, 1);
  }
  /** Retry deferred closing replies in order while the lane accepts them. */
  private flushClosings(): void {
    while (this.pendingClosings.length && !this.closed && this.offerFrame(this.pendingClosings[0])) { const f = this.pendingClosings.shift()!; this.pendingClosingBytes -= closingCost(f.requestId); }
    // Items left unacknowledged for lack of room are fetched again by one poll as soon as room exists
    // (event-driven; there is no fast poll timer, official polls on Watch events + 30 s safety poll).
    if (this.unackedWaiting && this.closingRoom() > 0 && !this.closed) { this.unackedWaiting = false; void this.pollOnce().catch(() => undefined); }
  }
  /** Official rejectCredential(e): only the channel that is still current may be closed. */
  private rejectCredential(ch: { credential: string } | null): void {
    // D:178423–178428: only the current channel; aborts the running Watch (if any) so it ends "unauthorized".
    if (!ch || this.channel !== ch) return;
    this.proven = false; this.credentialRejected = true; this.abortController?.abort();
  }
  /** D:rehello 178421: mark the Watch ending as "lifetime" and abort the running Watch (never tasks). */
  private rehello(): void { this.rehelloRequested = true; this.abortController?.abort(); }
  private credentialRejected = false;
  private rehelloRequested = false;

  private runBacklog(): void {
    while (!this.closed && !this.closing && this.active.size < UC_INFLIGHT_MAX && this.backlog.length && this.replies?.available) {
      const q = this.backlog.shift()!;
      if (this.active.has(q.requestId)) continue;
      this.active.add(q.requestId); this.bump(1); trace("admit", { rid: q.requestId.slice(0, 16) });
      const job = this.handleQueued(q).catch(e => q.kind === requestKinds.messagesOp || q.kind === requestKinds.localTool
        ? this.emit(this.closingFrame(q, e instanceof Error ? e.message : String(e)))
        : requestError(q.requestId, lastAllocatedExecIdOrZero(), e, this.emit, { root: this.opts.root, serverMessage: q.serverMessage }))
        .catch(() => { console.error("[user-computer-provider] request reply failed"); })
        .then(() => undefined).finally(() => { this.activeJobs.delete(job); this.active.delete(q.requestId); this.bump(-1); if (this.active.size === 0) this.onInflightDrained?.(); this.runBacklog(); });
      this.activeJobs.add(job);
    }
  }
  private startRetire(approvalId: string): void {
    const root = dataRootFromEnv();
    const job = retireApproval(approvalId, approvalsPathFor(root), retirementsPathFor(root))
      .catch(() => console.error("[user-computer-provider] failed to retire approval"))
      .finally(() => { this.retireJobs.delete(job); });
    this.retireJobs.add(job);
  }
  /** Test hook: wait for pending retire-approval writes. */
  async settleRetirements(): Promise<void> { await Promise.all([...this.retireJobs]); }
  private async handleQueued(q: Queued): Promise<void> {
    if (q.kind === requestKinds.upload) {
      // D:135989–136004 / 136374–136382: write-file auth, size check, n9, approximate cp, empty file success.
      const live = loadSettingsSync(), dataRoot = dataRootFromEnv();
      const refusal = await uploadRefusal({
        file: q.path ?? "", permission: live.permission, ceiling: live.settings.localToolPermissionCeiling,
        serverAuthoritative: this.serverAuthoritative, accountScope: this.opts.accountScope,
        approvalId: q.approvalId, authorization: q.authorization ?? { kind: "none" },
        terminalsFolder: this.opts.hello.terminalsFolder,
        approvalsPath: approvalsPathFor(dataRoot), retirementsPath: retirementsPathFor(dataRoot),
      });
      if (refusal !== undefined) { await this.emit({ kind: "file-error", requestId: q.requestId, error: refusal }); return; }
      try {
        await writeUploadFile(this.opts.root, q.path ?? "", q.bytes ?? new Uint8Array());
        await this.emit({ kind: "file", requestId: q.requestId });
      } catch (error) {
        await this.emit({ kind: "file-error", requestId: q.requestId, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (q.kind === requestKinds.discoverAiTool && q.source !== undefined) {
      // D:135989–136024: k6r→pJe read-ai-tool-setup on the product label; file-error refusal; VJe JSON as file bytes.
      const live = loadSettingsSync(), dataRoot = dataRootFromEnv();
      const refusal = await discoverAiToolRefusal({
        target: describeAiToolDiscovery(q.source).target, permission: live.permission, ceiling: live.settings.localToolPermissionCeiling,
        serverAuthoritative: this.serverAuthoritative, accountScope: this.opts.accountScope,
        approvalId: q.approvalId, authorization: q.authorization ?? { kind: "none" },
        terminalsFolder: this.opts.hello.terminalsFolder,
        approvalsPath: approvalsPathFor(dataRoot), retirementsPath: retirementsPathFor(dataRoot),
      });
      if (refusal !== undefined) { await this.emit({ kind: "file-error", requestId: q.requestId, error: refusal }); return; }
      let frame: ExecFrameOut;
      try { frame = { kind: "file", requestId: q.requestId, bytes: await discoverAiToolBytes(q.source, { configDirs: this.aiToolConfigDirs }) }; }
      catch (error) { frame = { kind: "file-error", requestId: q.requestId, error: error instanceof Error ? error.message : String(error) }; }
      await this.emit(frame);
      return;
    }
    if (q.kind === requestKinds.download) {
      // D:135989–136009: same authorization as exec, but read-file description and file-error refusal.
      const live = loadSettingsSync(), dataRoot = dataRootFromEnv();
      const refusal = await downloadRefusal({
        file: q.path ?? "", permission: live.permission, ceiling: live.settings.localToolPermissionCeiling,
        serverAuthoritative: this.serverAuthoritative, accountScope: this.opts.accountScope,
        approvalId: q.approvalId, authorization: q.authorization ?? { kind: "none" },
        terminalsFolder: this.opts.hello.terminalsFolder,
        approvalsPath: approvalsPathFor(dataRoot), retirementsPath: retirementsPathFor(dataRoot),
      });
      if (refusal !== undefined) { await this.emit({ kind: "file-error", requestId: q.requestId, error: refusal }); return; }
      try {
        const chunks = await prepareDownload(this.opts.root, q.path ?? "");
        if (!(this.replies instanceof UcReplyLanes)) { chunks.close(); throw new Error("Attached file source requires UC reply lanes"); }
        // Original non-exec branch has no post-authorization cancelled check (unlike exec).
        this.replies.stream(q.requestId, chunks);
      } catch (error) { await this.emit({ kind: "file-error", requestId: q.requestId, error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (q.kind === requestKinds.localTool && q.localTool !== undefined) {
      // D:v_.handle 135984–135987 → withInflight → handleLocalTool; r.cancel is wired for the cancel path.
      const entry = { cancelled: this.cancelledIds.has(q.requestId), cancel: () => {} };
      this.localToolEntries.set(q.requestId, entry);
      try {
        await handleLocalTool(q.requestId, q.localTool, entry, f => this.pushFrame(f), this.computerUse, {
          tools: this.deviceTools,
          // D:isDeviceToolBlocked → TUe 81514: effective permission or ceiling "never" → Xh.
          blocked: async () => { const d = this.messagesDecisionInput(); return d.permission === "never" || d.ceiling === "never" ? NEVER_MSG : undefined; },
        });
      }
      finally { this.localToolEntries.delete(q.requestId); }
      return;
    }
    if (q.kind === requestKinds.messagesOp && q.messages !== undefined) {
      // D:v_.handle 135974–135983 → shared executor (withSendKey → replayedSend → handleMessagesOp).
      const entry = { get cancelled() { return self.cancelledIds.has(q.requestId); } };
      const self = this;
      await this.messages.handle(q.messages, entry, f => this.pushFrame(f));
      return;
    }
    if (q.kind !== requestKinds.exec) {
      // Frozen oracle dispatch maps unimplemented outer variants to an error.
      // Full variant-specific payloads remain a documented gap (not silent success).
      const error = "This computer's local-exec daemon does not understand that request frame; update the desktop app.";
      // An admitted job: wait (bounded by the job's own slot) until its terminal frame is held.
      while (!this.closed && !this.storeClosing(q, error)) await new Promise(r => setTimeout(r, UC_KEEPALIVE_INTERVAL_MS));
      return;
    }
    // t117u: exec approval chain (src/uc/approvals.ts) — server flags only on a serverAuthoritative channel,
    // local approvals file + retirements + 1h recordedAtMs expiry + Yce. Discover-ai-tool and other request kinds stay unimplemented.
    // Official re() (D:L179276–179288) calls N.getLocalToolPermission() → load() → readFileSync (L82881/L82271/pue)
    // synchronously inside startRequest, before its first await (v_.handle L135963 → withInflight L136032 →
    // handleExecRequest L136309–136318 have no earlier await). Same here: one synchronous read per request, so execs
    // reach allocateExecId in admission order without any chain, cache or shared promise (t108u).
    const live = loadSettingsSync();
    const dataRoot = dataRootFromEnv();
    const terminalsFolder = this.opts.hello.terminalsFolder;
    // t110u: official `let i = await this.options.isLocalUseBlocked?.(...)` (D:L136318) — every request of a Poll
    // batch reads its permission synchronously first; exec id + heartbeat arm follow only after this await
    // (nextExecId++ L136332 → wE.handle h() L98140). Then `if (r.cancelled) { n(O6r(s)); return; }` (L136328–136331,
    // O6r L136419 = streamClose{id:0}): a cancel that landed meanwhile never starts the exec.
    // t117u: the await is now the AUe decision itself (official awaits isLocalUseBlocked → AUe → Qce).
    const refusal = await execRefusal({
      permission: live.permission,
      ceiling: live.settings.localToolPermissionCeiling,
      serverAuthoritative: this.serverAuthoritative,
      accountScope: this.opts.accountScope,
      approvalId: q.approvalId,
      authorization: q.authorization ?? { kind: "none" },
      describes: describeExec(q.serverMessage, terminalsFolder),
      terminalsFolder,
      approvalsPath: approvalsPathFor(dataRoot),
      retirementsPath: retirementsPathFor(dataRoot),
    });
    // t112u: official order after that await (D:L136324–136332): (1) blocked → `n(x9({requestId, error}))`, x9
    // (L136410) = control throw{id:0,error}, no exec id consumed; (2) cancelled → O6r; (3) nextExecId++.
    // AUe (L81503) / Qce (L81473): see approvals.ts. Text: NEVER_MSG = Xh (L81193), ASK_MSG = i5 (L81199).
    if (refusal !== undefined) {
      await this.emit({ kind: "control", requestId: q.requestId, message: { throw: { id: 0, error: refusal } } });
      return;
    }
    // Our guard (official stop path not mapped): stop() cancels only registered shells, so a stop landing in this
    // await also ends the request here instead of spawning after shutdown.
    if (this.cancelledIds.has(q.requestId) || this.stopped) {
      await this.emit({ kind: "control", requestId: q.requestId, message: { streamClose: { id: 0 } } });
      return;
    }
    await dispatchExec({ root: this.opts.root, requestId: q.requestId,
      // Authorised once above (as official: no second permission gate inside the exec handlers).
      // Approval does not reach back: a later retire/revoke never stops an exec already running (official).
      serverMessage: q.serverMessage, permission: "always", pullOutput: true, emit: frame => {
        if (this.replies instanceof UcReplyLanes) {
          // Original UC enqueue is synchronous push + flush, not a Promise for Submit success.
          this.replies.push(responseFrames(frame));
          void this.replies.flush();
          return;
        }
        return this.emit(frame); // Existing public async Emit/test-double contract.
      } });
  }

  /** Same enqueue as exec frames: synchronous lane push + flush (D:enqueue → replies.push(Y_(t))). */
  private pushFrame(frame: ExecFrameOut): void | Promise<void> {
    if (this.replies instanceof UcReplyLanes) { this.replies.push(responseFrames(frame)); void this.replies.flush(); return; }
    return this.emit(frame);
  }
  /** D:UL computer-use (Linux: no helper). */
  private computerUse = new ComputerUse();
  private get deviceTools(): DeviceTools {
    return this.opts.deviceTools ??= createDeviceTools({ rootDir: () => dataRootFromEnv(), log: m => console.error(`[local-exec-daemon] ${m}`) });
  }
  private localToolEntries = new Map<string, { cancelled: boolean; cancel: () => void }>();
  /** One v_ per UC provider (D:Ve 179353–179365): decideLocalUse = Qce, isLocalUseBlocked = AUe via re(Y, accountScope, SA). */
  private messages = new MessagesExecutor({
    capabilities: () => { const m = messagesSettings(loadSettingsSync()); return messagesCapabilities(m.enabled, { read: m.read, send: m.send }); },
    isLocalUseBlocked: async t => await execRefusal({ ...this.messagesDecisionInput(), approvalId: t.approvalId, authorization: t.authorization, describes: t.describes }),
    decideLocalUse: async t => {
      const v = await decideExecLocalUse({ ...this.messagesDecisionInput(), approvalId: t.approvalId, authorization: t.authorization, describes: t.describes });
      return v.kind === "refused" ? { kind: "refused", reason: v.error } : v;
    },
    sidecar: () => (this.opts.sidecar ?? locateSidecar)(),
  }, draftCardCodes(NEVER_MSG, ASK_MSG));
  private messagesDecisionInput() {
    const live = loadSettingsSync(), dataRoot = dataRootFromEnv();
    return { permission: live.permission, ceiling: live.settings.localToolPermissionCeiling, messagesEnabled: messagesSettings(live).enabled,
      serverAuthoritative: this.serverAuthoritative, accountScope: this.opts.accountScope, terminalsFolder: this.opts.hello.terminalsFolder,
      approvalsPath: approvalsPathFor(dataRoot), retirementsPath: retirementsPathFor(dataRoot), standingGrantsPath: standingGrantsPathFor(dataRoot) };
  }

  /**
   * D:hello 178137–178175: the provider itself builds every capabilities field on each Watch; nothing comes from the
   * caller. i = executor.messages.available() (Dpt → y5, the sidecar lookup); u = computerUse non-empty or a device
   * tool offering app consent. Always present: messagesOpGeneration gE=4 (D:97145), aiToolSetup true, mobileLocalTools.
   */
  private withLocalToolCapabilities(_base: Record<string, unknown> | undefined, lt: Awaited<ReturnType<typeof localToolsSnapshot>>): Record<string, unknown> {
    const i = (this.opts.sidecar ?? locateSidecar)() !== undefined;
    const c = helloLocalToolCapabilities(lt, this.deviceTools);
    return {
      ...(i ? { messagesOp: true } : {}),
      ...(i || c.consent ? { localStandingGrants: true } : {}),
      messagesOpGeneration: 4,
      aiToolSetup: true,
      mobileLocalTools: c.mobileLocalTools,
      ...(c.consent ? { localToolAppConsent: true, localToolGrantSeen: true } : {}),
      ...(c.helperName === undefined ? {} : { localToolHelperName: c.helperName }),
    };
  }
  private helloedLocalTools?: string;
  /**
   * D:watch 178342–178420. Reason classification:
   * - l(): closed → "closed"; credentialRejected → "unauthorized"; renewRequested → "network-change" (never set here:
   *   this port has no network-change renewal); rehelloRequested → "lifetime"; a fired watchdog → "silent" after
   *   connected, else "stall".
   * - Normal end → l() ?? "lifetime". On a throw: l() if set; Connect Canceled → "stall"; otherwise log
   *   `watch stream failed: xt` and rethrow, so the runLoop sees Unauthenticated → "unauthorized", else "error"
   *   (D:178247–178256).
   * - Watchdogs xh (unref'd): connect e9r = 35 s armed at dial; silence t9r = 15 s after connected. Every event kicks.
   */
  private watchHeardAfterConnected = false;
  private loopWake = new AbortController();
  /** Unref'd backoff sleep (Pu/qr timers do not hold the loop) that ends early on close/stop. */
  private loopSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const sig = this.loopWake.signal;
      if (sig.aborted) return resolve();
      const done = () => { clearTimeout(t); sig.removeEventListener("abort", done); resolve(); };
      const t = setTimeout(done, ms); t.unref();
      sig.addEventListener("abort", done, { once: true });
    });
  }
  /** D:sleepUnlessBackendReturns 178334–178341: a backoff sleep that a backend return (after a failure/silence) cuts short. */
  private async sleepUnlessBackendReturns(ms: number): Promise<void> {
    const armed = this.backendReturn.arm();
    try {
      await new Promise<void>(resolve => {
        const sigs = [armed.signal, this.loopWake.signal];
        if (sigs.some(x => x.aborted)) return resolve();
        const done = () => { clearTimeout(t); for (const x of sigs) x.removeEventListener("abort", done); resolve(); };
        const t = setTimeout(done, ms); t.unref();
        for (const x of sigs) x.addEventListener("abort", done, { once: true });
      });
    } finally { armed.dispose(); }
  }
  /** D:noteBackendReturn 178292–178294 */
  noteBackendReturn(): void { this.backendReturn.noteBackendReturn(); }
  /** D:noteNetworkChange 178295–178313 (cooldown n9r = 30 s, D:177839 / 177950). */
  noteNetworkChange(): void {
    if (this.networkRenewalHold !== undefined) { this.networkChangeDeferred = true; return; }
    const t = setTimeout(() => {
      this.networkRenewalHold = undefined;
      if (!this.networkChangeDeferred || this.closed) return;
      this.networkChangeDeferred = false; this.noteNetworkChange();
    }, UC_NETWORK_RENEWAL_COOLDOWN_MS);
    t.unref();
    this.networkRenewalHold = { dispose: () => clearTimeout(t) };
    if (this.abortController !== undefined) { this.renewRequested = true; this.abortController.abort(); return; }
    if (this.channel) this.renew(this.channel, "network-change");
    this.backendReturn.noteBackendReturn();
  }
  /** D:178314–178318 */
  private renew(ch: ResolvedUcChannel, cause: string): void {
    this.pollAbort?.abort();
    this.client = this.makeClient(ch.backendUrl);
    this.opts.onLoopEvent?.({ kind: "renewed", cause });
  }
  private async watchLoop(hello: UserComputerHello, onConnected?: () => void): Promise<string> {
    try { return await this.watchOnce(hello, onConnected); }
    catch (error) {
      this.backendReturn.noteFailure(error); // D:178252
      return error instanceof ConnectError && error.code === Code.Unauthenticated ? "unauthorized" : "error";
    }
  }
  private async watchOnce(hello: UserComputerHello, onConnected?: () => void): Promise<string> {
    const ch = this.channel!;
    this.proven = false;
    const s = new AbortController();
    // D:178347–178351: abortController = s; credentialRejected/rehelloRequested/renewRequested/heard reset.
    this.abortController = s;
    this.credentialRejected = false; this.rehelloRequested = false; this.renewRequested = false; this.watchHeardAfterConnected = false;
    let o = false, i = false;
    const fire = () => { i = true; s.abort(); };
    const watchdog = (ms: number) => {
      let t: NodeJS.Timeout | undefined;
      const arm = () => { clearTimeout(t); t = setTimeout(fire, ms); t.unref(); };
      arm();
      return { kick: arm, dispose: () => clearTimeout(t) };
    };
    let u = watchdog(UC_WATCH_CONNECT_IDLE_MS);
    const l = (): string | undefined => {
      if (this.closed || this.watchStopped) return "closed";
      if (this.credentialRejected) return "unauthorized";
      if (this.renewRequested) return "network-change";
      if (this.rehelloRequested) return "lifetime";
      if (i) return o ? "silent" : "stall";
      return undefined;
    };
    try {
      const events = this.client.watchGrokBotUserComputerRequests({
        machineId: ch.machineId, credential: ch.credential, presenceToken: this.presenceToken,
        hello: GrokBotUserComputerHello.fromJsonString(JSON.stringify(hello)),
      }, {signal: s.signal});
      for await (const event of events) {
        if (o) this.watchHeardAfterConnected = true; // D:178381
        u.kick();
        if (event.event.case === "connected") {
          u.dispose(); u = watchdog(UC_WATCH_SILENCE_MS); o = true;
          onConnected?.(); // D:178249 r(): e = 1
          // Official (L178388–178403): proven, requestPoll, flush — flush wakes held replies once the new Watch is up.
          this.proven = true;
          this.opts.onLoopEvent?.({ kind: "connected" }); // D:178389
          // official connected → this.flush() (not a credential resume)
          const r = this.replies as { flush?: () => Promise<void> } | undefined;
          if (r && typeof r.flush === "function") void r.flush();
        }
        // D:178396–178404: connected/notify → requestPoll; heartbeat only when pendingRequestCount > 0.
        if (event.event.case === "connected" || event.event.case === "notify" ||
            (event.event.case === "heartbeat" && event.event.value.pendingRequestCount > 0)) {
          void this.pollOnce().catch(() => undefined);
        }
      }
      return l() ?? "lifetime";
    } catch (error) {
      const p = l();
      if (p !== undefined) return p;
      if (error instanceof ConnectError && error.code === Code.Canceled) return "stall";
      console.error(`[user-computer-provider] watch stream failed: ${describeError(error)}`);
      throw error;
    } finally {
      u.dispose(); if (this.abortController === s) this.abortController = undefined;
    }
  }
}
