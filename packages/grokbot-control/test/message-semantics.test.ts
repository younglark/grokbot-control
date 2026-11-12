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

  it("send/status data match between CLI and MCP", async () => {
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
      });
    } finally {
      fs.rmSync(d1, { recursive: true, force: true });
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});
