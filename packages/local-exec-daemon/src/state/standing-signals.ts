import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dataRootFromEnv } from "../util";
import { openMaybeSealed } from "./connection";
import { describeError } from "../box/provider";

/** D:wTe 78800 / fce 80931: the app's "backend is back" marker in the data root. */
export const BACKEND_RETURN_FILE = "local-exec-backend-return.json";
export function backendReturnPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), BACKEND_RETURN_FILE);
}

/**
 * D:OLe 81014 → _d(path, up(JFt()), { failOpen: true }) (80956–80966) with no file key: any read error → null,
 * a sealed envelope → null (RDe without a key), plain JSON → `{ at: number }` or null (JFt 80887).
 */
export async function readBackendReturn(file = backendReturnPath()): Promise<{ at: number } | null> {
  let text: string;
  try { text = await fs.promises.readFile(file, "utf8"); } catch { return null; }
  const opened = openMaybeSealed(text, null);
  if (opened == null) return null;
  let v: unknown;
  try { v = JSON.parse(opened); } catch { return null; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const at = (v as { at?: unknown }).at;
  return typeof at === "number" && Number.isFinite(at) ? { at } : null;
}

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;
/** D:L9r 179171–179175: link-local addresses are ignored. */
function linkLocal(n: os.NetworkInterfaceInfo): boolean {
  return n.family === "IPv4" ? n.address.startsWith("169.254.") : /^fe[89ab][0-9a-f]:/i.test(n.address);
}
/** D:D9r 179161–179170: sorted "name|family|address" of every non-internal, non-link-local address. */
export function networkFingerprint(t: Ifaces): string {
  return Object.entries(t)
    .flatMap(([e, r = []]) => r.filter(n => !n.internal && !linkLocal(n)).map(n => `${e}|${n.family}|${n.address}`))
    .sort()
    .join(" ");
}

/**
 * D:lgt He/ut 179436–179456: each standing tick checks the backend-return marker (newer than the last seen `at`,
 * starting from startedAt) and the network fingerprint (first read is the baseline), then calls the providers.
 */
export function createStandingSignals(o: {
  startedAt: number;
  readBackendReturn?: () => Promise<{ at: number } | null>;
  networkInterfaces?: () => Ifaces;
  log?: (m: string) => void;
}) {
  let seenAt = o.startedAt;
  let print: string | undefined;
  const ifaces = o.networkInterfaces ?? os.networkInterfaces;
  return {
    async backendReturn(notify: () => void): Promise<void> {
      const y = await (o.readBackendReturn ?? readBackendReturn)();
      if (y === null || y.at <= seenAt) return;
      seenAt = y.at;
      notify();
    },
    networkChange(notify: () => void): void {
      let y: string;
      try { y = networkFingerprint(ifaces()); }
      catch (e) { o.log?.(`network interface read failed: ${describeError(e)}`); return; }
      const prev = print;
      print = y;
      if (!(prev === undefined || prev === y)) notify();
    },
  };
}
