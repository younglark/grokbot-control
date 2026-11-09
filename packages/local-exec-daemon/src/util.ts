import * as os from "node:os";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { lifecycleTrace } from "./trace";
import { cp } from "./state/fs-write";

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function filesKeyIdFromBase64Key(keyB64: string): string {
  return crypto.createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 16);
}

/**
 * Atomic write through the original's cp (src/state/fs-write.ts, D:80591). Lifecycle trace points for the
 * discovery file are test instrumentation only. `mode` undefined = the original's no-mode call (existing file mode
 * or 0o666 & ~umask).
 */
export async function writeAtomic(filePath: string, data: string, mode?: number): Promise<void> {
  const discovery = path.basename(filePath) === "local-exec-daemon.json";
  if (discovery) lifecycleTrace("discovery:write-begin");
  await cp(filePath, data, mode != null ? { mode } : {}, discovery ? {
    tempDone: () => lifecycleTrace("discovery:temp-done"),
    renameBegin: () => lifecycleTrace("discovery:rename-begin"),
    renameDone: () => lifecycleTrace("discovery:rename-done"),
  } : {});
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const discovery = path.basename(filePath) === "local-exec-daemon.json";
    if (discovery) lifecycleTrace("discovery:read-begin");
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as T;
    if (discovery) lifecycleTrace("discovery:read-done", { owner: (parsed as {pid?: number})?.pid });
    return parsed;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function dataRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.SAND_DATA_ROOT || env.SAND_USER_DATA_DIR || path.join(env.HOME || "/tmp", ".sand-local-exec");
}

/** wft (D:132542–132545), passed raw as lgt root (D:187320): trimmed SAND_LOCAL_EXEC_ROOT → trimmed
 *  SAND_AGENT_PROJECT_DIR → os.homedir(). The App sets neither (static main-core env R$e), so a real launch serves the
 *  home directory; the previous process.cwd() fallback served the inherited cwd instead (t165 drop-in fix). */
export function localRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const e = env.SAND_LOCAL_EXEC_ROOT?.trim() || env.SAND_AGENT_PROJECT_DIR?.trim();
  return e != null && e.length > 0 ? e : os.homedir();
}

export function logInfo(msg: string): void {
  console.log(`[sand-local-exec-daemon] ${msg}`);
}

export function logFatal(): void {
  // Match official external diagnostic shape used by offline lab oracle.
  console.error(`[sand-local-exec-daemon] fatal: Error`);
}
