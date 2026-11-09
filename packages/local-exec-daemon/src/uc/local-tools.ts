/** UC `local-tool` — port of v_.handleLocalTool (D:136131–136240) for what a Linux daemon can reach.
 * Device tools (location / ppt / Obsidian) and Mac Mail are absent on Linux (D:vft 132673 darwin-only, ppt 134878
 * `y()` false → mail()/helperName() undefined, Ipt 135418 gated by a host gate file + vault, see
 * docs/local-exec/local-tools-evidence.md). Computer use: UL (D:136514) with availableHelper → undefined on Linux
 * (Xpt 136712 non-darwin), so every valid call ends in BL.
 */
import { CANCELLED_BEFORE_START } from "../box/messages-op";
import { obsidianTools, type AnnouncedDeviceTool } from "./obsidian";

/** D:E5 84699 */
export const COMPUTER_USE_TOOLS = ["computer_screenshot", "computer_click", "computer_move", "computer_drag", "computer_type",
  "computer_key", "computer_scroll", "computer_wait", "computer_check_permissions", "computer_apps", "computer_resolve_app",
  "computer_app_state", "computer_set_value", "computer_app_action"] as const;
/** D:_b 79443 / ise 79499 */
export const MAC_SEND_MAIL = "mac_send_mail";
export const MAC_MAIL_ACCOUNTS = "mac_mail_accounts";
/** D:cse 79554 / hke 79556 */
export const MAIL_SEND_UNAVAILABLE = "mail_send_unavailable";
export const MAIL_ACCOUNTS_UNAVAILABLE = "mail_accounts_unavailable";
/** D:BL 135910 */
export const COMPUTER_USE_UNAVAILABLE = "Computer use is not available on this computer right now.";
/** D:B5e 135477 */
export function noSuchTool(t: string): string { return `This computer has no "${t}" tool.`; }
/** D:q6r 136493 — queue keepalive interval (hc, leading false). */
export const COMPUTER_USE_QUEUE_KEEPALIVE_MS = 60_000;

export type LocalToolCall = { toolId: string; inputJson: string; conversationId: string; approvalId?: string };
export type LocalToolOutcome =
  | { status: "done"; outputJson: string }
  | { status: "failed"; error: string }
  | { status: "needs_permission"; error?: string }
  | { status: "ask"; app: { bundleId: string; appName: string } };
export type LocalToolFrame =
  | { kind: "local-tool-accepted"; requestId: string; permissionGranted?: true }
  | { kind: "local-tool-permission-pending"; requestId: string; reason?: string }
  | { kind: "local-tool-result"; requestId: string; outcome: LocalToolOutcome };
export type Entry = { cancelled: boolean; cancel: () => void };
export type Clock = { schedule(ms: number, fn: () => void): { dispose(): void } };
const realClock: Clock = { schedule(ms, fn) { const t = setTimeout(fn, ms); t.unref(); return { dispose: () => clearTimeout(t) }; } };

type Parsed = { kind: "invalid"; error: string } | { kind: "valid"; toolId: string; arguments: Record<string, unknown>; conversationId: string };
/** D:ewr 136738–136765 */
export function parseComputerUseCall(t: LocalToolCall): Parsed {
  const e = COMPUTER_USE_TOOLS.find(n => n === t.toolId);
  if (e === undefined) return { kind: "invalid", error: `${t.toolId} is not a computer-use tool.` };
  if (t.conversationId.length === 0) return { kind: "invalid", error: "The call names no conversation to run it for." };
  let r: unknown; try { r = JSON.parse(t.inputJson); } catch { r = undefined; } // tn
  if (r === null) return { kind: "valid", toolId: e, arguments: {}, conversationId: t.conversationId };
  return r === undefined || typeof r !== "object" || Array.isArray(r)
    ? { kind: "invalid", error: `The ${e} arguments are not a JSON object.` }
    : { kind: "valid", toolId: e, arguments: r as Record<string, unknown>, conversationId: t.conversationId };
}

/** D:UL 136514–136611 (Linux-reachable part): one call at a time per conversation, onStillQueued keepalive while
 * waiting, then callNow → availableHelper undefined → BL.
 */
export class ComputerUse {
  private callLines = new Map<string, Promise<void>>();
  constructor(private readonly clock: Clock = realClock, private readonly availableHelper: () => Promise<unknown> = async () => undefined) {}
  async announcedTools(): Promise<string[]> { return (await this.availableHelper()) === undefined ? [] : [...COMPUTER_USE_TOOLS]; }
  async call(e: LocalToolCall, r: { signal: AbortSignal; onStillQueued: () => void }): Promise<LocalToolOutcome> {
    const n = parseComputerUseCall(e);
    if (n.kind === "invalid") return { status: "failed", error: n.error };
    return await this.oneCallAtATime(n.conversationId, r, () => this.callNow());
  }
  private async oneCallAtATime(e: string, r: { signal: AbortSignal; onStillQueued: () => void }, n: () => Promise<LocalToolOutcome>): Promise<LocalToolOutcome> {
    const s = this.callLines.get(e), o = s ?? Promise.resolve();
    let a = () => {};
    const i = new Promise<void>(res => { a = res; }), u = o.then(() => i);
    this.callLines.set(e, u);
    try {
      // D:hc(q6r, leading false): first keepalive after 60 s, then every 60 s after each completes.
      let ka: { dispose(): void } | undefined;
      let stopped = false;
      const arm = () => { if (!stopped) ka = this.clock.schedule(COMPUTER_USE_QUEUE_KEEPALIVE_MS, () => { r.onStillQueued(); arm(); }); };
      if (s !== undefined && !r.signal.aborted) arm();
      const d = await waitOrAbort(o, r.signal); // D:fwr
      stopped = true; ka?.dispose();
      return d ? await n() : { status: "failed", error: CANCELLED_BEFORE_START };
    } finally {
      a();
      void u.then(() => { if (this.callLines.get(e) === u) this.callLines.delete(e); });
    }
  }
  private async callNow(): Promise<LocalToolOutcome> {
    const helper = await this.availableHelper();
    if (helper === undefined) return { status: "failed", error: COMPUTER_USE_UNAVAILABLE };
    // NOT REACHABLE on Linux (readGate NLe + Xpt dev override only for sand-dev); not ported.
    return { status: "failed", error: COMPUTER_USE_UNAVAILABLE };
  }
}
function waitOrAbort(t: Promise<void>, e: AbortSignal): Promise<boolean> {
  if (e.aborted) return Promise.resolve(false);
  return new Promise(r => { const n = () => r(false); e.addEventListener("abort", n, { once: true }); void t.then(() => { e.removeEventListener("abort", n); r(true); }); });
}

/** D:handleLocalTool 136131–136240 with deviceTools = Ppt on Linux (offers nothing, mail undefined). */
/**
 * Linux shape of Ppt (D:135510–135612): location (vft) is darwin+sidecar only and the mac tool set (ppt) needs
 * supported(), so both are inert; only the Obsidian part (Ipt) can offer tools. consentApp → e.offers ? oke :
 * ppt.consentApp → undefined for every id here; mail/helperName → undefined.
 */
export type DeviceTools = {
  announced(): AnnouncedDeviceTool[];
  offers(toolId: string): boolean;
  consentApp(toolId: string): { bundleId: string; appName: string } | undefined;
  refresh(): Promise<void>;
  run(c: { toolId: string; inputJson: string; signal?: AbortSignal }): Promise<LocalToolOutcome>;
  helperName(): string | undefined;
};
export function createDeviceTools(t: { rootDir: () => string; readGate?: () => Promise<boolean>; log?: (m: string) => void }): DeviceTools {
  const o = obsidianTools(t);
  return {
    announced: () => [...o.announced()],
    offers: id => o.offers(id),
    consentApp: () => undefined,
    refresh: async () => { await Promise.all([o.refresh()]); },
    run: async c => (o.offers(c.toolId) ? await o.run(c) : { status: "failed", error: noSuchTool(c.toolId) }),
    helperName: () => undefined,
  };
}

/** D:C6r 2500 — localTools() races deviceTools.refresh() against this timer (NJe, unref'd qr timer). */
export const DEVICE_REFRESH_RACE_MS = 2500;
export type LocalToolsSnapshot = { computerUse: string[]; device: AnnouncedDeviceTool[] };
/** D:v_.localTools 135944–135955 */
export async function localToolsSnapshot(cu: ComputerUse, device: DeviceTools | undefined, clock: Clock = realClock): Promise<LocalToolsSnapshot> {
  const n = device?.refresh();
  let h: { dispose(): void } | undefined;
  const [s] = await Promise.all([
    cu.announcedTools(),
    n === undefined ? undefined : Promise.race([n, new Promise<void>(res => { h = clock.schedule(DEVICE_REFRESH_RACE_MS, res); })]),
  ]);
  h?.dispose();
  return { computerUse: s ?? [], device: device?.announced() ?? [] };
}
/** D:hello 178137–178175: mobileLocalTools and the consent flag u from a localTools() snapshot. */
export function helloLocalToolCapabilities(r: LocalToolsSnapshot, device: DeviceTools | undefined): {
  mobileLocalTools: { toolId: string; state: string; features: string[] }[]; consent: boolean; helperName?: string;
} {
  const u = r.computerUse.length > 0 || r.device.some(d => device?.consentApp(d.toolId) !== undefined);
  const l = device?.helperName();
  return {
    mobileLocalTools: [
      ...r.computerUse.map(d => ({ toolId: d, state: "ready", features: [] as string[] })),
      ...r.device.map(({ toolId, state, features }) => ({ toolId, state, features: [...(features ?? [])] })),
    ],
    consent: u,
    ...(l === undefined ? {} : { helperName: l }),
  };
}

export async function handleLocalTool(requestId: string, call: LocalToolCall, entry: Entry, n: (f: LocalToolFrame) => unknown, cu: ComputerUse,
  device?: { tools: DeviceTools; blocked: () => Promise<string | undefined> }): Promise<void> {
  const s = requestId, o = call.toolId;
  if (o === MAC_SEND_MAIL || o === MAC_MAIL_ACCOUNTS) {
    // D:Mpt 135625 → h6r (accounts: mail undefined → hke) / x6r 135728 (send: mail undefined → cse), both before accept.
    await n({ kind: "local-tool-result", requestId: s, outcome: { status: "failed", error: o === MAC_MAIL_ACCOUNTS ? MAIL_ACCOUNTS_UNAVAILABLE : MAIL_SEND_UNAVAILABLE } });
    return;
  }
  const i = device?.tools;
  if (i?.offers(o) === true) {
    // D:136170–136204: accepted → deviceToolConsent → cancelled? Gl → consent result → run with an abort signal.
    await n({ kind: "local-tool-accepted", requestId: s });
    let d: LocalToolOutcome | undefined;
    // D:deviceToolConsent 136240–136259: isDeviceToolBlocked (TUe) → consentApp (undefined on Linux → no ask).
    const refusal = await device!.blocked();
    if (refusal !== undefined) d = { status: "failed", error: refusal };
    if (entry.cancelled) { await n({ kind: "local-tool-result", requestId: s, outcome: { status: "failed", error: CANCELLED_BEFORE_START } }); return; }
    if (d !== undefined) { await n({ kind: "local-tool-result", requestId: s, outcome: d }); return; }
    const f = new AbortController();
    entry.cancel = () => f.abort();
    const p = await i.run({ toolId: o, inputJson: call.inputJson, signal: f.signal });
    await n({ kind: "local-tool-result", requestId: s, outcome: p });
    return;
  }
  if (!(COMPUTER_USE_TOOLS as readonly string[]).includes(o)) {
    await n({ kind: "local-tool-result", requestId: s, outcome: { status: "failed", error: noSuchTool(o) } });
    return;
  }
  await n({ kind: "local-tool-accepted", requestId: s });
  const a = new AbortController();
  entry.cancel = () => a.abort();
  if (entry.cancelled) a.abort();
  const l = await cu.call(call, { signal: a.signal, onStillQueued: () => void n({ kind: "local-tool-accepted", requestId: s }) });
  await n({ kind: "local-tool-result", requestId: s, outcome: l });
}
