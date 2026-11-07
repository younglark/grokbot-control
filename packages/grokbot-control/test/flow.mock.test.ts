import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlPlane } from "../src/ops/plane.js";
import { createEmptyMockState, createMockTransport } from "../src/testing/mock-transport.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { GrokBotAgentHarnessKind, CreateGrokBotAgentRequest } from "#proto-gen/aiserver";

function plane(state = createEmptyMockState()) {
  return {
    state,
    plane: new ControlPlane({
      baseUrl: "mock://",
      transport: createMockTransport(state),
      simulated: true,
      auth: staticTokenProvider({ kind: "cursor", backend: "https://api2.cursor.sh", accessToken: "t" }),
    }),
  };
}

describe("generated schema serialization", () => {
  it("CreateGrokBotAgentRequest encodes TEMPORAL harness field", () => {
    const msg = new CreateGrokBotAgentRequest({
      agentId: "a1",
      name: "n",
      description: "d",
      title: "t",
      avatarShape: "circle",
      avatarColor: "#000",
      harness: GrokBotAgentHarnessKind.TEMPORAL,
      kickstartRequested: false,
      introductionSuppressed: true,
    });
    const bytes = msg.toBinary();
    assert.ok(bytes.byteLength > 0);
    const round = CreateGrokBotAgentRequest.fromBinary(bytes);
    assert.equal(round.agentId, "a1");
    assert.equal(round.harness, GrokBotAgentHarnessKind.TEMPORAL);
    assert.equal(round.name, "n");
  });
});

describe("mock vertical slice (explicit simulated)", () => {
  it("create → send → status/history → sidebar → delete", async () => {
    const { plane: p, state } = plane();
    const created = await p.bot.create(
      { name: "demo", description: "d" },
      { allowWrite: true },
    );
    assert.equal(created.ok, true);
    assert.equal(created.simulated, true);
    const agentId = created.data!.agent_id;
    const sessionId = created.data!.bot.viewer_session_id || `sess-${agentId}`;

    const sent = await p.message.send({
      agentId,
      sessionId,
      text: "hello",
      allowWrite: true,
    });
    assert.equal(sent.ok, true);
    assert.match(sent.data!.note, /NOT task/);

    const st = await p.message.status({
      agentId,
      sessionId,
      messageId: sent.data!.message_id,
    });
    assert.equal(st.ok, true);

    const hist = await p.message.history({ agentId });
    assert.equal(hist.ok, true);
    assert.ok((hist.data!.entries.length ?? 0) >= 1);

    const prog = await p.progress.status([agentId]);
    assert.equal(prog.ok, true);

    const sec = await p.sidebar.createSection("Work", { allowWrite: true });
    assert.equal(sec.ok, true);
    const sectionId = sec.data!.sections.find((s) => s.name === "Work")!.id;
    const moved = await p.sidebar.moveBot(agentId, sectionId, { allowWrite: true });
    assert.equal(moved.ok, true);
    assert.ok(moved.data!.sections.some((s) => s.agent_ids.includes(agentId)));

    const renamed = await p.sidebar.renameSection(sectionId, "Work2", { allowWrite: true });
    assert.equal(renamed.ok, true);

    // delete section must not delete bot
    const delSec = await p.sidebar.deleteSection(sectionId, {
      allowWrite: true,
      confirm: sectionId,
    });
    assert.equal(delSec.ok, true);
    const still = await p.bot.get(agentId);
    assert.equal(still.ok, true);

    const del = await p.bot.delete(agentId, { allowWrite: true, confirm: agentId });
    assert.equal(del.ok, true);
    assert.equal(state.bots.length, 0);
  });

  it("sidebar base conflict", async () => {
    const { plane: p, state } = plane();
    await p.sidebar.createSection("A", { allowWrite: true });
    state.forceSidebarConflict = true;
    const r = await p.sidebar.createSection("B", { allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, "sidebar_conflict");
  });

  it("unknown outcome on dropped write — no auto replay", async () => {
    const { plane: p, state } = plane();
    state.dropNextWrite = true;
    const r = await p.bot.create({ name: "x" }, { allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.retryable, false);
  });

  it("dry-run does not mutate mock state", async () => {
    const { plane: p, state } = plane();
    const r = await p.bot.create({ name: "x" }, { dryRun: true, allowWrite: true });
    assert.equal(r.ok, true);
    assert.equal(r.code, "dry_run");
    assert.equal(state.bots.length, 0);
  });

  it("delete without confirm denied", async () => {
    const { plane: p } = plane();
    const c = await p.bot.create({ name: "x" }, { allowWrite: true });
    const r = await p.bot.delete(c.data!.agent_id, { allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, "denied");
  });

  it("get is list filter not Get RPC", async () => {
    const { plane: p } = plane();
    const c = await p.bot.create({ name: "x" }, { allowWrite: true });
    const g = await p.bot.get(c.data!.agent_id);
    assert.equal(g.ok, true);
    const missing = await p.bot.get("no-such");
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "not_found");
  });
});
