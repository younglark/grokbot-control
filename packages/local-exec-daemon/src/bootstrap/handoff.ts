import { describeError } from "../box/provider";
import { logFatal } from "../util";

export const FILE_KEY_HANDOFF_TYPE = "sand-local-exec-file-key"; // D:i$t 79671

/** D:Uae 79679–79687 result: key is null unless it decodes to 32 bytes (Bae, lenient base64); computerId trimmed (Lae). */
export type FileKeyHandoff = { key: string | null; computerId?: string };

const isRecord = (t: unknown): t is Record<string, unknown> => typeof t === "object" && t !== null && !Array.isArray(t); // D:Ke 78764
/** D:Lae 79662–79666 */
function trimmedId(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const e = t.trim();
  return e.length > 0 && e.length <= 127 ? e : undefined;
}
/** D:Bae 79676 */
const isFileKey = (t: string): boolean => Buffer.from(t, "base64").length === 32;

/** D:Uae 79679–79687: a message of another type (or not an object) is null → ignored by the waiter. */
export function parseHandoff(msg: unknown): FileKeyHandoff | null {
  if (!isRecord(msg) || msg.type !== FILE_KEY_HANDOFF_TYPE) return null;
  const { key } = msg;
  const computerId = trimmedId(msg.computerId);
  return { key: typeof key === "string" && isFileKey(key) ? key : null, ...(computerId === undefined ? {} : { computerId }) };
}

type PortLike = { on(ev: string, cb: (e: { data?: unknown }) => void): void; start?(): void };
/** D:oqr 187212–187231 */
function parentPortOf(proc: NodeJS.Process): PortLike | null {
  if (!("parentPort" in proc)) return null;
  const e = (proc as unknown as { parentPort: unknown }).parentPort;
  if (!isRecord(e)) return null;
  const r = e.on, n = e.start;
  if (typeof r !== "function") return null;
  return { on: (ev, cb) => { r.call(e, ev, cb); }, ...(typeof n === "function" ? { start: () => { n.call(e); } } : {}) };
}

/**
 * D:iqr 187232–187283 (v7t "local-exec-daemon-file-key-handoff", 5 s, D:187193). Resolves `{ key, computerId? }`:
 * - parentPort (Electron utilityProcess): first message whose data parses (Uae) wins; others are ignored; timeout → key null.
 * - no IPC channel: the pre-IPC env key (sqr D:187198/187204, already removed from the env) with no computerId.
 * - Node IPC: same as parentPort; `disconnect` → key null; timeout → key null; afterwards listeners are removed and
 *   the IPC channel is disconnected (`process.connected && process.disconnect()`, D:187278–187282).
 * The caller (cqr D:187302–187303) treats a missing computerId as fatal.
 */
export async function awaitHandoff(timeoutMs = 5000, preIpcFileKey: string | null = null): Promise<FileKeyHandoff> {
  const port = parentPortOf(process);
  if (port !== null) {
    return await new Promise<FileKeyHandoff>((resolve) => {
      const t = setTimeout(() => resolve({ key: null }), timeoutMs);
      port.on("message", (s) => {
        const o = parseHandoff(s?.data);
        if (o !== null) { clearTimeout(t); resolve(o); }
      });
      port.start?.();
    });
  }
  if (process.channel == null) return { key: preIpcFileKey };
  let onMessage: ((m: unknown) => void) | undefined, onDisconnect: (() => void) | undefined;
  try {
    return await new Promise<FileKeyHandoff>((resolve) => {
      const t = setTimeout(() => resolve({ key: null }), timeoutMs);
      onMessage = (m: unknown) => { const o = parseHandoff(m); if (o !== null) { clearTimeout(t); resolve(o); } };
      onDisconnect = () => { clearTimeout(t); resolve({ key: null }); };
      process.on("message", onMessage);
      process.once("disconnect", onDisconnect);
    });
  } finally {
    if (onMessage) process.off("message", onMessage);
    if (onDisconnect) process.off("disconnect", onDisconnect);
    if (process.connected) process.disconnect();
  }
}

/** D:cqr catch 187341–187348: `[sand-local-exec-daemon] fatal: ${xt(e)}` then exit 1. No argument → "Error". */
export function exitFatal(error?: unknown): never {
  if (error === undefined) logFatal();
  else console.error(`[sand-local-exec-daemon] fatal: ${describeError(error instanceof Error ? error : new Error(String(error)))}`);
  process.exit(1);
}
