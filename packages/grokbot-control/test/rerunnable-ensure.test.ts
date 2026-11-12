/**
 * Issue #6: rerun the same sidebar/bot script after a mid-way failure without
 * duplicates. Offline only (mock transport / CLI --mock). Mock passing ≠ live proof.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "../src/ops/plane.js";
import { createEmptyMockState, createMockTransport, type MockState } from "../src/testing/mock-transport.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { buildTools } from "../src/mcp/tools.js";
import { mapExitCode } from "../src/errors.js";
import { botNameForms, TITLE_MERGE_SEPARATOR } from "../src/ops/bot.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = { allowWrite: true };
const R = { ifExists: "reuse" as const };
const exitOf = (r: { code: string; outcome?: string; retryable?: boolean }) =>
  mapExitCode(r.code, r.outcome as never, r.retryable);

function setup(patch: Partial<MockState> = {}) {
  const state = Object.assign(createEmptyMockState(), patch);
  const plane = new ControlPlane({
    baseUrl: "mock://",
    transport: createMockTransport(state),
    simulated: true,
    auth: staticTokenProvider({ kind: "cursor", backend: "https://api2.cursor.sh", accessToken: "t" }),
  });
  return { state, plane };
}

function seedBot(state: MockState, agentId: string, name: string, title = "") {
  state.bots.push({ id: agentId, agentId, name, title, description: "", harness: "TEMPORAL" });
}

describe("sidebar create --if-exists=reuse", () => {
  it("rerun reuses the one same-name section: existing true, no write", async () => {
    const { state, plane } = setup();
    const a = await plane.sidebar.createSection("Grok Bot Replica", W, R);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.data!.existing, false);
    assert.ok(a.data!.section_id);
    assert.equal(a.data!.section!.name, "Grok Bot Replica");
    assert.equal(state.sidebarWrites, 1);

    const b = await plane.sidebar.createSection("Grok Bot Replica", W, R);
    assert.equal(b.ok, true);
    assert.equal(b.data!.existing, true);
    assert.equal(b.data!.section_id, a.data!.section_id);
    assert.equal(state.sidebarWrites, 1, "no second write");
    assert.equal(state.sections.length, 1);
  });

  it("reuse does not need --allow-writes when nothing is written", async () => {
    const { state, plane } = setup({ sections: [{ id: "s1", name: "Work", agent_ids: [] }] });
    const r = await plane.sidebar.createSection("Work", {}, R);
    assert.equal(r.ok, true);
    assert.equal(r.data!.existing, true);
    assert.equal(state.sidebarWrites ?? 0, 0);
  });

  it("two same-name sections -> ambiguous_match exit 6 with candidates, no write", async () => {
    const { state, plane } = setup({
      sections: [
        { id: "s1", name: "Dup", agent_ids: [] },
        { id: "s2", name: "Dup", agent_ids: ["a"] },
      ],
    });
    const r = await plane.sidebar.createSection("Dup", W, R);
    assert.equal(r.ok, false);
    assert.equal(r.code, "ambiguous_match");
    assert.equal(exitOf(r), 6);
    const det = r.error!.details as any;
    assert.deepEqual(det.candidates.map((c: any) => c.section_id), ["s1", "s2"]);
    assert.equal(det.write_sent, false);
    assert.equal(state.sidebarWrites ?? 0, 0);
  });

  it("default (no flag) still always creates a new section", async () => {
    const { state, plane } = setup({ sections: [{ id: "s1", name: "Work", agent_ids: [] }] });
    const r = await plane.sidebar.createSection("Work", W);
    assert.equal(r.ok, true);
    assert.equal(r.data!.existing, false);
    assert.notEqual(r.data!.section_id, "s1");
    assert.equal(state.sections.filter((s) => s.name === "Work").length, 2);
  });

  it("dry-run lists would create / would reuse and sends no write", async () => {
    const { state, plane } = setup({ sections: [{ id: "s1", name: "Have", agent_ids: [] }] });
    const reuse = await plane.sidebar.createSection("Have", { dryRun: true }, R);
    assert.equal(reuse.code, "dry_run");
    assert.equal(reuse.data!.would, "reuse");
    assert.equal(reuse.data!.existing, true);
    const create = await plane.sidebar.createSection("New", { dryRun: true }, R);
    assert.equal(create.code, "dry_run");
    assert.equal(create.data!.would, "create");
    assert.equal(create.data!.existing, false);
    assert.equal(state.sidebarWrites ?? 0, 0);
    assert.equal(state.sections.length, 1);
  });

  it("write failure keeps the planned section_id in error.details", async () => {
    const { state, plane } = setup({ dropNextWrite: true });
    const r = await plane.sidebar.createSection("X", W, R);
    assert.equal(r.ok, false);
    assert.equal(exitOf(r), 10);
    const det = r.error!.details as any;
    assert.ok(det.section_id);
    assert.equal(det.write_sent, true);
    assert.equal(state.sidebarWrites, 1);
  });
});

describe("sidebar move: skip when already there", () => {
  it("already only in the target section -> skipped, existing, no write, order kept", async () => {
    const { state, plane } = setup({ sections: [{ id: "s1", name: "W", agent_ids: ["a1", "a2"] }] });
    const r = await plane.sidebar.moveBot("a1", "s1", W);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data!.skipped, true);
    assert.equal(r.data!.existing, true);
    assert.equal(state.sidebarWrites ?? 0, 0);
    assert.deepEqual(state.sections[0]!.agent_ids, ["a1", "a2"], "not moved to the end");
  });

  it("in target and also elsewhere -> one write removes the other copy, target position kept", async () => {
    const { state, plane } = setup({
      sections: [
        { id: "s1", name: "W", agent_ids: ["a1", "a2"] },
        { id: "s2", name: "V", agent_ids: ["a1"] },
      ],
    });
    const r = await plane.sidebar.moveBot("a1", "s1", W);
    assert.equal(r.ok, true);
    assert.equal(r.data!.skipped, false);
    assert.equal(r.data!.existing, true);
    assert.equal(state.sidebarWrites, 1);
    assert.deepEqual(state.sections[0]!.agent_ids, ["a1", "a2"]);
    assert.deepEqual(state.sections[1]!.agent_ids, []);
  });

  it("not yet there -> moves (existing false, skipped false)", async () => {
    const { state, plane } = setup({
      sections: [
        { id: "s1", name: "W", agent_ids: [] },
        { id: "s2", name: "V", agent_ids: ["a1"] },
      ],
    });
    const r = await plane.sidebar.moveBot("a1", "s1", W);
    assert.equal(r.ok, true);
    assert.equal(r.data!.existing, false);
    assert.equal(r.data!.skipped, false);
    assert.deepEqual(state.sections[0]!.agent_ids, ["a1"]);
    assert.deepEqual(state.sections[1]!.agent_ids, []);
  });

  it("--section-name resolves a unique exact name; duplicates -> 6; missing -> 5", async () => {
    const { state, plane } = setup({
      sections: [
        { id: "s1", name: "W", agent_ids: [] },
        { id: "d1", name: "Dup", agent_ids: [] },
        { id: "d2", name: "Dup", agent_ids: [] },
      ],
    });
    const ok = await plane.sidebar.moveBot("a1", { sectionName: "W" }, W);
    assert.equal(ok.ok, true);
    assert.equal(ok.data!.section_id, "s1");
    const dup = await plane.sidebar.moveBot("a1", { sectionName: "Dup" }, W);
    assert.equal(dup.code, "ambiguous_match");
    assert.equal(exitOf(dup), 6);
    const none = await plane.sidebar.moveBot("a1", { sectionName: "w" }, W);
    assert.equal(none.code, "not_found");
    assert.equal(exitOf(none), 5);
    assert.equal(state.sidebarWrites, 1);
  });

  it("dry-run reports would move / would skip with no write", async () => {
    const { state, plane } = setup({ sections: [{ id: "s1", name: "W", agent_ids: ["a1"] }] });
    const skip = await plane.sidebar.moveBot("a1", "s1", { dryRun: true });
    assert.equal(skip.code, "dry_run");
    assert.equal(skip.data!.would, "skip");
    const move = await plane.sidebar.moveBot("a2", "s1", { dryRun: true });
    assert.equal(move.data!.would, "move");
    assert.equal(state.sidebarWrites ?? 0, 0);
  });

  it("needs exactly one of section id / name (usage)", async () => {
    const { plane } = setup();
    const r = await plane.sidebar.moveBot("a1", {}, W);
    assert.equal(r.code, "usage");
    const r2 = await plane.sidebar.moveBot("a1", { sectionId: "s", sectionName: "n" }, W);
    assert.equal(r2.code, "usage");
  });

  it("write failure carries agent_id and section_id", async () => {
    const { plane } = setup({ sections: [{ id: "s1", name: "W", agent_ids: [] }], dropNextWrite: true });
    const r = await plane.sidebar.moveBot("a1", "s1", W);
    assert.equal(exitOf(r), 10);
    const det = r.error!.details as any;
    assert.equal(det.agent_id, "a1");
    assert.equal(det.section_id, "s1");
  });
});

describe("bot create --if-exists=reuse", () => {
  it("uses the observed separator for merged names", () => {
    assert.equal(TITLE_MERGE_SEPARATOR, " · ");
    assert.deepEqual(botNameForms("Showrunner", "幕僚长"), ["Showrunner", "Showrunner · 幕僚长"]);
    assert.deepEqual(botNameForms("Showrunner"), ["Showrunner"]);
  });

  it("rerun after a server title merge reuses the bot (merged_name), no second create", async () => {
    const { state, plane } = setup({ mergeTitleIntoName: true });
    const a = await plane.bot.create({ name: "Showrunner", title: "幕僚长", description: "route only" }, W, R);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.data!.existing, false);
    assert.equal(a.data!.bot.name, "Showrunner · 幕僚长");
    const b = await plane.bot.create({ name: "Showrunner", title: "幕僚长", description: "route only" }, W, R);
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.data!.existing, true);
    assert.equal(b.data!.matched_by, "merged_name");
    assert.equal(b.data!.agent_id, a.data!.agent_id);
    assert.equal(b.data!.renamed_by_server, true);
    assert.equal(state.createCalls, 1);
    assert.equal(state.bots.length, 1);
  });

  it("exact name match -> matched_by name; works without --allow-writes", async () => {
    const { state, plane } = setup();
    seedBot(state, "a1", "Spec");
    const r = await plane.bot.create({ name: "Spec" }, {}, R);
    assert.equal(r.ok, true);
    assert.equal(r.data!.matched_by, "name");
    assert.equal(r.data!.agent_id, "a1");
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("--agent-id match wins even if the name changed", async () => {
    const { state, plane } = setup();
    seedBot(state, "fixed-1", "Renamed");
    const r = await plane.bot.create({ name: "Spec", agentId: "fixed-1" }, W, R);
    assert.equal(r.ok, true);
    assert.equal(r.data!.matched_by, "agent_id");
    assert.equal(r.data!.existing, true);
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("--agent-id differs from the one same-name bot -> conflict exit 6, no create", async () => {
    const { state, plane } = setup();
    seedBot(state, "other", "Spec");
    const r = await plane.bot.create({ name: "Spec", agentId: "fixed-1" }, W, R);
    assert.equal(r.code, "conflict");
    assert.equal(exitOf(r), 6);
    assert.equal((r.error!.details as any).candidates[0].agent_id, "other");
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("several matches (plain + merged) -> ambiguous_match exit 6 with candidates", async () => {
    const { state, plane } = setup();
    seedBot(state, "a1", "Showrunner");
    seedBot(state, "a2", "Showrunner · 幕僚长");
    const r = await plane.bot.create({ name: "Showrunner", title: "幕僚长" }, W, R);
    assert.equal(r.code, "ambiguous_match");
    assert.equal(exitOf(r), 6);
    assert.deepEqual((r.error!.details as any).candidates.map((c: any) => c.agent_id), ["a1", "a2"]);
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("truncated list -> lookup_incomplete exit 10, no create (even with one name match)", async () => {
    const { state, plane } = setup({ listTruncated: true });
    const none = await plane.bot.create({ name: "New" }, W, R);
    assert.equal(none.code, "lookup_incomplete");
    assert.equal(none.outcome, "unknown");
    assert.equal(exitOf(none), 10);
    seedBot(state, "a1", "Have");
    const one = await plane.bot.create({ name: "Have" }, W, R);
    assert.equal(exitOf(one), 10);
    assert.equal((one.error!.details as any).reason, "truncated");
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("truncated list still reuses an --agent-id match (ids are unique)", async () => {
    const { state, plane } = setup({ listTruncated: true });
    seedBot(state, "fixed-1", "Have");
    const r = await plane.bot.create({ name: "Have", agentId: "fixed-1" }, W, R);
    assert.equal(r.ok, true);
    assert.equal(r.data!.matched_by, "agent_id");
  });

  it("list failure -> lookup_incomplete exit 10, no create", async () => {
    const { state, plane } = setup({ failListAgents: true });
    const r = await plane.bot.create({ name: "X" }, W, R);
    assert.equal(r.code, "lookup_incomplete");
    assert.equal(exitOf(r), 10);
    assert.equal((r.error!.details as any).reason, "list_failed");
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("dry-run: would reuse / would create, reads the list, sends no create", async () => {
    const { state, plane } = setup();
    seedBot(state, "a1", "Have");
    const reuse = await plane.bot.create({ name: "Have" }, { dryRun: true }, R);
    assert.equal(reuse.code, "dry_run");
    assert.equal(reuse.data!.would, "reuse");
    const create = await plane.bot.create({ name: "New" }, { dryRun: true }, R);
    assert.equal(create.code, "dry_run");
    assert.equal(create.data!.would, "create");
    assert.equal(create.data!.existing, false);
    assert.equal(state.createCalls ?? 0, 0);
  });

  it("default (no flag): duplicates are still created; dry-run sends no RPC at all", async () => {
    const { state, plane } = setup();
    seedBot(state, "a1", "Spec");
    const before = state.callCounts!.listGrokBotAgents;
    const dry = await plane.bot.create({ name: "Spec" }, { dryRun: true });
    assert.equal(dry.data!.existing, false);
    assert.equal(dry.data!.would, undefined);
    assert.equal(state.callCounts!.listGrokBotAgents, before);
    const r = await plane.bot.create({ name: "Spec" }, W);
    assert.equal(r.ok, true);
    assert.equal(r.data!.existing, false);
    assert.equal(state.bots.filter((b) => b.name === "Spec").length, 2);
  });

  it("create RPC failure keeps the client-chosen agent_id in error.details", async () => {
    const { plane } = setup({ dropNextWrite: true });
    const r = await plane.bot.create({ name: "Drop", agentId: "drop-1" }, W, R);
    assert.equal(exitOf(r), 10);
    const det = r.error!.details as any;
    assert.equal(det.agent_id, "drop-1");
    assert.equal(det.write_sent, true);
  });

  it("invalid if-exists value -> usage", async () => {
    const { plane } = setup();
    const r = await plane.bot.create({ name: "X" }, W, { ifExists: "update" as never });
    assert.equal(r.code, "usage");
    const s = await plane.sidebar.createSection("X", W, { ifExists: "update" as never });
    assert.equal(s.code, "usage");
  });
});

describe("issue #6 script: rerun after a mid-way failure", () => {
  it("section + bots + moves; failure after the first bot; rerun completes without duplicates", async () => {
    const { state, plane } = setup({ mergeTitleIntoName: true });
    const bots = [
      { name: "Showrunner", title: "幕僚长" },
      { name: "Spec", title: "行为规格" },
      { name: "Builder", title: "" },
    ];
    async function run(failAfterFirstCreate: boolean) {
      const sec = await plane.sidebar.createSection("Grok Bot Replica", W, R);
      assert.equal(sec.ok, true, JSON.stringify(sec));
      for (const [i, b] of bots.entries()) {
        const c = await plane.bot.create({ name: b.name, title: b.title || undefined }, W, R);
        assert.equal(c.ok, true, JSON.stringify(c));
        if (failAfterFirstCreate && i === 0) return;
        const m = await plane.sidebar.moveBot(c.data!.agent_id, { sectionName: "Grok Bot Replica" }, W);
        assert.equal(m.ok, true, JSON.stringify(m));
      }
    }
    await run(true);
    assert.equal(state.bots.length, 1);
    assert.deepEqual(state.sections[0]!.agent_ids, []);
    await run(false);
    await run(false);
    assert.equal(state.sections.length, 1);
    assert.equal(state.bots.length, 3);
    assert.equal(state.createCalls, 3);
    assert.equal(state.sections[0]!.agent_ids.length, 3);
    // 1 section create + 3 moves; the third run writes nothing.
    assert.equal(state.sidebarWrites, 4);
  });
});

describe("CLI / MCP parity", () => {
  function runGbc(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/cli/main.ts"), ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  it("CLI rerun: same section and bot ids, move skipped, exit 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-ensure-"));
    const env = { GBT_MOCK_STATE: path.join(dir, "state.json"), GBT_CREDENTIALS_DIR: dir };
    try {
      const g = (...a: string[]) => runGbc(["--mock", "--json", "--allow-writes", ...a], env);
      const s1 = JSON.parse((await g("sidebar", "create", "--name", "Replica", "--if-exists=reuse")).stdout);
      const s2 = JSON.parse((await g("sidebar", "create", "--name", "Replica", "--if-exists", "reuse")).stdout);
      assert.equal(s1.data.existing, false);
      assert.equal(s2.data.existing, true);
      assert.equal(s2.data.section_id, s1.data.section_id);
      const b1 = JSON.parse((await g("bot", "create", "--name", "Showrunner", "--if-exists=reuse")).stdout);
      const b2 = JSON.parse((await g("bot", "create", "--name", "Showrunner", "--if-exists=reuse")).stdout);
      assert.equal(b2.data.existing, true);
      assert.equal(b2.data.agent_id, b1.data.agent_id);
      const m1 = JSON.parse((await g("sidebar", "move", "--agent-id", b1.data.agent_id, "--section-name", "Replica")).stdout);
      const m2r = await g("sidebar", "move", "--agent-id", b1.data.agent_id, "--section-id", s1.data.section_id);
      assert.equal(m2r.code, 0, m2r.stderr);
      const m2 = JSON.parse(m2r.stdout);
      assert.equal(m1.data.skipped, false);
      assert.equal(m2.data.skipped, true);

      const bad = await g("sidebar", "create", "--name", "X", "--if-exists=update");
      assert.equal(bad.code, 2);
      const both = await g("sidebar", "move", "--agent-id", "a", "--section-id", "s", "--section-name", "n");
      assert.equal(both.code, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI ambiguous section exits 6", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-ensure-"));
    const env = { GBT_MOCK_STATE: path.join(dir, "state.json"), GBT_CREDENTIALS_DIR: dir };
    try {
      const g = (...a: string[]) => runGbc(["--mock", "--json", "--allow-writes", ...a], env);
      await g("sidebar", "create", "--name", "Dup");
      await g("sidebar", "create", "--name", "Dup");
      const r = await g("sidebar", "create", "--name", "Dup", "--if-exists=reuse");
      assert.equal(r.code, 6);
      assert.equal(JSON.parse(r.stderr).code, "ambiguous_match");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MCP tools expose if_exists / section_name and match the SDK", async () => {
    const tools = buildTools({ allowWrites: true });
    const get = (n: string) => tools.find((t) => t.name === n)!;
    assert.ok(get("create_bot").inputSchema.shape.if_exists);
    assert.ok(get("create_sidebar_section").inputSchema.shape.if_exists);
    assert.ok(get("move_bot_to_sidebar_section").inputSchema.shape.section_name);
    assert.equal(get("create_bot").inputSchema.safeParse({ name: "x", if_exists: "update" }).success, false);

    const { state, plane } = setup({ mergeTitleIntoName: true });
    const s1 = await get("create_sidebar_section").handler(plane, { name: "R", if_exists: "reuse", allow_writes: true });
    const s2 = await get("create_sidebar_section").handler(plane, { name: "R", if_exists: "reuse", allow_writes: true });
    assert.equal((s2.data as any).existing, true);
    assert.equal((s2.data as any).section_id, (s1.data as any).section_id);
    const b1 = await get("create_bot").handler(plane, { name: "Showrunner", title: "幕僚长", if_exists: "reuse", allow_writes: true });
    const b2 = await get("create_bot").handler(plane, { name: "Showrunner", title: "幕僚长", if_exists: "reuse", allow_writes: true });
    assert.equal((b2.data as any).matched_by, "merged_name");
    assert.equal((b2.data as any).agent_id, (b1.data as any).agent_id);
    const m1 = await get("move_bot_to_sidebar_section").handler(plane, {
      agent_id: (b1.data as any).agent_id,
      section_name: "R",
      allow_writes: true,
    });
    const m2 = await get("move_bot_to_sidebar_section").handler(plane, {
      agent_id: (b1.data as any).agent_id,
      section_id: (s1.data as any).section_id,
      allow_writes: true,
    });
    assert.equal((m1.data as any).skipped, false);
    assert.equal((m2.data as any).skipped, true);
    const none = await get("move_bot_to_sidebar_section").handler(plane, { agent_id: "a", allow_writes: true });
    assert.equal(none.code, "usage");
    assert.equal(state.createCalls, 1);
    assert.equal(state.sidebarWrites, 2);
  });
});
