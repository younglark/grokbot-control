import { GbcError } from "../errors.js";

export type FlagSpec = {
  values: string[];
  switches: string[];
};

/** Per-command flags (noun + verb). Globals are consumed before this check. */
export const COMMAND_FLAGS: Record<string, Record<string, FlagSpec>> = {
  auth: {
    whoami: { values: [], switches: [] },
    status: { values: [], switches: [] },
    "login-begin": { values: ["--login-mode"], switches: [] },
    poll: { values: [], switches: [] },
    complete: { values: ["--timeout"], switches: [] },
    login: { values: ["--timeout", "--login-mode"], switches: [] },
    cancel: { values: [], switches: [] },
    refresh: { values: [], switches: ["--force"] },
    logout: { values: [], switches: [] },
  },
  computer: {
    state: { values: [], switches: [] },
    reset: { values: ["--confirm", "--timeout"], switches: ["--hard", "--wait"] },
  },
  bot: {
    list: { values: ["--limit", "--offset"], switches: [] },
    get: { values: ["--agent-id"], switches: [] },
    create: {
      values: ["--name", "--description", "--title", "--agent-id", "--language"],
      switches: ["--kickstart"],
    },
    update: { values: ["--agent-id", "--name", "--description", "--title"], switches: [] },
    delete: { values: ["--agent-id", "--confirm"], switches: [] },
    status: { values: ["--agent-id"], switches: [] },
    todos: { values: ["--agent-id"], switches: [] },
    tasks: { values: ["--agent-id"], switches: [] },
    subagents: { values: ["--agent-id"], switches: [] },
    interrupt: {
      values: ["--agent-id", "--confirm", "--reason", "--session-id"],
      switches: [],
    },
  },
  message: {
    send: {
      values: ["--agent-id", "--session-id", "--text", "--text-file", "--message-id"],
      switches: ["--text-stdin"],
    },
    status: { values: ["--agent-id", "--session-id", "--message-id"], switches: [] },
    history: { values: ["--agent-id", "--limit", "--offset"], switches: [] },
  },
  session: {
    list: { values: ["--agent-id", "--limit", "--offset"], switches: [] },
  },
  dashboard: {
    start: { values: ["--port", "--host"], switches: ["--no-open"] },
  },
  sidebar: {
    list: { values: ["--limit", "--offset"], switches: [] },
    create: { values: ["--name"], switches: [] },
    rename: { values: ["--section-id", "--name"], switches: [] },
    delete: { values: ["--section-id", "--confirm"], switches: [] },
    move: { values: ["--agent-id", "--section-id"], switches: [] },
  },
};

export const GLOBAL_FLAGS = [
  "--json",
  "--plain",
  "--allow-writes",
  "--dry-run",
  "--mock",
  "--trust-backend",
  "--base-url",
  "--auth-kind",
  "--login-mode",
  "--help",
  "-h",
];

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}

export function closestName(got: string, allowed: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const name of allowed) {
    const d = levenshtein(got, name);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  // Suggest only when close: 1 edit, or 2 edits for longer names.
  if (best !== undefined && (bestD === 1 || (bestD === 2 && got.length >= 5))) return best;
  return undefined;
}

function flagName(token: string): string {
  return token.split("=")[0]!;
}

/**
 * Reject unknown or misplaced flags with exit 2 and a close-name hint.
 * `rest` is argv after globals: [noun, verb, ...flags].
 */
export function assertCommandFlags(noun: string, verb: string, rest: string[]): void {
  const spec = COMMAND_FLAGS[noun]?.[verb];
  if (!spec) return;
  const allowed = [...spec.values, ...spec.switches];
  const values = new Set(spec.values);
  const switches = new Set(spec.switches);
  for (let i = 2; i < rest.length; i++) {
    const tok = rest[i]!;
    if (!tok.startsWith("-")) {
      throw new GbcError("usage", `unexpected argument: ${tok}`, {
        exitCode: 2,
        hint: `gbc ${noun} ${verb} accepts only flags: ${allowed.join(" ") || "(none)"}`,
      });
    }
    const name = flagName(tok);
    if (!allowed.includes(name)) {
      const suggestion = closestName(name, [...allowed, ...GLOBAL_FLAGS]);
      throw new GbcError("usage", `unknown flag: ${name}`, {
        exitCode: 2,
        hint: suggestion
          ? `did you mean ${suggestion}? See gbc --help`
          : `allowed flags: ${allowed.join(" ") || "(none)"}. See gbc --help`,
      });
    }
    if (switches.has(name) && tok.includes("=")) {
      throw new GbcError("usage", `${name} is a switch, not a value flag`, {
        exitCode: 2,
        hint: `pass ${name} without a value`,
      });
    }
    if (values.has(name) && !tok.includes("=")) i++;
  }
}

/** After parseGlobals, a leftover leading flag is not a noun. */
export function assertNoLeadingFlag(rest: string[]): void {
  const first = rest[0];
  if (first?.startsWith("-")) {
    const name = flagName(first);
    const suggestion = closestName(name, GLOBAL_FLAGS);
    throw new GbcError("usage", `unknown flag: ${name}`, {
      exitCode: 2,
      hint: suggestion
        ? `did you mean ${suggestion}? See gbc --help`
        : "see gbc --help for global flags",
    });
  }
}
