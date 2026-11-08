import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerOps, RESET_CONFIRM } from "../src/ops/computer.js";
import { ControlPlane } from "../src/ops/plane.js";
import { createEmptyMockState, createMockTransport } from "../src/testing/mock-transport.js";
import { buildTools } from "../src/mcp/tools.js";
import { staticTokenProvider } from "../src/auth/provider.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Call = [string, unknown];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeComputer(impl: Record<string, (req?: any, opts?: any) => any>) {
  const calls: Call[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped: Record<string, (req?: any, opts?: any) => any> = {};
  for (const [k, fn] of Object.entries(impl)) {
    wrapped[k] = (req, opts) => {
      calls.push([k, req]);
      return fn(req, opts);
    };
  }
  return { calls, ops: new ComputerOps(wrapped as any) };
}

function mockPlane(state = createEmptyMockState()) {
  return new ControlPlane({
    baseUrl: "mock://",
    transport: createMockTransport(state),
    simulated: true,
    auth: staticTokenProvider({
      kind: "cursor",
      backend: "https://api2.cursor.sh",
      accessToken: "mock-token",
    }),
  });
}

function runGbc(
  args: string[],
  mockStatePath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(root, "src/cli/main.ts"), ...args],
      {
        env: { ...process.env, GBT_MOCK: "1", GBT_MOCK_STATE: mockStatePath },
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

describe("computer ops", () => {
  it("maps GetSandBoxRunState to a stable state string", async () => {
    const { calls, ops } = fakeComputer({
      getSandBoxRunState: () => ({
        state: 3,
        imageUpdateAvailable: true,
        egressTunnelOwnership: false,
        image: { registryTag: "img-1", staticSnapshotPath: "/snap" },
      }),
    });
    const r = await ops.state();
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [["getSandBoxRunState", {}]]);
    assert.equal(r.data?.state, "running");
    assert.equal(r.data?.state_code, 3);
    assert.equal(r.data?.image_update_available, true);
    assert.equal(r.data?.egress_tunnel_ownership, false);
    assert.deepEqual(r.data?.image, {
      registry_tag: "img-1",
      static_snapshot_path: "/snap",
    });
  });

  it("reset is denied without the exact confirm token and sends no RPC", async () => {
    const { calls, ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op" }),
    });
    const missing = await ops.reset({ allowWrite: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "denied");
    const wrong = await ops.reset({ allowWrite: true, confirm: "reset" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, "denied");
    assert.equal(calls.length, 0);
  });

  it("reset is denied without --allow-writes and sends no RPC", async () => {
    const previous = process.env.GBT_ALLOW_WRITES;
    delete process.env.GBT_ALLOW_WRITES;
    try {
      const { calls, ops } = fakeComputer({
        recreateSandBox: () => ({ started: true, operationId: "op" }),
      });
      const r = await ops.reset({ confirm: RESET_CONFIRM });
      assert.equal(r.ok, false);
      assert.equal(r.code, "denied");
      assert.equal(calls.length, 0);
    } finally {
      if (previous === undefined) delete process.env.GBT_ALLOW_WRITES;
      else process.env.GBT_ALLOW_WRITES = previous;
    }
  });

  it("dry-run sends no RPC and is marked dry_run", async () => {
    const { calls, ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op" }),
    });
    const r = await ops.reset({ dryRun: true, confirm: RESET_CONFIRM, allowWrite: true });
    assert.equal(r.ok, true);
    assert.equal(r.code, "dry_run");
    assert.equal(r.data?.started, false);
    assert.equal(calls.length, 0);
  });

  it("reset calls RecreateSandBox with preserveData=false", async () => {
    const { calls, ops } = fakeComputer({
      recreateSandBox: (req) => ({ started: true, operationId: "op-1", reason: "", ...req }),
    });
    const r = await ops.reset({ confirm: RESET_CONFIRM, allowWrite: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls, [
      ["recreateSandBox", { preserveData: false, force: false }],
    ]);
    assert.equal(r.data?.started, true);
    assert.equal(r.data?.operation_id, "op-1");
    assert.equal(r.data?.tracking, "operation");
    assert.equal(r.data?.preserve_data, false);
  });

  it("--hard calls ForceRecreateSandBox", async () => {
    const { calls, ops } = fakeComputer({
      forceRecreateSandBox: () => ({ started: true, operationId: "op-2" }),
    });
    const r = await ops.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      hard: true,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls, [["forceRecreateSandBox", {}]]);
    assert.equal(r.data?.hard, true);
  });

  it("started=false is a known failure with the server reason", async () => {
    const { ops } = fakeComputer({
      recreateSandBox: () => ({ started: false, reason: "box blocked", operationId: "" }),
    });
    const r = await ops.reset({ confirm: RESET_CONFIRM, allowWrite: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, "failed_precondition");
    assert.match(r.error?.message ?? "", /box blocked/);
  });

  it("--wait filters events by operation_id and stops at done", async () => {
    const { ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op-1" }),
      async *watchSandBoxMigration() {
        yield { phase: 1, detail: "backing up", offsetKey: "o1", operationId: "other" };
        yield { phase: 1, detail: "backing up", offsetKey: "o2", operationId: "op-1" };
        yield { phase: 2, detail: "creating", offsetKey: "o3", operationId: "op-1" };
        yield { phase: 6, detail: "done", offsetKey: "o4", operationId: "op-1" };
      },
    });
    const r = await ops.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      wait: true,
      timeoutSeconds: 5,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.wait?.completed, true);
    assert.equal(r.data?.wait?.status, "done");
    assert.deepEqual(
      r.data?.wait?.events.map((e) => e.phase),
      ["backing-up", "creating", "done"],
    );
  });

  it("--wait maps a failed migration to migration_failed", async () => {
    const { ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op-1" }),
      async *watchSandBoxMigration() {
        yield { phase: 1, detail: "backing up", offsetKey: "o1", operationId: "op-1" };
        yield { phase: 7, detail: "disk error", offsetKey: "o2", operationId: "op-1" };
      },
    });
    const r = await ops.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      wait: true,
      timeoutSeconds: 5,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "migration_failed");
    assert.match(r.error?.message ?? "", /disk error/);
    assert.equal(r.outcome, "known_failure");
  });

  it("--wait reports untrackable when operation_id is empty", async () => {
    const { ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "" }),
    });
    const r = await ops.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      wait: true,
      timeoutSeconds: 5,
    });
    assert.equal(r.ok, true);
    assert.equal(r.data?.tracking, "untrackable");
    assert.equal(r.data?.wait?.completed, false);
    assert.equal(r.data?.wait?.reason, "operation_id_unavailable");
  });

  it("--wait timeout is outcome=unknown and does not retry the reset", async () => {
    const { calls, ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op-1" }),
      async *watchSandBoxMigration(_req, opts) {
        await new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const r = await ops.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      wait: true,
      timeoutSeconds: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "wait_timeout");
    assert.equal(r.outcome, "unknown");
    assert.equal(calls.filter((c) => c[0] === "recreateSandBox").length, 1);
  });

  it("--wait abort reports canceled and keeps the started reset visible", async () => {
    const { ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op-1" }),
      async *watchSandBoxMigration(_req, opts) {
        await new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await ops.reset(
      { confirm: RESET_CONFIRM, allowWrite: true, wait: true, timeoutSeconds: 30 },
      ac.signal,
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "canceled");
    assert.equal(r.outcome, "unknown");
  });

  it("rejects an out-of-range timeout before any RPC", async () => {
    const { calls, ops } = fakeComputer({
      recreateSandBox: () => ({ started: true, operationId: "op" }),
    });
    const r = await ops.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      timeoutSeconds: 0,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid_argument");
    assert.equal(calls.length, 0);
  });
});

describe("computer mock vertical slice", () => {
  it("state and reset work through the router transport", async () => {
    const state = createEmptyMockState();
    const plane = mockPlane(state);
    const before = await plane.computer.state();
    assert.equal(before.ok, true);
    assert.equal(before.data?.state, "absent");
    assert.equal(before.simulated, true);

    const reset = await plane.computer.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
    });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.data?.operation_id, "op-mock");

    const after = await plane.computer.state();
    assert.equal(after.data?.state, "starting");
  });

  it("wait through the router transport reaches done", async () => {
    const plane = mockPlane();
    const r = await plane.computer.reset({
      confirm: RESET_CONFIRM,
      allowWrite: true,
      wait: true,
      timeoutSeconds: 5,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.wait?.status, "done");
  });
});

describe("computer CLI", () => {
  it("state exits 0 with a JSON envelope", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-computer-"));
    const r = await runGbc(
      ["--mock", "--json", "computer", "state"],
      path.join(dir, "state.json"),
    );
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.simulated, true);
    assert.equal(j.data.state, "absent");
  });

  it("reset requires confirm and allow-writes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-computer-"));
    const statePath = path.join(dir, "state.json");
    const noConfirm = await runGbc(
      ["--mock", "--json", "--allow-writes", "computer", "reset"],
      statePath,
    );
    assert.equal(noConfirm.code, 7);
    assert.equal(JSON.parse(noConfirm.stderr).code, "denied");

    const noWrites = await runGbc(
      ["--mock", "--json", "computer", "reset", `--confirm=${RESET_CONFIRM}`],
      statePath,
    );
    assert.equal(noWrites.code, 7);
    assert.equal(JSON.parse(noWrites.stderr).code, "denied");
  });

  it("reset and --wait exit 0 with phases", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-computer-"));
    const r = await runGbc(
      [
        "--mock",
        "--json",
        "--allow-writes",
        "computer",
        "reset",
        `--confirm=${RESET_CONFIRM}`,
        "--wait",
        "--timeout=5",
      ],
      path.join(dir, "state.json"),
    );
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.data.started, true);
    assert.equal(j.data.wait.status, "done");
    assert.deepEqual(
      j.data.wait.events.map((e: { phase: string }) => e.phase),
      ["backing-up", "creating", "done"],
    );
  });

  it("invalid timeout exits 2 before any RPC", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-computer-"));
    const r = await runGbc(
      [
        "--mock",
        "--json",
        "--allow-writes",
        "computer",
        "reset",
        `--confirm=${RESET_CONFIRM}`,
        "--timeout=0",
      ],
      path.join(dir, "state.json"),
    );
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stderr).code, "usage");
  });
});

describe("computer MCP tools", () => {
  it("exposes state as read-only and reset as a write", () => {
    const tools = buildTools();
    const state = tools.find((t) => t.name === "get_computer_state")!;
    const reset = tools.find((t) => t.name === "reset_computer")!;
    assert.equal(state.readOnly, true);
    assert.equal(reset.readOnly, undefined);

    const readOnly = buildTools({ readOnly: true }).map((t) => t.name);
    assert.ok(readOnly.includes("get_computer_state"));
    assert.ok(!readOnly.includes("reset_computer"));
  });

  it("reset_computer maps confirm, hard, and wait_seconds", async () => {
    const plane = mockPlane();
    const reset = buildTools().find((t) => t.name === "reset_computer")!;
    const r = await reset.handler(plane, {
      confirm: RESET_CONFIRM,
      allow_writes: true,
      hard: false,
      wait_seconds: 5,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.wait?.status, "done");
  });
});
