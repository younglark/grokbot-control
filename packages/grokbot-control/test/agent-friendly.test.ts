/**
 * Coverage for the agent-friendly CLI/MCP review fixes (offline / --mock only).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouterTransport } from "@connectrpc/connect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GrokBotService } from "#proto-gen/GrokBotService";
import { ControlPlane } from "../src/ops/plane.js";
import { paginate, LIMIT_DEFAULT } from "../src/ops/limits.js";
import { closestName } from "../src/cli/flags.js";
import { outputMode } from "../src/cli/io.js";
import { buildTools, toolAnnotations } from "../src/mcp/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliSrc = path.join(root, "src/cli/main.ts");
const mcpSrc = path.join(root, "src/mcp/main.ts");

function fakePlane(impl: Record<string, (req: any) => any>) {
  const transport = createRouterTransport(({ service }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service(GrokBotService as any, impl as any),
  );
  return new ControlPlane({ baseUrl: "fake://", transport, simulated: true });
}

function runGbc(args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliSrc, ...args],
      {
        env: { ...process.env, GBT_MOCK: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("shared list pagination", () => {
  it("paginate marks truncated, next, and hint", () => {
    const page = paginate(Array.from({ length: 60 }, (_, i) => i), 50, 0);
    assert.equal(page.items.length, 50);
    assert.equal(page.truncated, true);
    assert.equal(page.next, "50");
    assert.match(page.hint ?? "", /offset=50/);
    const rest = paginate(Array.from({ length: 60 }, (_, i) => i), 50, 50);
    assert.deepEqual(rest.items, [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
    assert.equal(rest.truncated, false);
    assert.equal(rest.next, undefined);
  });

  it("message history, session list, sidebar list, and bot list share truncated/next/hint", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      id: `e${i}`,
      entryKind: "user",
      plaintext: `m${i}`,
    }));
    const sessions = Array.from({ length: 60 }, (_, i) => ({
      agentId: "a1",
      sessionId: `s${i}`,
      kind: 1,
    }));
    const sections = Array.from({ length: 60 }, (_, i) => ({
      id: `sec${i}`,
      name: `S${i}`,
      agentIds: [],
    }));
    const agents = Array.from({ length: 60 }, (_, i) => ({
      id: `${i}`,
      agentId: `a${i}`,
      name: `n${i}`,
    }));
    const plane = fakePlane({
      listGrokBotTranscriptEntries: () => ({ entries, generation: 1 }),
      listGrokBotAgentSessions: () => ({ sessions }),
      getGrokBotUserRuntimeSettings: () => ({
        settings: { sidebarSections: { sections } },
      }),
      listGrokBotAgents: () => ({ agents, truncated: false }),
    });
    const hist = await plane.message.history({ agentId: "a1" });
    assert.equal(hist.ok, true);
    assert.equal(hist.data!.entries.length, LIMIT_DEFAULT);
    assert.equal(hist.data!.truncated, true);
    assert.equal(hist.data!.next, "50");
    assert.ok(hist.data!.hint);
    const hist2 = await plane.message.history({ agentId: "a1", offset: 50 });
    assert.equal(hist2.data!.entries.length, 10);
    assert.equal(hist2.data!.truncated, false);

    const sess = await plane.session.list("a1");
    assert.equal(sess.data!.sessions.length, 50);
    assert.equal(sess.data!.truncated, true);
    assert.equal(sess.data!.next, "50");

    const side = await plane.sidebar.list();
    assert.equal(side.data!.sections.length, 50);
    assert.equal(side.data!.truncated, true);

    const bots = await plane.bot.list();
    assert.equal(bots.data!.bots.length, 50);
    assert.equal(bots.data!.truncated, true);
    assert.equal(bots.data!.next, "50");
    assert.ok(bots.data!.hint);
  });
});

describe("CLI output and unknown flags", () => {
  it("closestName suggests --limit for --limt", () => {
    assert.equal(closestName("--limt", ["--limit", "--offset"]), "--limit");
  });

  it("outputMode is envelope on TTY and pipe; --plain is data-only", () => {
    assert.deepEqual(outputMode({ json: false, plain: false }, true), {
      plain: false,
      compact: false,
    });
    assert.deepEqual(outputMode({ json: true, plain: false }, true), {
      plain: false,
      compact: true,
    });
    assert.deepEqual(outputMode({ json: false, plain: false }, false), {
      plain: false,
      compact: true,
    });
    assert.deepEqual(outputMode({ json: false, plain: true }, false), {
      plain: true,
      compact: true,
    });
  });

  it("pipe without --json still prints the full envelope", async () => {
    const r = await runGbc(["--mock", "bot", "list"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.schema_version, "1.0.0");
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.data.bots));
    assert.equal(typeof j.data.truncated, "boolean");
  });

  it("--plain prints only data", async () => {
    const r = await runGbc(["--mock", "--plain", "bot", "list"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.schema_version, undefined);
    assert.ok(Array.isArray(j.bots));
    assert.equal(typeof j.truncated, "boolean");
  });

  it("--json and --plain together exit 2", async () => {
    const r = await runGbc(["--mock", "--json", "--plain", "bot", "list"]);
    assert.equal(r.code, 2);
    const j = JSON.parse(r.stderr);
    assert.equal(j.code, "usage");
    assert.match(j.error.message, /either --json or --plain/);
  });

  it("unknown flag --limt exits 2 and suggests --limit", async () => {
    const r = await runGbc(["--mock", "--json", "bot", "list", "--limt=5"]);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stdout, "");
    const j = JSON.parse(r.stderr);
    assert.equal(j.code, "usage");
    assert.match(j.error.message, /--limt/);
    assert.match(j.error.hint, /--limit/);
  });

  it("session list accepts --limit and returns truncation fields", async () => {
    const created = await runGbc([
      "--mock",
      "--json",
      "--allow-writes",
      "bot",
      "create",
      "--name",
      "sess-bot",
      "--description",
      "d",
    ]);
    assert.equal(created.code, 0, created.stderr);
    const id = JSON.parse(created.stdout).data.agent_id;
    const listed = await runGbc([
      "--mock",
      "--json",
      "session",
      "list",
      "--agent-id",
      id,
      "--limit",
      "5",
    ]);
    assert.equal(listed.code, 0, listed.stderr);
    const data = JSON.parse(listed.stdout).data;
    assert.ok("truncated" in data);
    assert.ok(data.sessions.length <= 5);
  });
});

describe("MCP default read-only, strict schema, annotations, errors", () => {
  it("default tool list hides writes and keeps auth + reads", () => {
    const names = buildTools().map((t) => t.name);
    assert.ok(names.includes("list_bots"));
    assert.ok(names.includes("auth_whoami"));
    assert.ok(names.includes("auth_login_begin"));
    assert.ok(names.includes("auth_refresh"));
    assert.ok(!names.includes("delete_bot"));
    assert.ok(!names.includes("send_message"));
    assert.ok(!names.includes("reset_computer"));
    assert.ok(!names.includes("interrupt_run"));
    const writes = buildTools({ allowWrites: true }).map((t) => t.name);
    assert.ok(writes.includes("delete_bot"));
    assert.ok(writes.includes("interrupt_run"));
    const ro = buildTools({ readOnly: true, allowWrites: true }).map((t) => t.name);
    assert.ok(ro.includes("auth_whoami"));
    assert.ok(!ro.includes("auth_refresh"));
    assert.ok(!ro.includes("delete_bot"));
  });

  it("schemas are strict and list tools accept limit/offset", () => {
    const tools = buildTools();
    const sessions = tools.find((t) => t.name === "list_sessions")!;
    assert.equal(sessions.inputSchema.safeParse({ agent_id: "a", typo: 1 }).success, false);
    assert.equal(sessions.inputSchema.safeParse({ agent_id: "a", limit: 10, offset: 0 }).success, true);
    const who = tools.find((t) => t.name === "auth_whoami")!;
    assert.equal(who.inputSchema.safeParse({ unexpected: true }).success, false);
    assert.equal(who.inputSchema.safeParse({}).success, true);
  });

  it("annotations mark interrupt and logout as destructive; whoami is closed-world", () => {
    const interrupt = toolAnnotations({ name: "interrupt_run" });
    assert.equal(interrupt.readOnlyHint, false);
    assert.equal(interrupt.destructiveHint, true);
    const logout = toolAnnotations({ name: "auth_logout", authTool: true, readOnly: true });
    assert.equal(logout.destructiveHint, true);
    const who = toolAnnotations({ name: "auth_whoami", readOnly: true });
    assert.equal(who.readOnlyHint, true);
    assert.equal(who.openWorldHint, false);
    const del = toolAnnotations({ name: "delete_bot" });
    assert.equal(del.destructiveHint, true);
    const send = toolAnnotations({ name: "send_message" });
    assert.equal(send.destructiveHint, false);
  });
});

async function withMcp<T>(
  envExtra: Record<string, string>,
  argv: string[],
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", mcpSrc, ...argv],
    env: (() => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.GBT_ALLOW_WRITES;
      delete env.GBT_MCP_READONLY;
      return { ...env, UC_SKIP_OFFICIAL: "1", GBT_MOCK: "1", ...envExtra };
    })(),
    stderr: "pipe",
  });
  const client = new Client({ name: "agent-friendly-test", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

describe("MCP stdio server", () => {
  it("default tools/list is read-only; --allow-writes exposes writes; READONLY wins", async () => {
    await withMcp({ GBT_ALLOW_WRITES: "0" }, [], async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("list_bots"));
      assert.ok(!names.includes("delete_bot"));
      const info = c.getServerVersion();
      assert.equal(info?.name, "grokbot-control");
      assert.match(info?.version ?? "", /^\d+\.\d+\.\d+/);
    });
    await withMcp({}, ["--allow-writes"], async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("delete_bot"));
      const del = (await c.listTools()).tools.find((t) => t.name === "interrupt_run")!;
      assert.equal(del.annotations?.destructiveHint, true);
    });
    await withMcp({ GBT_ALLOW_WRITES: "1", GBT_MCP_READONLY: "1" }, [], async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name);
      assert.ok(!names.includes("delete_bot"));
      assert.ok(!names.includes("auth_refresh"));
    });
  });

  it("validation errors return isError plus envelope code and hint", async () => {
    await withMcp({ GBT_ALLOW_WRITES: "0" }, [], async (c) => {
      const bad = await c.callTool({
        name: "list_bots",
        arguments: { limit: "nope" },
      });
      assert.equal(bad.isError, true);
      const env = bad.structuredContent as {
        ok: boolean;
        code: string;
        error?: { hint?: string; message?: string };
      };
      assert.equal(env.ok, false);
      assert.equal(env.code, "usage");
      assert.ok(env.error?.hint);
      const text = (bad.content as { type: string; text: string }[])[0]?.text ?? "";
      assert.match(text, /"code":"usage"/);

      const extra = await c.callTool({
        name: "list_bots",
        arguments: { typo_limit: 1 },
      });
      assert.equal(extra.isError, true);
      assert.equal((extra.structuredContent as { code: string }).code, "usage");

      const missing = await c.callTool({ name: "no_such_tool", arguments: {} });
      assert.equal(missing.isError, true);
      const miss = missing.structuredContent as {
        code: string;
        error?: { hint?: string };
      };
      assert.equal(miss.code, "not_found");
      assert.match(miss.error?.hint ?? "", /tools\/list/);
    });
  });
});
