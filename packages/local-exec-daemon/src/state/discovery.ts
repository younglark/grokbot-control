import * as fs from "node:fs";
import * as path from "node:path";
import { lifecycleTrace, lifecycleTraceEnabled } from "../trace";
import { dataRootFromEnv, filesKeyIdFromBase64Key, writeAtomic } from "../util";

export type DiscoveryRecord = {
  pid: number;
  startedAt: number;
  servingAt?: number;
  inflightCount: number;
  filesKeyId?: string;
  generation?: number;
  /** D:179216: SAND_NODE_PROXY_ENV fingerprint (nke), only when a proxy was applied. */
  proxyFingerprint?: string;
  /** D:v 179205: sorted rejected account scopes, only when non-empty. */
  rejectedAccountScopes?: string[];
};

export function discoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-daemon.json");
}

export async function publishDiscovery(
  partial: Partial<DiscoveryRecord> & { pid: number; startedAt: number },
  fileKeyB64?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const rec: DiscoveryRecord = {
    pid: partial.pid,
    startedAt: partial.startedAt,
    servingAt: partial.servingAt,
    inflightCount: partial.inflightCount ?? 0,
    ...(fileKeyB64 ? { filesKeyId: filesKeyIdFromBase64Key(fileKeyB64) } : {}),
    ...(partial.generation != null ? { generation: partial.generation } : {}),
    ...(partial.proxyFingerprint != null ? { proxyFingerprint: partial.proxyFingerprint } : {}),
    ...(partial.rejectedAccountScopes?.length ? { rejectedAccountScopes: [...partial.rejectedAccountScopes].sort() } : {}),
  };
  // D:CLe 80993 → TLe(path, record, {pretty:true}) → cp without a mode.
  await writeAtomic(discoveryPath(env), JSON.stringify(rec, null, 2));
}

export async function clearDiscovery(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await fs.promises.unlink(discoveryPath(env));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}


// Correlation is (pid, timeOrigin, readId); allocate only when diagnostics are enabled.
let discoveryReadSequence = 0;
function readErrorCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
  } catch { return "UNKNOWN"; }
}

export async function loadDiscovery(env: NodeJS.ProcessEnv = process.env): Promise<DiscoveryRecord | null> {
  const readId = lifecycleTraceEnabled() ? ++discoveryReadSequence : 0;
  let ioFinished = false;
  let jsonParsed = false;
  let outcome = "invalid-record";
  if (readId) lifecycleTrace("discovery:load-read-start", { readId });
  try {
    const text = await fs.promises.readFile(discoveryPath(env), "utf8");
    ioFinished = true;
    // Promise settlement observed by JS, before JSON.parse; not the kernel's physical I/O completion time.
    if (readId) lifecycleTrace("discovery:load-read-io-end", { readId });
    const raw = JSON.parse(text) as Partial<DiscoveryRecord>;
    jsonParsed = true;
    if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) {
      if (readId) lifecycleTrace("discovery:load-read-parse-end", { readId, result: "invalid-record", reason: "pid" });
      return null;
    }
    if (typeof raw.startedAt !== "number" || Number.isNaN(raw.startedAt)) {
      if (readId) lifecycleTrace("discovery:load-read-parse-end", { readId, result: "invalid-record", reason: "startedAt" });
      return null;
    }
    const record: DiscoveryRecord = {
      pid: raw.pid as number,
      startedAt: raw.startedAt,
      servingAt: typeof raw.servingAt === "number" ? raw.servingAt : undefined,
      inflightCount: typeof raw.inflightCount === "number" ? raw.inflightCount : 0,
      filesKeyId: typeof raw.filesKeyId === "string" ? raw.filesKeyId : undefined,
      generation: typeof raw.generation === "number" ? raw.generation : undefined,
    };
    outcome = "record";
    if (readId) lifecycleTrace("discovery:load-read-parse-end", { readId, result: "record", owner: record.pid });
    return record;
  } catch (error) {
    if (readId) {
      if (!ioFinished) {
        const code = readErrorCode(error);
        outcome = code === "ENOENT" ? "missing" : "io-error";
        lifecycleTrace("discovery:load-read-io-error", { readId, code });
      } else {
        outcome = jsonParsed ? "invalid-record" : "invalid-json";
        lifecycleTrace("discovery:load-read-parse-end", { readId, result: outcome });
      }
    }
    return null; // Preserve existing fail-open fallback for every read/parse/shape failure.
  } finally {
    if (readId) lifecycleTrace("discovery:load-read-end", { readId, outcome });
  }
}

export type SupervisorRecord = { pid: number; at: number };

export function supervisorPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-supervisor.json");
}

/** Fresh supervisor window used by official Hello.supervised (~90s). */
const SUPERVISOR_FRESH_MS = 90_000;

export async function isSupervised(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(supervisorPath(env), "utf8");
    const j = JSON.parse(raw) as SupervisorRecord;
    // D:pce/$Ft 80881: {pid:int>0, at:number}; anything else reads as {pid:0, at:0} (never fresh).
    if (typeof j.at !== "number" || !Number.isInteger(j.pid) || j.pid <= 0) return false;
    return Date.now() - j.at <= SUPERVISOR_FRESH_MS;
  } catch {
    return false;
  }
}
