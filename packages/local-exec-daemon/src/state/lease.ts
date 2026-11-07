import * as path from "node:path";
import { z } from "zod";
import { dataRootFromEnv, readJsonIfExists } from "../util";

/** Official filename: local-exec-update-lease.json with { until: number }. */
const LeaseSchema = z.object({
  until: z.number(),
});

export type LeaseRecord = z.infer<typeof LeaseSchema>;

/** Official RTe (daemon.formatted.cjs L78808): inflight grace while unsupervised/superseded. */
export const INFLIGHT_GRACE_MS = 120_000;

export function leasePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-update-lease.json");
}

export async function loadLease(env: NodeJS.ProcessEnv = process.env): Promise<LeaseRecord | null> {
  const raw = await readJsonIfExists<unknown>(leasePath(env));
  if (raw == null) return null;
  const parsed = LeaseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function leaseIsActive(lease: LeaseRecord | null, nowMs = Date.now()): boolean {
  return lease != null && lease.until > nowMs;
}

/**
 * Official pid liveness (daemon.formatted.cjs L81004–81009 hce):
 * process.kill(pid, 0) succeeds, or errno EPERM (alive but not signalable).
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Official FDe (daemon.formatted.cjs L79882–79896).
 * When supersededForMs is set (discovery names another live pid), only inflight
 * within grace keeps the process; otherwise heartbeat/lease/inflight-stale path.
 * App publishes SAND_LOCAL_EXEC_GENERATION into discovery; daemon ownership does
 * not compare generation numbers (R13).
 */
export function ownershipDecision(args: {
  supervisedFresh: boolean;
  lease: LeaseRecord | null;
  inflightCount: number;
  nowMs?: number;
  inflightGraceMs?: number;
  supervisorStaleForMs?: number;
  /** null/undefined = not superseded; number = ms since other live discovery pid observed */
  supersededForMs?: number | null;
}): "keep" | "exit" {
  const now = args.nowMs ?? Date.now();
  const grace = args.inflightGraceMs ?? INFLIGHT_GRACE_MS;
  if (args.supersededForMs != null) {
    return args.inflightCount > 0 && args.supersededForMs <= grace ? "keep" : "exit";
  }
  if (args.supervisedFresh || leaseIsActive(args.lease, now)) return "keep";
  return args.inflightCount > 0 && (args.supervisorStaleForMs ?? Infinity) <= grace ? "keep" : "exit";
}

export function generationFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SAND_LOCAL_EXEC_GENERATION;
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
