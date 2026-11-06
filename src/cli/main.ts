#!/usr/bin/env node
import { HELP } from "./help.js";
import { buildPlane, flag, hasFlag, parseGlobals, persistMockState } from "./config.js";
import { catchToExit, emitResult, usageExit } from "./io.js";
import { failResult, okResult } from "../dto/result.js";

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
    const plane = buildPlane(globals);
    const write = {
      dryRun: globals.dryRun,
      allowWrite: globals.allowWrites,
    };

    let code = 0;
    if (noun === "auth" && verb === "whoami") {
      if (!plane.auth) usageExit("no auth provider");
      code = emitResult(okResult(await plane.auth.whoamiLocal()), asJson);
    } else if (noun === "auth" && verb === "login-begin") {
      if (!plane.auth) usageExit("no auth provider");
      if (globals.mock) {
        code = emitResult(
          failResult("unsupported", "auth login-begin against mock is a stub; inject fetch for unit tests", {
            hint: "Live browser login is incomplete/unverified.",
          }),
          asJson,
        );
      } else {
        const begin = await plane.auth.beginLogin();
        code = emitResult(
          okResult({
            authorization_url: begin.authorization_url,
            state: begin.state,
            note: begin.note,
            poll_token: "[held-in-memory-only-not-returned-in-cli]",
          }),
          asJson,
        );
      }
    } else if (noun === "bot" && verb === "list") {
      code = emitResult(await plane.bot.list({ limit: Number(flag(rest, "--limit") || 50) }), asJson);
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
        text = fs.readFileSync(flag(rest, "--text-file")!, "utf8");
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
      code = emitResult(await plane.message.history({ agentId, limit: Number(flag(rest, "--limit") || 50) }), asJson);
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
