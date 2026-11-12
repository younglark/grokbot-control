/**
 * PR A (issue #1 + the history part of #2): message send/status enum names,
 * workflow_id/refusal/session_source, REFUSED as a failure, and schema-shaped
 * history decoding. Offline only (router transport / --mock); no live calls.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proto3 } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GrokBotService } from "#proto-gen/GrokBotService";
import {
  GrokBotSendStatus,
  GrokBotTemporalHarnessMode,
  GrokBotUserMessageDelivery,
} from "#proto-gen/aiserver";
import { ControlPlane } from "../src/ops/plane.js";
import { HISTORY_TEXT_LIMIT } from "../src/ops/message.js";
import { DELIVERY_NAMES, HARNESS_MODE_NAMES, SEND_STATUS_NAMES } from "../src/ops/enum-names.js";
import { mapExitCode, EXIT } from "../src/errors.js";
import { createEmptyMockState, createMockTransport, type MockState } from "../src/testing/mock-transport.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliSrc = path.join(root, "src/cli/main.ts");
const mcpSrc = path.join(root, "src/mcp/main.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePlane(impl: Record<string, (req: any) => any>) {
  const transport = createRouterTransport(({ service }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service(GrokBotService as any, impl as any),
  );
  return new ControlPlane({ baseUrl: "fake://", transport, simulated: true });
}

function mockPlane(state: MockState) {
  return new ControlPlane({ baseUrl: "mock://", transport: createMockTransport(state), simulated: true });
}

function uiBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** The frozen schema's enum values, read from the generated code (not hand-copied). */
function schemaValues(e: unknown): Array<{ no: number; localName: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return proto3.getEnumType(e as any).values.map((v) => ({ no: v.no, localName: v.localName ?? v.name }));
}

const EXPECTED_DELIVERY = ["unspecified", "accepted_box", "accepted_temporal", "duplicate", "refused"];
const EXPECTED_STATUS = ["unspecified", "not_found", "accepted", "rejected", "pending", "unknown_durability"];
const EXPECTED_MODE = ["unspecified", "off", "shadow", "live", "box"];

describe("enum name tables come from the generated schema", () => {
  it("cover every generated value as lower snake", () => {
    for (const [table, gen, expected] of [
      [DELIVERY_NAMES, GrokBotUserMessageDelivery, EXPECTED_DELIVERY],
      [SEND_STATUS_NAMES, GrokBotSendStatus, EXPECTED_STATUS],
      [HARNESS_MODE_NAMES, GrokBotTemporalHarnessMode, EXPECTED_MODE],
    ] as const) {
      const values = schemaValues(gen);
      assert.equal(Object.keys(table).length, values.length);
      for (const v of values) assert.equal(table[v.no], v.localName.toLowerCase());
      assert.deepEqual(values.map((v) => table[v.no]), expected);
    }
  });
});

describe("message send", () => {
  for (const [code, name] of EXPECTED_DELIVERY.entries()) {
    it(`delivery ${code} -> ${name}`, async () => {
      const refusal = code === 4 ? { failureCode: "quota", message: "over quota" } : undefined;
      const plane = fakePlane({
        sendGrokBotUserMessage: () => ({
          dispatched: code !== 4,
          delivery: code,
          mode: 3,
          workflowId: code === 4 ? "wf-refused" : "wf-1",
          ...(refusal ? { refusal } : {}),
        }),
      });
      const r = await plane.message.send({ agentId: "a1", text: "hi", messageId: "m1", allowWrite: true });
      assert.equal(r.data?.delivery, name);
      assert.equal(r.data?.delivery_code, code);
      assert.equal(r.data?.mode, "live");
      assert.equal(r.data?.mode_code, 3);
      if (name === "refused") {
        assert.equal(r.ok, false);
        assert.equal(r.code, "refused");
        assert.equal(r.outcome, "known_failure");
        assert.equal(r.retryable, false);
        assert.equal(mapExitCode(r.code, r.outcome, r.retryable), EXIT.DENIED);
        assert.deepEqual(r.data?.refusal, { failure_code: "quota", message: "over quota" });
        assert.equal(r.data?.workflow_id, "wf-refused");
        assert.match(r.error?.message ?? "", /refused.*over quota/);
        assert.deepEqual((r.error?.details as { refusal: unknown }).refusal, r.data?.refusal);
      } else {
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.code, "ok");
        assert.equal(r.data?.workflow_id, "wf-1");
        assert.equal(r.data?.refusal, null);
      }
    });
  }

  it("unknown delivery/mode numbers become 'unknown' with the raw code", async () => {
    const plane = fakePlane({ sendGrokBotUserMessage: () => ({ dispatched: true, delivery: 42, mode: 77 }) });
    const r = await plane.message.send({ agentId: "a1", text: "hi", allowWrite: true });
    assert.equal(r.ok, true);
    assert.equal(r.data?.delivery, "unknown");
    assert.equal(r.data?.delivery_code, 42);
    assert.equal(r.data?.mode, "unknown");
    assert.equal(r.data?.mode_code, 77);
  });

  for (const [code, name] of EXPECTED_MODE.entries()) {
    it(`mode ${code} -> ${name}`, async () => {
      const plane = fakePlane({ sendGrokBotUserMessage: () => ({ dispatched: true, delivery: 2, mode: code }) });
      const r = await plane.message.send({ agentId: "a1", text: "hi", allowWrite: true });
      assert.equal(r.data?.mode, name);
      assert.equal(r.data?.mode_code, code);
    });
  }

  it("missing workflow_id/refusal are explicit null, not dropped", async () => {
    const plane = fakePlane({ sendGrokBotUserMessage: () => ({ dispatched: true, delivery: 2 }) });
    const r = await plane.message.send({ agentId: "a1", text: "hi", allowWrite: true });
    assert.ok(r.data && "workflow_id" in r.data && "refusal" in r.data);
    assert.equal(r.data.workflow_id, null);
    assert.equal(r.data.refusal, null);
  });

  it("session_id: caller value echoed, omitted -> null + default_unreported, and '' is sent on the wire", async () => {
    const seen: string[] = [];
    const plane = fakePlane({
      sendGrokBotUserMessage: (req: { sessionId: string }) => {
        seen.push(req.sessionId);
        return { dispatched: true, delivery: 2 };
      },
    });
    const withSid = await plane.message.send({ agentId: "a1", sessionId: "s1", text: "hi", allowWrite: true });
    assert.equal(withSid.data?.session_id, "s1");
    assert.equal(withSid.data?.session_source, "caller");
    const noSid = await plane.message.send({ agentId: "a1", text: "hi", allowWrite: true });
    assert.equal(noSid.data?.session_id, null);
    assert.equal(noSid.data?.session_source, "default_unreported");
    const dry = await plane.message.send({ agentId: "a1", text: "hi", dryRun: true });
    assert.equal(dry.data?.session_id, null);
    assert.equal(dry.data?.session_source, "default_unreported");
    assert.deepEqual(seen, ["s1", ""]);
  });
});

describe("message status", () => {
  for (const [code, name] of [...EXPECTED_STATUS.entries(), [9, "unknown"] as [number, string]]) {
    it(`status ${code} -> ${name}`, async () => {
      const plane = fakePlane({
        getGrokBotSendStatus: () => ({
          status: code,
          ...(code === 2 ? { echoEntryId: "e-1", acceptedAtMs: 1_700_000_000_000n } : {}),
          ...(code === 3 ? { rejectionCode: "too_long" } : {}),
        }),
      });
      const r = await plane.message.status({ agentId: "a1", messageId: "m1" });
      assert.equal(r.ok, true);
      assert.equal(r.data?.status, name);
      assert.equal(r.data?.status_code, code);
      assert.equal(r.data?.echo_entry_id, code === 2 ? "e-1" : null);
      assert.equal(r.data?.accepted_at_ms, code === 2 ? "1700000000000" : null);
      assert.equal(r.data?.rejection_code, code === 3 ? "too_long" : null);
      assert.equal(r.data?.session_id, null);
      assert.equal(r.data?.session_source, "default_unreported");
    });
  }
});

describe("message history decodes schema-shaped bodies", () => {
  function seeded(): MockState {
    const state = createEmptyMockState();
    const long = "长".repeat(HISTORY_TEXT_LIMIT + 5);
    state.transcript.push(
      {
        entryId: "u1",
        seq: 1n,
        entryKind: "message",
        bodyOmitted: false,
        body: uiBody({ id: "u1", kind: "message", role: "user", content: "开工简报", timestampMs: 1_700_000_000_000 }),
        agentId: "a1",
        sessionId: "s1",
      },
      {
        entryId: "b1",
        seq: 2n,
        entryKind: "send-message",
        bodyOmitted: false,
        body: uiBody({ id: "b1", kind: "send-message", message: { type: "text", content: long } }),
        agentId: "a1",
        sessionId: "s1",
      },
      { entryId: "o1", seq: 3n, entryKind: "message", bodyOmitted: true, agentId: "a1", sessionId: "s1" },
      {
        entryId: "x1",
        seq: 4n,
        entryKind: "message",
        bodyOmitted: false,
        body: new Uint8Array([0xff, 0xfe, 0x00]),
        agentId: "a1",
        sessionId: "s2",
      },
    );
    return state;
  }

  it("decodes text, keeps preview, caps text, keeps placeholders", async () => {
    const state = seeded();
    const r = await mockPlane(state).message.history({ agentId: "a1" });
    assert.equal(r.ok, true);
    const [u, b, o, x] = r.data!.entries;
    assert.equal(u.entry_id, "u1");
    assert.equal(u.seq, "1");
    assert.equal(u.role, "user");
    assert.equal(u.text, "开工简报");
    assert.equal(u.preview, "开工简报");
    assert.equal(u.decode_status, "decoded");
    assert.equal(u.timestamp_ms, "1700000000000");
    assert.equal(u.untrusted, true);
    assert.equal(b.role, "assistant");
    assert.equal(Array.from(b.preview!).length, 200);
    assert.equal(Array.from(b.text!).length, HISTORY_TEXT_LIMIT);
    assert.equal(b.text_truncated, true);
    assert.equal(b.text_chars, HISTORY_TEXT_LIMIT + 5);
    assert.equal(o.omitted, true);
    assert.equal(o.decode_status, "omitted");
    assert.equal(o.text, undefined);
    assert.equal(x.decode_status, "opaque");
    assert.equal(x.decode_reason, "not_valid_utf8_json");
    assert.equal(x.text, undefined);
    assert.equal(r.data!.text_limit, HISTORY_TEXT_LIMIT);
    assert.doesNotMatch(r.data!.note, /Ciphertext/);
  });

  it("full returns the whole text", async () => {
    const r = await mockPlane(seeded()).message.history({ agentId: "a1", full: true });
    const b = r.data!.entries[1];
    assert.equal(Array.from(b.text!).length, HISTORY_TEXT_LIMIT + 5);
    assert.equal(b.text_truncated, undefined);
    assert.equal(r.data!.text_limit, null);
  });

  it("session_id is sent only when given; limit is never sent", async () => {
    const state = seeded();
    const plane = mockPlane(state);
    const all = await plane.message.history({ agentId: "a1" });
    assert.equal(state.lastTranscriptRequest?.sessionId, "");
    assert.equal(state.lastTranscriptRequest?.limit, 0);
    assert.equal(all.data!.session_id, null);
    assert.equal(all.data!.session_source, "default_unreported");
    const s1 = await plane.message.history({ agentId: "a1", sessionId: "s1" });
    assert.equal(state.lastTranscriptRequest?.sessionId, "s1");
    assert.equal(s1.data!.session_id, "s1");
    assert.equal(s1.data!.session_source, "caller");
    assert.deepEqual(s1.data!.entries.map((e) => e.entry_id), ["u1", "b1", "o1"]);
  });

  it("legacy non-schema fields (plaintext/text/ciphertext) never surface as text", async () => {
    const plane = fakePlane({
      listGrokBotTranscriptEntries: () => ({
        entries: [{ entryId: "l1", entryKind: "message", plaintext: "leak", text: "leak", ciphertext: "x" }],
        generation: 1,
      }),
    });
    const r = await plane.message.history({ agentId: "a1" });
    const [e] = r.data!.entries;
    assert.equal(e.text, undefined);
    assert.equal(e.preview, undefined);
    assert.equal(e.decode_status, "absent");
  });

  it("send then history round-trips the sent text through the mock (body bytes)", async () => {
    const state = createEmptyMockState();
    const plane = mockPlane(state);
    const sent = await plane.message.send({ agentId: "a9", text: "ping 你好", allowWrite: true });
    assert.equal(sent.ok, true);
    const h = await plane.message.history({ agentId: "a9" });
    assert.equal(h.data!.entries.length, 1);
    assert.equal(h.data!.entries[0].text, "ping 你好");
    assert.equal(h.data!.entries[0].entry_id, `tr-${sent.data!.message_id}`);
  });
});

// ---------- process-level: CLI vs MCP stdio over the same persisted mock state ----------

function seedFile(dir: string, extra: Partial<MockState>): string {
  const f = path.join(dir, "mock-state.json");
  const state = { ...createEmptyMockState(), ...extra };
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
    args: ["--import", "tsx", mcpSrc, "--allow-writes"],
    env: { ...base, UC_SKIP_OFFICIAL: "1", GBT_MOCK: "1", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "message-semantics-test", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stable(env: any) {
  const { request_id: _r, ...rest } = env;
  return rest;
}

describe("CLI and MCP agree (process level, --mock)", () => {
  const transcript = [
    {
      entryId: "u1",
      seq: 1n,
      entryKind: "message",
      bodyOmitted: false,
      body: uiBody({ id: "u1", kind: "message", role: "user", content: "hello" }),
      agentId: "a1",
    },
  ];

  it("REFUSED: CLI exits 7 with code refused; MCP isError with the same envelope", async () => {
    const sendResponse = {
      dispatched: false,
      delivery: 4,
      mode: 3,
      workflowId: "wf-9",
      refusal: { failureCode: "blocked", message: "policy" },
    };
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-msg-"));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-msg-"));
    try {
      const f1 = seedFile(d1, { sendResponse });
      const f2 = seedFile(d2, { sendResponse });
      const cli = await runGbc(
        ["--mock", "--json", "--allow-writes", "message", "send", "--agent-id", "a1", "--text", "hi", "--message-id", "m-1"],
        { GBT_MOCK_STATE: f1, GBT_CREDENTIALS_DIR: d1 },
      );
      assert.equal(cli.code, 7, cli.stderr);
      assert.equal(cli.stdout, "");
      const cliEnv = JSON.parse(cli.stderr);
      assert.equal(cliEnv.ok, false);
      assert.equal(cliEnv.code, "refused");
      assert.deepEqual(cliEnv.data.refusal, { failure_code: "blocked", message: "policy" });
      assert.equal(cliEnv.data.workflow_id, "wf-9");
      assert.equal(cliEnv.data.delivery, "refused");
      assert.equal(cliEnv.data.delivery_code, 4);
      const mcp = await withMcp({ GBT_MOCK_STATE: f2, GBT_CREDENTIALS_DIR: d2 }, (c) =>
        c.callTool({ name: "send_message", arguments: { agent_id: "a1", text: "hi", message_id: "m-1", allow_writes: true } }),
      );
      assert.equal(mcp.isError, true);
      assert.deepEqual(stable(mcp.structuredContent), stable(cliEnv));
    } finally {
      fs.rmSync(d1, { recursive: true, force: true });
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it("send/status/history data match between CLI and MCP", async () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-msg-"));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-msg-"));
    try {
      const extra = {
        transcript,
        sendResponse: { dispatched: true, delivery: 2, mode: 3, workflowId: "wf-1" },
        sendStatusResponse: { status: 2, echoEntryId: "e-1", acceptedAtMs: "1700000000000" },
      } as unknown as Partial<MockState>;
      const f1 = seedFile(d1, extra);
      const f2 = seedFile(d2, extra);
      const env1 = { GBT_MOCK_STATE: f1, GBT_CREDENTIALS_DIR: d1 };
      const g = (args: string[]) => runGbc(["--mock", "--json", ...args], env1);
      const cliSend = await g(["--allow-writes", "message", "send", "--agent-id", "a1", "--text", "hi", "--message-id", "m-1"]);
      assert.equal(cliSend.code, 0, cliSend.stderr);
      const cliStatus = await g(["message", "status", "--agent-id", "a1", "--message-id", "m-1"]);
      assert.equal(cliStatus.code, 0, cliStatus.stderr);
      const cliHist = await g(["message", "history", "--agent-id", "a1", "--full"]);
      assert.equal(cliHist.code, 0, cliHist.stderr);
      const sendData = JSON.parse(cliSend.stdout).data;
      assert.equal(sendData.delivery, "accepted_temporal");
      assert.equal(sendData.delivery_code, 2);
      assert.equal(sendData.session_id, null);
      assert.equal(sendData.session_source, "default_unreported");
      const statusData = JSON.parse(cliStatus.stdout).data;
      assert.equal(statusData.status, "accepted");
      assert.equal(statusData.echo_entry_id, "e-1");

      await withMcp({ GBT_MOCK_STATE: f2, GBT_CREDENTIALS_DIR: d2 }, async (c) => {
        const send = await c.callTool({
          name: "send_message",
          arguments: { agent_id: "a1", text: "hi", message_id: "m-1", allow_writes: true },
        });
        assert.equal(send.isError, false);
        assert.deepEqual(stable(send.structuredContent), stable(JSON.parse(cliSend.stdout)));
        const status = await c.callTool({ name: "get_send_status", arguments: { agent_id: "a1", message_id: "m-1" } });
        assert.deepEqual(stable(status.structuredContent), stable(JSON.parse(cliStatus.stdout)));
        const hist = await c.callTool({ name: "list_transcript", arguments: { agent_id: "a1", full: true } });
        const histData = (hist.structuredContent as { data: { entries: Array<{ text?: string }> } }).data;
        // CLI history ran after its send, MCP's too; both see the seeded row plus the sent one.
        // The mock stamps the sent row with the send time, so drop timestamp_ms before comparing.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const noTs = (d: any) => ({ ...d, entries: d.entries.map(({ timestamp_ms: _t, ...e }: any) => e) });
        assert.deepEqual(noTs(histData), noTs(JSON.parse(cliHist.stdout).data));
        assert.deepEqual(histData.entries.map((e) => e.text), ["hello", "hi"]);
      });
    } finally {
      fs.rmSync(d1, { recursive: true, force: true });
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });

  it("history --session-id and --full are accepted flags; unknown flags still exit 2", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-msg-"));
    try {
      const f = seedFile(d, { transcript } as unknown as Partial<MockState>);
      const env = { GBT_MOCK_STATE: f, GBT_CREDENTIALS_DIR: d };
      const ok = await runGbc(["--mock", "--json", "message", "history", "--agent-id", "a1", "--session-id", "s1", "--full"], env);
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(JSON.parse(ok.stdout).data.session_source, "caller");
      const bad = await runGbc(["--mock", "--json", "message", "history", "--agent-id", "a1", "--ful"], env);
      assert.equal(bad.code, 2);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
