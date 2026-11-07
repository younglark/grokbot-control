/**
 * Regression tests for the 14b88bf review findings (offline only: fake Connect
 * router transport + CLI subprocess against --mock). Mock passing ≠ live proof.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRouterTransport, ConnectError, Code } from "@connectrpc/connect";
import { GrokBotService } from "#proto-gen/GrokBotService";
import { ControlPlane } from "../src/ops/plane.js";
import { createAuthProvider } from "../src/auth/provider.js";
import { diffSections } from "../src/ops/sidebar.js";
import { buildTools } from "../src/mcp/tools.js";
import { mapExitCode } from "../src/errors.js";

type Call = [string, unknown];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fake(impl: Record<string, (req: any) => any>) {
  const calls: Call[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped: Record<string, (req: any) => any> = {};
  for (const [k, fn] of Object.entries(impl)) {
    wrapped[k] = (req) => {
      calls.push([k, req]);
      return fn(req);
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = createRouterTransport(({ service }) => service(GrokBotService as any, wrapped as any));
  return { calls, plane: new ControlPlane({ baseUrl: "fake://", transport }) };
}

const W = { allowWrite: true };
const exitOf = (r: { code: string; outcome?: string; retryable?: boolean }) =>
  mapExitCode(r.code, r.outcome as never, r.retryable);

function sidebarFake(initial: Array<{ id: string; name: string; agentIds: string[] }>, onUpdate?: (req: any) => void) {
  const state = { sections: initial };
  const f = fake({
    getGrokBotUserRuntimeSettings: () => ({ settings: { sidebarSections: { sections: state.sections } } }),
    updateGrokBotUserRuntimeSettings: (req) => {
      if (onUpdate) onUpdate.call(state, req);
      else state.sections = req.sidebarSections.sections;
      return {};
    },
  });
  return { ...f, state };
}

describe("fix1: sidebar delete requires confirm == section_id (SDK)", () => {
  for (const confirm of [undefined, "", "other"]) {
    it(`confirm=${JSON.stringify(confirm)} is denied without any write`, async () => {
      const { plane, calls } = sidebarFake([{ id: "s1", name: "A", agentIds: ["a1"] }]);
      const r = await plane.sidebar.deleteSection("s1", { ...W, confirm });
      assert.equal(r.ok, false);
      assert.equal(r.code, "denied");
      assert.equal(calls.filter((c) => c[0] === "updateGrokBotUserRuntimeSettings").length, 0);
    });
  }
  it("matching confirm deletes; dry-run needs no confirm and does not write", async () => {
    const { plane, calls, state } = sidebarFake([{ id: "s1", name: "A", agentIds: ["a1"] }]);
    const dry = await plane.sidebar.deleteSection("s1", { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(calls.filter((c) => c[0] === "updateGrokBotUserRuntimeSettings").length, 0);
    const r = await plane.sidebar.deleteSection("s1", { ...W, confirm: "s1" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(state.sections, []);
  });
});

describe("fix3: write errors that cannot exclude side effects are unknown", () => {
  const ambiguous = [Code.Unavailable, Code.Internal, Code.Unknown, Code.DeadlineExceeded, Code.ResourceExhausted];
  for (const code of ambiguous) {
    it(`send/create/update/delete/interrupt with ${Code[code]} -> unknown, retryable=false, exit 10`, async () => {
      const boom = () => {
        throw new ConnectError("x", code);
      };
      const { plane } = fake({
        sendGrokBotUserMessage: boom,
        createGrokBotTemporalAgent: boom,
        updateGrokBotAgent: boom,
        deleteGrokBotAgent: boom,
        interruptGrokBotAgentRun: boom,
      });
      const rs = [
        await plane.message.send({ agentId: "a", sessionId: "s", text: "t", allowWrite: true }),
        await plane.bot.create({ name: "n" }, W),
        await plane.bot.update("a", { name: "n" }, W),
        await plane.bot.delete("a", { ...W, confirm: "a" }),
        await plane.progress.interrupt("a", { ...W, confirm: "a" }),
      ];
      for (const r of rs) {
        assert.equal(r.ok, false);
        assert.equal(r.outcome, "unknown", JSON.stringify(r));
        assert.equal(r.retryable, false);
        assert.equal(exitOf(r), 10);
      }
    });
  }
  it("sidebar write Unavailable -> unknown exit 10", async () => {
    const { plane } = sidebarFake([], () => {
      throw new ConnectError("x", Code.Unavailable);
    });
    const r = await plane.sidebar.createSection("n", W);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.retryable, false);
    assert.equal(exitOf(r), 10);
  });
  it("reads keep Unavailable retryable (exit 8)", async () => {
    const { plane } = fake({
      listGrokBotAgents: () => {
        throw new ConnectError("x", Code.Unavailable);
      },
    });
    const r = await plane.bot.list();
    assert.equal(r.retryable, true);
    assert.equal(exitOf(r), 8);
  });
  it("write known rejections stay known (invalid_argument exit 2, sidebar conflict exit 6)", async () => {
    const { plane } = fake({
      sendGrokBotUserMessage: () => {
        throw new ConnectError("bad", Code.InvalidArgument);
      },
    });
    const r = await plane.message.send({ agentId: "a", sessionId: "s", text: "t", allowWrite: true });
    assert.equal(r.outcome, "known_failure");
    assert.equal(exitOf(r), 2);
    const sb = sidebarFake([], () => {
      throw new ConnectError("stale base", Code.FailedPrecondition);
    });
    const c = await sb.plane.sidebar.createSection("n", W);
    assert.equal(c.code, "sidebar_conflict");
    assert.equal(exitOf(c), 6);
  });
  it("delete NotFound still normalized to ok (unchanged App behavior)", async () => {
    const { plane } = fake({
      deleteGrokBotAgent: () => {
        throw new ConnectError("nf", Code.NotFound);
      },
    });
    const r = await plane.bot.delete("a", { ...W, confirm: "a" });
    assert.equal(r.ok, true);
  });
});

describe("fix4: sidebar read-back is semantic", () => {
  it("server silently drops the write -> sidebar_unverified, unknown, exit 10, diff", async () => {
    const { plane } = sidebarFake([{ id: "s1", name: "A", agentIds: ["a1"] }], () => {
      /* accept but drop */
    });
    const r = await plane.sidebar.moveBot("a2", "s1", W);
    assert.equal(r.ok, false);
    assert.equal(r.code, "sidebar_unverified");
    assert.equal(r.outcome, "unknown");
    assert.equal(exitOf(r), 10);
    const d = (r.error?.details as { diff: string[] }).diff;
    assert.ok(d.some((x) => x.includes("missing [a2]")), JSON.stringify(d));
  });
  it("only agent_ids order changed -> verified ok", async () => {
    const { plane } = sidebarFake([{ id: "s1", name: "A", agentIds: ["a1"] }], function (this: any, req: any) {
      this.sections = req.sidebarSections.sections.map((s: any) => ({ ...s, agentIds: [...s.agentIds].reverse() }));
    });
    const r = await plane.sidebar.moveBot("a2", "s1", W);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.verified, true);
  });
  it("section order change IS a mismatch; rename mismatch detected", () => {
    const a = { id: "a", name: "A", agent_ids: [] };
    const b = { id: "b", name: "B", agent_ids: [] };
    assert.equal(diffSections([a, b], [b, a]).length, 1);
    assert.equal(diffSections([a], [{ ...a, name: "X" }]).length, 1);
    assert.equal(diffSections([a, b], [a, b]).length, 0);
  });
  it("read-back failure after write -> unknown, not success", async () => {
    let n = 0;
    const { plane } = fake({
      getGrokBotUserRuntimeSettings: () => {
        if (n++ > 0) throw new ConnectError("x", Code.Unavailable);
        return { settings: { sidebarSections: { sections: [] } } };
      },
      updateGrokBotUserRuntimeSettings: () => ({}),
    });
    const r = await plane.sidebar.createSection("n", W);
    assert.equal(r.code, "sidebar_unverified");
    assert.equal(exitOf(r), 10);
  });
});

describe("fix5: GBT_TRUST_BACKEND strict === '1'", () => {
  for (const v of ["0", "true", "yes", ""]) {
    it(`GBT_TRUST_BACKEND=${JSON.stringify(v)} does not trust custom backend`, () => {
      const prev = process.env.GBT_TRUST_BACKEND;
      process.env.GBT_TRUST_BACKEND = v;
      try {
        assert.throws(() => createAuthProvider({ kind: "cursor", backend: "https://evil.example" }), /allowlist/);
      } finally {
        if (prev === undefined) delete process.env.GBT_TRUST_BACKEND;
        else process.env.GBT_TRUST_BACKEND = prev;
      }
    });
  }
  it("exact '1' trusts", () => {
    const prev = process.env.GBT_TRUST_BACKEND;
    process.env.GBT_TRUST_BACKEND = "1";
    try {
      assert.doesNotThrow(() =>
        createAuthProvider({ kind: "cursor", backend: "https://evil.example", store: { load: () => undefined } as never }),
      );
    } finally {
      if (prev === undefined) delete process.env.GBT_TRUST_BACKEND;
      else process.env.GBT_TRUST_BACKEND = prev;
    }
  });
});

describe("fix6: limits validated (SDK/MCP), never empty success; get vs truncated", () => {
  const listFake = (truncated = false) =>
    fake({
      listGrokBotAgents: () => ({ agents: [{ id: "i1", agentId: "a1", name: "x" }], truncated }),
      listGrokBotTranscriptEntries: () => ({ entries: [] }),
    });
  for (const bad of [0, -1, 1.5, Number.NaN, 1001]) {
    it(`SDK list/history limit=${bad} -> invalid_argument exit 2, no RPC`, async () => {
      const { plane, calls } = listFake();
      const r1 = await plane.bot.list({ limit: bad });
      const r2 = await plane.message.history({ agentId: "a", limit: bad });
      for (const r of [r1, r2]) {
        assert.equal(r.ok, false);
        assert.equal(r.code, "invalid_argument");
        assert.equal(exitOf(r), 2);
      }
      assert.equal(calls.length, 0);
    });
  }
  it("MCP list_bots / list_transcript schemas reject limit 0 and 1001", () => {
    const tools = buildTools();
    for (const name of ["list_bots", "list_transcript"]) {
      const t = tools.find((x) => x.name === name)!;
      assert.equal(t.inputSchema.safeParse({ agent_id: "a", limit: 0 }).success, false);
      assert.equal(t.inputSchema.safeParse({ agent_id: "a", limit: 1001 }).success, false);
      assert.equal(t.inputSchema.safeParse({ agent_id: "a", limit: 5 }).success, true);
    }
  });
  it("get on truncated list without match -> lookup_incomplete (unknown), not not_found", async () => {
    const { plane } = listFake(true);
    const r = await plane.bot.get("zzz");
    assert.equal(r.code, "lookup_incomplete");
    assert.equal(r.outcome, "unknown");
    const ok = await plane.bot.get("a1");
    assert.equal(ok.ok, true);
  });
  it("get on complete list without match -> not_found", async () => {
    const { plane } = listFake(false);
    assert.equal((await plane.bot.get("zzz")).code, "not_found");
  });
});

// ---------------- CLI subprocess (mock, isolated state) ----------------
const CLI = path.resolve("dist/cli/main.js");
function cli(args: string[], stateFile: string) {
  const env = { ...process.env, GBT_MOCK_STATE: stateFile };
  delete (env as Record<string, string | undefined>).GBT_ALLOW_WRITES;
  delete (env as Record<string, string | undefined>).GBT_TRUST_BACKEND;
  const r = spawnSync(process.execPath, [CLI, "--mock", "--json", ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gbc-rev-")), "state.json");
}
function readState(f: string) {
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { bots: [], messages: [], sections: [] };
}

describe("CLI subprocess regressions", () => {
  it("fix1: sidebar delete without --confirm -> exit 7, section kept", () => {
    const f = tmpState();
    const c = cli(["--allow-writes", "sidebar", "create", "--name", "Work"], f);
    assert.equal(c.code, 0, c.err);
    const sid = JSON.parse(c.out).data.sections[0].id;
    const d = cli(["--allow-writes", "sidebar", "delete", "--section-id", sid], f);
    assert.equal(d.code, 7, d.err);
    assert.equal(readState(f).sections.length, 1);
    const ok = cli(["--allow-writes", "sidebar", "delete", "--section-id", sid, `--confirm=${sid}`], f);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(readState(f).sections.length, 0);
  });
  it("fix2: missing flag values do not swallow next flag and do not write", () => {
    const f = tmpState();
    const a = cli(["--allow-writes", "bot", "create", "--name", "--description", "x"], f);
    assert.equal(a.code, 2, a.err);
    assert.equal(readState(f).bots.length, 0);
    const b = cli(["--allow-writes", "message", "send", "--agent-id", "a", "--session-id", "s", "--text", "--message-id", "m1"], f);
    assert.equal(b.code, 2, b.err);
    assert.equal((readState(f).messages ?? []).length, 0);
    const c = cli(["--allow-writes", "message", "send", "--agent-id", "a", "--session-id", "s", "--text-file"], f);
    assert.equal(c.code, 2, c.err);
    assert.match(c.err, /"code":"usage"/);
    const d = cli(["--allow-writes", "message", "send", "--agent-id", "a", "--session-id", "s", "--text-file", "/nonexistent/x"], f);
    assert.equal(d.code, 2, d.err);
    assert.equal(c.out, "");
  });
  it("fix2: --text=--literal sends dash-leading text; space form still works", () => {
    const f = tmpState();
    const a = cli(["--allow-writes", "message", "send", "--agent-id", "a", "--session-id", "s", "--text=--literal", "--message-id", "m1"], f);
    assert.equal(a.code, 0, a.err);
    assert.equal(JSON.parse(a.out).data.message_id, "m1");
    const b = cli(["--allow-writes", "bot", "create", "--name", "demo"], f);
    assert.equal(b.code, 0, b.err);
    assert.equal(JSON.parse(b.out).data.bot.name, "demo");
  });
  it("fix6: CLI --limit abc/0/1001/-1 -> exit 2, valid passes", () => {
    const f = tmpState();
    for (const v of ["abc", "0", "1001", "1.5"]) {
      const r = cli(["bot", "list", `--limit=${v}`], f);
      assert.equal(r.code, 2, `${v}: ${r.err}`);
      assert.equal(r.out, "");
    }
    assert.equal(cli(["bot", "list", "--limit", "-1"], f).code, 2);
    assert.equal(cli(["message", "history", "--agent-id", "a", "--limit", "0"], f).code, 2);
    assert.equal(cli(["bot", "list", "--limit", "5"], f).code, 0);
  });
});
