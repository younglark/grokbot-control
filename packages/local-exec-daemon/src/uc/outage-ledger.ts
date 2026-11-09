import { ConnectError, Code } from "@connectrpc/connect";

/**
 * Port of the UC watch outage ledger (Z1t D:177641–177830, wrapped by Y1t/K1t/W1t D:177571–177610).
 * It writes `[user-computer-watch] <ISO> …` diagnostic lines and, for outages of at least G1t = 60 s, one
 * `{"event":"sand.local_exec_daemon.watch_outage",…}` JSON line to the daemon's stdout (jh.writeStdout D:79737);
 * the App's main-core parses that event into telemetry (foe/NHe). Every call is fault-contained.
 */
export const WATCH_OUTAGE_EVENT = "sand.local_exec_daemon.watch_outage"; // q1t D:177512
const OUTAGE_EVENT_MIN_MS = 60_000; // G1t D:177513
const MONITOR_MS = 5_000; // rxe D:177570
const STILL_OUT_EVERY_MS = 60_000; // Y8r
const LOG_LINES_PER_HOUR = 600; // nxe
const HOUR_MS = 3_600_000; // Z8r

// D:177441–177486
const CONNECT_CODES = new Set(["Canceled", "Unknown", "InvalidArgument", "DeadlineExceeded", "NotFound", "AlreadyExists",
  "PermissionDenied", "ResourceExhausted", "FailedPrecondition", "Aborted", "OutOfRange", "Unimplemented", "Internal",
  "Unavailable", "DataLoss", "Unauthenticated"]);
const ERRNO_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETRESET", "ENETDOWN",
  "ENETUNREACH", "EHOSTUNREACH", "EHOSTDOWN", "EAI_AGAIN", "ENOTFOUND", "EADDRINUSE", "EACCES", "EPERM", "ENOENT", "ENOSPC",
  "EDQUOT", "EROFS", "EBUSY", "EMFILE", "EIO"]);
const SAFE = /^[0-9A-Za-z._|:-]{1,64}$/; // $8r D:177433

function errnoCode(t: unknown): string | undefined { // un/j7t D:78659–78671
  const seen = new Set<unknown>();
  for (let n: unknown = t; n != null && typeof n === "object" && !seen.has(n); n = (n as { cause?: unknown }).cause) {
    seen.add(n); const s = (n as { code?: unknown }).code;
    if (typeof s === "string" && /^E[A-Z_]+$/.test(s)) return s;
  }
  return undefined;
}
/** X8r D:177611–177626 */
export function outageCause(t: unknown): string | undefined {
  if (t === undefined) return undefined;
  try {
    const e = errnoCode(t);
    if (e !== undefined) return ERRNO_CODES.has(e) ? e : "E_OTHER";
    if (t instanceof ConnectError) {
      const name = Code[t.code] as string | undefined;
      const r = name === undefined ? undefined : (CONNECT_CODES.has(name) ? name : "Other").toLowerCase();
      return (typeof r === "string" && SAFE.test(r) ? r : undefined) ?? "other";
    }
    if (t instanceof Error && t.name === "DeadlineExceededError" && (t as { code?: unknown }).code === "deadline_exceeded") return "deadline";
  } catch { return "other"; }
  return "other";
}

type Phase = "dialing" | "waiting" | "channel-missing";
type Ends = { lifetime: number; stall: number; silent: number; "network-change": number; error: number; unauthorized: number };
type Outage = {
  machineId: string; startedBy: string; startCause?: string; lastStreamMs: number; phase: Phase;
  openedAt: number; openedAtMono: number; ends: Ends; segmentStartedAt: number; lastCause?: string; attempts: number;
  dialMs: number; longestDialMs: number; channelMissingMs: number; quietMaxMs: number; quietPhase: Phase;
  lastTickAt: number; lastTickAtMono: number; tickLateMaxMs: number; tickMonoLateMaxMs: number; stillOutMinutesLogged: number;
};
type State = { kind: "out"; outage: Outage; monitor: { dispose(): void } } | { kind: "connected"; machineId: string; since: number } | { kind: "closed" };

export type OutageLedger = {
  dialing(): void; connected(machineId: string): void; ended(reason: string, error?: unknown): void; channelMissing(): void; close(): void; faults(): number;
};
export type OutageLedgerOptions = {
  now?: () => number; monotonicNow?: () => number;
  write?: (record: Record<string, unknown>) => void; log?: (line: string) => void;
  schedule?: (ms: number, fn: () => void) => { dispose(): void };
};

function writeStdout(t: string): void { // jh.writeStdout + u$t D:79727–79740
  const e = process.stdout;
  if (e.listenerCount("error") === 0) e.on("error", () => e.destroy());
  if (e.writable) e.write(t);
}

export function createOutageLedger(o: OutageLedgerOptions = {}): OutageLedger {
  const now = o.now ?? Date.now, mono = o.monotonicNow ?? (() => performance.now());
  const write = o.write ?? (g => writeStdout(`${JSON.stringify({ event: WATCH_OUTAGE_EVENT, ...g })}\n`));
  const log = o.log ?? (t => writeStdout(`${t}\n`));
  const schedule = o.schedule ?? ((ms, fn) => { const t = setTimeout(fn, ms); t.unref(); return { dispose: () => clearTimeout(t) }; });
  // W1t D:177578–177594
  let faults = 0;
  const contain = (n: () => void) => {
    try { n(); } catch { faults += 1; try { log(`[user-computer-watch] ledger fault ${faults}, ignored`); } catch { faults += 1; } }
  };
  let hourStart = mono(), lines = 0;
  const u = (g: number, msg: string) => {
    const y = mono();
    if (y - hourStart >= HOUR_MS) { hourStart = y; lines = 0; }
    lines += 1;
    if (lines > LOG_LINES_PER_HOUR + 1) return;
    const w = lines > LOG_LINES_PER_HOUR ? `log capped at ${LOG_LINES_PER_HOUR} lines this hour` : msg;
    contain(() => log(`[user-computer-watch] ${new Date(g).toISOString()} ${w}`));
  };
  const cee = (t: Outage, e: number) => { // D:177632–177640
    const r = Math.max(0, e - t.segmentStartedAt);
    if (r > t.quietMaxMs) { t.quietMaxMs = r; t.quietPhase = t.phase; }
    if (t.phase === "dialing") { t.dialMs += r; t.longestDialMs = Math.max(t.longestDialMs, r); }
    if (t.phase === "channel-missing") t.channelMissingMs += r;
    t.segmentStartedAt = e;
    return r;
  };
  const tick = (g: Outage) => { // l D:177663–177677
    const _ = now(), y = mono();
    g.tickLateMaxMs = Math.max(g.tickLateMaxMs, _ - g.lastTickAt - MONITOR_MS);
    g.tickMonoLateMaxMs = Math.max(g.tickMonoLateMaxMs, y - g.lastTickAtMono - MONITOR_MS);
    g.lastTickAt = _; g.lastTickAtMono = y;
    const w = _ - g.openedAt, T = Math.floor(w / STILL_OUT_EVERY_MS);
    if (T <= g.stillOutMinutesLogged) return;
    g.stillOutMinutesLogged = T;
    u(_, `still out ${w} ms, phase ${g.phase}`);
  };
  const open = (g: { machineId: string; startedBy: string; startCause?: string; lastStreamMs: number; phase: Phase }): State => { // d
    const _ = now(), y = mono();
    const w: Outage = { ...g, openedAt: _, openedAtMono: y,
      ends: { lifetime: 0, stall: 0, silent: 0, "network-change": 0, error: 0, unauthorized: 0 },
      segmentStartedAt: _, lastCause: undefined, attempts: 0, dialMs: 0, longestDialMs: 0, channelMissingMs: 0, quietMaxMs: 0,
      quietPhase: g.phase, lastTickAt: _, lastTickAtMono: y, tickLateMaxMs: 0, tickMonoLateMaxMs: 0, stillOutMinutesLogged: 0 };
    // hc "user-computer-watch-outage-monitor": leading false, next tick 5 s after the previous completes.
    let h: { dispose(): void } | undefined, stopped = false;
    const loop = () => { h = schedule(MONITOR_MS, () => { if (stopped) return; contain(() => tick(w)); loop(); }); };
    loop();
    return { kind: "out", outage: w, monitor: { dispose: () => { stopped = true; h?.dispose(); } } };
  };
  const finish = (g: Extract<State, { kind: "out" }>, outcome: string, machineId: string, w: number) => { // f
    g.monitor.dispose();
    const T = g.outage;
    cee(T, w);
    const R: Record<string, unknown> & { outageMs: number; attempts: number } = {
      machineId, outcome, startedBy: T.startedBy,
      ...(T.startCause === undefined ? {} : { startCause: T.startCause }),
      ...(T.lastCause === undefined ? {} : { lastCause: T.lastCause }),
      outageMs: Math.max(0, w - T.openedAt),
      outageMonoMs: Math.max(0, Math.round(mono() - T.openedAtMono)),
      lastStreamMs: T.lastStreamMs, attempts: T.attempts, dialMs: T.dialMs, longestDialMs: T.longestDialMs,
      channelMissingMs: T.channelMissingMs, ends: { ...T.ends }, tickLateMaxMs: T.tickLateMaxMs,
      tickMonoLateMaxMs: Math.round(T.tickMonoLateMaxMs), quietMaxMs: T.quietMaxMs, quietPhase: T.quietPhase,
    };
    if (R.outageMs >= OUTAGE_EVENT_MIN_MS) contain(() => write(R));
    return R;
  };
  let p: State = open({ machineId: "", startedBy: "startup", startCause: undefined, lastStreamMs: 0, phase: "waiting" });
  const close = () => { // m
    const g = now();
    switch (p.kind) {
      case "out": { const _ = finish(p, "closed", p.outage.machineId, g); u(g, `closed after ${_.outageMs} ms out (attempts ${_.attempts})`); break; }
      case "connected": u(g, `closed after ${Math.max(0, g - p.since)} ms connected`); break;
      case "closed": return;
    }
    p = { kind: "closed" };
  };
  const H1t = (t: string | undefined) => (t === undefined ? "" : `, cause ${t}`);
  const inner = {
    dialing() {
      if (p.kind !== "out") return;
      const g = now(), _ = p.outage;
      cee(_, g); _.phase = "dialing"; _.attempts += 1;
      u(g, `dialing (attempt ${_.attempts})`);
    },
    connected(g: string) {
      if (p.kind !== "out") return;
      const _ = now(), y = finish(p, "reconnected", g, _);
      u(_, `connected after ${y.outageMs} ms out (attempts ${y.attempts})`);
      p = { kind: "connected", machineId: g, since: _ };
    },
    ended(g: string, _e?: unknown) {
      if (g === "closed") { close(); return; }
      const y = now(), w = outageCause(_e);
      if (p.kind === "connected") {
        const A = Math.max(0, y - p.since);
        u(y, `ended ${g} after ${A} ms connected${H1t(w)}`);
        p = open({ machineId: p.machineId, startedBy: g, startCause: w, lastStreamMs: A, phase: "waiting" });
        return;
      }
      if (p.kind !== "out") return;
      const T = p.outage, R = T.phase, b = cee(T, y);
      (T.ends as Record<string, number>)[g] += 1; // unguarded like the original
      if (w !== undefined) T.lastCause = w;
      T.phase = "waiting";
      u(y, `ended ${g} after ${b} ms ${R}${H1t(w)}`);
    },
    channelMissing() {
      const g = now();
      if (p.kind === "connected") {
        u(g, "channel missing");
        p = open({ machineId: p.machineId, startedBy: "channel-missing", startCause: undefined, lastStreamMs: Math.max(0, g - p.since), phase: "channel-missing" });
        return;
      }
      if (p.kind !== "out") return;
      const _ = p.outage, y = _.phase !== "channel-missing";
      cee(_, g); _.phase = "channel-missing";
      if (y) u(g, "channel missing");
    },
    close,
  };
  // K1t D:177595–177607: every entry point is fault-contained.
  return {
    dialing: () => contain(() => inner.dialing()),
    connected: n => contain(() => inner.connected(n)),
    ended: (n, s) => contain(() => inner.ended(n, s)),
    channelMissing: () => contain(() => inner.channelMissing()),
    close: () => contain(() => inner.close()),
    faults: () => faults,
  };
}
