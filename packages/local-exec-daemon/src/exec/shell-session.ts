/**
 * Bash execution environment + cross-call state, aligned with observed official
 * 0.79.3 behavior (isolated oracle official-v2; see docs/local-exec-scenario-matrix.md).
 *
 * Official evidence (daemon.formatted.cjs):
 *  - Zze L22670: bash = $SHELL if it contains "bash", else PATH lookup; none → "Can't find Bash".
 *  - Ok L20851 / Lze L20848: `bash -O extglob -c <script> -- <command>`, non-login, stdin </dev/null.
 *  - Kme ~L22702: initial state from `bash -O extglob -ilc` (interactive login) snapshot, empty on failure.
 *  - Wme L22688: each command restores snapshot, `set +u`, exports PWD, expand_aliases,
 *    eval command, then dumps state; `exit` inside the command skips the dump.
 *  - Wo L21040: TERM=dumb NO_COLOR=1 FORCE_COLOR=0 _ZO_DOCTOR=0; lWt L18948 core.quotePath=false.
 * Observed (oracle): exported vars, functions, aliases, shopt and `set -o` persist;
 * non-exported vars do not; cwd does not persist (each call starts at workingDirectory
 * or root) while exit.cwd reports the final pwd; nonexistent cwd → stderr notice + root.
 *
 * The dump/restore script below is an independent implementation, NOT the official
 * dump_bash_state; parity is asserted only for the oracle-observed cases.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const BASE_ENV: Record<string, string> = { TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", _ZO_DOCTOR: "0" };
export const CWD_MARK = "__GB_STATE_CWD__=";
const INIT_MARK = "__GB_STATE_INIT__";

/** Bash function printing restorable state to stdout. First line carries cwd. */
export const DUMP_FN = String.raw`__gb_dump_state() {
  builtin printf '%s%s\n' '${CWD_MARK}' "$PWD"
  local __n
  for __n in $(builtin compgen -e); do
    case "$__n" in PWD|OLDPWD|SHLVL|_|SHELLOPTS|BASHOPTS|BASH_*|CURSOR_STATE_*|__GB_*) continue;; esac
    builtin printf 'builtin export %s=%q\n' "$__n" "${"$"}{!__n}"
  done
  builtin declare -f | LC_ALL=C command sed -n '/^__gb_dump_state ()/,/^}/!p'
  builtin alias -p | LC_ALL=C command sed 's/^alias /builtin alias /' 2>/dev/null
  builtin shopt -p 2>/dev/null | LC_ALL=C command grep -v -e ' login_shell$' -e ' restricted_shell$'
  builtin set +o | LC_ALL=C command grep -v -E ' (monitor|history|emacs|vi|interactive-comments|posix)$'
}
`;

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

/** Test-only reset of daemon-global shell state. */
export function resetShellState(): void { snapshot = null; initPromise = null; }

function stripCwd(s: string): { cwd?: string; rest: string } {
  const nl = s.indexOf("\n");
  const first = nl < 0 ? s : s.slice(0, nl);
  if (!first.startsWith(CWD_MARK)) return { rest: s };
  return { cwd: first.slice(CWD_MARK.length), rest: nl < 0 ? "" : s.slice(nl + 1) };
}

/** Lazily capture the initial interactive-login snapshot once per daemon. */
export function initialSnapshot(bash: string, timeoutMs = 10000): Promise<string> {
  if (snapshot !== null) return Promise.resolve(snapshot);
  if (initPromise) return initPromise;
  initPromise = new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string) => { if (done) return; done = true; clearTimeout(t); snapshot = v; resolve(v); };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bash, ["-O", "extglob", "-ilc", `${DUMP_FN} builtin printf '%s\\n' '${INIT_MARK}'; __gb_dump_state`], {
        env: { ...process.env, ...BASE_ENV }, detached: true, stdio: ["ignore", "pipe", "ignore"], cwd: os.homedir(),
      });
    } catch { finish(""); return; }
    const t = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } finish(""); }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { if (out.length < 4 * 1024 * 1024) out += b.toString("utf8"); });
    child.once("error", () => finish(""));
    child.once("close", () => {
      const i = out.lastIndexOf(INIT_MARK + "\n");
      finish(i < 0 ? "" : stripCwd(out.slice(i + INIT_MARK.length + 1)).rest);
    });
  });
  return initPromise;
}

export type PreparedShell = { bash: string; args: string[]; env: NodeJS.ProcessEnv; snapshotIn: string };

/**
 * Snapshot travels on fd 3 (in) and fd 4 (out) like official Wme's default
 * transport, and both are closed for the user command (`3<&- 4>&-`), so no
 * CURSOR_STATE_* file variables leak into the command environment.
 */
export async function prepareShell(command: string, root: string): Promise<PreparedShell> {
  const bash = findBash();
  if (!bash) throw new Error("Can't find Bash");
  const snapshotIn = await initialSnapshot(bash);
  const script =
    `${DUMP_FN}snap=$(command cat <&3) && builtin shopt -s extglob && builtin eval -- "$snap" 2>/dev/null; ` +
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

/** Commit dumped state (only if the command reached the dump) and return final cwd. */
export function commitShell(dumped: string, aborted: boolean): string | undefined {
  if (aborted || !dumped.startsWith(CWD_MARK)) return undefined;
  const { cwd, rest } = stripCwd(dumped);
  snapshot = rest;
  return cwd;
}
