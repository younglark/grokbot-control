import { describeError } from "../box/provider";
import { logFatal } from "../util";

export type FileKeyHandoff = {
  type: "sand-local-exec-file-key";
  key: string;
  computerId: string;
};

const KEY_RE = /^[A-Za-z0-9+/]+=*$/;

export function parseHandoff(msg: unknown): FileKeyHandoff | null {
  if (msg == null || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "sand-local-exec-file-key") return null;
  if (typeof m.key !== "string" || !KEY_RE.test(m.key) || Buffer.from(m.key, "base64").length !== 32) {
    return null;
  }
  if (typeof m.computerId !== "string" || m.computerId.length === 0) return null;
  return { type: "sand-local-exec-file-key", key: m.key, computerId: m.computerId };
}

export type HandoffResult =
  | { ok: true; handoff: FileKeyHandoff }
  | { ok: false; reason: "timeout" | "invalid" | "disconnect" | "no-channel" };

/**
 * Wait for IPC or parentPort handoff. Official waits ~5s then fatal.
 */
export async function awaitHandoff(timeoutMs = 5000): Promise<HandoffResult> {
  const proc = process as NodeJS.Process & {
    parentPort?: { once: (ev: string, cb: (e: { data: unknown }) => void) => void };
    channel?: unknown;
  };

  if (proc.parentPort) {
    return await new Promise<HandoffResult>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
      const port = proc.parentPort as {
        once: (ev: string, cb: (e: { data: unknown }) => void) => void;
        on?: (ev: string, cb: (e: { data: unknown }) => void) => void;
        start?: () => void;
      };
      const onMsg = (e: { data: unknown }) => {
        clearTimeout(t);
        const parsed = parseHandoff(e?.data ?? e);
        resolve(parsed ? { ok: true, handoff: parsed } : { ok: false, reason: "invalid" });
      };
      if (typeof port.on === "function") port.on("message", onMsg);
      else port.once("message", onMsg);
      try {
        port.start?.();
      } catch {
        /* ignore */
      }
    });
  }

  if (!proc.channel && !process.connected) {
    return { ok: false, reason: "no-channel" };
  }

  return await new Promise<HandoffResult>((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);

    const onMessage = (msg: unknown) => {
      cleanup();
      const parsed = parseHandoff(msg);
      resolve(parsed ? { ok: true, handoff: parsed } : { ok: false, reason: "invalid" });
    };
    const onDisconnect = () => {
      cleanup();
      resolve({ ok: false, reason: "disconnect" });
    };
    const cleanup = () => {
      clearTimeout(t);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
  });
}

/** D:cqr catch 187341–187348: `[sand-local-exec-daemon] fatal: ${xt(e)}` then exit 1. No argument → "Error". */
export function exitFatal(error?: unknown): never {
  if (error === undefined) logFatal();
  else console.error(`[sand-local-exec-daemon] fatal: ${describeError(error instanceof Error ? error : new Error(String(error)))}`);
  process.exit(1);
}
