import { describeError } from "../box/provider";

/**
 * D:pTe 78700–78712 / V7t 78689–78699 / H7t 78686: installed first thing in cqr (D:187290–187292) with scope
 * "sand-local-exec-daemon". An uncaught exception or unhandled rejection is logged and the process is KEPT ALIVE:
 * `[${scope}] ${kind} (kept alive): ${xt(err)}`. The optional reporter is the Sentry crash reporter (T7t), which
 * this port does not ship (see docs/local-exec/port-coverage.md); a throwing reporter prints
 * `sand.host.crash_reporter_failed kind=… error_class=…` to stderr.
 */
export function installCrashGuard(scope: string, onError?: (error: Error, kind: string) => void): { setReporter(r?: (error: Error, kind: string) => void): void } {
  let report = onError;
  const handle = (kind: string, raw: unknown) => {
    const n = raw instanceof Error ? raw : new Error(String(raw));
    console.error(`[${scope}] ${kind} (kept alive): ${describeError(n)}`);
    try { report?.(n, kind); }
    catch (s) { process.stderr.write(`sand.host.crash_reporter_failed kind=${kind} error_class=${describeError(s)}\n`); }
  };
  process.on("uncaughtException", n => handle("uncaughtException", n));
  process.on("unhandledRejection", n => handle("unhandledRejection", n));
  return { setReporter: r => { report = r; } };
}
