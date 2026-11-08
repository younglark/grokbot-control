/**
 * Exec approval chain — static port of local-exec-daemon 0.79.3 (daemon.formatted.cjs, D:).
 *
 * Scope (t117u): UserComputer `exec` only. Upload / download / discover-ai-tool / messages / local-tool,
 * standing grants (subject actions) and send-mail spending are NOT implemented here.
 *
 * What this module does NOT do (no evidence in the daemon bundle, so nothing is invented):
 *  - it never WRITES approval records (the writer is outside the daemon bundle; no self-grant API);
 *  - it verifies no signature, MAC or expiry on approval ids or on the server booleans;
 *    `authorized_by_*` are trusted only on a serverAuthoritative channel, exactly as D:L81473 Qce.
 *
 * Known original behaviours kept AS-IS (reported, not "fixed", per user instruction):
 *  - non-SA effective `never` without ceiling `never` still allows a matching approval (Qce/AUe);
 *  - a record without `recordedAtMs` never expires (xqt D:L81320);
 *  - Yce matches on resourcePath ⇄ attachToResourcePath across targets, and compares machineId
 *    which is undefined on both sides in practice (D:L81255);
 *  - non-SA approvals ignore accountScope (only SA checks it, D:L81489).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionMode } from "../settings";
import { NEVER_MSG, ASK_MSG } from "../exec/handlers";

/** D: WFt / KFt (L81062–81086). */
export const LOCAL_TOOL_ACTIONS = [
  "run-command", "send-input", "read-file", "list-directory", "write-file", "read-ai-tool-setup",
  "read-messages", "send-imessage", "run-phone-tool", "use-app", "send-mail",
] as const;
export type LocalToolAction = (typeof LOCAL_TOOL_ACTIONS)[number];
const ACTION_CLASS: Record<LocalToolAction, "global" | "setting" | "subject" | "call"> = {
  "run-command": "global", "send-input": "global", "read-file": "global", "list-directory": "global",
  "write-file": "global", "read-ai-tool-setup": "global", "read-messages": "setting",
  "send-imessage": "subject", "run-phone-tool": "call", "use-app": "subject", "send-mail": "call",
};
export function isAction(v: unknown): v is LocalToolAction {
  return typeof v === "string" && (LOCAL_TOOL_ACTIONS as readonly string[]).includes(v);
}
/** D: rI (L81060). */
export function actionClass(a: string): "global" | "setting" | "subject" | "call" {
  return isAction(a) ? ACTION_CLASS[a] : "subject";
}

/** D: c5 (L81276). Only meaningful on a serverAuthoritative channel. */
export type Authorization = { kind: "approval" } | { kind: "standing" } | { kind: "none" };
export function authorizationOf(v: { authorizedByApproval?: boolean; authorizedByStanding?: boolean }): Authorization {
  return v.authorizedByApproval ? { kind: "approval" } : v.authorizedByStanding ? { kind: "standing" } : { kind: "none" };
}

export type Describes = {
  action: LocalToolAction; target: string; resourcePath?: string; attachToResourcePath?: string;
  machineId?: string; outlivesScope?: boolean; targetKind?: string;
};
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** D: _qt (L81209). */
function isTerminalFile(p: string, folder: string): boolean {
  const r = norm(folder);
  if (r.length === 0) return false;
  const n = norm(p);
  if (!n.startsWith(`${r}/`)) return false;
  const s = n.slice(r.length + 1);
  return s.length > 0 && !s.includes("/") && s.endsWith(".txt");
}
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** D: fUe (L81219). Input is the ExecServerMessage JSON record (one oneof key). */
export function describeExec(sm: Record<string, unknown>, terminalsFolder: string): Describes | undefined {
  const obj = (k: string) => (sm[k] && typeof sm[k] === "object" ? (sm[k] as Record<string, unknown>) : undefined);
  let v: Record<string, unknown> | undefined;
  if ((v = obj("shellStreamArgs")) || (v = obj("backgroundShellSpawnArgs"))) {
    const bg = sm.backgroundShellSpawnArgs !== undefined || v.isBackground === true;
    return { action: "run-command", target: str(v.command), resourcePath: terminalsFolder, ...(bg ? { outlivesScope: true } : {}) };
  }
  if (obj("forceBackgroundShellArgs")) return {
    action: "run-command", target: "a command already running", targetKind: "command_already_running",
    attachToResourcePath: terminalsFolder, outlivesScope: true,
  };
  if ((v = obj("writeShellStdinArgs"))) return { action: "send-input", target: str(v.chars) };
  if ((v = obj("readArgs")) || (v = obj("redactedReadArgs"))) {
    const p = str(v.path);
    return { action: "read-file", target: p, ...(isTerminalFile(p, terminalsFolder) ? { attachToResourcePath: terminalsFolder } : {}) };
  }
  if ((v = obj("lsArgs"))) return { action: "list-directory", target: str(v.path) };
  return undefined;
}

export type ApprovalRecord = { id: string; action: LocalToolAction; target: string; resourcePath?: string; accountScope?: string; recordedAtMs?: number; machineId?: undefined };
/** D: Yce (L81255) — verbatim, including the known resourcePath / machineId behaviour. */
export function approvalMatches(t: { action: string; target: string; resourcePath?: string; machineId?: string }, e: Describes): boolean {
  if (t.machineId !== e.machineId) return false;
  if (t.action === e.action && t.target === e.target) return true;
  const l = (s?: string) => (s === undefined || s.length === 0 ? undefined : s.replace(/\\/g, "/"));
  const r = l(t.resourcePath), n = l(e.attachToResourcePath);
  return r !== undefined && r === n;
}

export const APPROVAL_TTL_MS = 3_600_000; // D: xqt 36e5
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** D: wqt (L81293). */
function parseRecord(v: unknown): ApprovalRecord | undefined {
  if (!isObj(v)) return undefined;
  const { id, action, target } = v;
  if (typeof id !== "string" || id.length === 0 || !isAction(action) || typeof target !== "string") return undefined;
  return {
    id, action, target,
    ...(typeof v.resourcePath === "string" ? { resourcePath: v.resourcePath } : {}),
    ...(typeof v.accountScope === "string" && v.accountScope.length > 0 ? { accountScope: v.accountScope } : {}),
    ...(typeof v.recordedAtMs === "number" && Number.isFinite(v.recordedAtMs) ? { recordedAtMs: v.recordedAtMs } : {}),
  };
}
/** D: SUe (L81323) + xqt. Undefined when `approvals` is not an array. */
export function parseApprovals(raw: unknown, nowMs: number): Map<string, ApprovalRecord> | undefined {
  const list = isObj(raw) ? raw.approvals : undefined;
  if (!Array.isArray(list)) return undefined;
  const out = new Map<string, ApprovalRecord>();
  for (const item of list) {
    const r = parseRecord(item);
    if (r !== undefined && !(r.recordedAtMs !== undefined && nowMs - r.recordedAtMs > APPROVAL_TTL_MS)) out.set(r.id, r);
  }
  return out;
}
/** D: yUe (L81337): every failure (missing, unreadable, malformed) → empty map, i.e. no approval. */
export async function readApprovals(file: string, nowMs = Date.now()): Promise<Map<string, ApprovalRecord>> {
  try { return parseApprovals(JSON.parse(await fs.promises.readFile(file, "utf-8")), nowMs) ?? new Map(); }
  catch { return new Map(); }
}
/** D: EUe (L81344). */
export async function readRetirements(file: string): Promise<Set<string>> {
  try {
    const raw: unknown = JSON.parse(await fs.promises.readFile(file, "utf-8"));
    const ids = isObj(raw) && Array.isArray(raw.retiredIds) ? raw.retiredIds : [];
    return new Set(ids.filter((x): x is string => typeof x === "string"));
  } catch { return new Set(); }
}
/** D: Rqt (L81428). */
export async function liveApprovals(approvalsPath: string, retirementsPath: string, nowMs = Date.now()): Promise<Map<string, ApprovalRecord>> {
  const r = await readApprovals(approvalsPath, nowMs);
  const n = await readRetirements(retirementsPath);
  if (n.size === 0) return r;
  const s = new Map(r);
  for (const id of n) s.delete(id);
  return s;
}

/** D: gUe (L81284) per-path in-process serialisation. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, p);
  try { return await p; } finally { if (locks.get(key) === p) locks.delete(key); }
}
/** Approximation of D: cp (L80591): write to a sibling temp file then rename (0600). Not byte-identical internals. */
async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, data, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}
/** D: wUe (L81351): add id, prune ids no longer present in approvals, rm when empty. No reply frame. */
export async function retireApproval(id: string, approvalsPath: string, retirementsPath: string, nowMs?: number): Promise<void> {
  await withLock(retirementsPath, async () => {
    const approvals = await readApprovals(approvalsPath, nowMs ?? Date.now());
    const s = new Set(await readRetirements(retirementsPath));
    if (s.has(id)) return;
    s.add(id);
    for (const o of [...s]) if (!approvals.has(o)) s.delete(o);
    if (s.size === 0) { await fs.promises.rm(retirementsPath, { force: true }); return; }
    await writeAtomic(retirementsPath, JSON.stringify({ retiredIds: [...s] }));
  });
}

export type ExecDecisionInput = {
  permission: PermissionMode;        // effective nI(permission, ceiling), as getLocalToolPermission() L82881
  ceiling?: PermissionMode;          // raw ceiling
  serverAuthoritative: boolean;      // from the channel descriptor, never from the request
  accountScope?: string;
  approvalId?: string;
  authorization: Authorization;
  describes?: Describes;
  terminalsFolder: string;
  approvalsPath: string;
  retirementsPath: string;
  nowMs?: number;
};
export type Verdict = { kind: "allow" } | { kind: "refused"; error: string } | { kind: "ask" };

/**
 * D: Qce (L81473) restricted to exec. fUe only yields global actions, so the setting / subject
 * branches (messagesEnabled, standing grants) are unreachable here; any non-global class is
 * treated as "ask" (fail closed, not extended).
 */
export async function decideExecLocalUse(t: ExecDecisionInput): Promise<Verdict> {
  const e = t.describes;
  const n = e === undefined ? "global" : actionClass(e.action);
  const s = t.serverAuthoritative === true;
  if (s) {
    if (t.authorization.kind === "approval" || (t.authorization.kind === "standing" && n === "global")) return { kind: "allow" };
  } else {
    if (t.ceiling === "never") return { kind: "refused", error: NEVER_MSG };
    if (t.permission === "always" && n === "global") return { kind: "allow" };
    if (t.permission === "never" && n !== "global") return { kind: "refused", error: NEVER_MSG };
  }
  if (n !== "global") return { kind: "ask" };
  if (t.approvalId == null || t.approvalId.length === 0 || e === undefined) return { kind: "ask" };
  const o = (await liveApprovals(t.approvalsPath, t.retirementsPath, t.nowMs)).get(t.approvalId);
  if (o === undefined || (s && (t.accountScope === undefined || o.accountScope !== t.accountScope))) return { kind: "ask" };
  return approvalMatches({ ...o, ...(o.action === "run-command" ? { resourcePath: t.terminalsFolder } : {}) }, e)
    ? { kind: "allow" } : { kind: "ask" };
}
/** D: AUe (L81503): undefined = allowed, else the refusal text. */
export async function execRefusal(t: ExecDecisionInput): Promise<string | undefined> {
  const v = await decideExecLocalUse(t);
  if (v.kind === "allow") return undefined;
  if (v.kind === "refused") return v.error;
  return !t.serverAuthoritative && t.permission === "never" ? NEVER_MSG : ASK_MSG;
}

/** D: MDe / NDe (L79817–79822) under Zn(); here under the same data root as settings.json. */
export function approvalsPathFor(dataRoot: string): string { return path.join(dataRoot, "local-tool-approvals.json"); }
export function retirementsPathFor(dataRoot: string): string { return path.join(dataRoot, "local-tool-retirements.json"); }
