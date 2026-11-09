import { trace } from "../trace";
import { withExecChannelHeartbeat } from "./output-channel";
import { proto3 } from "@bufbuild/protobuf";
import {
  ExecClientMessage,
  LsError,
  LsResult,
  LsSuccess,
  LsTimeout,
  ShellAbortReason,
  ShellBackgroundReason,
  SandboxPolicy,
  SandboxPolicy_Type,
} from "../generated/agent.v1_pb";
import { Qk, m3Structured } from "./denylist";
import { Kc, assertSandboxSupported, SandboxUnsupportedError, type InternalSandboxPolicy } from "./sandbox";
import { backgroundShellManagerFor } from "./background-shell";
import { buildTreeFromRipgrepStream, LS_CHAR_BUDGET, LS_DEFAULT_TIMEOUT_MS, withTimeoutSignal } from "./ls-ripgrep";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { assertRealpathUnderRoot, assertUnderRoot, PathGuardError } from "./path";
import type { PermissionMode } from "../settings";
import { commitShell, getSessionCwd, MAX_STATE_BYTES, prepareShell, terminateInitialSnapshot, type PreparedShell } from "./shell-session";

export type ExecFrameOut =
  | { kind: "client"; requestId: string; message: Record<string, unknown> }
  | { kind: "control"; requestId: string; message: Record<string, unknown>; cwdState?: string }
  | { kind: "file-error" | "messages-error"; requestId: string; error: string }
  /** UC upload success has no bytes (Y_ empty seq0/last). Box download materializes bytes for bytesBase64. */
  | { kind: "file"; requestId: string; bytes?: Uint8Array }
  /** UC messages-op frames (D:Y_ 179001–179040). */
  | { kind: "messages-accepted"; requestId: string }
  | { kind: "messages-consent-result"; requestId: string; verdict: { kind: "allow" } | { kind: "ask" } | { kind: "refused"; reason: string } }
  | { kind: "messages-result"; requestId: string; result: unknown; timings?: { daemonMs: number; helperMs: number; sqliteMs?: number } }
  /** UC local-tool frames (D:Y_ 179042–179078). */
  | { kind: "local-tool-accepted"; requestId: string; permissionGranted?: true }
  | { kind: "local-tool-permission-pending"; requestId: string; reason?: string }
  | { kind: "local-tool-result"; requestId: string; outcome: { status: "done"; outputJson: string } | { status: "failed"; error: string } | { status: "needs_permission"; error?: string } | { status: "ask"; app: { bundleId: string; appName: string } } };

export type Emit = (frame: ExecFrameOut) => void | Promise<void>;

type ShellJob = { abort: (reason: ShellAbortReason) => void; done: Promise<void> };
const shells = new Map<string, ShellJob>();
/**
 * Official inner exec message ids: every v_ executor owns `nextExecId = 1` (D:135935) and does
 * `let a = this.nextExecId++; o.id = a` (D:136332–136333). Box builds its own v_ (D:137251) and every UC provider
 * builds a fresh one (D:179358, also on an SA flip recreate D:179352–179366), so each provider counts from 1.
 */
export class ExecIdCounter {
  constructor(private next = 1) {}
  private lastId = 0;
  allocate(): number {
    this.lastId = this.next++;
    lastAllocatedExecId = this.lastId;
    trace("exec-id", { id: this.lastId });
    return this.lastId;
  }
  /** Most recent id of this counter (0 if none). For catch paths that must not double-allocate. */
  last(): number { return this.lastId; }
}
/** Fallback counter for callers that pass no provider counter (unit tests calling dispatchExec directly). */
let defaultExecIds = new ExecIdCounter();
let lastAllocatedExecId = 0;
export function allocateExecId(): number {
  return defaultExecIds.allocate();
}
/** Most recent id allocated by any counter (0 if none since reset). Test observability only. */
export function lastAllocatedExecIdOrZero(): number {
  return lastAllocatedExecId;
}
/** Test-only: reset the fallback counter (value = next id) and the observed last id. */
export function resetExecIdCounter(value = 1): void {
  defaultExecIds = new ExecIdCounter(value);
  lastAllocatedExecId = 0;
}
/**
 * Official Aft (daemon.formatted.cjs L132554–132566) used when forwarding an exec throw (L136340–136347):
 * - only shellStreamArgs / backgroundShellSpawnArgs probe workingDirectory (bft L132549: empty → root);
 * - otherwise "unset";
 * - xft (L132546) via stat: directory → "exists", ENOENT/ENOTDIR (F5r L132528) → "missing";
 * - other probe errors / Wi 1000 ms timeout (J5r L132553) → undefined so the field is omitted.
 * Permission refusals use x9 (L136410) with no cwdState — callers must not pass a probe context there.
 */
export async function cwdStateForThrow(
  root: string,
  serverMessage?: Record<string, unknown>,
): Promise<"exists" | "missing" | "unset" | undefined> {
  const shell = (serverMessage?.shellStreamArgs ?? serverMessage?.backgroundShellSpawnArgs) as
    | { workingDirectory?: string }
    | undefined;
  if (!shell || typeof shell !== "object") return "unset";
  const requested = String(shell.workingDirectory ?? "").trim();
  const target = requested.length === 0
    ? root
    : path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  try {
    const isDir = await Promise.race([
      fs.promises.stat(target).then(
        (st) => st.isDirectory(),
        (e: NodeJS.ErrnoException) => {
          if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return false;
          throw e;
        },
      ),
      new Promise<never>((_, rej) => {
        setTimeout(() => rej(new Error("cwd probe timed out")), 1000);
      }),
    ]);
    return isDir ? "exists" : "missing";
  } catch (e) {
    console.error(
      `[local-exec-daemon] cwd probe failed, cwdState left out: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

export type ThrowCwdContext = { root: string; serverMessage?: Record<string, unknown> };

export async function requestError(
  requestId: string,
  msgId: number,
  error: unknown,
  emit: Emit,
  ctx?: ThrowCwdContext,
): Promise<void> {
  const cwdState = ctx ? await cwdStateForThrow(ctx.root, ctx.serverMessage) : "unset";
  const throwFrame: ExecFrameOut = {
    kind: "control",
    requestId,
    message: { throw: { id: msgId, error: String(error instanceof Error ? error.message : error) } },
  };
  if (cwdState !== undefined) throwFrame.cwdState = cwdState;
  await emit(throwFrame);
  await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
}
export async function shutdownShells(): Promise<void> {
  const jobs = [...shells.values()];
  jobs.forEach(j => j.abort(ShellAbortReason.USER_ABORT));
  // Daemon shutdown (not per-request cancel) also ends the shared initial-snapshot process group.
  await terminateInitialSnapshot();
  await Promise.all(jobs.map(j => j.done));
}

export const NEVER_MSG =
  'Local tools are turned off. The user has set local tool access to "Never", so Shell, Read, and AwaitShell with machineId, plus CopyToBox and CopyFromBox, cannot run on their computer. Do not retry them while this setting remains "Never". Use your own computer instead by omitting machineId, or ask the user to change the setting in Settings → Bot → Execution on Local Computer. If they change it away from "Never", you may try again.';

export const ASK_MSG =
  'That action was not approved on the user\'s computer, so nothing ran. Ask the user to approve it (or to set Settings → Bot → Execution on Local Computer to "Always allow"), and use your own computer (Shell, Read, AwaitShell) in the meantime.';

export function refuseByPermission(permission: PermissionMode, requestId: string, emit: Emit): boolean {
  if (permission === "never") {
    void Promise.resolve(emit({ kind: "file-error", requestId, error: NEVER_MSG })).catch(() => console.error("[local-exec] refusal reply failed"));
    return true;
  }
  if (permission === "ask") {
    void Promise.resolve(emit({ kind: "file-error", requestId, error: ASK_MSG })).catch(() => console.error("[local-exec] refusal reply failed"));
    return true;
  }
  return false;
}

export async function handleRead(args: {
  root: string;
  requestId: string;
  msgId: number;
  path: string;
  emit: Emit;
}): Promise<void> {
  const { root, requestId, msgId, emit } = args;
  try {
    const abs = assertRealpathUnderRoot(root, args.path);
    const canonical = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    const fh = await fs.promises.open(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);

    let content: string;
    let fileSize: number;
    try {
      const st = await fh.stat();
      // Linux fd-path verification checks the opened object, not the path that
      // was checked before open. This is NOT portable openat2 confinement.
      if (process.platform !== "linux") throw new Error("Verified fd reads require Linux in this local-exec-daemon subset");
      const opened = fs.realpathSync(`/proc/self/fd/${fh.fd}`);
      const relative = path.relative(realRoot, opened);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new PathGuardError("Opened file is outside the allowed local-exec root");
      if (!st.isFile()) throw new Error("Path is not a regular file");
      fileSize = st.size;
      // Conservative bounded text subset. Full official binary/image/streaming
      // variants remain unsupported, never silently decode with replacements.
      if (fileSize > 8 * 1024 * 1024) throw new Error("Read exceeds local-exec-daemon text limit (8 MiB); streaming not implemented");
      const buf = Buffer.alloc(fileSize + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > fileSize) throw new Error("File grew during read");
      const bytes = buf.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new Error("Binary read not implemented in local-exec-daemon text subset");
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { await fh.close(); }
    const totalLines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
    await emit({
      kind: "client",
      requestId,
      message: {
        id: msgId,
        readResult: {
          success: {
            path: abs,
            content,
            totalLines,
            fileSize: String(fileSize),
          },
        },
        localExecutionTimeMs: 1,
      },
    });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
  } catch (e) {
    await requestError(requestId, msgId, e, emit, { root, serverMessage: { readArgs: { path } } });
  }
}

/** Exact official 0.79.3 message (daemon.formatted.cjs L19008–19011, nl()); configuration lives in ls-ripgrep.ts. */
export { RIPGREP_UNCONFIGURED, configureRipgrepPath, getRipgrepPath } from "./ls-ripgrep";

/** D:er 15130 (zNe ~ expansion 15119, DLt file:// 15122): the ls executor's own path resolution against the workspace root. */
export function lsResolvePath(t: string, root: string): string {
  let r = t;
  if (r.startsWith("file://")) { try { r = url.fileURLToPath(r); } catch { /* keep */ } }
  r = r.replace(/^~(?=$|\/|\\)/, () => os.homedir());
  return root && !path.isAbsolute(r) ? path.resolve(root, r) : path.resolve(r);
}
/** D:uae 15087 / cae 15079: <...>/.cursor/projects/<id>/terminals exactly. */
export function isCursorTerminalsDir(t: string): boolean {
  const r = t.split(/[/\\]/).filter(e => e);
  for (let n = 0; n < r.length - 2; n++)
    if (r[n] === ".cursor" && r[n + 1] === "projects" && r[n + 3] === "terminals") return r.slice(n + 4).length === 0;
  return false;
}
export async function handleLs(args: {
  root: string;
  requestId: string;
  msgId: number;
  path: string;
  emit: Emit;
  /** LsArgs.ignore (field 2) → getDirectoryTree's exclude globs (D:129449). */
  ignore?: string[];
  /** LsArgs.timeout_ms (field 5); `?? Q4r` = 5000 (D:129445). */
  timeoutMs?: number;
  /** LsArgs.sandbox_policy (field 4) → Kc (D:129444). */
  sandboxPolicy?: { type?: unknown } | null;
}): Promise<void> {
  // LocalLsExecutor.execute (D:129400–129483): stat the er()-resolved path first (ENOENT / terminals /
  // not-a-directory / other), then getDirectoryTree (D:129484) → buildTreeFromRipgrepStream (D:129495–129542) → kO.
  // In the 0.79.3 App the ripgrep path Z2 is never configured, so kO's nl() throws and the catch
  // (D:129466–129478) answers LsResult.error with RIPGREP_UNCONFIGURED. After configureRipgrepPath()
  // the same code path yields success / timeout with directoryTreeRoot (t196, ls-ripgrep.ts).
  // Path guard (assertRealpathUnderRoot, our n9 equivalent) stays first.
  const { root, requestId, msgId, emit } = args;
  try {
    assertRealpathUnderRoot(root, args.path);
    const abs = lsResolvePath(args.path, root);
    let result: LsResult;
    const lsError = (error: string) => new LsResult({ result: { case: "error", value: new LsError({ path: abs, error }) } });
    let st: fs.Stats | undefined;
    let statError: string | undefined;
    try {
      st = await fs.promises.stat(abs);
    } catch (m) {
      const code = typeof m === "object" && m !== null && "code" in m ? (m as { code?: unknown }).code : undefined;
      statError = code === "ENOENT"
        ? (isCursorTerminalsDir(abs) ? "No active terminals." : `Path does not exist: ${abs}`)
        : m instanceof Error ? m.message : typeof m === "object" && m !== null && typeof (m as { message?: unknown }).message === "string" ? (m as { message: string }).message : "";
    }
    if (statError !== undefined) result = lsError(statError);
    else if (!st!.isDirectory()) result = lsError(`Path is not a directory: ${abs}`);
    else {
      try {
        const u = Kc(args.sandboxPolicy), l = args.timeoutMs ?? LS_DEFAULT_TIMEOUT_MS, d = withTimeoutSignal(l);
        const { tree: f, didTimeout: p } = await buildTreeFromRipgrepStream(d, abs, args.ignore ?? [], u, LS_CHAR_BUDGET);
        result = p
          ? new LsResult({ result: { case: "timeout", value: new LsTimeout({ directoryTreeRoot: f }) } })
          : new LsResult({ result: { case: "success", value: new LsSuccess({ directoryTreeRoot: f }) } });
      } catch (a) {
        result = lsError(a instanceof Error ? a.message : "Unknown error occurred");
      }
    }
    const client = new ExecClientMessage({
      id: msgId,
      message: { case: "lsResult", value: result },
      localExecutionTimeMs: 1,
    });
    await emit({ kind: "client", requestId, message: client.toJson() as Record<string, unknown> });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
  } catch (e) {
    await requestError(requestId, msgId, e, emit, { root, serverMessage: { lsArgs: { path: args.path || root } } });
  }
}

export async function handleShellStream(args: {
  root: string; requestId: string; msgId: number; command: string;
  workingDirectory?: string; timeout?: number; emit: Emit;
  /** Soft-timeout mode: BACKGROUND → r5e handoff (D:131022–131184). */
  timeoutBehavior?: string | number;
  isBackground?: boolean;
  /** D:hardTimeout — aborts even after backgrounding (E_ D:131055–131065). */
  hardTimeout?: number;
  adminCommandDenylist?: string[];
  requestedSandboxPolicy?: { type?: unknown } | null;
  description?: string;
}): Promise<void> {
  const { root, requestId, msgId, command } = args;
  const backgroundMode = isBackgroundTimeoutBehavior(args);
  const softTimeoutMs = args.timeout ?? 0;
  const hardTimeoutMs = typeof args.hardTimeout === "number" && args.hardTimeout > 0 ? args.hardTimeout : 0;
  const policy = Kc(args.requestedSandboxPolicy);
  const denylist = Array.isArray(args.adminCommandDenylist) ? args.adminCommandDenylist : [];
  const startedAt = Date.now();
  // Guarded emitter: a sync throw becomes a rejection; the first failure latches, aborts the job
  // and every later emit becomes a no-op, so a broken reply channel cannot cause unbounded emits.
  let emitFailed = false;
  const emit: Emit = (f) => {
    if (emitFailed) return Promise.resolve();
    let p: Promise<unknown>;
    try { p = Promise.resolve(args.emit(f)); } catch (e) { p = Promise.reject(e); }
    return p.then(() => undefined, (e) => {
      if (!emitFailed) { emitFailed = true; abortJob(ShellAbortReason.USER_ABORT); }
      throw e;
    }) as ReturnType<Emit>;
  };
  // Lifecycle is registered on entry so cancel/timeout/shutdown cover the whole request:
  // cwd validation, (shared) initial-snapshot wait, spawn, run and close. Official oracle
  // (independent-r3-cancel): cancel during a slow login snapshot → USER_ABORT exit, no start
  // frame, command never runs.
  let pendingReason: ShellAbortReason | undefined;
  let wakePreSpawn: () => void = () => undefined;
  const preSpawnAborted = new Promise<void>((r) => { wakePreSpawn = r; });
  let abortJob: (reason: ShellAbortReason) => void = (why) => {
    if (pendingReason !== undefined) return;
    pendingReason = why; wakePreSpawn();
  };
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((r) => { resolveDone = r; });
  shells.set(requestId, { abort: (why) => abortJob(why), done });
  // Official oracle (independent-r3-cancel, timeout=100ms, cancel at 150ms during a 2s login
  // snapshot) reports USER_ABORT, i.e. the timeout clock does not run during the snapshot wait;
  // it is armed at spawn. The snapshot wait itself is bounded by initialSnapshot's own cap.
  let timeoutTimer: NodeJS.Timeout | undefined;
  let startSent = false;

  const emitAborted = async (why: ShellAbortReason, cwdForExit: string) => {
    clearTimeout(timeoutTimer);
    shells.delete(requestId);
    try {
      const elapsed = Date.now() - startedAt;
      // Oracle frame order for an abort before the command ran: start, aborted exit, close.
      if (!startSent) await emit({ kind: "client", requestId, message: { id: msgId,
        shellStream: { start: { sandboxPolicy: new SandboxPolicy({type: SandboxPolicy_Type.INSECURE_NONE}).toJson() } }, localExecutionTimeMs: elapsed } });
      await emit({ kind: "client", requestId, message: { id: msgId,
        shellStream: { exit: { code: 4294967295, cwd: cwdForExit, aborted: true,
          abortReason: proto3.getEnumType(ShellAbortReason).findNumber(why)!.name, localExecutionTimeMs: elapsed } },
        localExecutionTimeMs: elapsed } });
      await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
    } catch { console.error("[local-exec] reply emission failed during shell abort"); }
    resolveDone();
  };

  const body = async (): Promise<void> => {
  let cwd: string;
  let realRoot: string;
  let prepared: PreparedShell;
  let notice: string | undefined;
  try {
    // t110u: official shell execute awaits Sft (cwd resolution, D:L132620) before any shell preparation, so the
    // synchronous cwd checks and the first (shared) prepareShell never run inside the admission pass that arms the
    // other execs' heartbeat timers. The lifecycle is already registered above, so a cancel/stop landing here
    // sets pendingReason and takes the existing pre-spawn abort path (start, aborted exit, streamClose; no spawn).
    await undefined;
    trace("shell-body", { rid: requestId });
    realRoot = fs.realpathSync(root);
    // Explicit workingDirectory wins; otherwise reuse the session cwd (official oracle cwdpersist),
    // re-validated against the root on every use; fall back to the root.
    const session = args.workingDirectory ? undefined : getSessionCwd();
    const wanted = args.workingDirectory || session || root;
    // Accept the logical root (may be a symlink, oracle independent-r3-rootlink) or its canonical
    // form; both checks keep symlink-escape protection via realpath.
    const guard = (target: string): string => {
      try { return assertRealpathUnderRoot(root, target); }
      catch (e) { if (!(e instanceof PathGuardError) || realRoot === path.resolve(root)) throw e; return assertRealpathUnderRoot(realRoot, target); }
    };
    let abs: string;
    if (session !== undefined) {
      // A session cwd outside the root (e.g. `cd /tmp`) is never reused; fall back to the root.
      try { abs = guard(session); } catch { abs = realRoot; }
    } else abs = guard(wanted);
    if (!fs.existsSync(abs) && !args.workingDirectory) {
      cwd = realRoot; // stale session cwd: silently use the root (official behavior unverified)
    } else if (!fs.existsSync(abs)) {
      // Official (oracle sh-badcwd): stderr notice, then run in the root. Escapes stay refused.
      notice = `working directory ${abs} does not exist on this machine; running in ${realRoot} instead\n`;
      cwd = realRoot;
    } else {
      cwd = fs.realpathSync(abs);
      // Synchronous like the surrounding realpath/exists checks: an async stat here let fs thread-pool completion
      // order reorder concurrent admissions before `start` (official Sft does no I/O for an empty cwd).
      if (!fs.statSync(cwd).isDirectory()) throw new Error("cwd is not a directory");
    }
    if (pendingReason === undefined) {
      trace("prep-call", { rid: requestId });
      const p = prepareShell(command, realRoot);
      trace("prep-returned", { rid: requestId });
      p.catch(() => undefined);
      await Promise.race([p, preSpawnAborted]);
      if (pendingReason === undefined) prepared = await p;
    }
  } catch (e) {
    clearTimeout(timeoutTimer); shells.delete(requestId);
    await requestError(requestId, msgId, e, emit, { root, serverMessage: { shellStreamArgs: { workingDirectory: args.workingDirectory ?? "" } } }); resolveDone(); return;
  }
  if (pendingReason !== undefined) { await emitAborted(pendingReason, cwd); return; }
  if (notice) await emit({ kind: "client", requestId, message: { id: msgId, shellStream: { stderr: { data: notice } }, localExecutionTimeMs: 0 } });
  // Re-check after the notice await: never spawn a cancelled request.
  if (pendingReason !== undefined) { await emitAborted(pendingReason, cwd); return; }

  // D:Qk 106788 / E_ 130859–130874 — denylist reject BEFORE start (no start frame).
  const denyReason = Qk({ command, parsingResult: m3Structured(command), blockedCommands: denylist });
  if (denyReason !== undefined) {
    shells.delete(requestId);
    await emit({ kind: "client", requestId, message: { id: msgId,
      shellStream: { rejected: { command, workingDirectory: cwd, reason: denyReason } }, localExecutionTimeMs: Date.now() - startedAt } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
    resolveDone(); return;
  }

  // Official shell executor yields `start` before it spawns (daemon.formatted.cjs L130994–130996).
  // start.sandboxPolicy is Xk(requested) (D:130994); we emit the converted policy JSON.
  await emit({ kind: "client", requestId, message: { id: msgId,
    shellStream: { start: { sandboxPolicy: startSandboxPolicyJson(policy) } }, localExecutionTimeMs: 1 } });
  startSent = true;
  if (pendingReason !== undefined) { await emitAborted(pendingReason, cwd); return; }

  // D:Ud 20797 after start — non-insecure_none without helper → sandboxUnsupported (E_ 131119–131136).
  try { assertSandboxSupported(policy); }
  catch (e) {
    if (!(e instanceof SandboxUnsupportedError)) throw e;
    shells.delete(requestId);
    await emit({ kind: "client", requestId, message: { id: msgId,
      shellStream: { sandboxUnsupported: {
        command, workingDirectory: cwd, sandboxPolicyType: policy.type,
        reason: e.reason ?? e.message, isReadonly: policy.type === "workspace_readonly",
      } }, localExecutionTimeMs: Date.now() - startedAt } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
    resolveDone(); return;
  }

  const prep = prepared!;
  {
    const child = spawn(prep.bash, prep.args, {
      cwd, detached: true,
      env: prep.env,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const stateIn = child.stdio?.[3] as NodeJS.WritableStream | null;
    const stateOut = child.stdio?.[4] as NodeJS.ReadableStream | null;
    const dumpChunks: Buffer[] = [];
    let dumpSize = 0;
    stateIn?.on("error", () => undefined);
    stateIn?.end(prep.snapshotIn);
    stateOut?.on("data", (b: Buffer) => { dumpSize += b.length; if (dumpSize <= MAX_STATE_BYTES) dumpChunks.push(b); });
    stateOut?.on("error", () => undefined);
    let finished = false;
    let backgrounded = false;
    let interleaved = "";
    let reason: ShellAbortReason | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let softTimer: NodeJS.Timeout | undefined;
    let bgShellId: number | undefined;
    const mgr = backgroundShellManagerFor(root);
    const groupKill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    };
    const clearAllTimers = () => {
      clearTimeout(timeoutTimer); clearTimeout(deadline); clearTimeout(escalation);
      clearTimeout(drain); clearTimeout(hardTimer); clearTimeout(softTimer);
    };
    const finish = async (code: number | null, error?: Error) => {
      if (finished || backgrounded) return;
      finished = true;
      clearAllTimers();
      if (reason) groupKill("SIGKILL");
      child.stdout?.destroy(); child.stderr?.destroy();
      shells.delete(requestId);
      const truncated = dumpSize > MAX_STATE_BYTES;
      const finalCwd = commitShell(Buffer.concat(dumpChunks), Boolean(reason) || Boolean(error) || truncated) ?? cwd;
      try {
      if (error) await requestError(requestId, msgId, error, emit, { root, serverMessage: { shellStreamArgs: { workingDirectory: args.workingDirectory ?? "" } } });
      else {
        const elapsed = Date.now() - startedAt;
        await emit({ kind: "client", requestId, message: { id: msgId,
          shellStream: { exit: { code: reason ? 4294967295 : (code ?? 4294967295), cwd: finalCwd,
            ...(reason ? { aborted: true, abortReason: proto3.getEnumType(ShellAbortReason).findNumber(reason)!.name } : {}), localExecutionTimeMs: elapsed } },
          localExecutionTimeMs: elapsed } });
        await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
      }
      } catch { console.error("[local-exec] reply emission failed during shell completion"); }
      resolveDone();
    };
    /** D:E_ background handoff 131146–131184 — emit backgrounded + streamClose; child keeps running into terminals/{id}.txt. */
    const goBackground = async (bgReason: "TIMEOUT" | "USER_REQUEST") => {
      if (finished || backgrounded) return;
      backgrounded = true;
      clearTimeout(softTimer); clearTimeout(timeoutTimer); clearTimeout(drain);
      // Ensure pipes flow for the terminal-file listeners adopt will attach (we may have paused them).
      child.stdout?.resume(); child.stderr?.resume();
      // Request lifecycle ends; cancel no longer kills the adopted shell (ZO owns it).
      shells.delete(requestId);
      const shellId = bgShellId ?? mgr.generateShellId();
      bgShellId = shellId;
      const msToWait = bgReason === "USER_REQUEST" ? Date.now() - startedAt : softTimeoutMs;
      try {
        await mgr.adopt({
          shellId, command, workingDirectory: cwd, pid: child.pid,
          initialOutput: interleaved, startTime: startedAt, showElapsedTime: true,
          description: args.description, child,
          onCleanup: () => { clearTimeout(hardTimer); },
        });
        const elapsed = Date.now() - startedAt;
        await emit({ kind: "client", requestId, message: { id: msgId,
          shellStream: { backgrounded: {
            shellId, command, workingDirectory: cwd,
            ...(child.pid !== undefined ? { pid: child.pid } : {}),
            msToWait,
            reason: bgReason === "USER_REQUEST"
              ? proto3.getEnumType(ShellBackgroundReason).findNumber(ShellBackgroundReason.USER_REQUEST)!.name
              : proto3.getEnumType(ShellBackgroundReason).findNumber(ShellBackgroundReason.TIMEOUT)!.name,
          } }, localExecutionTimeMs: elapsed } });
        await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
      } catch (e) {
        console.error("[local-exec] background handoff failed", e);
        backgrounded = false;
        await finish(null, e instanceof Error ? e : new Error(String(e)));
        return;
      }
      resolveDone();
    };
    abortJob = (why) => {
      if (finished || backgrounded || reason) return;
      reason = why; groupKill("SIGTERM");
      escalation = setTimeout(() => groupKill("SIGKILL"), 250);
      deadline = setTimeout(() => finish(null), 750);
    };
    child.once("error", (e) => { if (!backgrounded) void finish(null, e); });
    child.once("close", (code) => { if (!backgrounded) void finish(code); });
    child.once("exit", (code) => {
      if (backgrounded) return;
      // Isolated original oracle: 4s background drains naturally; both 6s
      // background cases exit at ~5.04s. Preserve that bounded normal drain.
      drain = setTimeout(() => { void finish(code); }, 5000);
    });
    // Soft timeout: CANCEL → abortJob(TIMEOUT); BACKGROUND → goBackground(TIMEOUT) (D:r5e 130721).
    // softTimeoutMs===0 with BACKGROUND backgrounds immediately after spawn (r5e timer 0).
    if (backgroundMode) {
      softTimer = setTimeout(() => { void goBackground("TIMEOUT"); }, Math.max(0, softTimeoutMs));
    } else if (softTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => abortJob(ShellAbortReason.TIMEOUT), softTimeoutMs);
    } else if (softTimeoutMs === 0 && hardTimeoutMs > 0) {
      // D:t5e+E_: non-BACKGROUND with hardTimeout → soft timeout 0 → immediate abort.
      timeoutTimer = setTimeout(() => abortJob(ShellAbortReason.TIMEOUT), 0);
    }
    // D:hardTimeout 131055–131065 — survives backgrounding; aborts via manager or foreground.
    if (hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => {
        if (backgrounded && bgShellId !== undefined) {
          if (!mgr.abort(bgShellId)) groupKill("SIGKILL");
        } else {
          abortJob(ShellAbortReason.TIMEOUT);
        }
      }, hardTimeoutMs);
    }
    for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
      stream?.on("data", (b: Buffer) => {
        if (finished) return;
        const text = b.toString("utf8");
        interleaved += text;
        if (backgrounded) return; // adopt owns further output via its own listeners after handoff
        stream?.pause();
        Promise.resolve(emit({ kind: "client", requestId, message: { id: msgId,
          shellStream: { [name]: { data: text } }, localExecutionTimeMs: Date.now() - startedAt } }))
          .catch(() => abortJob(ShellAbortReason.USER_ABORT))
          .finally(() => { if (!finished && !backgrounded) stream?.resume(); });
      });
    }
  }
  await done;
  };
  // Any failure (including a rejected emit) settles the registered lifecycle; no further emits here.
  try { await body(); }
  catch { console.error("[local-exec] shell request failed; lifecycle closed without further replies"); }
  finally { clearTimeout(timeoutTimer); shells.delete(requestId); resolveDone(); }
}
export function cancelRequest(requestId: string): boolean {
  const job = shells.get(requestId);
  if (!job) return false;
  job.abort(ShellAbortReason.USER_ABORT); return true;
}

/** D:jHt 98041–98046, used by wE.handle for unregistered cases (D:98199–98201): computer use / screen recording have fixed refusals. */
const NO_HANDLER_TEXT: Record<string, string> = {
  computerUseArgs:
    "Computer use is not enabled for this environment, so the Computer tool and the computerUse subagent cannot run here. Do not retry computer actions; verify with non-GUI methods (automated tests, shell commands) instead. (No computer-use handler is registered on this exec daemon.)",
  recordScreenArgs:
    "Screen recording is not enabled for this environment, so recordings cannot be captured here. Do not retry; skip the recording and present other evidence instead. (No record-screen handler is registered on this exec daemon.)",
};

export function handleUnsupported(
  requestId: string,
  msgId: number,
  typeName: string,
  emit: Emit,
  ctx?: ThrowCwdContext,
): void {
  void (async () => {
    const cwdState = ctx ? await cwdStateForThrow(ctx.root, ctx.serverMessage) : "unset";
    const throwFrame: ExecFrameOut = {
      kind: "control",
      requestId,
      message: { throw: { id: msgId, error: NO_HANDLER_TEXT[typeName] ?? `No handler found for server message of type ${typeName}` } },
    };
    if (cwdState !== undefined) throwFrame.cwdState = cwdState;
    await emit(throwFrame);
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
  })().catch(() => console.error("[local-exec] unsupported reply failed"));
}

/** Box JSON download materializer after the caller already applied Qce/AUe (D:137534–137544 / iqe).
 * Not a UC attached stream. Callers must refuse before invoking this.
 */
export async function handleDownload(args: {
  root: string;
  requestId: string;
  filePath: string;
  emit: Emit;
}): Promise<void> {
  const { prepareDownload, readWholeFile } = await import("../uc/file-source");
  try {
    const source = await prepareDownload(args.root, args.filePath);
    const whole = await readWholeFile(source);
    if ("error" in whole) await args.emit({ kind: "file-error", requestId: args.requestId, error: whole.error });
    else await args.emit({ kind: "file", requestId: args.requestId, bytes: whole.bytes });
  } catch (e) {
    await args.emit({ kind: "file-error", requestId: args.requestId, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Official zHt = 3e3 (daemon.formatted.cjs L98040). */
export const EXEC_HEARTBEAT_MS = 3000;
/**
 * Official per-exec wrapper (wE.handle, L98140–98153 / finally L98187–98193): once a handler accepts the
 * exec, a timer writes `heartbeat{id}` into the exec's output channel every zHt ms; the next timer is armed
 * only after the previous heartbeat write settled (`.then(h)`), a failed write is swallowed and ends the
 * chain (`.catch(() => {})`), and the finally (completion, throw, cancel/abort, shutdown) clears the timer
 * and closes the channel so no frame follows. The heartbeat is an ordinary control frame in the request's
 * reply lane; it gives no keepalive credit by itself — only a successful Submit carrying it calls noteHeard.
 * Deviation: the official channel is closed in `finally`, so a timer firing between the streamClose write and
 * the finally would reject on the next write only; here the wrapper closes as soon as streamClose/throw is
 * emitted, so no heartbeat can follow the terminal frame.
 */
export async function withExecHeartbeat(requestId: string, msgId: number, emit: Emit,
  run: (emit: Emit) => Promise<void>, intervalMs = EXEC_HEARTBEAT_MS): Promise<void> {
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    trace("hb-arm", { rid: requestId, id: msgId });
    timer = setTimeout(() => {
      trace("hb-fire", { rid: requestId, id: msgId, closed });
      if (closed) return;
      let p: Promise<unknown>;
      try { p = Promise.resolve(emit({ kind: "control", requestId, message: { heartbeat: { id: msgId } } })); }
      catch (e) { p = Promise.reject(e); }
      p.then(() => { trace("hb-write-resolved", { rid: requestId, id: msgId }); if (!closed) arm(); }, () => undefined);
    }, intervalMs);
  };
  const wrapped: Emit = (f) => {
    if (f.kind === "control" && ("streamClose" in f.message || "throw" in f.message)) { closed = true; clearTimeout(timer); }
    return emit(f);
  };
  arm();
  try { await run(wrapped); }
  finally { closed = true; clearTimeout(timer); }
}

/** D:bE / $3 execute 110633–110810 — spawn into ZO; single result then streamClose. */
export async function handleBackgroundShellSpawn(args: {
  root: string; requestId: string; msgId: number; command: string;
  workingDirectory?: string; adminCommandDenylist?: string[];
  sandboxPolicy?: { type?: unknown } | null; description?: string;
  enableWriteShellStdinTool?: boolean; emit: Emit;
}): Promise<void> {
  const { root, requestId, msgId, command, emit } = args;
  const mgr = backgroundShellManagerFor(root);
  let cwd = root;
  try {
    const realRoot = fs.realpathSync(root);
    const wanted = args.workingDirectory || root;
    try { cwd = assertRealpathUnderRoot(root, wanted); }
    catch { cwd = realRoot; }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) cwd = realRoot;
    else cwd = fs.realpathSync(cwd);
  } catch (e) {
    await emit({ kind: "client", requestId, message: { id: msgId,
      backgroundShellSpawnResult: { error: { command, workingDirectory: cwd, error: e instanceof Error ? e.message : String(e) } } } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
    return;
  }
  const denylist = Array.isArray(args.adminCommandDenylist) ? args.adminCommandDenylist : [];
  const denyReason = Qk({ command, parsingResult: m3Structured(command), blockedCommands: denylist });
  if (denyReason !== undefined) {
    await emit({ kind: "client", requestId, message: { id: msgId,
      backgroundShellSpawnResult: { rejected: { command, workingDirectory: cwd, reason: denyReason } } } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
    return;
  }
  const policy = Kc(args.sandboxPolicy);
  try { assertSandboxSupported(policy); }
  catch (e) {
    if (!(e instanceof SandboxUnsupportedError)) throw e;
    await emit({ kind: "client", requestId, message: { id: msgId,
      backgroundShellSpawnResult: { sandboxUnsupported: {
        command, workingDirectory: cwd, sandboxPolicyType: policy.type,
        reason: e.reason ?? e.message, isReadonly: policy.type === "workspace_readonly",
      } } } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
    return;
  }
  try {
    const prep = await prepareShell(command, fs.realpathSync(root));
    const stdio: ("ignore" | "pipe")[] = args.enableWriteShellStdinTool
      ? ["pipe", "pipe", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", "pipe", "pipe"];
    const child = spawn(prep.bash, prep.args, { cwd, detached: true, env: prep.env, stdio });
    const stateIn = child.stdio?.[3] as NodeJS.WritableStream | null;
    stateIn?.on("error", () => undefined);
    stateIn?.end(prep.snapshotIn);
    const shellId = mgr.generateShellId();
    await mgr.adopt({
      shellId, command, workingDirectory: cwd, pid: child.pid, initialOutput: "",
      startTime: Date.now(), showElapsedTime: true, description: args.description, child,
    });
    await emit({ kind: "client", requestId, message: { id: msgId,
      backgroundShellSpawnResult: { success: {
        shellId, command, workingDirectory: cwd, ...(child.pid !== undefined ? { pid: child.pid } : {}),
      } } } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
  } catch (e) {
    await emit({ kind: "client", requestId, message: { id: msgId,
      backgroundShellSpawnResult: { error: { command, workingDirectory: cwd, error: e instanceof Error ? e.message : String(e) } } } });
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
  }
}

/** D:ZO.writeStdin 110510. Not registered in Tft (D:132615–132670) — wire writeShellStdinArgs stays No handler. */
export async function handleWriteShellStdin(args: {
  root: string; requestId: string; msgId: number; shellId?: number; data?: string; emit: Emit;
}): Promise<void> {
  const { root, requestId, msgId, emit } = args;
  try {
    if (typeof args.shellId !== "number") throw new Error("Shell not found");
    await backgroundShellManagerFor(root).writeStdin(args.shellId, args.data ?? "");
    await emit({ kind: "client", requestId, message: { id: msgId, writeShellStdinResult: { success: {} } } });
  } catch (e) {
    await emit({ kind: "client", requestId, message: { id: msgId,
      writeShellStdinResult: { error: { error: e instanceof Error ? e.message : String(e) } } } });
  }
  await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
}

export function detectServerMessageType(serverMessage: Record<string, unknown>): string {
  for (const k of Object.keys(serverMessage)) {
    if (k.endsWith("Args") || k === "readArgs" || k === "lsArgs" || k === "shellStreamArgs") return k;
  }
  // Official throws "...of type ${case}" with case undefined for unknown oneofs.
  return "undefined";
}

/** D:i5r 130633 — the shell stream default timeout. */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
/**
 * D:t5e — effective foreground timeout: a non-zero `timeout` wins; otherwise 0 for background
 * shells (isBackground / TIMEOUT_BEHAVIOR_BACKGROUND / hardTimeout > 0), else i5r (30 s).
 * Soft timeout for BACKGROUND / isBackground is the r5e wait (D:130721); 0 backgrounds immediately.
 * hardTimeout>0 alone also yields 0 (original setTimeout(abort,0) when not BACKGROUND).
 */

export function isBackgroundTimeoutBehavior(a: { isBackground?: unknown; timeoutBehavior?: unknown }): boolean {
  return a.isBackground === true
    || a.timeoutBehavior === "TIMEOUT_BEHAVIOR_BACKGROUND"
    || a.timeoutBehavior === "BACKGROUND"
    || a.timeoutBehavior === 2;
}

function startSandboxPolicyJson(policy: InternalSandboxPolicy): Record<string, unknown> {
  if (policy.type === "workspace_readonly") return new SandboxPolicy({ type: SandboxPolicy_Type.WORKSPACE_READONLY }).toJson() as Record<string, unknown>;
  if (policy.type === "workspace_readwrite") return new SandboxPolicy({ type: SandboxPolicy_Type.WORKSPACE_READWRITE }).toJson() as Record<string, unknown>;
  return new SandboxPolicy({ type: SandboxPolicy_Type.INSECURE_NONE }).toJson() as Record<string, unknown>;
}

export function shellTimeoutMs(a: { timeout?: unknown; isBackground?: unknown; timeoutBehavior?: unknown; hardTimeout?: unknown }): number {
  const t = typeof a.timeout === "number" ? a.timeout : Number(a.timeout ?? 0) || 0;
  if (t !== 0) return t;
  const bg = a.isBackground === true || a.timeoutBehavior === "TIMEOUT_BEHAVIOR_BACKGROUND" || a.timeoutBehavior === 2
    || (typeof a.hardTimeout === "number" && a.hardTimeout > 0);
  return bg ? 0 : DEFAULT_SHELL_TIMEOUT_MS;
}

export async function dispatchExec(args: {
  root: string;
  requestId: string;
  serverMessage: Record<string, unknown>;
  permission: PermissionMode;
  emit: Emit;
  /** Ki exec output channel (D:14896–14972); UC and Box both set it. Off only for direct unit callers. */
  pullOutput?: boolean;
  /** The owning provider's executor counter (D:135935); Box and each UC provider pass their own. */
  execIds?: ExecIdCounter;
}): Promise<void> {
  const { root, requestId, serverMessage, permission, emit } = args;
  const heartbeat = args.pullOutput
    ? (rid: string, id: number, output: Emit, run: (write: Emit) => Promise<void>) => withExecChannelHeartbeat(rid, id, output, run, () => { cancelRequest(rid); })
    : withExecHeartbeat;
  // Do not echo serverMessage.id — official maps e.g. server id=7 → local sequential id starting at 1.
  const msgId = args.execIds ? args.execIds.allocate() : allocateExecId();

  if (serverMessage.readArgs && typeof serverMessage.readArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const p = (serverMessage.readArgs as { path?: string }).path;
    if (!p) {
      handleUnsupported(requestId, msgId, "readArgs", emit, { root, serverMessage });
      return;
    }
    await heartbeat(requestId, msgId, emit, (e) => handleRead({ root, requestId, msgId, path: p, emit: e }));
    return;
  }
  if (serverMessage.lsArgs && typeof serverMessage.lsArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const la = serverMessage.lsArgs as { path?: string; ignore?: unknown; timeoutMs?: unknown; sandboxPolicy?: { type?: unknown } | null };
    const p = la.path || root;
    const ignore = Array.isArray(la.ignore) ? la.ignore.filter((x): x is string => typeof x === "string") : undefined;
    const timeoutMs = typeof la.timeoutMs === "number" ? la.timeoutMs : undefined;
    await heartbeat(requestId, msgId, emit, (e) => handleLs({ root, requestId, msgId, path: p, emit: e, ignore, timeoutMs, sandboxPolicy: la.sandboxPolicy }));
    return;
  }
  if (serverMessage.shellStreamArgs && typeof serverMessage.shellStreamArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const a = serverMessage.shellStreamArgs as {
      command?: string;
      workingDirectory?: string;
      timeout?: number;
      isBackground?: boolean;
      timeoutBehavior?: string | number;
      hardTimeout?: number;
      adminCommandDenylist?: string[];
      requestedSandboxPolicy?: { type?: unknown } | null;
      description?: string;
    };
    if (!a.command) {
      handleUnsupported(requestId, msgId, "shellStreamArgs", emit, { root, serverMessage });
      return;
    }
    const command = a.command;
    await heartbeat(requestId, msgId, emit, (e) => handleShellStream({
      root,
      requestId,
      msgId,
      command,
      workingDirectory: a.workingDirectory,
      timeout: shellTimeoutMs(a),
      timeoutBehavior: a.timeoutBehavior,
      isBackground: a.isBackground,
      hardTimeout: typeof a.hardTimeout === "number" ? a.hardTimeout : undefined,
      adminCommandDenylist: a.adminCommandDenylist,
      requestedSandboxPolicy: a.requestedSandboxPolicy,
      description: a.description,
      emit: e,
    }));
    return;
  }
  if (serverMessage.backgroundShellSpawnArgs && typeof serverMessage.backgroundShellSpawnArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const a = serverMessage.backgroundShellSpawnArgs as {
      command?: string;
      workingDirectory?: string;
      adminCommandDenylist?: string[];
      sandboxPolicy?: { type?: unknown } | null;
      description?: string;
      enableWriteShellStdinTool?: boolean;
    };
    if (!a.command) {
      handleUnsupported(requestId, msgId, "backgroundShellSpawnArgs", emit, { root, serverMessage });
      return;
    }
    await heartbeat(requestId, msgId, emit, (e) => handleBackgroundShellSpawn({
      root, requestId, msgId, command: a.command!, workingDirectory: a.workingDirectory,
      adminCommandDenylist: a.adminCommandDenylist, sandboxPolicy: a.sandboxPolicy,
      description: a.description, enableWriteShellStdinTool: a.enableWriteShellStdinTool, emit: e,
    }));
    return;
  }
  const typeName = detectServerMessageType(serverMessage);
  handleUnsupported(requestId, msgId, typeName, emit, { root, serverMessage });
}
