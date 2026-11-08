/**
 * t109u DIAGNOSTIC ONLY (not production behavior): when UC_TRACE_FILE is set, append one JSON line per event
 * with an epoch-aligned monotonic stamp (performance.timeOrigin + performance.now()). Unset → no-op.
 */
import * as fs from "node:fs";
const file = process.env.UC_TRACE_FILE;
export function trace(ev: string, o: Record<string, unknown> = {}): void {
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ w: performance.timeOrigin + performance.now(), ev, ...o }) + "\n"); } catch { /* diagnostic */ }
}
