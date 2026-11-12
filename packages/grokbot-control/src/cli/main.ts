#!/usr/bin/env node
import { syncCommand } from "./sync.js";
import { HELP } from "./help.js";
import {
  buildPlane,
  flag,
  hasFlag,
  parseGlobals,
  persistMockState,
} from "./config.js";
import { catchToExit, emitResult, outputMode, usageExit } from "./io.js";
import { assertCommandFlags, assertNoLeadingFlag } from "./flags.js";
import { failResult, okResult } from "../dto/result.js";
import { parseCliLimit, parseCliOffset } from "../ops/limits.js";
import { dashboardCommand } from "./dashboard.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const { globals, rest } = parseGlobals(argv);
    const mode = outputMode(globals, process.stdout.isTTY);
    assertNoLeadingFlag(rest);

    // Local `gbc dashboard` is a noun-only (and `dashboard start`) special case.
    // Official protobuf DashboardService is a different thing and is not a CLI noun.
    let argvRest = rest;
    if (argvRest[0] === "dashboard" && (argvRest[1] === undefined || argvRest[1].startsWith("-"))) {
      argvRest = ["dashboard", "start", ...argvRest.slice(1)];
    }
    const [noun, verb] = argvRest;
    if (!noun || !verb) usageExit("missing <noun> <verb>", "gbc --help");
    assertCommandFlags(noun, verb, argvRest);

    if (noun === "sync")
      return emitResult(await syncCommand(globals, argvRest), mode);
    const plane = buildPlane(globals);
    const write = {
      dryRun: globals.dryRun,
      allowWrite: globals.allowWrites,
    };

    let code = 0;
    if (noun === "dashboard" && verb === "start") {
      code = await dashboardCommand(globals, argvRest, mode, plane);
    } else if (noun === "dashboard") {
      usageExit(
        `unknown command: dashboard ${verb}`,
        "gbc dashboard  or  gbc dashboard start  [--port] [--host] [--no-open]",
      );
    } else if (noun === "auth") {
      const ops = plane.authOps;
      const loginOpts = () => ({ loginMode: globals.loginMode });
      if (verb === "whoami" || verb === "status") {
        code = emitResult(await ops.whoami(), mode);
      } else if (verb === "login-begin") {
        code = emitResult(await ops.begin(loginOpts()), mode);
      } else if (verb === "poll") {
        code = emitResult(await ops.poll(), mode);
      } else if (verb === "complete" || verb === "login") {
        const timeout = flag(rest, "--timeout");
        if (timeout !== undefined && !/^\d+$/.test(timeout))
          usageExit(
            "--timeout must be an integer number of seconds",
            "--timeout=300",
          );
        if (verb === "login") {
          const begin = await ops.begin(loginOpts());
          if (!begin.ok) {
            code = emitResult(begin, mode);
            persistMockState();
            return code;
          }
          // Human-facing URL goes to stderr; stdout carries only the final result.
          process.stderr.write(
            JSON.stringify({
              event: "open_browser",
              authorization_url: (begin.data as { authorization_url: string })
                .authorization_url,
            }) + "\n",
          );
        }
        const ac = new AbortController();
        const onSig = () => ac.abort();
        process.once("SIGINT", onSig);
        process.once("SIGTERM", onSig);
        try {
          code = emitResult(
            await ops.complete(
              timeout === undefined ? undefined : Number(timeout),
              ac.signal,
            ),
            mode,
          );
        } finally {
          process.off("SIGINT", onSig);
          process.off("SIGTERM", onSig);
        }
      } else if (verb === "cancel") {
        code = emitResult(await ops.cancel(), mode);
      } else if (verb === "refresh") {
        code = emitResult(
          await ops.refresh({ force: hasFlag(rest, "--force") }),
          mode,
        );
      } else if (verb === "logout") {
        code = emitResult(await ops.logout(), mode);
      } else {
        usageExit(
          `unknown command: auth ${verb}`,
          "gbc auth whoami|login|login-begin|complete|poll|cancel|refresh[--force]|logout",
        );
      }
    } else if (noun === "computer" && verb === "state") {
      code = emitResult(await plane.computer.state(), mode);
    } else if (noun === "computer" && verb === "reset") {
      const timeoutRaw = flag(rest, "--timeout");
      let timeoutSeconds: number | undefined;
      if (timeoutRaw !== undefined) {
        const parsed = Number(timeoutRaw);
        if (
          !/^\d+$/.test(timeoutRaw) ||
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > 3600
        ) {
          usageExit(
            "--timeout must be an integer 1..3600 seconds",
            "--timeout=600",
          );
        }
        timeoutSeconds = parsed;
      }
      const ac = new AbortController();
      const onSig = () => ac.abort();
      process.once("SIGINT", onSig);
      process.once("SIGTERM", onSig);
      try {
        code = emitResult(
          await plane.computer.reset(
            {
              ...write,
              confirm: flag(rest, "--confirm"),
              hard: hasFlag(rest, "--hard"),
              wait: hasFlag(rest, "--wait"),
              timeoutSeconds,
            },
            ac.signal,
          ),
          mode,
        );
      } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
      }
    } else if (noun === "account" && verb === "cleanup") {
      const timeoutRaw = flag(rest, "--timeout");
      let timeoutSeconds: number | undefined;
      if (timeoutRaw !== undefined) {
        const parsed = Number(timeoutRaw);
        if (
          !/^\d+$/.test(timeoutRaw) ||
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > 3600
        ) {
          usageExit(
            "--timeout must be an integer 1..3600 seconds",
            "--timeout=600",
          );
        }
        timeoutSeconds = parsed;
      }
      const ac = new AbortController();
      const onSig = () => ac.abort();
      process.once("SIGINT", onSig);
      process.once("SIGTERM", onSig);
      try {
        code = emitResult(
          await plane.account.cleanup(
            {
              ...write,
              confirm: flag(rest, "--confirm"),
              plan: flag(rest, "--plan"),
              hard: hasFlag(rest, "--hard"),
              wait: hasFlag(rest, "--wait"),
              timeoutSeconds,
            },
            ac.signal,
          ),
          mode,
        );
      } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
      }
    } else if (noun === "account") {
      usageExit(`unknown command: account ${verb}`, "gbc account cleanup");
    } else if (noun === "bot" && verb === "list") {
      code = emitResult(
        await plane.bot.list({
          limit: parseCliLimit(flag(rest, "--limit")),
          offset: parseCliOffset(flag(rest, "--offset")),
        }),
        mode,
      );
    } else if (noun === "bot" && verb === "get") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot get requires --agent-id", "gbc bot get --agent-id <id>");
      code = emitResult(await plane.bot.get(id), mode);
    } else if (noun === "bot" && verb === "create") {
      const name = flag(rest, "--name");
      if (!name) usageExit("bot create requires --name");
      code = emitResult(
        await plane.bot.create(
          {
            name,
            description: flag(rest, "--description") || "",
            title: flag(rest, "--title"),
            agentId: flag(rest, "--agent-id"),
            language: flag(rest, "--language"),
            kickstart: hasFlag(rest, "--kickstart"),
          },
          write,
        ),
        mode,
      );
    } else if (noun === "bot" && verb === "update") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot update requires --agent-id");
      code = emitResult(
        await plane.bot.update(
          id,
          {
            name: flag(rest, "--name"),
            description: flag(rest, "--description"),
            title: flag(rest, "--title"),
          },
          write,
        ),
        mode,
      );
    } else if (noun === "bot" && verb === "delete") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot delete requires --agent-id");
      code = emitResult(
        await plane.bot.delete(id, {
          ...write,
          confirm: flag(rest, "--confirm"),
        }),
        mode,
      );
    } else if (noun === "bot" && verb === "status") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot status requires --agent-id");
      code = emitResult(await plane.progress.status([id]), mode);
    } else if (noun === "bot" && verb === "todos") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(await plane.progress.todos(id), mode);
    } else if (noun === "bot" && verb === "tasks") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(await plane.progress.tasks(id), mode);
    } else if (noun === "bot" && verb === "subagents") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(await plane.progress.subagents(id), mode);
    } else if (noun === "bot" && verb === "interrupt") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(
        await plane.progress.interrupt(id, {
          ...write,
          confirm: flag(rest, "--confirm"),
          reason: flag(rest, "--reason"),
          sessionId: flag(rest, "--session-id"),
        }),
        mode,
      );
    } else if (noun === "message" && verb === "send") {
      const agentId = flag(rest, "--agent-id");
      const sessionId = flag(rest, "--session-id");
      let text = flag(rest, "--text");
      if (hasFlag(rest, "--text-file")) {
        const fs = await import("node:fs");
        const file = flag(rest, "--text-file");
        if (!file)
          usageExit(
            "--text-file requires a path",
            "gbc message send ... --text-file ./msg.txt",
          );
        try {
          text = fs.readFileSync(file, "utf8");
        } catch (err) {
          usageExit(`cannot read --text-file: ${(err as Error).message}`);
        }
      }
      if (hasFlag(rest, "--text-stdin")) text = await readStdin();
      if (!agentId || text == null) {
        usageExit(
          "message send requires --agent-id and --text|--text-file|--text-stdin; omitted --session-id uses default",
        );
      }
      code = emitResult(
        await plane.message.send({
          agentId,
          sessionId: sessionId || undefined,
          text,
          messageId: flag(rest, "--message-id"),
          dryRun: write.dryRun,
          allowWrite: write.allowWrite,
        }),
        mode,
      );
    } else if (noun === "message" && verb === "status") {
      const agentId = flag(rest, "--agent-id");
      const sessionId = flag(rest, "--session-id");
      const messageId = flag(rest, "--message-id");
      if (!agentId || !messageId)
        usageExit(
          "message status requires --agent-id --message-id; optional --session-id",
        );
      code = emitResult(
        await plane.message.status({
          agentId,
          sessionId: sessionId || undefined,
          messageId,
        }),
        mode,
      );
    } else if (noun === "message" && verb === "history") {
      const agentId = flag(rest, "--agent-id");
      if (!agentId) usageExit("message history requires --agent-id", "gbc message history --agent-id <id> [--limit 50] [--offset 0]");
      code = emitResult(
        await plane.message.history({
          agentId,
          limit: parseCliLimit(flag(rest, "--limit")),
          offset: parseCliOffset(flag(rest, "--offset")),
        }),
        mode,
      );
    } else if (noun === "session" && verb === "list") {
      const agentId = flag(rest, "--agent-id");
      if (!agentId) usageExit("session list requires --agent-id", "gbc session list --agent-id <id> [--limit 50] [--offset 0]");
      code = emitResult(
        await plane.session.list(agentId, {
          limit: parseCliLimit(flag(rest, "--limit")),
          offset: parseCliOffset(flag(rest, "--offset")),
        }),
        mode,
      );
    } else if (noun === "sidebar" && verb === "list") {
      code = emitResult(
        await plane.sidebar.list({
          limit: parseCliLimit(flag(rest, "--limit")),
          offset: parseCliOffset(flag(rest, "--offset")),
        }),
        mode,
      );
    } else if (noun === "sidebar" && verb === "create") {
      const name = flag(rest, "--name");
      if (!name) usageExit("sidebar create requires --name");
      code = emitResult(await plane.sidebar.createSection(name, write), mode);
    } else if (noun === "sidebar" && verb === "rename") {
      const id = flag(rest, "--section-id");
      const name = flag(rest, "--name");
      if (!id || !name)
        usageExit("sidebar rename requires --section-id --name");
      code = emitResult(
        await plane.sidebar.renameSection(id, name, write),
        mode,
      );
    } else if (noun === "sidebar" && verb === "delete") {
      const id = flag(rest, "--section-id");
      if (!id) usageExit("--section-id required");
      code = emitResult(
        await plane.sidebar.deleteSection(id, {
          ...write,
          confirm: flag(rest, "--confirm"),
        }),
        mode,
      );
    } else if (noun === "sidebar" && verb === "move") {
      const agentId = flag(rest, "--agent-id");
      const sectionId = flag(rest, "--section-id");
      if (!agentId || !sectionId)
        usageExit("sidebar move requires --agent-id --section-id");
      code = emitResult(
        await plane.sidebar.moveBot(agentId, sectionId, write),
        mode,
      );
    } else if (noun === "room") {
      code = emitResult(
        failResult(
          "unsupported",
          "Room RPCs are intentionally not mixed into sidebar; not implemented in this cut",
          {
            hint: "Use sidebar for App sidebar grouping.",
          },
        ),
        mode,
      );
    } else {
      usageExit(`unknown command: ${noun} ${verb}`, "gbc --help");
    }
    persistMockState();
    return code;
  } catch (e) {
    persistMockState();
    return catchToExit(e);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error("stdin is a TTY; pass --text or --text-file"));
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", reject);
  });
}

main().then((code) => process.exit(code));
