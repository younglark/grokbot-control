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

/** Optional lifecycle diagnostics: identity/counts only; never credential/key/request bodies. */
const lifecycleFile = process.env.LED_LIFECYCLE_TRACE;
const lifecycleBuffered = process.env.LED_LIFECYCLE_TRACE_MODE === "buffered";
const lifecycleEvents: string[] = [];
if (lifecycleFile && lifecycleBuffered) process.once("exit", () => {
  try { fs.appendFileSync(lifecycleFile, lifecycleEvents.join("")); } catch { /* diagnostic */ }
});
export function lifecycleTraceEnabled(): boolean { return !!lifecycleFile; }
export function lifecycleTrace(ev: string, info: Record<string, unknown> = {}): void {
  if (!lifecycleFile) return;
  try {
    const monoMs = performance.now();
    const row = JSON.stringify({ w: performance.timeOrigin + monoMs, monoMs, timeOrigin: performance.timeOrigin, pid: process.pid, ev, ...info }) + "\n";
    if (lifecycleBuffered) lifecycleEvents.push(row);
    else fs.appendFileSync(lifecycleFile, row);
  } catch { /* diagnostic */ }
}
