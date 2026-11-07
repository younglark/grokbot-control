#!/usr/bin/env node
import { syncCommand } from "./sync.js";
import { HELP } from "./help.js";
import { buildPlane, flag, hasFlag, parseGlobals, persistMockState } from "./config.js";
import { catchToExit, emitResult, usageExit } from "./io.js";
import { failResult, okResult } from "../dto/result.js";
import { parseCliLimit } from "../ops/limits.js";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const { globals, rest } = parseGlobals(argv);
  const asJson = globals.json || !process.stdout.isTTY;

  const [noun, verb] = rest;
  if (!noun || !verb) usageExit("missing <noun> <verb>", "gbc --help");

  try {
    if (noun === "sync") return emitResult(await syncCommand(globals, rest), asJson);
    const plane = buildPlane(globals);
    const write = {
      dryRun: globals.dryRun,
      allowWrite: globals.allowWrites,
    };

    let code = 0;
    if (noun === "auth") {
      const ops = plane.authOps;
      if (verb === "whoami" || verb === "status") {
        code = emitResult(await ops.whoami(), asJson);
      } else if (verb === "login-begin") {
        code = emitResult(await ops.begin(), asJson);
      } else if (verb === "poll") {
        code = emitResult(await ops.poll(), asJson);
      } else if (verb === "complete" || verb === "login") {
        const timeout = flag(rest, "--timeout");
        if (timeout !== undefined && !/^\d+$/.test(timeout)) usageExit("--timeout must be an integer number of seconds", "--timeout=300");
        if (verb === "login") {
          const begin = await ops.begin();
          if (!begin.ok) {
            code = emitResult(begin, asJson);
            persistMockState();
            return code;
          }
          // Human-facing URL goes to stderr; stdout carries only the final result.
          process.stderr.write(
            JSON.stringify({ event: "open_browser", authorization_url: (begin.data as { authorization_url: string }).authorization_url }) + "\n",
          );
        }
        const ac = new AbortController();
        const onSig = () => ac.abort();
        process.once("SIGINT", onSig);
        process.once("SIGTERM", onSig);
        try {
          code = emitResult(await ops.complete(timeout === undefined ? undefined : Number(timeout), ac.signal), asJson);
        } finally {
          process.off("SIGINT", onSig);
          process.off("SIGTERM", onSig);
        }
      } else if (verb === "cancel") {
        code = emitResult(await ops.cancel(), asJson);
      } else if (verb === "refresh") {
        code = emitResult(await ops.refresh(), asJson);
      } else if (verb === "logout") {
        code = emitResult(await ops.logout(), asJson);
      } else {
        usageExit(`unknown command: auth ${verb}`, "gbc auth whoami|login|login-begin|complete|poll|cancel|refresh|logout");
      }
    } else if (noun === "bot" && verb === "list") {
      code = emitResult(await plane.bot.list({ limit: parseCliLimit(flag(rest, "--limit")) }), asJson);
    } else if (noun === "bot" && verb === "get") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot get requires --agent-id");
      code = emitResult(await plane.bot.get(id), asJson);
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
        asJson,
      );
    } else if (noun === "bot" && verb === "update") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot update requires --agent-id");
      code = emitResult(
        await plane.bot.update(
          id,
          { name: flag(rest, "--name"), description: flag(rest, "--description"), title: flag(rest, "--title") },
          write,
        ),
        asJson,
      );
    } else if (noun === "bot" && verb === "delete") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot delete requires --agent-id");
      code = emitResult(await plane.bot.delete(id, { ...write, confirm: flag(rest, "--confirm") }), asJson);
    } else if (noun === "bot" && verb === "status") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("bot status requires --agent-id");
      code = emitResult(await plane.progress.status([id]), asJson);
    } else if (noun === "bot" && verb === "todos") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(await plane.progress.todos(id), asJson);
    } else if (noun === "bot" && verb === "tasks") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(await plane.progress.tasks(id), asJson);
    } else if (noun === "bot" && verb === "subagents") {
      const id = flag(rest, "--agent-id");
      if (!id) usageExit("--agent-id required");
      code = emitResult(await plane.progress.subagents(id), asJson);
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
        asJson,
      );
    } else if (noun === "message" && verb === "send") {
      const agentId = flag(rest, "--agent-id");
      const sessionId = flag(rest, "--session-id");
      let text = flag(rest, "--text");
      if (hasFlag(rest, "--text-file")) {
        const fs = await import("node:fs");
        const file = flag(rest, "--text-file");
        if (!file) usageExit("--text-file requires a path", "gbc message send ... --text-file ./msg.txt");
        try {
          text = fs.readFileSync(file, "utf8");
        } catch (err) {
          usageExit(`cannot read --text-file: ${(err as Error).message}`);
        }
      }
      if (hasFlag(rest, "--text-stdin")) text = await readStdin();
      if (!agentId || !sessionId || text == null) {
        usageExit("message send requires --agent-id --session-id and --text|--text-file|--text-stdin");
      }
      code = emitResult(
        await plane.message.send({
          agentId,
          sessionId,
          text,
          messageId: flag(rest, "--message-id"),
          dryRun: write.dryRun,
          allowWrite: write.allowWrite,
        }),
        asJson,
      );
    } else if (noun === "message" && verb === "status") {
      const agentId = flag(rest, "--agent-id");
      const sessionId = flag(rest, "--session-id");
      const messageId = flag(rest, "--message-id");
      if (!agentId || !sessionId || !messageId) usageExit("message status requires --agent-id --session-id --message-id");
      code = emitResult(await plane.message.status({ agentId, sessionId, messageId }), asJson);
    } else if (noun === "message" && verb === "history") {
      const agentId = flag(rest, "--agent-id");
      if (!agentId) usageExit("--agent-id required");
      code = emitResult(await plane.message.history({ agentId, limit: parseCliLimit(flag(rest, "--limit")) }), asJson);
    } else if (noun === "session" && verb === "list") {
      const agentId = flag(rest, "--agent-id");
      if (!agentId) usageExit("--agent-id required");
      code = emitResult(await plane.session.list(agentId), asJson);
    } else if (noun === "sidebar" && verb === "list") {
      code = emitResult(await plane.sidebar.list(), asJson);
    } else if (noun === "sidebar" && verb === "create") {
      const name = flag(rest, "--name");
      if (!name) usageExit("sidebar create requires --name");
      code = emitResult(await plane.sidebar.createSection(name, write), asJson);
    } else if (noun === "sidebar" && verb === "rename") {
      const id = flag(rest, "--section-id");
      const name = flag(rest, "--name");
      if (!id || !name) usageExit("sidebar rename requires --section-id --name");
      code = emitResult(await plane.sidebar.renameSection(id, name, write), asJson);
    } else if (noun === "sidebar" && verb === "delete") {
      const id = flag(rest, "--section-id");
      if (!id) usageExit("--section-id required");
      code = emitResult(
        await plane.sidebar.deleteSection(id, { ...write, confirm: flag(rest, "--confirm") }),
        asJson,
      );
    } else if (noun === "sidebar" && verb === "move") {
      const agentId = flag(rest, "--agent-id");
      const sectionId = flag(rest, "--section-id");
      if (!agentId || !sectionId) usageExit("sidebar move requires --agent-id --section-id");
      code = emitResult(await plane.sidebar.moveBot(agentId, sectionId, write), asJson);
    } else if (noun === "room") {
      code = emitResult(
        failResult("unsupported", "Room RPCs are intentionally not mixed into sidebar; not implemented in this cut", {
          hint: "Use sidebar for App sidebar grouping.",
        }),
        asJson,
      );
    } else {
      usageExit(`unknown command: ${noun} ${verb}`, "gbc --help");
    }
    persistMockState();
    return code;
  } catch (e) {
    persistMockState();
    return catchToExit(e, asJson);
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
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

main().then((code) => process.exit(code));
