import { trace } from "../trace";
import { proto3 } from "@bufbuild/protobuf";
import {
  ExecClientMessage,
  LsError,
  LsResult,
  ShellAbortReason,
  SandboxPolicy,
  SandboxPolicy_Type,
} from "../generated/agent.v1_pb";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { assertRealpathUnderRoot, assertUnderRoot, PathGuardError } from "./path";
import type { PermissionMode } from "../settings";
import { commitShell, getSessionCwd, MAX_STATE_BYTES, prepareShell, terminateInitialSnapshot, type PreparedShell } from "./shell-session";

export type ExecFrameOut =
  | { kind: "client"; requestId: string; message: Record<string, unknown> }
  | { kind: "control"; requestId: string; message: Record<string, unknown>; cwdState?: string }
  | { kind: "file-error" | "messages-error"; requestId: string; error: string };

export type Emit = (frame: ExecFrameOut) => void | Promise<void>;

type ShellJob = { abort: (reason: ShellAbortReason) => void; done: Promise<void> };
const shells = new Map<string, ShellJob>();
/** Official daemon allocates inner exec message ids locally: nextExecId=1 then o.id=a. */
let nextExecId = 1;
let lastAllocatedExecId = 0;
export function allocateExecId(): number {
  lastAllocatedExecId = nextExecId++;
  trace("exec-id", { id: lastAllocatedExecId });
  return lastAllocatedExecId;
}
/** Most recent allocateExecId() result (0 if none since reset). For catch paths that must not double-allocate. */
export function lastAllocatedExecIdOrZero(): number {
  return lastAllocatedExecId;
}
/** Test-only: reset sequential inner ids to match a fresh daemon instance. */
export function resetExecIdCounter(value = 1): void {
  nextExecId = value;
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

/** Exact official 0.79.3 message (daemon.formatted.cjs L19008–19011, nl()). */
export const RIPGREP_UNCONFIGURED =
  "Ripgrep path not configured. Call configureRipgrepPath() at startup.";

export async function handleLs(args: {
  root: string;
  requestId: string;
  msgId: number;
  path: string;
  emit: Emit;
}): Promise<void> {
  // Official 0.79.3 Linux: LocalLsExecutor (L129403+) calls nl() before the
  // ripgrep tree build; the module-level ripgrep path (Z2) is never assigned in
  // this build, so the reachable behavior is LsResult.error with the requested
  // path. Verified by isolated oracle (docs/local-exec-scenario-matrix.md,
  // official-v2 "ls"). We match the observed behavior, not the design intent.
  // Path guard stays (official ls escape behavior is unverified).
  const { root, requestId, msgId, emit } = args;
  try {
    const abs = assertRealpathUnderRoot(root, args.path);
    const client = new ExecClientMessage({
      id: msgId,
      message: {
        case: "lsResult",
        value: new LsResult({
          result: { case: "error", value: new LsError({ path: abs, error: RIPGREP_UNCONFIGURED }) },
        }),
      },
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
}): Promise<void> {
  const { root, requestId, msgId, command } = args;
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
  // Official shell executor yields `start` before it spawns (daemon.formatted.cjs L130994–130996), so start
  // frames follow admission order; emitting on the child's async 'spawn' event reordered lanes (t112 fair gate).
  await emit({ kind: "client", requestId, message: { id: msgId,
    shellStream: { start: { sandboxPolicy: new SandboxPolicy({type: SandboxPolicy_Type.INSECURE_NONE}).toJson() } }, localExecutionTimeMs: 1 } });
  startSent = true;
  if (pendingReason !== undefined) { await emitAborted(pendingReason, cwd); return; }
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
    let reason: ShellAbortReason | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const groupKill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    };
    const finish = async (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer); clearTimeout(deadline); clearTimeout(escalation); clearTimeout(drain);
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
    abortJob = (why) => {
      if (finished || reason) return;
      reason = why; groupKill("SIGTERM");
      escalation = setTimeout(() => groupKill("SIGKILL"), 250);
      deadline = setTimeout(() => finish(null), 750);
    };
    child.once("error", (e) => finish(null, e));
    child.once("close", (code) => { void finish(code); });
    child.once("exit", (code) => {
      // Isolated original oracle: 4s background drains naturally; both 6s
      // background cases exit at ~5.04s, do not kill the background, and no
      // delayed stdout appears during 2.5s post-exit observation. Preserve
      // that observed bounded normal drain, separately from abort deadlines.
      drain = setTimeout(() => { void finish(code); }, 5000);
    });
    if (args.timeout && args.timeout > 0) timeoutTimer = setTimeout(() => abortJob(ShellAbortReason.TIMEOUT), args.timeout);
    for (const [stream, name] of [[child.stdout, "stdout"], [child.stderr, "stderr"]] as const) {
      stream?.on("data", (b: Buffer) => {
        if (finished) return;
        stream?.pause();
        Promise.resolve(emit({ kind: "client", requestId, message: { id: msgId,
          shellStream: { [name]: { data: b.toString("utf8") } }, localExecutionTimeMs: Date.now() - startedAt } }))
          .catch(() => abortJob(ShellAbortReason.USER_ABORT))
          .finally(() => { if (!finished) stream?.resume(); });
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
      message: { throw: { id: msgId, error: `No handler found for server message of type ${typeName}` } },
    };
    if (cwdState !== undefined) throwFrame.cwdState = cwdState;
    await emit(throwFrame);
    await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
  })().catch(() => console.error("[local-exec] unsupported reply failed"));
}

export function handleDownload(args: {
  root: string;
  requestId: string;
  filePath: string;
  permission: PermissionMode;
  emit: Emit;
}): void {
  const { requestId, emit, permission } = args;
  if (refuseByPermission(permission, requestId, emit)) return;
  try {
    assertRealpathUnderRoot(args.root, args.filePath);
    // Minimal: refuse to invent upload protocol; report not implemented for Always.
    emit({
      kind: "file-error",
      requestId,
      error: "Download streaming is not implemented in this P1 skeleton (path guards OK).",
    });
  } catch (e) {
    emit({
      kind: "file-error",
      requestId,
      error: e instanceof PathGuardError ? e.message : String(e),
    });
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

export function detectServerMessageType(serverMessage: Record<string, unknown>): string {
  for (const k of Object.keys(serverMessage)) {
    if (k.endsWith("Args") || k === "readArgs" || k === "lsArgs" || k === "shellStreamArgs") return k;
  }
  // Official throws "...of type ${case}" with case undefined for unknown oneofs.
  return "undefined";
}

export async function dispatchExec(args: {
  root: string;
  requestId: string;
  serverMessage: Record<string, unknown>;
  permission: PermissionMode;
  emit: Emit;
}): Promise<void> {
  const { root, requestId, serverMessage, permission, emit } = args;
  // Do not echo serverMessage.id — official maps e.g. server id=7 → local sequential id starting at 1.
  const msgId = allocateExecId();

  if (serverMessage.readArgs && typeof serverMessage.readArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const p = (serverMessage.readArgs as { path?: string }).path;
    if (!p) {
      handleUnsupported(requestId, msgId, "readArgs", emit, { root, serverMessage });
      return;
    }
    await withExecHeartbeat(requestId, msgId, emit, (e) => handleRead({ root, requestId, msgId, path: p, emit: e }));
    return;
  }
  if (serverMessage.lsArgs && typeof serverMessage.lsArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const p = (serverMessage.lsArgs as { path?: string }).path || root;
    await withExecHeartbeat(requestId, msgId, emit, (e) => handleLs({ root, requestId, msgId, path: p, emit: e }));
    return;
  }
  if (serverMessage.shellStreamArgs && typeof serverMessage.shellStreamArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const a = serverMessage.shellStreamArgs as {
      command?: string;
      workingDirectory?: string;
      timeout?: number;
    };
    if (!a.command) {
      handleUnsupported(requestId, msgId, "shellStreamArgs", emit, { root, serverMessage });
      return;
    }
    const command = a.command;
    await withExecHeartbeat(requestId, msgId, emit, (e) => handleShellStream({
      root,
      requestId,
      msgId,
      command,
      workingDirectory: a.workingDirectory,
      timeout: a.timeout,
      emit: e,
    }));
    return;
  }
  if (serverMessage.backgroundShellSpawnArgs) {
    handleUnsupported(requestId, msgId, "backgroundShellSpawnArgs", emit, { root, serverMessage });
    return;
  }
  const typeName = detectServerMessageType(serverMessage);
  handleUnsupported(requestId, msgId, typeName, emit, { root, serverMessage });
}
