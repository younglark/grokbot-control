/**
 * Issue #2: `message wait` / MCP `wait_for_message`. Offline only (mock router transport);
 * no live calls, no official code. The turn_id ↔ message_id mapping under test is from
 * static analysis of the official App and is not live-verified.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ControlPlane } from "../src/ops/plane.js";
import { HISTORY_TEXT_LIMIT } from "../src/ops/message.js";
import { mapExitCode } from "../src/errors.js";
import { buildTools } from "../src/mcp/tools.js";
import { createEmptyMockState, createMockTransport, type MockState } from "../src/testing/mock-transport.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliSrc = path.join(root, "src/cli/main.ts");
const mcpSrc = path.join(root, "src/mcp/main.ts");

const ACCEPTED_AT = "1700000000000";

function uiBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function row(entryId: string, seq: number, role: string, content: string) {
  return {
    entryId,
    seq: BigInt(seq),
    entryKind: "message",
    bodyOmitted: false,
    body: uiBody({ id: entryId, kind: "message", role, content }),
    agentId: "a1",
    sessionId: "s1",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function live(opts: { running?: boolean; settlement?: Record<string, unknown>; extra?: Record<string, any> } = {}) {
  return {
    isRunning: Boolean(opts.running),
    live: {
      agentId: "a1",
      isRunning: Boolean(opts.running),
      sessionId: "s1",
      ...(opts.settlement ? { lastTurnSettlement: opts.settlement } : {}),
      ...(opts.extra ?? {}),
    },
  };
}

function settled(turnId: string, outcome = "success", settledAtMs = "1700000005000") {
  return { turnId, outcome, settledAtMs };
}

function scenario(statuses: Array<Record<string, unknown>>, extra: Partial<MockState> = {}): MockState {
  return {
    ...createEmptyMockState(),
    transcript: [
      // Deliberately out of seq order; an older turn precedes the echo.
      row("r2", 4, "assistant", "第二段"),
      row("old", 1, "assistant", "上一轮回复"),
      row("tr-m1", 2, "user", "开工简报"),
      row("r1", 3, "assistant", "收到，开始干活"),
    ],
    sendStatusResponse: { status: 2, echoEntryId: "tr-m1", acceptedAtMs: ACCEPTED_AT },
    statusSequence: { a1: statuses },
    ...extra,
  } as MockState;
}

function plane(state: MockState) {
  return new ControlPlane({ baseUrl: "mock://", transport: createMockTransport(state), simulated: true });
}

const fast = { agentId: "a1", messageId: "m1", intervalMs: 5 };

describe("message wait: turn_settlement", () => {
  for (const outcome of ["success", "cancelled", "error"] as const) {
    it(`settles on turn_id == message_id with outcome ${outcome}`, async () => {
      const state = scenario([live({ running: true }), live({ settlement: settled("m1", outcome) })]);
      const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 5 });
      assert.equal(r.ok, true, JSON.stringify(r));
      const d = r.data!;
      assert.equal(d.completed, true);
      assert.equal(d.state, "settled");
      assert.equal(d.completion_basis, "turn_settlement");
      assert.equal(d.outcome, outcome);
      assert.equal(d.turn_id, "m1");
      assert.equal(d.settled_at_ms, "1700000005000");
      assert.equal(d.session_id, "s1");
      assert.equal(d.session_source, "live_state");
      assert.equal(d.replies_basis, "after_echo_entry");
      assert.deepEqual(d.replies.map((e) => e.entry_id), ["r1", "r2"]);
      assert.deepEqual(d.replies.map((e) => e.text), ["收到，开始干活", "第二段"]);
      assert.equal(d.replies[0].untrusted, true);
      assert.equal(d.send_status?.status, "accepted");
      assert.equal(d.send_status?.echo_entry_id, "tr-m1");
      assert.match(d.note, /not live-verified/);
      assert.equal(r.simulated, true);
    });
  }

  it("a settlement for an older turn is not ours; waits for the matching one", async () => {
    const state = scenario([
      live({ settlement: settled("m0", "success", "1690000000000") }),
      live({ running: true, settlement: settled("m0", "success", "1690000000000") }),
      live({ settlement: settled("m1", "error") }),
    ]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.data!.completion_basis, "turn_settlement");
    assert.equal(r.data!.outcome, "error");
    assert.equal(r.data!.polls, 3);
  });

  it("only an old turn's settlement and an idle bot: times out (exit 10), never 'done'", async () => {
    const state = scenario([live({ settlement: settled("m0", "success", "1690000000000") })]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 1, intervalMs: 50 });
    assert.equal(r.ok, false);
    assert.equal(r.code, "wait_timeout");
    assert.equal(r.outcome, "unknown");
    assert.equal(mapExitCode(r.code, r.outcome, r.retryable), 10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const det = r.error!.details as any;
    assert.equal(det.outcome, "unknown");
    assert.equal(det.completed, undefined);
    assert.equal(det.last_live.last_turn_settlement.turn_id, "m0");
    assert.equal(det.last_live.is_running, false);
    assert.match(r.error!.hint!, /another turn/);
  });

  it("an unknown outcome token is reported as unknown, not guessed", async () => {
    const state = scenario([live({ settlement: settled("m1", "weird") })]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 2 });
    assert.equal(r.data!.completion_basis, "turn_settlement");
    assert.equal(r.data!.outcome, "unknown");
  });
});

describe("message wait: running_transition fallback", () => {
  it("accepted + seen running + now idle → done with outcome unknown", async () => {
    const state = scenario([live(), live({ running: true }), live({ running: true }), live()]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 5 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data!.completion_basis, "running_transition");
    assert.equal(r.data!.outcome, "unknown");
    assert.equal(r.data!.turn_id, null);
    assert.equal(r.data!.observed_running, true);
    assert.deepEqual(r.data!.replies.map((e) => e.entry_id), ["r1", "r2"]);
  });

  it("is_running=false alone (never seen running) is not done", async () => {
    const state = scenario([live()]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 1, intervalMs: 50 });
    assert.equal(r.code, "wait_timeout");
  });

  it("running before acceptance (previous turn) does not count", async () => {
    const state = scenario([live({ running: true }), live()], {
      sendStatusSequence: [{ status: 4 }, { status: 2, echoEntryId: "tr-m1", acceptedAtMs: ACCEPTED_AT }],
    });
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 1, intervalMs: 50 });
    assert.equal(r.code, "wait_timeout");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((r.error!.details as any).observed_running, false);
  });
});

describe("message wait: subagents, send status, transcript alignment", () => {
  it("settled turn with subagents still running: reported, not awaited", async () => {
    const state = scenario([
      live({ settlement: settled("m1"), extra: { hasRunningSubagents: true, workingTaskIds: ["t1", "t2"] } }),
    ]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.data!.has_running_subagents, true);
    assert.deepEqual(r.data!.working_task_ids, ["t1", "t2"]);
    assert.equal(r.data!.polls, 1);
  });

  it("send status rejected fails fast with message_rejected (exit 7)", async () => {
    const state = scenario([live()], { sendStatusResponse: { status: 3, rejectionCode: "quota" } });
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 30 });
    assert.equal(r.code, "message_rejected");
    assert.equal(mapExitCode(r.code, r.outcome, r.retryable), 7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((r.error!.details as any).rejection_code, "quota");
  });

  it("send status not_found on 3 checks fails with message_not_found (exit 5)", async () => {
    const state = scenario([live()], { sendStatusResponse: { status: 1 } });
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 30 });
    assert.equal(r.code, "message_not_found");
    assert.equal(mapExitCode(r.code, r.outcome, r.retryable), 5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((r.error!.details as any).polls, 3);
  });

  it("no echo_entry_id: replies empty, replies_basis echo_entry_unknown", async () => {
    const state = scenario([live({ settlement: settled("m1") })], { sendStatusResponse: { status: 2 } });
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 2 });
    assert.equal(r.data!.completed, true);
    assert.deepEqual(r.data!.replies, []);
    assert.equal(r.data!.replies_basis, "echo_entry_unknown");
    assert.match(r.data!.replies_note!, /echo_entry_id/);
  });

  it("echo id not in transcript: not guessed", async () => {
    const state = scenario([live({ settlement: settled("m1") })], {
      sendStatusResponse: { status: 2, echoEntryId: "missing" },
    });
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 2 });
    assert.deepEqual(r.data!.replies, []);
    assert.equal(r.data!.replies_basis, "echo_entry_not_in_transcript");
  });

  it("no session anywhere: transcript not read", async () => {
    const st = live({ settlement: settled("m1") });
    (st.live as Record<string, unknown>).sessionId = "";
    const state = scenario([st]);
    const r = await plane(state).message.wait({ ...fast, timeoutSeconds: 2 });
    assert.equal(r.data!.session_id, null);
    assert.equal(r.data!.session_source, "unavailable");
    assert.equal(r.data!.replies_basis, "session_unknown");
    assert.equal(state.callCounts!.listGrokBotTranscriptEntries, 0);
  });

  it("--session-id wins and is sent to the transcript read", async () => {
    const state = scenario([live({ settlement: settled("m1") })]);
    const r = await plane(state).message.wait({ ...fast, sessionId: "s1", timeoutSeconds: 2 });
    assert.equal(r.data!.session_source, "caller");
    assert.equal(state.lastTranscriptRequest?.sessionId, "s1");
  });

  it("text is capped like history; full lifts it", async () => {
    const long = "字".repeat(HISTORY_TEXT_LIMIT + 7);
    const mk = () => {
      const s = scenario([live({ settlement: settled("m1") })]);
      s.transcript.push(row("r3", 5, "assistant", long));
      return s;
    };
    const capped = await plane(mk()).message.wait({ ...fast, timeoutSeconds: 2 });
    const last = capped.data!.replies.at(-1)!;
    assert.equal(Array.from(last.text!).length, HISTORY_TEXT_LIMIT);
    assert.equal(last.text_truncated, true);
    assert.equal(capped.data!.text_limit, HISTORY_TEXT_LIMIT);
    const full = await plane(mk()).message.wait({ ...fast, timeoutSeconds: 2, full: true });
    assert.equal(Array.from(full.data!.replies.at(-1)!.text!).length, HISTORY_TEXT_LIMIT + 7);
    assert.equal(full.data!.text_limit, null);
  });

  it("invalid timeout / interval are argument errors (exit 2)", async () => {
    const p = plane(scenario([live()]));
    for (const bad of [{ timeoutSeconds: 0 }, { timeoutSeconds: 3601 }, { intervalSeconds: 0, intervalMs: undefined }]) {
      const r = await p.message.wait({ agentId: "a1", messageId: "m1", ...bad });
      assert.equal(r.code, "invalid_argument");
      assert.equal(mapExitCode(r.code, r.outcome, r.retryable), 2);
    }
  });

  it("bot status now exposes last_turn_settlement.turn_id and has_running_subagents", async () => {
    const state = scenario([live({ settlement: settled("m1"), extra: { hasRunningSubagents: true } })]);
    const r = await plane(state).progress.status(["a1"]);
    const s = r.data!.statuses[0];
    assert.equal(s.live!.last_turn_settlement!.turn_id, "m1");
    assert.equal(s.live!.last_turn_settlement!.outcome, "success");
    assert.equal(s.live!.has_running_subagents, true);
  });
});

describe("MCP wait_for_message (in-process)", () => {
  const tool = buildTools().find((t) => t.name === "wait_for_message")!;

  it("is registered as read-only with wait_seconds capped at 30", () => {
    assert.ok(tool);
    assert.equal(tool.readOnly, true);
    assert.equal(tool.inputSchema.safeParse({ agent_id: "a1", message_id: "m1", wait_seconds: 31 }).success, false);
    assert.equal(tool.inputSchema.safeParse({ agent_id: "a1", message_id: "m1", wait_seconds: 30 }).success, true);
  });

  it("returns pending (ok) when not settled; observed_running carries over between calls", async () => {
    const state = scenario([live({ running: true }), live()]);
    const p = plane(state);
    const first = await tool.handler(p, { agent_id: "a1", message_id: "m1" });
    assert.equal(first.ok, true);
    assert.equal(first.code, "pending");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d1 = first.data as any;
    assert.equal(d1.state, "pending");
    assert.equal(d1.completed, false);
    assert.equal(d1.observed_running, true);
    assert.match(d1.hint, /observed_running=true/);
    const second = await tool.handler(p, { agent_id: "a1", message_id: "m1", observed_running: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d2 = second.data as any;
    assert.equal(second.code, "ok");
    assert.equal(d2.completion_basis, "running_transition");
  });
});

// ---------- process level: CLI and MCP over the same persisted mock state ----------

function seedFile(dir: string, state: MockState): string {
  const f = path.join(dir, "mock-state.json");
  fs.writeFileSync(
    f,
    JSON.stringify(state, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v,
    ),
  );
  return f;
}

function runGbc(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliSrc, ...args], {
      env: { ...process.env, UC_SKIP_OFFICIAL: "1", GBT_MOCK: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function withMcp<T>(env: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  delete base.GBT_MCP_READONLY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", mcpSrc],
    env: { ...base, UC_SKIP_OFFICIAL: "1", GBT_MOCK: "1", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "message-wait-test", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function comparable(data: any) {
  const { waited_ms: _w, ...rest } = data;
  return rest;
}

describe("CLI message wait (process level, --mock)", () => {
  it("settles: exit 0, envelope on stdout; MCP returns the same data", async () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-wait-"));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-wait-"));
    try {
      const statuses = () => [live({ settlement: settled("m1", "success") })];
      const f1 = seedFile(d1, scenario(statuses()));
      const f2 = seedFile(d2, scenario(statuses()));
      const cli = await runGbc(
        ["--mock", "--json", "message", "wait", "--agent-id", "a1", "--message-id", "m1", "--timeout", "5", "--interval", "1"],
        { GBT_MOCK_STATE: f1, GBT_CREDENTIALS_DIR: d1 },
      );
      assert.equal(cli.code, 0, cli.stderr);
      const env = JSON.parse(cli.stdout);
      assert.equal(env.ok, true);
      assert.equal(env.data.completion_basis, "turn_settlement");
      assert.equal(env.data.outcome, "success");
      assert.deepEqual(env.data.replies.map((e: { entry_id: string }) => e.entry_id), ["r1", "r2"]);
      const mcp = await withMcp({ GBT_MOCK_STATE: f2, GBT_CREDENTIALS_DIR: d2 }, (c) =>
        c.callTool({ name: "wait_for_message", arguments: { agent_id: "a1", message_id: "m1", wait_seconds: 5 } }),
      );
      assert.notEqual(mcp.isError, true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = mcp.structuredContent as any;
      assert.deepEqual(comparable(m.data), comparable(env.data));
    } finally {
      fs.rmSync(d1, { recursive: true, force: true });
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it("timeout: exit 10, code wait_timeout, last_live attached, progress on stderr", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-wait-"));
    try {
      const f = seedFile(d, scenario([live({ running: true, extra: { activity: { kind: "tool", tool: "SetStatus" } } })]));
      const cli = await runGbc(
        ["--mock", "--json", "message", "wait", "--agent-id", "a1", "--message-id", "m1", "--timeout", "1", "--interval", "1"],
        { GBT_MOCK_STATE: f, GBT_CREDENTIALS_DIR: d },
      );
      assert.equal(cli.code, 10, cli.stderr);
      assert.equal(cli.stdout, "");
      const lines = cli.stderr.trim().split("\n").map((l) => JSON.parse(l));
      const progress = lines.filter((l) => l.event === "message_wait");
      assert.ok(progress.length >= 1);
      assert.equal(progress[0].is_running, true);
      assert.equal(progress[0].tool, "SetStatus");
      const env = lines.at(-1);
      assert.equal(env.ok, false);
      assert.equal(env.code, "wait_timeout");
      assert.equal(env.outcome, "unknown");
      assert.equal(env.error.details.last_live.is_running, true);
      assert.equal(env.error.details.last_live.activity.tool, "SetStatus");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("usage errors exit 2", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-wait-"));
    try {
      const env = { GBT_MOCK_STATE: path.join(d, "s.json"), GBT_CREDENTIALS_DIR: d };
      for (const args of [
        ["message", "wait", "--agent-id", "a1"],
        ["message", "wait", "--agent-id", "a1", "--message-id", "m1", "--timeout", "0"],
        ["message", "wait", "--agent-id", "a1", "--message-id", "m1", "--interval", "61"],
        ["message", "wait", "--agent-id", "a1", "--message-id", "m1", "--bogus", "x"],
      ]) {
        const r = await runGbc(["--mock", "--json", ...args], env);
        assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
      }
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("send → wait round trip over the default mock (echo from send status)", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-wait-"));
    try {
      const state = createEmptyMockState();
      state.statusSequence = {
        a1: [
          { isRunning: false, live: { agentId: "a1", isRunning: false, sessionId: "" } },
          { isRunning: false, live: { agentId: "a1", isRunning: false, sessionId: "", lastTurnSettlement: settled("m-rt") } },
        ],
      };
      const f = seedFile(d, state);
      const env = { GBT_MOCK_STATE: f, GBT_CREDENTIALS_DIR: d };
      const sent = await runGbc(
        ["--mock", "--json", "--allow-writes", "message", "send", "--agent-id", "a1", "--text", "hi", "--message-id", "m-rt"],
        env,
      );
      assert.equal(sent.code, 0, sent.stderr);
      const w = await runGbc(
        ["--mock", "--json", "message", "wait", "--agent-id", "a1", "--message-id", "m-rt", "--timeout", "5", "--interval", "1"],
        env,
      );
      assert.equal(w.code, 0, w.stderr);
      const data = JSON.parse(w.stdout).data;
      assert.equal(data.send_status.echo_entry_id, "tr-m-rt");
      // Default session (no --session-id, live session empty): transcript is not guessed.
      assert.equal(data.replies_basis, "session_unknown");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
