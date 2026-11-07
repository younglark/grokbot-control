/**
 * Bash execution environment + cross-call state, aligned with observed official
 * 0.79.3 behavior (isolated oracle; see docs/local-exec/scenario-matrix.md).
 *
 * Official evidence (daemon.formatted.cjs):
 *  - Zze L22670: bash = $SHELL if it contains "bash", else PATH lookup; none → "Can't find Bash".
 *  - Ok L20851 / Lze L20848: `bash -O extglob -c <script> -- <command>`, non-login, stdin </dev/null.
 *  - Kme ~L22702: initial state from `bash -O extglob -ilc` snapshot, empty on failure.
 *  - Wme L22688: restore snapshot, `set +u`, export PWD, expand_aliases, eval command, dump;
 *    `exit` inside the command skips the dump.
 *  - dump_bash_state L21230–21389: excludes *_proxy, CURSOR_SANDBOX*, SUDO_ASKPASS, CURSOR_ASKPASS,
 *    CURSOR_CONVERSATION_ID, CURSOR_REQUEST_ID, CURSOR_AGENT_STORE, POSIXLY_CORRECT, ELECTRON_RUN_AS_NODE;
 *    set -o excludes errexit/nounset/pipefail/posix.
 *  - Wo L21040: TERM=dumb NO_COLOR=1 FORCE_COLOR=0 _ZO_DOCTOR=0; lWt L18948 core.quotePath=false.
 *
 * INTENTIONAL SAFETY DEVIATIONS (independent implementation, not official dump_bash_state):
 *  - cwd is never part of the restore script: it travels as a length-prefixed byte field that only
 *    Node parses. Official emits raw `$PWD` as a script line, so a directory name with a newline is
 *    executed on the next call (reproduced in independent-r3-cwd; we do not reproduce it).
 *  - The dump uses bash builtins only (no grep/sed/awk/cat), every value is `%q`-quoted, aliases are
 *    serialized via BASH_ALIASES assignments (no line rewriting), and a dump is committed only when
 *    it has both start and end markers and fits the size cap (atomic; otherwise the old state stays).
 *    Consequence: `export PATH=/nonexistent` is saved completely here, whereas official's dump fails
 *    for lack of external grep and silently keeps the previous state.
 *  - Exclusions are matched by variable NAME; official greps whole `export -p` lines, so it also drops
 *    variables whose value merely contains a token. POSIX-mode replay is not implemented.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BASE_ENV: Record<string, string> = { TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", _ZO_DOCTOR: "0" };
export const STATE_START = "__GB_STATE_START__";
export const STATE_END = "__GB_STATE_END__";
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
const INIT_MARK = "__GB_STATE_INIT__";

/**
 * Bash function printing: START\n <cwd-byte-length>\n <cwd bytes>\n <restore script> END\n.
 * Builtins only. The restore script never contains cwd.
 */
export const DUMP_FN = String.raw`__gb_dump_state() {
  builtin local __gb_n __gb_l __gb_k __gb_f __gb_len
  # Byte length in a subshell so the C locale never shadows the user's LC_ALL (review P2-3).
  __gb_len=$(LC_ALL=C; builtin printf '%s' "${"$"}{#PWD}")
  builtin printf '%s\n%s\n%s\n' '${STATE_START}' "$__gb_len" "$PWD"
  builtin printf '%s\n' 'builtin unset ELECTRON_RUN_AS_NODE 2>/dev/null'
  for __gb_n in $(builtin compgen -e); do
    case "$__gb_n" in
      PWD|OLDPWD|SHLVL|_|SHELLOPTS|BASHOPTS|BASH_*|POSIXLY_CORRECT|ELECTRON_RUN_AS_NODE|SUDO_ASKPASS|CURSOR_ASKPASS|CURSOR_CONVERSATION_ID|CURSOR_REQUEST_ID|CURSOR_AGENT_STORE|CURSOR_SANDBOX*|__GB_*|__gb_*) continue;;
      *_proxy|*_PROXY|*_Proxy) continue;;
    esac
    builtin printf 'builtin export %s=%q\n' "$__gb_n" "${"$"}{!__gb_n}"
  done
  builtin unset -f __gb_dump_state 2>/dev/null
  __gb_f=$(builtin declare -f)
  [[ -n "$__gb_f" ]] && builtin printf '__gb_f=%q; builtin eval -- "$__gb_f"; builtin unset __gb_f\n' "$__gb_f"
  for __gb_k in "${"$"}{!BASH_ALIASES[@]}"; do
    builtin printf 'BASH_ALIASES[%q]=%q\n' "$__gb_k" "${"$"}{BASH_ALIASES[$__gb_k]}"
  done
  while builtin read -r __gb_l; do
    case "$__gb_l" in *' login_shell'|*' restricted_shell') continue;; esac
    builtin printf 'builtin %s 2>/dev/null\n' "$__gb_l"
  done < <(builtin shopt -p)
  while builtin read -r __gb_l; do
    case "$__gb_l" in *'o errexit'|*'o nounset'|*'o pipefail'|*'o posix'|*'o history'|*'o monitor') continue;; esac
    builtin printf 'builtin %s 2>/dev/null\n' "$__gb_l"
  done < <(builtin set +o)
  builtin printf '%s\n' '${STATE_END}'
}
`;

export type ParsedState = { cwd: string; script: string };

/** Strict parser: returns null unless the dump is complete and well-formed. */
export function parseState(buf: Buffer, from = 0): ParsedState | null {
  if (buf.length - from > MAX_STATE_BYTES) return null;
  const start = Buffer.from(STATE_START + "\n");
  if (!buf.subarray(from, from + start.length).equals(start)) return null;
  let i = from + start.length;
  const nl = buf.indexOf(0x0a, i);
  if (nl < 0 || nl - i > 12) return null;
  const lenStr = buf.subarray(i, nl).toString("latin1");
  if (!/^\d+$/.test(lenStr)) return null;
  const len = Number(lenStr);
  i = nl + 1;
  if (i + len + 1 > buf.length || buf[i + len] !== 0x0a) return null;
  const cwd = buf.subarray(i, i + len).toString("utf8");
  const rest = buf.subarray(i + len + 1);
  const end = Buffer.from(STATE_END + "\n");
  if (rest.length < end.length || !rest.subarray(rest.length - end.length).equals(end)) return null;
  return { cwd, script: rest.subarray(0, rest.length - end.length).toString("utf8") };
}

export function findBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const sh = env.SHELL;
  if (sh && sh.includes("bash")) return sh;
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, "bash");
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

let snapshot: string | null = null;
let initPromise: Promise<string> | null = null;
let initClosed: Promise<void> = Promise.resolve();
/**
 * Session cwd (official oracle cwdpersist: with no workingDirectory the next call reuses the
 * previous call's final cwd). Kept as structured data only; never part of the restore script.
 */
let sessionCwd: string | undefined;
export function getSessionCwd(): string | undefined { return sessionCwd; }

/** Test-only reset of daemon-global shell state. */
export function resetShellState(): void { snapshot = null; initPromise = null; sessionCwd = undefined; }

/**
 * Daemon shutdown: terminate the shared initial-snapshot process group and wait for it to close.
 * Ordinary request cancellation never calls this (other waiters keep their shared init).
 */
export async function terminateInitialSnapshot(): Promise<void> {
  const g = initGroup;
  if (!g) return initClosed;
  // Leader alive (not reaped, so its number still names our group): SIGKILL the whole group
  // (interactive bash ignores SIGTERM). Leader exited but init not closed yet: residue may hold
  // the stdout pipe; reap it once. Once retired, the number is never reclaimed.
  cleanupInitGroup(g);
  await initClosed;
}

/**
 * Ownership handle for the init process group. `retired` is set permanently the first time the
 * group is cleaned up (signalled) or found empty, and when init closes; after that, no code path
 * may signal the number again, because a free PGID can be reused by an unrelated session and
 * /proc contents that "look the same" are not proof of ownership.
 */
interface InitGroup { child: ReturnType<typeof spawn>; pgid: number; retired: boolean }
let initGroup: InitGroup | null = null;

/**
 * The single cleanup entry used by every non-close path (init timeout, daemon shutdown):
 * leader not yet reaped → its number still names our group, signal it; leader exited →
 * reap residue via /proc (empty or reused → retire without signal). No-op once retired.
 * The close path calls reapInitGroup once and then retires the handle unconditionally.
 */
function cleanupInitGroup(g: InitGroup): void {
  if (g.retired) return;
  if (g.child.exitCode === null && g.child.signalCode === null) signalInitGroup(g);
  else reapInitGroup(g);
}

function signalInitGroup(g: InitGroup): void {
  if (g.retired) return;
  g.retired = true;
  try { process.kill(-g.pgid, "SIGKILL"); } catch { /* gone */ }
}

/**
 * Reap leftover members of our init group after its leader exited, at most once. Members are only
 * trusted while the handle is not retired (i.e. before init close / first cleanup); an empty group
 * retires the handle. A process with pid == pgid means the number was reused: retire, no signal.
 */
export function reapInitGroup(g: InitGroup): number {
  if (g.retired) return 0;
  let members: number[] = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      let st: string; try { st = fs.readFileSync(`/proc/${d}/stat`, "utf8"); } catch { continue; }
      const f = st.slice(st.lastIndexOf(")") + 2).split(" "); // state ppid pgrp session ...
      if (Number(f[2]) === g.pgid && Number(f[3]) === g.pgid) members.push(Number(d));
    }
  } catch { g.retired = true; return 0; }
  if (members.length === 0 || members.includes(g.pgid)) { g.retired = true; return 0; }
  signalInitGroup(g);
  return members.length;
}

/** Lazily capture the initial interactive-login snapshot once per daemon (shared by waiters). */
export function initialSnapshot(bash: string, timeoutMs = 10000): Promise<string> {
  if (snapshot !== null) return Promise.resolve(snapshot);
  if (initPromise) return initPromise;
  initPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: string) => { if (done) return; done = true; clearTimeout(t); if (snapshot === null) snapshot = v; resolve(snapshot); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bash, ["-O", "extglob", "-ilc", `${DUMP_FN} builtin printf '%s\\n' '${INIT_MARK}'; __gb_dump_state`], {
        env: { ...process.env, ...BASE_ENV }, detached: true, stdio: ["ignore", "pipe", "ignore"], cwd: os.homedir(),
      });
    } catch { finish(""); return; }
    const group: InitGroup | null = child.pid ? { child, pgid: child.pid, retired: false } : null;
    initGroup = group;
    initClosed = new Promise<void>((r) => child.once("close", () => r()));
    // Timeout: clean our (not yet retired) group whether or not the leader already exited; same-group
    // residue holding the stdout pipe would otherwise survive (review probe init-timeout).
    const t = setTimeout(() => { if (group) cleanupInitGroup(group); finish(""); }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { size += b.length; if (size <= MAX_STATE_BYTES * 2) chunks.push(b); });
    child.once("error", () => finish(""));
    child.once("close", () => {
      // Initialization is complete: clean up residue of our group once, then retire the handle
      // permanently so a later shutdown can never reclaim a (possibly reused) number.
      if (group) { reapInitGroup(group); group.retired = true; }
      const buf = Buffer.concat(chunks);
      const mark = Buffer.from(INIT_MARK + "\n");
      const at = buf.lastIndexOf(mark);
      const parsed = at < 0 ? null : parseState(buf, at + mark.length);
      finish(parsed ? parsed.script : "");
    });
  });
  return initPromise;
}

export type PreparedShell = { bash: string; args: string[]; env: NodeJS.ProcessEnv; snapshotIn: string };

/**
 * Snapshot travels on fd 3 (in, read with the `read` builtin) and fd 4 (out); both are closed for
 * the user command (`3<&- 4>&-`).
 */
export async function prepareShell(command: string, root: string): Promise<PreparedShell> {
  const bash = findBash();
  if (!bash) throw new Error("Can't find Bash");
  const snapshotIn = await initialSnapshot(bash);
  const script =
    `${DUMP_FN}IFS= builtin read -r -d '' __gb_snap <&3; builtin shopt -s extglob; builtin eval -- "$__gb_snap" 2>/dev/null; builtin unset __gb_snap; ` +
    `{ builtin set +u 2>/dev/null || true; builtin export PWD="$(builtin pwd)"; builtin shopt -s expand_aliases 2>/dev/null; ` +
    `builtin eval "$1" 3<&- 4>&- < /dev/null; }; COMMAND_EXIT_CODE=$?; __gb_dump_state >&4 2>/dev/null; builtin exit $COMMAND_EXIT_CODE`;
  const gitCount = Number(process.env.GIT_CONFIG_COUNT || 0) || 0;
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...BASE_ENV,
    CURSOR_AGENT: "1", SAND_AGENT: "1",
    AGENT_TRANSCRIPTS: path.join(root, "agent-transcripts"),
    GIT_CONFIG_COUNT: String(gitCount + 1),
    [`GIT_CONFIG_KEY_${gitCount}`]: "core.quotePath",
    [`GIT_CONFIG_VALUE_${gitCount}`]: "false",
  };
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return { bash, args: ["-O", "extglob", "-c", script, "--", command], env, snapshotIn };
}

/** Atomically commit a complete dump and return its cwd; otherwise keep the old state. */
export function commitShell(dumped: Buffer, aborted: boolean): string | undefined {
  if (aborted) return undefined;
  const parsed = parseState(dumped);
  if (!parsed) return undefined;
  snapshot = parsed.script;
  sessionCwd = parsed.cwd;
  return parsed.cwd;
}
