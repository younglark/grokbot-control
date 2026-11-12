/**
 * Issue #5: non-destructive `computer wake` (EnsureSandBox with an empty request).
 * Static inference only; these tests are offline (mock transport / fake client).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Code, ConnectError } from "@connectrpc/connect";
import { ComputerOps } from "../src/ops/computer.js";
import { ControlPlane } from "../src/ops/plane.js";
import {
  MOCK_ENSURE_SECRETS,
  createEmptyMockState,
  createMockTransport,
  type MockState,
} from "../src/testing/mock-transport.js";
import { buildTools } from "../src/mcp/tools.js";
import { staticTokenProvider } from "../src/auth/provider.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_VALUES = Object.values(MOCK_ENSURE_SECRETS);
const SECRET_KEYS = [
  "network_token", "networkToken", "exec_daemon_auth_token", "execDaemonAuthToken",
  "gateway_token", "gatewayToken", "vnc_url", "vncUrl", "gateway_url", "gatewayUrl",
  "exec_daemon_url", "execDaemonUrl", "fork_vnc", "forkVnc", "port_token", "PortToken",
  "cluster", "tenant", "pod_id", "podId", "terminals",
];

function assertNoSecrets(text: string, where: string): void {
  for (const v of SECRET_VALUES) assert.ok(!text.includes(v), `${where} leaked ${v}`);
  for (const k of SECRET_KEYS) assert.ok(!text.includes(k), `${where} leaked key ${k}`);
}

function stateWith(sandbox: Partial<MockState["sandbox"]>): MockState {
  const s = createEmptyMockState();
  s.sandbox = { ...s.sandbox, ...sandbox } as MockState["sandbox"];
  return s;
}

function mockPlane(state: MockState) {
  return new ControlPlane({
    baseUrl: "mock://",
    transport: createMockTransport(state),
    simulated: true,
    auth: staticTokenProvider({ kind: "cursor", backend: "https://api2.cursor.sh", accessToken: "mock-token" }),
  });
}

const writes = (s: MockState) => (s.writeCalls ?? []).map((c) => c.method);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeComputer(impl: Record<string, (req?: any) => any>) {
  const calls: [string, unknown][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: Record<string, (req?: any) => any> = {};
  for (const name of ["getSandBoxRunState", "ensureSandBox", "ensureSandBoxWindow", "recreateSandBox", "forceRecreateSandBox"]) {
    client[name] = (req) => {
      calls.push([name, req]);
      const fn = impl[name];
      if (!fn) throw new Error(`unexpected RPC ${name}`);
      return fn(req);
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { calls, ops: new ComputerOps(client as any) };
}

function runGbc(args: string[], statePath: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/cli/main.ts"), ...args], {
      env: { ...process.env, GBT_ALLOW_WRITES: "", GBT_MOCK: "1", GBT_MOCK_STATE: statePath, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function seed(sandbox: Partial<MockState["sandbox"]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-wake-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify(stateWith(sandbox)));
  return file;
}

const readState = (file: string): MockState => JSON.parse(fs.readFileSync(file, "utf8"));

describe("computer wake ops", () => {
  it("hibernated -> running: one empty EnsureSandBox, no header, no reset", async () => {
    const state = stateWith({ state: 2, imageUpdateAvailable: true, image: { registryTag: "img-7" } });
    const r = await mockPlane(state).computer.wake({ allowWrite: true, wait: true, pollIntervalMs: 1, timeoutSeconds: 5 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, "ok");
    assert.equal(r.simulated, true);
    assert.equal(r.data?.action, "wake");
    assert.equal(r.data?.write_sent, true);
    assert.deepEqual(r.data?.request, {});
    assert.equal(r.data?.before.state, "hibernated");
    assert.equal(r.data?.before.image_update_available, true);
    assert.equal(r.data?.ensure_response?.state, "starting");
    assert.equal(r.data?.after?.state, "running");
    assert.equal(r.data?.after?.image?.registry_tag, "img-7");
    assert.equal(r.data?.running, true);
    assert.equal(r.data?.wait?.completed, true);
    assert.equal(r.data?.evidence, "static_inference_not_live_verified");
    assert.deepEqual(writes(state), ["EnsureSandBox"]);
    assert.deepEqual(state.lastEnsureRequest, { req: {}, parkHeader: null });
    assertNoSecrets(JSON.stringify(r), "ops result");
  });

  it("sends exactly {} to ensureSandBox and never reset/window RPCs", async () => {
    let reads = 0;
    const { calls, ops } = fakeComputer({
      getSandBoxRunState: () => ({ state: reads++ === 0 ? 2 : 3 }),
      ensureSandBox: () => ({ ...MOCK_ENSURE_SECRETS, runState: 4 }),
    });
    const r = await ops.wake({ allowWrite: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls.map((c) => c[0]), ["getSandBoxRunState", "ensureSandBox", "getSandBoxRunState"]);
    assert.deepEqual(calls[1]![1], {});
    assertNoSecrets(JSON.stringify(r), "fake result");
  });

  it("without --wait a starting read-back is ok with code starting", async () => {
    const state = stateWith({ state: 2 });
    const r = await mockPlane(state).computer.wake({ allowWrite: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, "starting");
    assert.equal(r.data?.after?.state, "starting");
    assert.equal(r.data?.running, false);
    assert.equal(r.data?.wait, undefined);
  });

  it("still hibernated without --wait is wake_unverified (outcome unknown)", async () => {
    const state = stateWith({ state: 2, wakeStaysHibernated: true });
    const r = await mockPlane(state).computer.wake({ allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, "wake_unverified");
    assert.equal(r.outcome, "unknown");
    assert.deepEqual(writes(state), ["EnsureSandBox"]);
    assertNoSecrets(JSON.stringify(r), "unverified result");
  });

  it("--wait timeout is wake_unverified and does not resend EnsureSandBox", async () => {
    const state = stateWith({ state: 2, wakeStaysHibernated: true });
    const t0 = Date.now();
    const r = await mockPlane(state).computer.wake({ allowWrite: true, wait: true, timeoutSeconds: 1, pollIntervalMs: 50 });
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(r.code, "wake_unverified");
    assert.equal(r.outcome, "unknown");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details = (r.error?.details ?? {}) as any;
    assert.equal(details.wait.completed, false);
    assert.ok(details.wait.polls >= 2);
    assert.equal(details.after.state, "hibernated");
    assert.deepEqual(writes(state), ["EnsureSandBox"]);
    assertNoSecrets(JSON.stringify(r), "timeout result");
  });

  it("already running returns already_running with no write", async () => {
    const state = stateWith({ state: 3 });
    const r = await mockPlane(state).computer.wake({ allowWrite: true, wait: true });
    assert.equal(r.ok, true);
    assert.equal(r.code, "already_running");
    assert.equal(r.data?.action, "already_running");
    assert.equal(r.data?.write_sent, false);
    assert.deepEqual(writes(state), []);
  });

  it("already starting sends no write and waits for running", async () => {
    const state = stateWith({ state: 4, wakePendingReads: 1 });
    const r = await mockPlane(state).computer.wake({ allowWrite: true, wait: true, pollIntervalMs: 1, timeoutSeconds: 5 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, "already_starting");
    assert.equal(r.data?.write_sent, false);
    assert.equal(r.data?.after?.state, "running");
    assert.deepEqual(writes(state), []);
  });

  it("absent is refused without a write (wake never provisions)", async () => {
    const state = stateWith({ state: 1 });
    const r = await mockPlane(state).computer.wake({ allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, "failed_precondition");
    assert.deepEqual(writes(state), []);
  });

  it("dry-run reads state only and reports the planned action", async () => {
    const state = stateWith({ state: 2 });
    const r = await mockPlane(state).computer.wake({ dryRun: true, wait: true });
    assert.equal(r.ok, true);
    assert.equal(r.code, "dry_run");
    assert.equal(r.data?.action, "would_wake");
    assert.equal(r.data?.write_sent, false);
    assert.equal(r.data?.before.state, "hibernated");
    assert.deepEqual(writes(state), []);
    assert.equal(state.callCounts?.getSandBoxRunState, 1);
    assert.equal(state.sandbox.state, 2);

    const running = await mockPlane(stateWith({ state: 3 })).computer.wake({ dryRun: true });
    assert.equal(running.data?.action, "would_skip");
    const absent = await mockPlane(stateWith({ state: 1 })).computer.wake({ dryRun: true });
    assert.equal(absent.data?.action, "would_refuse");
  });

  it("is denied without --allow-writes and sends no RPC at all", async () => {
    const previous = process.env.GBT_ALLOW_WRITES;
    delete process.env.GBT_ALLOW_WRITES;
    try {
      const { calls, ops } = fakeComputer({});
      const r = await ops.wake({ wait: true });
      assert.equal(r.ok, false);
      assert.equal(r.code, "denied");
      assert.deepEqual(calls, []);
    } finally {
      if (previous !== undefined) process.env.GBT_ALLOW_WRITES = previous;
    }
  });

  it("an ambiguous EnsureSandBox failure is outcome unknown", async () => {
    const { ops } = fakeComputer({
      getSandBoxRunState: () => ({ state: 2 }),
      ensureSandBox: () => {
        throw new ConnectError("upstream reset", Code.Unavailable);
      },
    });
    const r = await ops.wake({ allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unknown");
  });

  it("rejects an out-of-range timeout before any RPC", async () => {
    const { calls, ops } = fakeComputer({});
    const r = await ops.wake({ allowWrite: true, wait: true, timeoutSeconds: 0 });
    assert.equal(r.code, "invalid_argument");
    assert.deepEqual(calls, []);
  });
});

describe("computer wake CLI", () => {
  it("hibernated -> running with --wait exits 0 and prints no credentials", async () => {
    const file = seed({ state: 2, imageUpdateAvailable: true });
    const r = await runGbc(["--mock", "--json", "--allow-writes", "computer", "wake", "--wait", "--timeout=30"], file);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.data.action, "wake");
    assert.equal(j.data.after.state, "running");
    assert.equal(j.data.before.image_update_available, true);
    assertNoSecrets(r.stdout + r.stderr, "cli");
    const after = readState(file);
    assert.deepEqual((after.writeCalls ?? []).map((c) => c.method), ["EnsureSandBox"]);
    assertNoSecrets(fs.readFileSync(file, "utf8"), "persisted mock state");
  });

  it("timeout while still hibernated exits 10 (wake_unverified) without leaking", async () => {
    const file = seed({ state: 2, wakeStaysHibernated: true });
    const r = await runGbc(["--mock", "--json", "--allow-writes", "computer", "wake", "--wait", "--timeout=1"], file);
    assert.equal(r.code, 10, r.stdout + r.stderr);
    const j = JSON.parse(r.stderr);
    assert.equal(j.code, "wake_unverified");
    assert.equal(j.outcome, "unknown");
    assertNoSecrets(r.stdout + r.stderr, "cli timeout");
  });

  it("already running exits 0 with already_running and no write", async () => {
    const file = seed({ state: 3 });
    const r = await runGbc(["--mock", "--json", "--allow-writes", "computer", "wake"], file);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).code, "already_running");
    assert.deepEqual(readState(file).writeCalls ?? [], []);
  });

  it("without --allow-writes exits 7 denied; --dry-run needs no --allow-writes and writes nothing", async () => {
    const file = seed({ state: 2 });
    const denied = await runGbc(["--mock", "--json", "computer", "wake"], file);
    assert.equal(denied.code, 7);
    assert.equal(JSON.parse(denied.stderr).code, "denied");
    const dry = await runGbc(["--mock", "--json", "--dry-run", "computer", "wake"], file);
    assert.equal(dry.code, 0, dry.stderr);
    const j = JSON.parse(dry.stdout);
    assert.equal(j.code, "dry_run");
    assert.equal(j.data.action, "would_wake");
    const after = readState(file);
    assert.deepEqual(after.writeCalls ?? [], []);
    assert.equal(after.sandbox.state, 2);
  });

  it("does not accept reset flags and rejects a bad timeout with exit 2", async () => {
    const file = seed({ state: 2 });
    const confirm = await runGbc(["--mock", "--json", "--allow-writes", "computer", "wake", "--confirm=RESET_COMPUTER"], file);
    assert.equal(confirm.code, 2);
    const bad = await runGbc(["--mock", "--json", "--allow-writes", "computer", "wake", "--timeout=0"], file);
    assert.equal(bad.code, 2);
    assert.deepEqual(readState(file).writeCalls ?? [], []);
  });

  it("help marks wake as a static inference and possibly billable", async () => {
    const r = await runGbc(["--help"], path.join(os.tmpdir(), "gbc-wake-unused.json"));
    assert.match(r.stdout, /computer wake/);
    assert.match(r.stdout, /NOT\s+live-verified/);
    assert.match(r.stdout, /charges/);
  });
});

describe("wake_computer MCP tool", () => {
  it("is registered only with allowWrites and never under readOnly", () => {
    assert.ok(!buildTools().some((t) => t.name === "wake_computer"));
    assert.ok(!buildTools({ readOnly: true, allowWrites: true }).some((t) => t.name === "wake_computer"));
    const tool = buildTools({ allowWrites: true }).find((t) => t.name === "wake_computer");
    assert.ok(tool);
    assert.equal(tool.readOnly, undefined);
    assert.match(tool.description, /NOT live-verified/);
  });

  it("caps wait_seconds at 30 and has no confirm argument", () => {
    const tool = buildTools({ allowWrites: true }).find((t) => t.name === "wake_computer")!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = tool.inputSchema as any;
    assert.equal(schema.safeParse({ wait_seconds: 30 }).success, true);
    assert.equal(schema.safeParse({ wait_seconds: 31 }).success, false);
    assert.equal(schema.safeParse({ confirm: "RESET_COMPUTER" }).success, false);
  });

  it("wakes through the handler without leaking credentials", async () => {
    const state = stateWith({ state: 2 });
    const tool = buildTools({ allowWrites: true }).find((t) => t.name === "wake_computer")!;
    const r = await tool.handler(mockPlane(state), { allow_writes: true, wait_seconds: 10 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.after?.state, "running");
    assertNoSecrets(JSON.stringify(r), "mcp");
    assert.deepEqual(writes(state), ["EnsureSandBox"]);

    const stuck = stateWith({ state: 2, wakeStaysHibernated: true });
    const f = await tool.handler(mockPlane(stuck), { allow_writes: true });
    assert.equal(f.code, "wake_unverified");
    assertNoSecrets(JSON.stringify(f), "mcp failure");
  });
});
