/**
 * t196: ripgrep configuration + LocalLsExecutor tree build, ported from 0.79.3
 * (D = /workspace/grokbot-node-analysis-0793/daemon.formatted.cjs).
 *
 * In the shipped 0.79.3 App the module-level ripgrep path `Z2` (D:19015) is declared but never
 * assigned and `configureRipgrepPath` is not defined, so `nl()` (D:19007–19013) always throws and
 * ls answers LsResult.error. We keep that as the default (nothing auto-configures; no PATH probe,
 * no CURSOR_RIPGREP_PATH read — the original only ever *writes* that variable, in b0). If a caller
 * does `configureRipgrepPath()`, the code below follows the original success/timeout path.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { LsDirectoryTreeNode, LsDirectoryTreeNode_File } from "../generated/agent.v1_pb";
import { assertSandboxSupported, type InternalSandboxPolicy } from "./sandbox";

/** Exact text of nl() (D:19008–19011). */
export const RIPGREP_UNCONFIGURED =
  "Ripgrep path not configured. Call configureRipgrepPath() at startup.";

/** D:Z2 (19015). Never assigned in 0.79.3; only configureRipgrepPath() sets it here. */
let Z2: string | undefined;

/** The setter the nl() message names (absent from the 0.79.3 bundle). Stores the value as given, like Z2. */
export function configureRipgrepPath(p: string): void { Z2 = p; }
/** Current Z2 (undefined = unconfigured, the 0.79.3 App state). */
export function getRipgrepPath(): string | undefined { return Z2; }

/** D:nl 19007–19013. */
export function nl(): string {
  if (!Z2) throw new Error(RIPGREP_UNCONFIGURED);
  return Z2;
}

/** D:IGe 18976 (non-win32 branch). */
function IGe(t: NodeJS.ProcessEnv): string | undefined {
  const e = Object.keys(t).filter((r) => r.toLowerCase() === "path");
  if (e.length !== 0) return process.platform === "win32" ? (e.find((r) => r === "Path") ?? e[0]) : (e.find((r) => r === "PATH") ?? e[0]);
  return undefined;
}
/** D:pWt 18983. */
function pWt(t: NodeJS.ProcessEnv): string { const e = IGe(t); return e !== undefined ? (t[e] ?? "") : ""; }
/** D:mWt 18987. */
function mWt(t: NodeJS.ProcessEnv, e: string): NodeJS.ProcessEnv {
  const r = IGe(t) ?? (process.platform === "win32" ? "Path" : "PATH"), n = { ...t };
  for (const s of Object.keys(n)) if (s !== r && s.toLowerCase() === "path") delete n[s];
  n[r] = e;
  return n;
}
const fWt = ["/usr/local/bin", "/usr/bin", "/bin"];
/** D:hWt 18994. */
function hWt(t: NodeJS.ProcessEnv, e: string): NodeJS.ProcessEnv {
  const r = path.dirname(e);
  if (!r || r === ".") return t;
  let n = pWt(t).split(path.delimiter).filter(Boolean);
  if (n.length === 0 && process.platform !== "win32") n = fWt;
  return mWt(t, [r, ...n.filter((o) => o !== r)].join(path.delimiter));
}
/**
 * D:b0 19002–19005: when Z2 is an absolute path, prepend its dir to PATH and set CURSOR_RIPGREP_PATH.
 * The original applies it to every Ko() spawn (D:21095: shell snapshot/commands); unconfigured → identity.
 */
export function b0(t: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return !Z2 || !path.isAbsolute(Z2) ? t : { ...hWt(t, Z2), CURSOR_RIPGREP_PATH: Z2 };
}

/** D:Md 18901: env for Ud spawns (drops ELECTRON_RUN_AS_NODE, AGENT_HOST_DAEMON_*, SSH_CLIENT, SSH2_CLIENT). */
function Md(t?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _r, ...n } = t || process.env;
  for (const s of Object.keys(n)) if (s.startsWith("AGENT_HOST_DAEMON_")) delete n[s];
  for (const s of ["SSH_CLIENT", "SSH2_CLIENT"]) delete n[s];
  return n;
}

/**
 * D:Ud 20798 for the paths ls can take: non-insecure_none → the existing sandbox check (throws ol);
 * insecure_none → plain spawn with windowsHide (VKt 20816). The enableSharedBuildCache env merge
 * (CE 19166) and the spawnWorkload cgroup/cwd-hop wrapper (t$t 16797) are not ported (same as shell).
 */
function Ud(cmd: string, args: string[], opts: { cwd: string }, policy: InternalSandboxPolicy): ChildProcess {
  const env = Md(undefined);
  assertSandboxSupported(policy);
  return spawn(cmd, args, { ...opts, env, windowsHide: true });
}

/** D:_er (CURSOR_RIPWALK_THREADS, ger=2). */
function _er(t: NodeJS.ProcessEnv = process.env): number | undefined {
  const e = t.CURSOR_RIPWALK_THREADS?.trim();
  if (e !== undefined && e !== "") {
    const r = Number(e);
    if (Number.isInteger(r) && r >= 0) return r === 0 ? undefined : r;
  }
  return Math.min(2, os.availableParallelism());
}

/** D:j0e. */
function j0e(t: AbortSignal): { aborted: Promise<"aborted">; dispose(): void } {
  if (t.aborted) return { aborted: Promise.resolve("aborted"), dispose() {} };
  let e = () => {};
  const r = new Promise<"aborted">((n) => { e = () => n("aborted"); });
  t.addEventListener("abort", e, { once: true });
  return { aborted: r, dispose() { t.removeEventListener("abort", e); } };
}

/** D:yer 107400. */
function yer(signal: AbortSignal, args: string[], cwd: string, policy: InternalSandboxPolicy) {
  const s = Ud(nl(), args, { cwd }, policy), o: Buffer[] = [];
  s.stderr?.on("data", (u: Buffer) => { o.push(u); });
  const i = new Promise<number>((u, l) => { s.on("error", l); s.on("close", (d) => u(d ?? 0)); });
  i.catch(() => {});
  if (!s.stdout) throw new Error("No stdout from ripgrep process");
  const a = j0e(signal);
  return {
    stdout: s.stdout,
    processExit: i,
    stderr: () => Buffer.concat(o).toString(),
    aborted: a.aborted,
    dispose() { a.dispose(); s.kill(); },
  };
}

/** D:Eer — UTF-8 line batches. */
async function* Eer(t: AsyncIterable<Buffer | string>): AsyncGenerator<string[]> {
  const e = new StringDecoder("utf8");
  let r = "";
  for await (const n of t) {
    r += e.write(n as Buffer);
    const s = r.split("\n");
    r = s.pop() ?? "";
    if (s.length > 0) yield s;
  }
  r += e.end();
  if (r) yield [r];
}

/** D:PO 107298 / fer 107288. With the no-op ignore service the input is always [] → []. Only that case is ported. */
async function PO(t: string[]): Promise<string[]> {
  if (t.length > 0) throw new Error("cursor-ignore file expansion (fer/ler) not ported");
  return [];
}

export type KOOptions = {
  root: string; searchPaths?: string[]; includeGlobs?: string[]; excludeGlobs?: string[];
  caseSensitive?: boolean; cursorIgnoreFiles?: string[]; sandboxPolicy?: InternalSandboxPolicy;
  noIgnoreVcs?: boolean; followSymlinks?: boolean; source?: string;
};

/** D:kO 107439 (telemetry p6 is a no-op when no sink is installed, D:f6/z0e — not ported). */
export function kO(signal: AbortSignal, o: KOOptions): { lines: AsyncGenerator<string>; didTimeout: Promise<boolean> } {
  const { root: e, searchPaths: r = [], includeGlobs: n = [], excludeGlobs: s = [], caseSensitive: cs = false,
    cursorIgnoreFiles: i = [], sandboxPolicy: a = { type: "insecure_none" }, noIgnoreVcs: u = false, followSymlinks: l = false } = o;
  const f = ["--files", "--hidden", "--no-require-git", "--no-config", "--color=never"], p = _er();
  if (p !== undefined) f.push("--threads", String(p));
  if (l) f.push("--follow");
  if (u) f.push("--no-ignore-vcs");
  if (cs) f.push("--case-sensitive");
  for (const w of n) f.push("--iglob", w);
  for (const w of s) f.push("--iglob", `!${w}`);
  const m = r.length > 0 ? ["--", ...r] : [];
  let h = false, g!: (v: boolean) => void;
  const _ = new Promise<boolean>((w) => { g = w; });
  async function* y(): AsyncGenerator<string> {
    let R: ReturnType<typeof yer> | undefined;
    try {
      const T: string[] = [];
      for (const x of await PO(i)) T.push("--cursor-ignore", x);
      R = yer(signal, [...f, ...T, ...m], e, a);
      let b = 0;
      const A = Eer(R.stdout as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      e: for (;;) {
        const x = await Promise.race([A.next(), R.aborted]);
        if (x === "aborted") { h = true; g(true); break; }
        if (x.done) break;
        for (const k of x.value) {
          if (signal.aborted) { h = true; g(true); break e; }
          b++; yield k;
        }
      }
      if (!(b > 0) && !h) {
        const x = await R.processExit;
        if (x !== 0 && x !== 1) {
          const k = R.stderr();
          throw new Error(`Ripgrep failed (exit ${x}) with no results${k ? `: ${k}` : ""}`);
        }
      }
      if (!h) g(false);
    } finally {
      R?.dispose(); // her(w) disposal of the mer-registered yer resource
    }
  }
  return { lines: y(), didTimeout: _ };
}

/** D:er 15130 for an already-absolute path with no workspace (np's first step). */
function erNoRoot(t: string): string { return path.resolve(t); }
/** D:np 15136 — realpath of the longest existing prefix, rejoined; null on non-ENOENT errors. */
async function np(t: string): Promise<string | null> {
  const r = erNoRoot(t);
  let n = r;
  for (;;) {
    try {
      const s = await fs.promises.realpath(n);
      return path.resolve(s, path.relative(n, r));
    } catch (s) {
      if ((s instanceof Error && "code" in s ? (s as { code?: unknown }).code : undefined) !== "ENOENT") return null;
      const i = path.dirname(n);
      if (i === n) return r;
      n = i;
    }
  }
}
/** D:ml 107881. */
async function ml(t: string): Promise<string | null> {
  if (!path.isAbsolute(t)) return null;
  const e = await np(t);
  return e === null ? null : e;
}

/** D:t9 132442 — the ignore service Tft (D:132607) hands to the ls executor. Every method is a constant. */
export const noopIgnoreService = {
  isCursorIgnored(_e: string) { return Promise.resolve(false); },
  isRepoBlocked(_e: string) { return Promise.resolve(false); },
  listCursorIgnoreFilesByRoot(_e: string) { return Promise.resolve([] as string[]); },
  getRepoBlockExcludeGlobs(_e: string) { return Promise.resolve([] as string[]); },
};

/** D:Ts 123812 — int32 clamp. */
function Ts(t: number): number { return Number.isNaN(t) ? 0 : t < -2147483648 ? -2147483648 : t > 2147483647 ? 2147483647 : t; }

/** D:X4r / Q4r (LocalLsExecutor constants). */
export const LS_CHAR_BUDGET = 2500;
export const LS_DEFAULT_TIMEOUT_MS = 5000;

type Budget = { charactersUsed: number; budgetExceeded: boolean; overflowDir?: string; overflowChain?: LsDirectoryTreeNode[] };

/** D:addPathToTree (LocalLsExecutor). */
function addPathToTree(e: string, r: string, n: Map<string, LsDirectoryTreeNode>, s: Budget, o: number): void {
  const i = path.basename(e), a = path.dirname(e);
  ensureDirectoryPath(a, r, n, s.budgetExceeded);
  const u = n.get(a);
  if (!u) return;
  const l = i.length;
  if (!s.budgetExceeded && s.charactersUsed + l <= o) {
    u.childrenFiles.push(new LsDirectoryTreeNode_File({ name: i }));
    s.charactersUsed += l;
    return;
  }
  if (!s.budgetExceeded) {
    s.budgetExceeded = true;
    let p = a;
    while (p.startsWith(r)) {
      const m = n.get(p);
      if (m) m.childrenWereProcessed = false;
      const h = path.dirname(p);
      if (h === p) break;
      p = h;
    }
  }
  let d = s.overflowChain;
  if (s.overflowDir !== a || d === undefined) {
    d = [];
    let p = a;
    while (p.startsWith(r)) {
      const m = n.get(p);
      if (m) d.push(m);
      const h = path.dirname(p);
      if (h === p) break;
      p = h;
    }
    s.overflowDir = a; s.overflowChain = d;
  }
  const f = path.extname(e);
  for (const p of d) {
    p.fullSubtreeExtensionCounts[f] ??= 0;
    p.fullSubtreeExtensionCounts[f] = Ts(p.fullSubtreeExtensionCounts[f] + 1);
    p.numFiles ??= 0;
    p.numFiles = Ts(p.numFiles + 1);
  }
}

/** D:ensureDirectoryPath. */
function ensureDirectoryPath(e: string, r: string, n: Map<string, LsDirectoryTreeNode>, s: boolean): void {
  if (n.has(e) || e === r) return;
  const o = path.dirname(e);
  if (o !== e && o.startsWith(r)) ensureDirectoryPath(o, r, n, s);
  const i = new LsDirectoryTreeNode({ absPath: e, childrenDirs: [], childrenFiles: [], childrenWereProcessed: !s, fullSubtreeExtensionCounts: {} });
  n.set(e, i);
  const a = n.get(o);
  if (a) a.childrenDirs.push(i);
}

/** D:sortTreeChildren. */
function sortTreeChildren(e: LsDirectoryTreeNode): void {
  e.childrenDirs.sort((r, n) => path.basename(r.absPath).localeCompare(path.basename(n.absPath)));
  e.childrenFiles.sort((r, n) => r.name.localeCompare(n.name));
  for (const r of e.childrenDirs) sortTreeChildren(r);
}

/** D:buildTreeFromRipgrepStream (LocalLsExecutor). */
export async function buildTreeFromRipgrepStream(signal: AbortSignal, r: string, n: string[], s: InternalSandboxPolicy, o: number,
  ignoreService = noopIgnoreService): Promise<{ tree: LsDirectoryTreeNode; didTimeout: boolean }> {
  const u = path.resolve(r);
  const l = new LsDirectoryTreeNode({ absPath: u, childrenDirs: [], childrenFiles: [], childrenWereProcessed: true, fullSubtreeExtensionCounts: {} });
  const d = new Map<string, LsDirectoryTreeNode>();
  d.set(u, l);
  const f: Budget = { charactersUsed: u.length, budgetExceeded: false };
  const [p, m] = await Promise.all([ignoreService.listCursorIgnoreFilesByRoot(r), ignoreService.getRepoBlockExcludeGlobs(r)]);
  const h = [...n, ...m];
  const { lines: g, didTimeout: _ } = kO(signal, { root: r, excludeGlobs: h, caseSensitive: true, cursorIgnoreFiles: p, sandboxPolicy: s, source: "ls" });
  for await (const y of g) {
    if (!y) continue;
    const w = path.resolve(r, y), T = await ml(w);
    if (T === null || (await ignoreService.isCursorIgnored(T)) || (await ignoreService.isRepoBlocked(T))) continue;
    addPathToTree(w, u, d, f, o);
  }
  sortTreeChildren(l);
  return { tree: l, didTimeout: await _ };
}

/**
 * D:withTimeout 18402 — child signal aborted after `ms` ("context deadline exceeded"). The original never
 * clears the timer on success; we unref it so a finished ls cannot hold the process open (no other effect).
 */
export function withTimeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => { c.abort(new Error("context deadline exceeded")); }, ms);
  t.unref?.();
  c.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return c.signal;
}
