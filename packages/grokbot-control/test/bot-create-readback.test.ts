/**
 * Issue #3 / #4: bot create/update read-back and --description-file.
 * Offline only (mock transport / CLI --mock). Mock passing ≠ live proof.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "../src/ops/plane.js";
import { BotOps, READBACK_BUDGET_MS } from "../src/ops/bot.js";
import { createEmptyMockState, createMockTransport, type MockState } from "../src/testing/mock-transport.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { buildTools } from "../src/mcp/tools.js";
import { mapExitCode } from "../src/errors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = { allowWrite: true };
const exitOf = (r: { code: string; outcome?: string; retryable?: boolean }) =>
  mapExitCode(r.code, r.outcome as never, r.retryable);

function setup(patch: Partial<MockState> = {}, delays?: number[]) {
  const state = Object.assign(createEmptyMockState(), patch);
  const plane = new ControlPlane({
    baseUrl: "mock://",
    transport: createMockTransport(state),
    simulated: true,
    auth: staticTokenProvider({ kind: "cursor", backend: "https://api2.cursor.sh", accessToken: "t" }),
  });
  const bot = delays ? new BotOps(plane.client, { simulated: true, readbackDelaysMs: delays }) : plane.bot;
  return { state, plane, bot };
}

function createReq(state: MockState): Record<string, unknown> {
  return state.bots[state.bots.length - 1] as Record<string, unknown>;
}

describe("bot create read-back (issue #3)", () => {
  it("server merges title into name -> renamed_by_server, observed from list", async () => {
    const { state, bot } = setup({ mergeTitleIntoName: true });
    const r = await bot.create({ name: "Showrunner", title: "幕僚长", description: "d" }, W);
    assert.equal(r.ok, true, JSON.stringify(r));
    const d = r.data!;
    assert.deepEqual(d.requested, { name: "Showrunner", title: "幕僚长" });
    assert.deepEqual(d.observed, { name: "Showrunner · 幕僚长", title: "" });
    assert.equal(d.renamed_by_server, true);
    assert.deepEqual(d.changed_fields, ["name", "title"]);
    assert.equal(d.bot.name, "Showrunner · 幕僚长");
    assert.equal(d.agent_id, d.bot.agent_id);
    assert.equal(d.readback.attempts, 1);
    assert.match(d.note!, /merge title/);
    assert.equal(state.callCounts!.listGrokBotAgents, 1);
  });

  it("no rename -> renamed_by_server false, no note", async () => {
    const { bot } = setup();
    const r = await bot.create({ name: "Spec", title: "行为规格" }, W);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data!.observed, { name: "Spec", title: "行为规格" });
    assert.equal(r.data!.renamed_by_server, false);
    assert.deepEqual(r.data!.changed_fields, []);
    assert.equal(r.data!.note, undefined);
  });

  it("omitted title sends \"\" (App: title: n.title ?? \"\")", async () => {
    const { state, bot } = setup();
    const r = await bot.create({ name: "NoTitle" }, W);
    assert.equal(r.ok, true);
    assert.equal(createReq(state).title, "");
    assert.deepEqual(r.data!.requested, { name: "NoTitle", title: "" });
    assert.equal(r.data!.renamed_by_server, false);
  });

  it("read-back lag: agent found on a retry", async () => {
    const { state, bot } = setup({ createVisibilityDelayLists: 2 }, [5, 5]);
    const r = await bot.create({ name: "Lag" }, W);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data!.readback.attempts, 3);
    assert.equal(state.callCounts!.listGrokBotAgents, 3);
  });

  it("default retry schedule stays within the ~3s budget and finds a lagging agent", async () => {
    const { bot } = setup({ createVisibilityDelayLists: 1 });
    const t0 = Date.now();
    const r = await bot.create({ name: "Lag1" }, W);
    assert.equal(r.ok, true);
    assert.equal(r.data!.readback.attempts, 2);
    assert.ok(Date.now() - t0 < READBACK_BUDGET_MS);
  });

  it("never found -> create_unverified, outcome unknown, exit 10, agent_id kept", async () => {
    const { state, bot } = setup({ createVisibilityDelayLists: 99 }, [1, 1]);
    const r = await bot.create({ name: "Ghost", title: "t", agentId: "ghost-1" }, W);
    assert.equal(r.ok, false);
    assert.equal(r.code, "create_unverified");
    assert.equal(r.outcome, "unknown");
    assert.equal(r.retryable, false);
    assert.equal(exitOf(r), 10);
    const det = r.error!.details as Record<string, any>;
    assert.equal(det.agent_id, "ghost-1");
    assert.equal(det.write_sent, true);
    assert.deepEqual(det.requested, { name: "Ghost", title: "t" });
    assert.equal(det.readback.reason, "not_found");
    assert.equal(det.readback.attempts, 3);
    assert.equal(state.callCounts!.listGrokBotAgents, 3);
    assert.equal(state.bots.length, 1, "create was sent exactly once (no replay)");
  });

  it("list failure after create -> create_unverified (no retry), exit 10", async () => {
    const { state, bot } = setup({ failListAgents: true }, [1, 1]);
    const r = await bot.create({ name: "X", agentId: "x-1" }, W);
    assert.equal(r.code, "create_unverified");
    assert.equal(exitOf(r), 10);
    const det = r.error!.details as Record<string, any>;
    assert.equal(det.agent_id, "x-1");
    assert.equal(det.readback.reason, "list_failed");
    assert.equal(det.readback.attempts, 1);
    assert.equal(state.bots.length, 1);
  });

  it("truncated list without the agent -> create_unverified (no retry)", async () => {
    const { bot } = setup({ listTruncated: true, createVisibilityDelayLists: 99 }, [1, 1]);
    const r = await bot.create({ name: "T", agentId: "t-1" }, W);
    assert.equal(r.code, "create_unverified");
    assert.equal((r.error!.details as any).readback.reason, "truncated");
    assert.equal((r.error!.details as any).readback.attempts, 1);
  });

  it("truncated list that contains the agent is still verified", async () => {
    const { bot } = setup({ listTruncated: true });
    const r = await bot.create({ name: "T2" }, W);
    assert.equal(r.ok, true);
  });

  it("dry-run: no RPC, note says a server rename cannot be detected, title \"\" when omitted", async () => {
    const { state, bot } = setup({ mergeTitleIntoName: true });
    const r = await bot.create({ name: "Dry", title: "标题" }, { dryRun: true });
    assert.equal(r.code, "dry_run");
    assert.match(r.data!.note!, /cannot reveal a server-side rename/);
    assert.match(r.data!.note!, /merge title into the display name/);
    assert.deepEqual(r.data!.observed, r.data!.requested);
    assert.equal(r.data!.readback.attempts, 0);
    assert.equal(state.bots.length, 0);
    assert.equal(state.callCounts!.listGrokBotAgents, 0);
    const r2 = await bot.create({ name: "Dry" }, { dryRun: true });
    assert.equal(r2.data!.bot.title, "");
  });
});

describe("bot update read-back", () => {
  it("compares only patched fields; detects server merge", async () => {
    const { bot } = setup({ mergeTitleIntoName: true });
    const c = await bot.create({ name: "U" }, W);
    const id = c.data!.agent_id;
    const u = await bot.update(id, { description: "new" }, W);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.deepEqual(u.data!.requested, { name: null, title: null });
    assert.equal(u.data!.renamed_by_server, false);
    const t = await bot.update(id, { title: "头衔" }, W);
    assert.equal(t.ok, true);
    assert.deepEqual(t.data!.requested, { name: null, title: "头衔" });
    assert.deepEqual(t.data!.observed, { name: "U · 头衔", title: "" });
    assert.equal(t.data!.renamed_by_server, true);
    assert.deepEqual(t.data!.changed_fields, ["title"]);
  });

  it("read-back failure -> update_unverified exit 10", async () => {
    const { state, bot } = setup({}, [1, 1]);
    const c = await bot.create({ name: "U2", agentId: "u2" }, W);
    assert.equal(c.ok, true);
    // serverId() resolves via one list; the read-back list after the write fails.
    state.failListAgentsAfter = 1;
    const u = await bot.update("u2", { name: "U3" }, W);
    assert.equal(u.code, "update_unverified");
    assert.equal(exitOf(u), 10);
    assert.equal((u.error!.details as any).agent_id, "u2");
    assert.equal(state.bots[0]!.name, "U3");
  });

  it("dry-run update carries the rename note", async () => {
    const { bot } = setup();
    const u = await bot.update("a", { title: "x" }, { dryRun: true });
    assert.equal(u.code, "dry_run");
    assert.match(u.data!.note!, /cannot reveal a server-side rename/);
  });
});

describe("MCP create_bot/update_bot match SDK shape", () => {
  it("returns requested/observed/renamed_by_server", async () => {
    const { plane } = setup({ mergeTitleIntoName: true });
    const tools = buildTools({ allowWrites: true });
    const c = await tools.find((t) => t.name === "create_bot")!.handler(plane, {
      name: "M",
      title: "T",
      allow_writes: true,
    });
    assert.equal(c.ok, true);
    const d = c.data as any;
    assert.equal(d.renamed_by_server, true);
    assert.deepEqual(d.observed, { name: "M · T", title: "" });
    const u = await tools.find((t) => t.name === "update_bot")!.handler(plane, {
      agent_id: d.agent_id,
      name: "M2",
      allow_writes: true,
    });
    assert.equal(u.ok, true);
    assert.deepEqual((u.data as any).requested, { name: "M2", title: null });
    assert.equal((u.data as any).renamed_by_server, false);
  });
});

// ---- CLI process tests (tsx entry, --mock, isolated state file) ----

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gbc-pr-c-"));
}
function cli(args: string[], stateFile: string) {
  const env: Record<string, string | undefined> = { ...process.env, GBT_MOCK_STATE: stateFile, GBT_MOCK: "1" };
  delete env.GBT_ALLOW_WRITES;
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src/cli/main.ts"), "--mock", "--json", ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI --description-file (issue #4)", () => {
  const multi = "第一行职责\n- 列表项 \"引号\" \\ 反斜杠\n\n末尾空行\n";

  it("create: multi-line description round-trips byte for byte; stdout is single-line JSON", () => {
    const d = tmpDir();
    const st = path.join(d, "s.json");
    const f = path.join(d, "desc.md");
    fs.writeFileSync(f, multi);
    const r = cli(["--allow-writes", "bot", "create", "--name", "Doc", "--description-file", f], st);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split("\n").length, 2, "one JSON line + trailing newline");
    const j = JSON.parse(r.out);
    assert.equal(j.data.bot.description, multi);
    const g = cli(["bot", "get", "--agent-id", j.data.agent_id], st);
    assert.equal(JSON.parse(g.out).data.bot.description, multi);
  });

  it("update: --description-file=<path> form", () => {
    const d = tmpDir();
    const st = path.join(d, "s.json");
    const f = path.join(d, "desc.md");
    fs.writeFileSync(f, multi);
    const c = JSON.parse(cli(["--allow-writes", "bot", "create", "--name", "Doc"], st).out);
    const r = cli(["--allow-writes", "bot", "update", "--agent-id", c.data.agent_id, `--description-file=${f}`], st);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).data.bot.description, multi);
  });

  it("--description and --description-file together -> exit 2, nothing written", () => {
    const d = tmpDir();
    const st = path.join(d, "s.json");
    const f = path.join(d, "desc.md");
    fs.writeFileSync(f, "x");
    for (const verb of [
      ["bot", "create", "--name", "A"],
      ["bot", "update", "--agent-id", "a"],
    ]) {
      const r = cli(["--allow-writes", ...verb, "--description", "y", "--description-file", f], st);
      assert.equal(r.code, 2, r.err);
      assert.equal(JSON.parse(r.err).code, "usage");
      assert.match(JSON.parse(r.err).error.message, /not both/);
    }
    assert.ok(!fs.existsSync(st) || JSON.parse(fs.readFileSync(st, "utf8")).bots.length === 0);
  });

  it("missing file -> exit 2, nothing written", () => {
    const d = tmpDir();
    const st = path.join(d, "s.json");
    const r = cli(["--allow-writes", "bot", "create", "--name", "A", "--description-file", path.join(d, "nope.md")], st);
    assert.equal(r.code, 2);
    assert.match(JSON.parse(r.err).error.message, /cannot read --description-file/);
    assert.ok(!fs.existsSync(st) || JSON.parse(fs.readFileSync(st, "utf8")).bots.length === 0);
  });

  it("--description-file without a value -> exit 2", () => {
    const st = path.join(tmpDir(), "s.json");
    const r = cli(["--allow-writes", "bot", "create", "--name", "A", "--description-file"], st);
    assert.equal(r.code, 2);
  });

  it("--text-file still works after the shared helper refactor", () => {
    const d = tmpDir();
    const st = path.join(d, "s.json");
    const f = path.join(d, "m.txt");
    fs.writeFileSync(f, "a\nb");
    const r = cli(["--allow-writes", "message", "send", "--agent-id", "a", "--session-id", "s", "--text-file", f], st);
    assert.equal(r.code, 0, r.err);
    const bad = cli(["--allow-writes", "message", "send", "--agent-id", "a", "--text-file", path.join(d, "no")], st);
    assert.equal(bad.code, 2);
    assert.match(JSON.parse(bad.err).error.message, /cannot read --text-file/);
  });

  it("help documents --description-file, the echo pitfall and the title merge", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "src/cli/main.ts"), "--help"], { encoding: "utf8" });
    assert.match(r.stdout, /--description-file/);
    assert.match(r.stdout, /printf '%s'/);
    assert.match(r.stdout, /Do not re-print --json output with echo/);
    assert.match(r.stdout, /create_unverified/);
    assert.match(r.stdout, /issue #3/);
  });
});

describe("CLI read-back exit codes", () => {
  it("rename visible in CLI output; read-back miss exits 10 with agent_id on stderr", () => {
    const d = tmpDir();
    const st = path.join(d, "s.json");
    fs.writeFileSync(st, JSON.stringify({ ...createEmptyMockState(), callCounts: undefined, mergeTitleIntoName: true }));
    const ok = cli(["--allow-writes", "bot", "create", "--name", "Showrunner", "--title", "幕僚长"], st);
    assert.equal(ok.code, 0, ok.err);
    const j = JSON.parse(ok.out);
    assert.equal(j.data.renamed_by_server, true);
    assert.equal(j.data.observed.name, "Showrunner · 幕僚长");

    const s2 = JSON.parse(fs.readFileSync(st, "utf8"));
    s2.createVisibilityDelayLists = 99;
    fs.writeFileSync(st, JSON.stringify(s2));
    const miss = cli(["--allow-writes", "bot", "create", "--name", "Ghost", "--agent-id", "ghost-cli"], st);
    assert.equal(miss.code, 10, miss.err);
    assert.equal(miss.out, "");
    const e = JSON.parse(miss.err);
    assert.equal(e.code, "create_unverified");
    assert.equal(e.outcome, "unknown");
    assert.equal(e.error.details.agent_id, "ghost-cli");
  });
});
