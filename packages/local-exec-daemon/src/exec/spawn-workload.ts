/**
 * t198: the original's single spawn path for exec children, ported from 0.79.3
 * (D = /workspace/grokbot-node-analysis-0793/daemon.formatted.cjs):
 *
 *   Ko (D:21094–21095)  env = b0(r.env ?? process.env), then Ud
 *   Ud (D:20798–20812)  env = Md(env); enableSharedBuildCache → {...Md(process.env), ...CE(), ...env};
 *                       non-insecure_none → sandbox helper or ol; else VKt → spawnWorkload(spawn, …, windowsHide)
 *   Yn = t$t(ZUt(process.platform, process.env.CURSOR_WORKLOAD_CGROUP)) (D:16842–16845), computed once at load
 *   t$t (D:16797–16829) cgroup "armed" wrapper + FUSE cwd hop (_ae D:15327, CURSOR_SPAWN_CWD_HOP) + BNe oom_score_adj
 *
 * Only the ChildProcess branch of oDe/xae is ported (our only spawner is child_process.spawn, like VKt).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { spawn as cpSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { assertSandboxSupported, type InternalSandboxPolicy } from "./sandbox";
import { b0 } from "./ripgrep-path";

// ---- Md (D:18901–18907) ----
/** D:Md: drop ELECTRON_RUN_AS_NODE, AGENT_HOST_DAEMON_* (aWt), SSH_CLIENT / SSH2_CLIENT (cWt). */
export function Md(t?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _r, ...n } = t || process.env;
  for (const s of Object.keys(n)) if (s.startsWith("AGENT_HOST_DAEMON_")) delete n[s];
  for (const s of ["SSH_CLIENT", "SSH2_CLIENT"]) delete n[s];
  return n;
}

// ---- CE (D:19127–19193, vWt D:19210) ----
let Ek: string | undefined;
/** D:IWt / RWt — one random 16-byte hex id per process. */
function IWt(): string { return (Ek ||= crypto.randomBytes(16).toString("hex")); }
/** D:CE — shared build-cache env under $TMPDIR/cursor-sandbox-cache/<id>. Nothing is created on disk. */
export function CE(t: string = path.join(os.tmpdir(), "cursor-sandbox-cache", IWt())): Record<string, string> {
  const j = (s: string) => path.join(t, s);
  return {
    NPM_CONFIG_CACHE: j("npm"), PNPM_STORE_PATH: j("pnpm-store"), GOCACHE: j("go-build"), GOMODCACHE: j("go-mod"),
    CARGO_TARGET_DIR: j("cargo-target"), PIP_CACHE_DIR: j("pip"), UV_CACHE_DIR: j("uv"), BUN_INSTALL_CACHE_DIR: j("bun"),
    YARN_CACHE_FOLDER: j("yarn"), npm_config_devdir: j("node-gyp"), PLAYWRIGHT_BROWSERS_PATH: j("playwright"),
    PUPPETEER_CACHE_DIR: j("puppeteer"), TURBO_CACHE_DIR: j("turbo"), GRADLE_USER_HOME: j("gradle"), CONDA_PKGS_DIRS: j("conda"),
    POETRY_CACHE_DIR: j("poetry"), GEM_SPEC_CACHE: j("gem-specs"), BUNDLE_PATH: j("bundle"), COMPOSER_HOME: j("composer"),
    HOMEBREW_CACHE: j("homebrew"), CYPRESS_CACHE_FOLDER: j("cypress"), NX_CACHE_DIRECTORY: j("nx"), NUGET_PACKAGES: j("nuget"),
    CCACHE_DIR: j("ccache"), CP_HOME_DIR: j("cocoapods"),
  };
}

// ---- FUSE cwd hop (D:15270–15620; constants D:15580–15590, UR D:15629) ----
const hae = "/cursor/stores";
const ULt = "/proc/self/mountinfo";
const nDe = "CURSOR_SPAWN_CWD_HOP";
const BR = "cursor-fuse-cwd";
const F4 = 79;
const c2 = "cursor-fuse-cwd:cd";
const ZNe = Buffer.from(c2);
const gae = 32;
const UR = `cd "$1" || { printf %s '${c2}'; exit ${F4}; }; shift; exec "$@"`;
void hae; // gd(): only used by the original's span attributes (qR), not ported

export type MountOpts = { platform?: string; processCwd?: string; tmpdir?: string; readMountinfo?: () => string | undefined };
const Sae = (t: Buffer[]) => Buffer.from(Buffer.concat(t));
function $Lt(): string | undefined { try { return fs.readFileSync(ULt, "utf8"); } catch { return undefined; } }
const FLt = $Lt;
function JLt(t?: MountOpts) { return t?.readMountinfo ?? FLt; }
function qLt(t: string) { return t.replace(/\\([0-7]{3})/g, (_e, r) => String.fromCharCode(Number.parseInt(r, 8))); }
function GLt(t: string) { return t === "/" ? "/" : t.replace(/\/+$/, ""); }
function zLt(t: string, e: string) { return e === "/" || t === e || t.startsWith(`${e}/`); }
function jLt(t: string) { return t === "fuse" || t === "fuseblk" || t.startsWith("fuse."); }
type Mount = { mountPoint: string; fstype: string };
function HLt(t: string): Mount[] {
  const e: Mount[] = [];
  for (const r of t.split("\n")) {
    if (r.length === 0) continue;
    const n = r.split(" ");
    if (n.length < 10) continue;
    let s = -1;
    for (let a = 6; a < n.length; a++) if (n[a] === "-") { s = a; break; }
    const o = n[4], i = s === -1 ? undefined : n[s + 1];
    if (!(o === undefined || i === undefined || i.length === 0)) e.push({ mountPoint: GLt(qLt(o)), fstype: i });
  }
  return e;
}
let XNe: string | undefined, LR: Mount[] | undefined;
function VLt(t: string): Mount[] { if (!(XNe === t && LR !== undefined)) { XNe = t; LR = HLt(t); } return LR!; }
function WLt(t: string, e: Mount[]): Mount | undefined {
  let r: Mount | undefined;
  for (const n of e) if (zLt(t, n.mountPoint) && (r === undefined || n.mountPoint.length >= r.mountPoint.length)) r = n;
  return r;
}
/** D:u2 — is `t` on a FUSE mount per /proc/self/mountinfo? */
export function u2(t: string, e?: MountOpts): boolean {
  const r = JLt(e)();
  if (r === undefined) return false;
  const n = WLt(path.resolve(t), VLt(r));
  return n !== undefined && jLt(n.fstype);
}
function $R(t?: MountOpts): string {
  const e = t?.processCwd ?? process.cwd();
  return (t?.platform ?? process.platform) === "linux" && u2(e, t) ? (t?.tmpdir ?? os.tmpdir()) : e;
}
type Hop = { command: string; args: string[]; options: SpawnOptions | undefined; hopped: boolean; hopCwd?: string };
/** D:_ae 15327–15346. */
export function _ae(t: string, e: readonly string[], r: SpawnOptions | undefined, n?: MountOpts): Hop {
  const s = n?.platform ?? process.platform, o = r?.cwd;
  if (s !== "linux" || o === undefined || r?.shell || !u2(String(o), n)) return { command: t, args: [...e], options: r, hopped: false };
  const i = path.resolve(String(o));
  const a = $R({ processCwd: n?.processCwd, tmpdir: n?.tmpdir, platform: s, readMountinfo: n?.readMountinfo });
  return { command: "/bin/sh", args: ["-c", UR, BR, i, t, ...e], options: { ...r, cwd: a }, hopped: true, hopCwd: i };
}
/** D:FR 15347. */
export function FR(t: NodeJS.ProcessEnv = process.env): boolean { return t[nDe] === "1"; }
function GR(t: string | undefined, e: NodeJS.ProcessEnv = process.env): boolean { return FR(e) && t !== undefined && u2(t); }
function Eae(t: string) { return `working directory is not accessible: ${path.resolve(t)}`; }
function KLt(t: Buffer | string) { return typeof t === "string" ? t === c2 : Buffer.from(t).equals(Buffer.from(c2)); }
function l2(t: { cwd?: string; env?: NodeJS.ProcessEnv; exitCode: number | null; stdoutBytes: number; stdoutPrefix: Buffer }): boolean {
  return GR(t.cwd, t.env) && t.exitCode === F4 && t.stdoutBytes === c2.length && KLt(t.stdoutPrefix);
}
function q4(t: string): Error { const e = new Error(Eae(t)) as Error & { code?: string }; e.code = "ENOENT"; return e; }
/** D:Gh — holds stdout bytes while they could still be the cd-failure marker. */
class Gh {
  private held = Buffer.alloc(0); private released = false; private seen = 0; private prefix = Buffer.alloc(0);
  get bytes() { return this.seen; }
  get stdoutPrefix() { return this.prefix; }
  get diverged() { return this.released; }
  note(e: Buffer | string): Buffer | undefined {
    const r = Buffer.from(e as Buffer);
    this.seen += r.length;
    if (this.prefix.length < gae) { const s = Math.min(r.length, gae - this.prefix.length); this.prefix = Sae([this.prefix, r.subarray(0, s)]); }
    if (this.released) return r;
    const n = Sae([this.held, r]);
    if (n.length <= ZNe.length && ZNe.subarray(0, n.length).equals(n)) { this.held = n; return undefined; }
    this.released = true; this.held = Buffer.alloc(0); return n;
  }
  takeHeld(): Buffer | undefined {
    if (this.held.length === 0) { this.released = true; return undefined; }
    const e = this.held; this.held = Buffer.alloc(0); this.released = true; return e;
  }
}
/** D:eBt 15440–15500 — ChildProcess branch of oDe: swallow the marker, turn exit 79 + marker into ENOENT 'error'. */
function eBt(t: ChildProcess, e: string): void {
  const r = new Gh(), n = new PassThrough(), i = t.stdout, a = t.emit.bind(t) as (ev: string | symbol, ...args: unknown[]) => boolean;
  let s = false, o: unknown[] | undefined;
  const u = (m: boolean) => {
    if (m) r.takeHeld();
    else { const h = r.takeHeld(); if (h !== undefined && !n.writableEnded) n.write(h); }
    if (!n.writableEnded) n.end();
  };
  const l = (m: unknown[] | undefined) => { const h = m?.[0]; return h === null || typeof h === "number" ? (h as number | null) : null; };
  const d = (m: unknown[] | undefined) => l2({ exitCode: l(m), stdoutBytes: r.bytes, stdoutPrefix: r.stdoutPrefix, cwd: e });
  const f = () => { s = true; u(true); return a("error", q4(e)); };
  const p = () => { if (o !== undefined && l(o) === F4) { a("exit", ...o); o = undefined; } };
  if (i) {
    i.on("data", (m: Buffer) => {
      if (s) return;
      const h = r.note(m);
      if (h !== undefined) { n.write(h); p(); return; }
      if (d(o)) f();
    });
    i.on("error", (m: Error) => { n.destroy(m); });
    Object.defineProperty(t, "stdout", { configurable: true, enumerable: true, get() { return n; } });
  }
  (t as { emit: (ev: string | symbol, ...h: unknown[]) => boolean }).emit = (m, ...h) =>
    s
      ? (m === "exit" || m === "close" ? false : a(m, ...h))
      : m === "exit"
        ? ((o = h), l(h) !== F4 ? a(m, ...h) : d(h) ? f() : r.diverged || i == null ? ((o = undefined), a(m, ...h)) : false)
        : m === "close"
          ? (d(h) || d(o) ? f() : (u(false), p(), a(m, ...h)))
          : a(m, ...h);
}
/** D:ZLt — only meaningful for spawnSync-shaped errors; a sync throw from spawn() has no `status`. */
function ZLt(t: unknown, e: string): boolean {
  if (typeof t !== "object" || t === null || !("status" in t)) return false;
  const r = (t as { status?: unknown }).status, n = "stdout" in t ? (t as { stdout?: unknown }).stdout : undefined;
  const st = typeof r === "number" || r === null ? r : undefined;
  const so = typeof n === "string" || n instanceof Uint8Array || n === null ? n : undefined;
  const b = so == null ? Buffer.alloc(0) : typeof so === "string" ? Buffer.from(so) : Sae([Buffer.from(so)]);
  return l2({ exitCode: typeof st === "number" ? st : null, stdoutBytes: b.length, stdoutPrefix: b.subarray(0, gae), cwd: e });
}
function xae(t: unknown, e: string): never { throw ZLt(t, e) ? q4(e) : t; }

// ---- workload cgroup (D:16745–16845) ----
const WUt = /^\/sys\/fs\/cgroup\/[A-Za-z0-9_/.-]+$/;
export type WorkloadMode = { kind: "direct" } | { kind: "armed"; workloadCgroupDir: string; executable: string; argumentPrefix: readonly string[] };
const KUt: WorkloadMode = Object.freeze({ kind: "direct" });
/** D:Oae 16745. */
export function Oae({ workloadCgroupDir: t, hopCwd: e }: { workloadCgroupDir: string; hopCwd?: string }): string {
  const r = `echo $$ 2>/dev/null > '${t}/cgroup.procs'; echo 0 2>/dev/null > /proc/$$/oom_score_adj; `;
  return e !== undefined ? r + UR : `${r}exec "$0" "$@"`;
}
/** D:YUt 16749. */
function YUt(t: string): boolean {
  try { return fs.statSync(t).isDirectory() ? (fs.accessSync(`${t}/cgroup.procs`, fs.constants.W_OK), true) : false; }
  catch { return false; }
}
/** D:ZUt 16758. */
export function ZUt(t: string, e: string | undefined, r: (d: string) => boolean = YUt): WorkloadMode {
  return t !== "linux" || e === undefined || !WUt.test(e) || e.includes("..") || !r(e)
    ? KUt
    : Object.freeze({ kind: "armed", workloadCgroupDir: e, executable: "/bin/sh", argumentPrefix: Object.freeze(["-c", Oae({ workloadCgroupDir: e })]) });
}
/** D:BNe 15066. */
function BNe(t: number | undefined): void {
  if (!(process.platform !== "linux" || t === undefined || t <= 0)) try { fs.writeFileSync(`/proc/${t}/oom_score_adj`, "0"); } catch { /* ignore */ }
}
function XUt(t: unknown): boolean { return t !== null && typeof t === "object" && !Array.isArray(t); }
type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
/** D:t$t 16797–16829. */
export function t$t(t: WorkloadMode, e: (pid: number | undefined) => void = BNe) {
  return function (n: SpawnFn, s: string, o: readonly string[], opts: SpawnOptions): ChildProcess {
    const u = FR() && XUt(opts) ? _ae(s, o, opts) : undefined;
    let l = s, d = [...o], f = opts;
    if (u?.hopped === true && u.hopCwd !== undefined) {
      f = u.options ?? opts;
      if (t.kind === "armed") { l = "/bin/sh"; d = ["-c", Oae({ workloadCgroupDir: t.workloadCgroupDir, hopCwd: u.hopCwd }), BR, u.hopCwd, s, ...o]; }
      else { l = u.command; d = u.args; }
    } else if (t.kind === "armed") { l = t.executable; d = [...t.argumentPrefix, s, ...o]; }
    let p: ChildProcess;
    try { p = n(l, d, f); }
    catch (m) { if (u?.hopped === true && u.hopCwd !== undefined) xae(m, u.hopCwd); throw m; }
    if (typeof p.pid === "number") e(p.pid);
    if (u?.hopped === true && u.hopCwd !== undefined) eBt(p, u.hopCwd);
    return p;
  };
}
/** D:r$t / Yn (16845): decided once from the daemon's own inherited env. */
const r$t = ZUt(process.platform, process.env.CURSOR_WORKLOAD_CGROUP);
const Yn = t$t(r$t);
export function workloadMode(): WorkloadMode { return r$t; }

// ---- Ud / Ko ----
/** D:Ud 20798–20812 (+VKt 20815). Throws SandboxUnsupportedError (ol) for non-insecure_none without the helper. */
export function Ud(t: string, e: string[] = [], r: SpawnOptions = {}, n: InternalSandboxPolicy): ChildProcess {
  r.env = Md(r.env);
  if (n.enableSharedBuildCache) r = { ...r, env: { ...Md(process.env), ...CE(), ...r.env } };
  if (n.type !== "insecure_none") assertSandboxSupported(n);
  return Yn(cpSpawn as SpawnFn, t, e, { ...r, windowsHide: true });
}
/** D:Ko 21094–21095 (process-tree kill on `s` is handled by the callers' own abort paths). */
export function Ko(t: string, e: string[] = [], r: SpawnOptions = {}, n: InternalSandboxPolicy): ChildProcess {
  return Ud(t, e, { ...r, env: b0(r.env ?? process.env) }, n);
}
