import * as fs from "node:fs";
import * as path from "node:path";
import { dataRootFromEnv, filesKeyIdFromBase64Key, writeAtomic } from "../util";

export type DiscoveryRecord = {
  pid: number;
  startedAt: number;
  servingAt?: number;
  inflightCount: number;
  filesKeyId?: string;
  generation?: number;
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
  };
  await writeAtomic(discoveryPath(env), JSON.stringify(rec));
}

export async function clearDiscovery(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await fs.promises.unlink(discoveryPath(env));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}


export async function loadDiscovery(env: NodeJS.ProcessEnv = process.env): Promise<DiscoveryRecord | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(discoveryPath(env), "utf8")) as Partial<DiscoveryRecord>;
    if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0) return null;
    if (typeof raw.startedAt !== "number" || Number.isNaN(raw.startedAt)) return null;
    return {
      pid: raw.pid as number,
      startedAt: raw.startedAt,
      servingAt: typeof raw.servingAt === "number" ? raw.servingAt : undefined,
      inflightCount: typeof raw.inflightCount === "number" ? raw.inflightCount : 0,
      filesKeyId: typeof raw.filesKeyId === "string" ? raw.filesKeyId : undefined,
      generation: typeof raw.generation === "number" ? raw.generation : undefined,
    };
  } catch {
    return null;
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
    if (typeof j.at !== "number") return false;
    return Date.now() - j.at <= SUPERVISOR_FRESH_MS;
  } catch {
    return false;
  }
}
