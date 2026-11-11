import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_CLEANUP_CONFIRM,
  classifyListedAgent,
  planFingerprint,
} from "../src/ops/account.js";
import { ControlPlane } from "../src/ops/plane.js";
import { createEmptyMockState, createMockTransport } from "../src/testing/mock-transport.js";
import type { MockState } from "../src/testing/mock-transport.js";
import { buildTools } from "../src/mcp/tools.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { HELP } from "../src/cli/help.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function owned(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    agentId: `agent-${id}`,
    name: `Bot ${id}`,
    kind: 1,
    viewerIsOwner: true,
    visibility: 1,
    ...extra,
  };
}

function mockPlane(state: MockState = createEmptyMockState()) {
  return {
    state,
    plane: new ControlPlane({
      baseUrl: "mock://",
      transport: createMockTransport(state),
      simulated: true,
      auth: staticTokenProvider({
        kind: "cursor",
        backend: "https://api2.cursor.sh",
        accessToken: "mock-token",
      }),
    }),
  };
}

function writeMethods(state: MockState): string[] {
  return (state.writeCalls ?? []).map((c) => c.method);
}

function writeIds(state: MockState, method: string): string[] {
  return (state.writeCalls ?? [])
    .filter((c) => c.method === method)
    .map((c) => String((c.req as { id?: string } | undefined)?.id ?? ""));
}

async function previewThen(state: MockState) {
  const { plane } = mockPlane(state);
  const preview = await plane.account.cleanup({ dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.code, "dry_run");
  return { plane, preview, fingerprint: preview.data!.fingerprint };
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

describe("account cleanup classification", () => {
  it("deletes only explicit personal owners with a server id", () => {
    const row = classifyListedAgent(owned("101"));
    assert.deepEqual(row, { id: "101", agent_id: "agent-101", name: "Bot 101" });
  });

  it("does not guess when ownership fields are missing", () => {
    const row = classifyListedAgent({ id: "1", agentId: "a", name: "x", kind: 1 });
    assert.equal("reason" in row && row.reason, "ownership_unknown");
  });

  it("skips not-owner, team, shared, group, room, and missing id", () => {
    assert.equal(classifyListedAgent(owned("1", { viewerIsOwner: false })).reason, "not_owner");
    assert.equal(classifyListedAgent(owned("1", { teamId: 7 })).reason, "team");
    assert.equal(
      classifyListedAgent(owned("1", { visibility: "GROK_BOT_AGENT_VISIBILITY_TEAM" })).reason,
      "team",
    );
    assert.equal(classifyListedAgent(owned("1", { viewerAccess: 3 })).reason, "team");
    assert.equal(classifyListedAgent(owned("1", { teamDefaultForViewer: true })).reason, "team");
    assert.equal(classifyListedAgent(owned("1", { sharedWithOthers: true })).reason, "shared");
    assert.equal(classifyListedAgent(owned("1", { viewerAccess: 2 })).reason, "group_access");
    assert.equal(classifyListedAgent(owned("1", { kind: 2 })).reason, "room");
    assert.equal(classifyListedAgent({ name: "no-id", viewerIsOwner: true }).reason, "missing_server_id");
  });

  it("does not treat viewer_can_manage as ownership", () => {
    const row = classifyListedAgent({
      id: "9",
      agentId: "a9",
      name: "mgr",
      viewerCanManage: true,
    });
    assert.equal("reason" in row && row.reason, "ownership_unknown");
  });

  it("binds the plan fingerprint to the sorted target set", () => {
    const a = { id: "202", agent_id: "b", name: "B" };
    const b = { id: "101", agent_id: "a", name: "A" };
    assert.equal(planFingerprint([a, b]), planFingerprint([b, a]));
    assert.notEqual(planFingerprint([a, b]), planFingerprint([b]));
  });
});

describe("account cleanup preview and confirmation", () => {
  it("dry-run lists targets, skips, counts, warnings, and sends no writes", async () => {
    const state = createEmptyMockState();
    state.bots = [
      owned("202"),
      owned("101"),
      owned("303", { viewerIsOwner: false, name: "Other" }),
      { id: "404", agentId: "agent-404", name: "Unknown" },
      owned("505", { teamId: 2, name: "Team bot" }),
    ];
    const { plane } = mockPlane(state);
    const r = await plane.account.cleanup({ dryRun: true, allowWrite: true });
    assert.equal(r.ok, true);
    assert.equal(r.code, "dry_run");
    assert.equal(r.simulated, true);
    assert.equal(r.data?.preview, true);
    assert.equal(r.data?.listed, 5);
    assert.equal(r.data?.delete_count, 2);
    assert.equal(r.data?.skip_count, 3);
    assert.deepEqual(
      r.data?.targets.map((t) => t.id),
      ["101", "202"],
    );
    assert.equal(r.data?.fingerprint, planFingerprint(r.data!.targets));
    assert.equal(r.data?.confirm_token, ACCOUNT_CLEANUP_CONFIRM);
    assert.ok(r.data?.warnings.some((w) => w.includes("not a full account reset")));
    assert.deepEqual(writeMethods(state), []);
  });

  it("refuses truncated inventories before any write, including dry-run", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101")];
    state.listTruncated = true;
    const { plane } = mockPlane(state);
    const preview = await plane.account.cleanup({ dryRun: true });
    assert.equal(preview.ok, false);
    assert.equal(preview.code, "lookup_incomplete");
    assert.equal(preview.outcome, "unknown");
    const exec = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: "deadbeef",
    });
    assert.equal(exec.ok, false);
    assert.equal(exec.code, "lookup_incomplete");
    assert.deepEqual(writeMethods(state), []);
  });

  it("sends no writes without allow-writes, with a bad confirm, or without a plan", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101")];
    const { plane, preview, fingerprint } = await previewThen(state);

    const noWrites = await plane.account.cleanup({
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(noWrites.ok, false);
    assert.equal(noWrites.code, "denied");

    const badConfirm = await plane.account.cleanup({
      allowWrite: true,
      confirm: "RESET_COMPUTER",
      plan: fingerprint,
    });
    assert.equal(badConfirm.ok, false);
    assert.equal(badConfirm.code, "denied");

    const noPlan = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
    });
    assert.equal(noPlan.ok, false);
    assert.equal(noPlan.code, "denied");

    assert.equal(preview.data?.delete_count, 1);
    assert.deepEqual(writeMethods(state), []);
  });

  it("sends no writes when the list changes after preview", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101")];
    const { plane, fingerprint } = await previewThen(state);
    state.bots.push(owned("202"));
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "denied");
    assert.match(r.error?.message ?? "", /does not match the current deletable bot list/);
    assert.deepEqual(writeMethods(state), []);
  });

  it("skips shared and non-owned bots and does not invent ids or team headers", async () => {
    const state = createEmptyMockState();
    state.bots = [
      owned("101"),
      owned("202", { sharedWithOthers: true }),
      owned("303", { viewerIsOwner: false }),
    ];
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(writeIds(state, "DeleteGrokBotAgent"), ["101"]);
    assert.deepEqual(writeMethods(state), ["DeleteGrokBotAgent", "RecreateSandBox"]);
    const deleteReq = state.writeCalls!.find((c) => c.method === "DeleteGrokBotAgent")!.req as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(deleteReq).sort(), ["id"]);
    assert.equal(deleteReq.id, "101");
    assert.equal(state.bots.some((b) => b.id === "202"), true);
    assert.equal(state.bots.some((b) => b.id === "303"), true);
  });
});

describe("account cleanup execution order and failure bounds", () => {
  it("deletes approved targets in id order then resets once when verification is clean", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("202"), owned("101"), owned("303", { teamId: 9 })];
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.preview, false);
    assert.equal(r.data?.deleted, 2);
    assert.deepEqual(writeMethods(state), [
      "DeleteGrokBotAgent",
      "DeleteGrokBotAgent",
      "RecreateSandBox",
    ]);
    assert.deepEqual(writeIds(state, "DeleteGrokBotAgent"), ["101", "202"]);
    assert.equal(r.data?.computer?.started, true);
    assert.equal(state.bots.map((b) => b.id).join(","), "303");
  });

  it("handles zero owned bots: matching empty plan, no deletes, then reset", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("303", { viewerIsOwner: false })];
    const { plane, fingerprint } = await previewThen(state);
    assert.equal(fingerprint, planFingerprint([]));
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data?.delete_count, 0);
    assert.deepEqual(writeMethods(state), ["RecreateSandBox"]);
  });

  it("stops after a permission failure and does not reset", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101"), owned("202")];
    state.deleteErrorById = { "202": "permission" };
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "permission_denied");
    const details = r.error?.details as { stopped_before_reset?: boolean; deleted?: number };
    assert.equal(details.stopped_before_reset, true);
    assert.equal(details.deleted, 1);
    assert.match(r.error?.hint ?? "", /cannot be undone/);
    assert.deepEqual(writeMethods(state), ["DeleteGrokBotAgent", "DeleteGrokBotAgent"]);
    assert.deepEqual(writeIds(state, "DeleteGrokBotAgent"), ["101", "202"]);
    assert.equal(state.bots.some((b) => b.id === "202"), true);
  });

  it("treats an unknown delete outcome as incomplete and does not reset or retry", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101"), owned("202")];
    state.deleteErrorById = { "101": "unknown" };
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, "unknown");
    const details = r.error?.details as { stopped_before_reset?: boolean; deleted?: number };
    assert.equal(details.stopped_before_reset, true);
    assert.equal(details.deleted, 0);
    assert.deepEqual(writeMethods(state), ["DeleteGrokBotAgent"]);
    assert.deepEqual(writeIds(state, "DeleteGrokBotAgent"), ["101"]);
  });

  it("does not reset or extra-delete when a planned bot remains after delete", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101"), owned("202")];
    state.retainAfterDeleteIds = ["202"];
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "cleanup_incomplete");
    const details = r.error?.details as { residual?: Array<{ id: string }>; stopped_before_reset?: boolean };
    assert.equal(details.stopped_before_reset, true);
    assert.deepEqual(
      details.residual?.map((t) => t.id),
      ["202"],
    );
    assert.deepEqual(writeMethods(state), ["DeleteGrokBotAgent", "DeleteGrokBotAgent"]);
  });

  it("does not reset or extra-delete when a new owned bot appears after delete", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101")];
    state.afterDeleteInjectBots = [owned("999", { name: "New" })];
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "cleanup_incomplete");
    const details = r.error?.details as { unexpected?: Array<{ id: string }> };
    assert.deepEqual(
      details.unexpected?.map((t) => t.id),
      ["999"],
    );
    assert.deepEqual(writeMethods(state), ["DeleteGrokBotAgent"]);
  });

  it("forwards --hard to ForceRecreateSandBox after a clean cleanup", async () => {
    const state = createEmptyMockState();
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup({
      allowWrite: true,
      confirm: ACCOUNT_CLEANUP_CONFIRM,
      plan: fingerprint,
      hard: true,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(writeMethods(state), ["ForceRecreateSandBox"]);
  });

  it("does not automatically retry a reset when wait times out", async () => {
    const state = createEmptyMockState();
    state.bots = [owned("101")];
    state.sandbox = {
      state: 1,
      recreateStarted: true,
      operationId: "op-mock",
      migrationPhases: [{ phase: 1, detail: "backing up" }],
    };
    const { plane, fingerprint } = await previewThen(state);
    const r = await plane.account.cleanup(
      {
        allowWrite: true,
        confirm: ACCOUNT_CLEANUP_CONFIRM,
        plan: fingerprint,
        wait: true,
        timeoutSeconds: 1,
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "wait_timeout");
    assert.equal(r.outcome, "unknown");
    assert.match(r.error?.hint ?? "", /not retried automatically|may still be running/i);
    const recreates = writeMethods(state).filter((m) => m === "RecreateSandBox");
    assert.deepEqual(writeMethods(state).filter((m) => m !== "DeleteGrokBotAgent"), ["RecreateSandBox"]);
    assert.equal(recreates.length, 1);
    assert.deepEqual(writeIds(state, "DeleteGrokBotAgent"), ["101"]);
  });
});

describe("account cleanup CLI and surfaces", () => {
  it("documents the command and does not add an MCP or dashboard write entry", () => {
    assert.match(HELP, /account cleanup --dry-run/);
    assert.match(HELP, /ACCOUNT_CLEANUP/);
    assert.match(HELP, /not a full\s+account reset/);
    const writeNames = buildTools({ allowWrites: true }).map((t) => t.name);
    assert.ok(!writeNames.includes("account_cleanup"));
    assert.ok(!writeNames.includes("cleanup_account"));
    assert.ok(writeNames.includes("delete_bot"));
    assert.ok(writeNames.includes("reset_computer"));
  });

  it("CLI dry-run previews over --mock and writes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-account-cleanup-"));
    const statePath = path.join(dir, "state.json");
    const state = createEmptyMockState();
    state.bots = [owned("101"), owned("202", { viewerIsOwner: false })];
    fs.writeFileSync(statePath, JSON.stringify(state));
    const r = await runGbc(
      ["--mock", "--json", "account", "cleanup", "--dry-run"],
      statePath,
    );
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.code, "dry_run");
    assert.equal(j.simulated, true);
    assert.equal(j.data.preview, true);
    assert.equal(j.data.delete_count, 1);
    assert.equal(j.data.targets[0].id, "101");
    assert.equal(typeof j.data.fingerprint, "string");
    assert.equal(j.data.fingerprint.length, 64);
  });

  it("CLI refuses execution without allow-writes or a matching plan", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-account-cleanup-"));
    const statePath = path.join(dir, "state.json");
    const state = createEmptyMockState();
    state.bots = [owned("101")];
    fs.writeFileSync(statePath, JSON.stringify(state));
    const preview = await runGbc(
      ["--mock", "--json", "account", "cleanup", "--dry-run"],
      statePath,
    );
    const fingerprint = JSON.parse(preview.stdout).data.fingerprint as string;

    const noWrites = await runGbc(
      [
        "--mock",
        "--json",
        "account",
        "cleanup",
        `--confirm=${ACCOUNT_CLEANUP_CONFIRM}`,
        `--plan=${fingerprint}`,
      ],
      statePath,
    );
    assert.equal(noWrites.code, 7);
    assert.equal(JSON.parse(noWrites.stderr).code, "denied");

    const badPlan = await runGbc(
      [
        "--mock",
        "--json",
        "--allow-writes",
        "account",
        "cleanup",
        `--confirm=${ACCOUNT_CLEANUP_CONFIRM}`,
        "--plan=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ],
      statePath,
    );
    assert.equal(badPlan.code, 7);
    assert.equal(JSON.parse(badPlan.stderr).code, "denied");
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8")) as MockState;
    assert.equal((saved.writeCalls ?? []).length, 0);
    assert.equal(saved.bots?.some((b) => b.id === "101"), true);
  });
});
