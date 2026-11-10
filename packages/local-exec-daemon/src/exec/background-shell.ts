/**
 * Background shell manager (ZO D:110394, p1e terminal logging D:110252–110393, f1e adopt D:110025).
 * Soft-timeout BACKGROUND handoff from shellStream (E_ D:131146–131184) and direct
 * backgroundShellSpawnArgs (bE / $3 D:110633–110810).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildProcess } from "node:child_process";

const YO = 1000;       // D:109689
const u1e = 999999;    // D:109690
const HEADER_INTERVAL_MS = 5000; // D:cYe 110248

export type BackgroundReason = "TIMEOUT" | "USER_REQUEST";

export type BgShell = {
  id: number;
  pid?: number;
  abort: () => void;
  stdin?: NodeJS.WritableStream | null;
};

function quoteField(t: string): string {
  // D:WO 110228
  return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** D:HO 110232 — terminal file header. */
export function terminalHeader(t: {
  pid?: number; cwd: string; command: string; title?: string;
  status: string; startedAt: string; runningForMs: number;
}): string {
  const e = String(t.runningForMs).padEnd(9, " ");
  const r = t.status.padEnd(9, " ");
  let n = "---\n";
  if (t.pid !== undefined && t.pid !== 0) n += `pid: ${t.pid}\n`;
  n += `cwd: ${quoteField(t.cwd)}\n`;
  n += `command: ${quoteField(t.command)}\n`;
  if (t.title !== undefined && t.title.trim().length > 0) n += `title: ${quoteField(t.title)}\n`;
  n += `status: ${r}\n`;
  n += `started_at: ${t.startedAt}\n`;
  n += `running_for_ms: ${e}\n`;
  n += `---\n`;
  return n;
}

export class BackgroundShellManager {
  private running = new Map<number, BgShell & { child?: ChildProcess; cleanup?: () => void }>();
  private nextId = YO;

  constructor(private projectDir: string) {}

  /** D:generateShellId 110500–110508 */
  generateShellId(): number {
    for (let e = 0; e <= u1e - YO; e++) {
      if (this.nextId > u1e) this.nextId = YO;
      const r = this.nextId;
      this.nextId += 1;
      if (!this.running.has(r)) return r;
    }
    throw new Error("No available background shell id in range");
  }

  terminalsDir(): string { return path.join(this.projectDir, "terminals"); }

  abort(id: number): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.abort();
    this.running.delete(id);
    r.cleanup?.();
    return true;
  }

  isRunning(id: number): boolean { return this.running.has(id); }

  dispose(): void {
    for (const [id, r] of this.running) { r.abort(); r.cleanup?.(); this.running.delete(id); }
    this.running.clear();
  }

  /**
   * D:p1e.adopt 110252 — write terminals/{id}.txt header + initialOutput, then append further
   * stdout/stderr until exit; refresh header every 5 s.
   */
  async adopt(args: {
    shellId: number;
    command: string;
    workingDirectory: string;
    pid?: number;
    initialOutput: string;
    startTime: number;
    showElapsedTime?: boolean;
    description?: string;
    child: ChildProcess;
    /** Called when the background shell is cleaned up (hardTimeout clear etc.). */
    onCleanup?: () => void;
  }): Promise<{ shellId: number; pid?: number }> {
    const dir = this.terminalsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${args.shellId}.txt`);
    const startedAt = new Date(args.startTime).toISOString();
    let status = "running";
    let header =
      terminalHeader({
        pid: args.pid, cwd: args.workingDirectory, command: args.command,
        title: args.description, status, startedAt, runningForMs: Date.now() - args.startTime,
      }) + (args.initialOutput ?? "");
    await fs.promises.writeFile(file, header, "utf8");

    const fh = await fs.promises.open(file, "r+");
    let append: fs.promises.FileHandle;
    try { append = await fs.promises.open(file, "a"); }
    catch (e) { await fh.close(); throw e; }

    let closed = false, ended = false;
    let chain = Promise.resolve();
    const rewriteHeader = async () => {
      const v = terminalHeader({
        pid: args.pid, cwd: args.workingDirectory, command: args.command,
        title: args.description, status, startedAt, runningForMs: Date.now() - args.startTime,
      });
      try { await fh.write(v, 0, "utf8"); } catch { /* ignore */ }
    };
    const scheduleHeader = () => { chain = chain.then(rewriteHeader).catch(() => undefined); return chain; };
    let timer: NodeJS.Timeout | undefined = setInterval(() => { void scheduleHeader(); }, HEADER_INTERVAL_MS);
    const stopTimer = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };

    const closeFiles = async () => {
      if (closed) return;
      closed = true; stopTimer(); await chain;
      try { await fh.close(); } catch { /* */ }
      try { await append.close(); } catch { /* */ }
    };
    const writeAppend = async (b: string) => { try { await append.write(b); } catch { /* */ } };
    const finish = async (st: string, exitLine?: string) => {
      if (ended) return;
      ended = true; stopTimer();
      if (exitLine !== undefined) {
        const elapsed = Date.now() - args.startTime;
        const block = `\n---\n${exitLine}\n` +
          (args.showElapsedTime !== false ? `elapsed_ms: ${elapsed}\n` : "") +
          `ended_at: ${new Date().toISOString()}\n---\n`;
        await writeAppend(block);
      }
      status = st;
      await scheduleHeader();
    };

    const onData = (chunk: Buffer | string) => { void writeAppend(typeof chunk === "string" ? chunk : chunk.toString("utf8")); };
    args.child.stdout?.on("data", onData);
    args.child.stderr?.on("data", onData);

    const groupKill = (sig: NodeJS.Signals) => {
      if (!args.child.pid) return;
      try { process.kill(-args.child.pid, sig); } catch { /* */ }
    };

    const entry: BgShell & { child?: ChildProcess; cleanup?: () => void; dispose?: () => void } = {
      id: args.shellId,
      pid: args.pid,
      child: args.child,
      stdin: args.child.stdin,
      abort: () => {
        groupKill("SIGTERM");
        // unref so abort() cannot keep a test or CLI process alive if the child is already gone
        setTimeout(() => groupKill("SIGKILL"), 250).unref();
      },
      cleanup: args.onCleanup,
    };
    this.running.set(args.shellId, entry);

    let settled = false;
    const settle = (work: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      void work();
    };
    const onChildClose = (code: number | null) => {
      settle(async () => {
        await finish(
          code === 0 ? "succeeded" : "failed",
          `exit_code: ${code ?? "unknown"}`,
        );
        await closeFiles();
        this.running.delete(args.shellId);
        args.onCleanup?.();
      });
    };
    const onChildError = () => {
      settle(async () => {
        await finish("failed");
        await closeFiles();
        this.running.delete(args.shellId);
        args.onCleanup?.();
      });
    };
    // Attach first, then handle an already-exited child. `echo` / `true` can exit
    // before adopt() runs; missing the close event used to leak the 5s header
    // interval and hang `node --test` until the job was killed.
    args.child.once("close", onChildClose);
    args.child.once("error", onChildError);
    if (args.child.exitCode !== null || args.child.signalCode !== null) {
      onChildClose(args.child.exitCode);
    }

    // Detach request-side listeners: keep pipes flowing into the terminal file.
    args.child.stdout?.resume();
    args.child.stderr?.resume();

    return { shellId: args.shellId, pid: args.pid };
  }

  /** D:writeStdin 110510–110540 — write; EOT (\\u0004) ends stdin. */
  async writeStdin(id: number, data: string): Promise<void> {
    const n = this.running.get(id);
    if (!n) throw new Error("Shell not found");
    if (!n.stdin) throw new Error("Shell stdin not available");
    const s = "\u0004", o = "\\u0004";
    const i = data.indexOf(s);
    const a = i !== -1 ? i : data.indexOf(o);
    if (a !== -1) {
      const u = data.substring(0, a);
      if (u.length > 0) {
        await new Promise<void>((l, d) => { n.stdin!.write(u, (f) => { f ? d(f) : l(); }); });
      }
      n.stdin.end();
    } else {
      await new Promise<void>((u, l) => { n.stdin!.write(data, (d) => { d ? l(d) : u(); }); });
    }
  }
}

/** Per-root managers (Tft constructs one per daemon root). */
const managers = new Map<string, BackgroundShellManager>();
export function backgroundShellManagerFor(root: string): BackgroundShellManager {
  const key = path.resolve(root);
  let m = managers.get(key);
  if (!m) { m = new BackgroundShellManager(key); managers.set(key, m); }
  return m;
}
