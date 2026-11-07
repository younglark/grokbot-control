import * as path from "node:path";
import { z } from "zod";
import { dataRootFromEnv, readJsonIfExists } from "../util";

/** Official filename: local-exec-update-lease.json with { until: number }. */
const LeaseSchema = z.object({
  until: z.number(),
});

export type LeaseRecord = z.infer<typeof LeaseSchema>;

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
 * Simplified ownership keep/exit (subset of official FDe).
 * keep if: supervisor fresh OR active lease OR inflight with grace.
 * Full generation preempt / supersededForMs not implemented — see tests skip.
 */
export function ownershipDecision(args: {
  supervisedFresh: boolean;
  lease: LeaseRecord | null;
  inflightCount: number;
  nowMs?: number;
  inflightGraceMs?: number;
  supervisorStaleForMs?: number;
}): "keep" | "exit" {
  const now = args.nowMs ?? Date.now();
  if (args.supervisedFresh || leaseIsActive(args.lease, now)) return "keep";
  return args.inflightCount > 0 && (args.supervisorStaleForMs ?? Infinity) <= (args.inflightGraceMs ?? 120_000) ? "keep" : "exit";
}

export function generationFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SAND_LOCAL_EXEC_GENERATION;
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
