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
import { commitShell, prepareShell, type PreparedShell } from "./shell-session";

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
export async function requestError(requestId: string, msgId: number, error: unknown, emit: Emit): Promise<void> {
  await emit({ kind: "control", requestId, message: { throw: { id: msgId, error: String(error instanceof Error ? error.message : error) } }, cwdState: "unset" });
  await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
}
export async function shutdownShells(): Promise<void> {
  const jobs = [...shells.values()];
  jobs.forEach(j => j.abort(ShellAbortReason.USER_ABORT));
  await Promise.all(jobs.map(j => j.done));
}

const NEVER_MSG =
  'Local tools are turned off. The user has set local tool access to "Never", so Shell, Read, and AwaitShell with machineId, plus CopyToBox and CopyFromBox, cannot run on their computer. Do not retry them while this setting remains "Never". Use your own computer instead by omitting machineId, or ask the user to change the setting in Settings → Bot → Execution on Local Computer. If they change it away from "Never", you may try again.';

const ASK_MSG =
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
    await requestError(requestId, msgId, e, emit);
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
    await requestError(requestId, msgId, e, emit);
  }
}

export async function handleShellStream(args: {
  root: string; requestId: string; msgId: number; command: string;
  workingDirectory?: string; timeout?: number; emit: Emit;
}): Promise<void> {
  const { root, requestId, msgId, command, emit } = args;
  let cwd: string;
  let prepared: PreparedShell;
  let notice: string | undefined;
  try {
    const realRoot = fs.realpathSync(root);
    const wanted = args.workingDirectory || root;
    // Official (oracle sh-badcwd): a missing working directory is not an error;
    // stderr notice first, then run in the root. Escapes stay refused here
    // (official escape behavior for cwd is unverified).
    assertUnderRoot(realRoot, path.resolve(realRoot, wanted));
    if (!fs.existsSync(path.resolve(realRoot, wanted))) {
      notice = `working directory ${path.resolve(realRoot, wanted)} does not exist on this machine; running in ${realRoot} instead\n`;
      cwd = realRoot;
    } else {
      cwd = assertRealpathUnderRoot(root, wanted);
      if (!(await fs.promises.stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    }
    prepared = await prepareShell(command, realRoot);
  } catch (e) { await requestError(requestId, msgId, e, emit); return; }
  if (notice) await emit({ kind: "client", requestId, message: { id: msgId, shellStream: { stderr: { data: notice } }, localExecutionTimeMs: 0 } });
  const startedAt = Date.now();
  let abortJob: (reason: ShellAbortReason) => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    const child = spawn(prepared.bash, prepared.args, {
      cwd, detached: true,
      env: prepared.env,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const stateIn = child.stdio?.[3] as NodeJS.WritableStream | null;
    const stateOut = child.stdio?.[4] as NodeJS.ReadableStream | null;
    let dumped = "";
    stateIn?.on("error", () => undefined);
    stateIn?.end(prepared.snapshotIn);
    stateOut?.on("data", (b: Buffer) => { if (dumped.length < 4 * 1024 * 1024) dumped += b.toString("utf8"); });
    stateOut?.on("error", () => undefined);
    let finished = false;
    let reason: ShellAbortReason | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const groupKill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
    };
    const finish = async (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearTimeout(deadline); clearTimeout(escalation); clearTimeout(drain);
      if (reason) groupKill("SIGKILL");
      child.stdout?.destroy(); child.stderr?.destroy();
      shells.delete(requestId);
      const finalCwd = commitShell(dumped, Boolean(reason) || Boolean(error)) ?? cwd;
      try {
      if (error) await requestError(requestId, msgId, error, emit);
      else {
        const elapsed = Date.now() - startedAt;
        await emit({ kind: "client", requestId, message: { id: msgId,
          shellStream: { exit: { code: reason ? 4294967295 : (code ?? 4294967295), cwd: finalCwd,
            ...(reason ? { aborted: true, abortReason: proto3.getEnumType(ShellAbortReason).findNumber(reason)!.name } : {}), localExecutionTimeMs: elapsed } },
          localExecutionTimeMs: elapsed } });
        await emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
      }
      } catch { console.error("[local-exec] reply emission failed during shell completion"); }
      resolve();
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
    child.once("spawn", () => {
      emit({ kind: "client", requestId, message: { id: msgId,
        shellStream: { start: { sandboxPolicy: new SandboxPolicy({type: SandboxPolicy_Type.INSECURE_NONE}).toJson() } }, localExecutionTimeMs: 1 } });
    });
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
    if (args.timeout && args.timeout > 0) timeout = setTimeout(() => abortJob(ShellAbortReason.TIMEOUT), args.timeout);
  });
  shells.set(requestId, { abort: why => abortJob(why), done });
  await done;
}
export function cancelRequest(requestId: string): boolean {
  const job = shells.get(requestId);
  if (!job) return false;
  job.abort(ShellAbortReason.USER_ABORT); return true;
}

export function handleUnsupported(requestId: string, msgId: number, typeName: string, emit: Emit): void {
  emit({
    kind: "control",
    requestId,
    message: { throw: { id: msgId, error: `No handler found for server message of type ${typeName}` } },
    cwdState: "unset",
  });
  emit({ kind: "control", requestId, message: { streamClose: { id: msgId } } });
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
      handleUnsupported(requestId, msgId, "readArgs", emit);
      return;
    }
    await handleRead({ root, requestId, msgId, path: p, emit });
    return;
  }
  if (serverMessage.lsArgs && typeof serverMessage.lsArgs === "object") {
    if (refuseByPermission(permission, requestId, emit)) return;
    const p = (serverMessage.lsArgs as { path?: string }).path || root;
    await handleLs({ root, requestId, msgId, path: p, emit });
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
      handleUnsupported(requestId, msgId, "shellStreamArgs", emit);
      return;
    }
    await handleShellStream({
      root,
      requestId,
      msgId,
      command: a.command,
      workingDirectory: a.workingDirectory,
      timeout: a.timeout,
      emit,
    });
    return;
  }
  if (serverMessage.backgroundShellSpawnArgs) {
    handleUnsupported(requestId, msgId, "backgroundShellSpawnArgs", emit);
    return;
  }
  const typeName = detectServerMessageType(serverMessage);
  handleUnsupported(requestId, msgId, typeName, emit);
}
