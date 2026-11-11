/**
 * Read-only dashboard signal coverage: waiting, current action, freshness,
 * recent activity, sandbox/computer tone, and channel connection state.
 * Synthetic mock data only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlPlane } from "../src/ops/plane.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { createEmptyMockState, createMockTransport, type MockState } from "../src/testing/mock-transport.js";
import { startDashboardServer, type StartedDashboard } from "../src/localdash/server.js";
import { payloadLooksSecret } from "../src/localdash/sanitize.js";
import { mapChannelConnections, mapStatus, mapTodo, mapSession } from "../src/ops/map.js";
import {
  classifyAwaitingReason,
  classifySettlementOutcome,
  mapTurnSettlement,
  sanitizeBoxHandoff,
  waitingSignals,
} from "../src/localdash/signals.js";
import { botCategory, presentComputer, waitingReason } from "../src/localdash/view.js";
import { formatShanghaiDateTime, formatUnspecifiedEpoch } from "../src/localdash/time.js";

function planeOf(state: MockState) {
  return new ControlPlane({
    baseUrl: "mock://gbc",
    transport: createMockTransport(state),
    simulated: true,
    auth: staticTokenProvider({ kind: "cursor", backend: "mock://gbc", accessToken: "mock-token" }),
  });
}

function fixtureUi(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-dash-signals-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>gbc fixture</title></head><body>gbc 本地监视器</body></html>\n",
  );
  return dir;
}

async function started(state: MockState): Promise<StartedDashboard> {
  return startDashboardServer({
    plane: planeOf(state),
    host: "127.0.0.1",
    port: 0,
    sessionToken: "testsessiontoken",
    uiRoot: fixtureUi(),
    poller: { detailIntervalMs: 80, timelineActiveIntervalMs: 60, timelineIdleIntervalMs: 80 },
  });
}

function req(
  target: StartedDashboard,
  pathName: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(pathName, `http://127.0.0.1:${target.bind.port}`);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: target.bind.port,
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: {
          host: `127.0.0.1:${target.bind.port}`,
          ...(init.body
            ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(init.body)) }
            : {}),
          ...init.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    r.on("error", reject);
    if (init.body) r.write(init.body);
    r.end();
  });
}

async function connectSse(
  dash: StartedDashboard,
  client = "signals-client",
): Promise<{ events: { event: string; data: string }[]; close: () => void }> {
  const url = new URL(`api/events?client=${client}`, dash.url);
  const events: { event: string; data: string }[] = [];
  const r = http.get(
    {
      hostname: "127.0.0.1",
      port: dash.bind.port,
      path: url.pathname + url.search,
      headers: { host: `127.0.0.1:${dash.bind.port}`, accept: "text/event-stream" },
    },
    (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const ev = /(?:^|\n)event: ([^\n]+)/.exec(part)?.[1] ?? "message";
          const data = /(?:^|\n)data: ([\s\S]+)/.exec(part)?.[1] ?? "";
          events.push({ event: ev, data });
        }
      });
    },
  );
  r.on("error", () => undefined);
  const start = Date.now();
  while (!events.some((e) => e.event === "snapshot") && Date.now() - start < 5_000) {
    await new Promise((res) => setTimeout(res, 25));
  }
  return { events, close: () => r.destroy() };
}

async function waitFor<T>(fn: () => T | undefined, timeout = 4_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out");
}

describe("signal mappers and display helpers", () => {
  it("classifies waiting kinds, sanitizes handoff text, and maps settlement without inventing outcomes", () => {
    assert.equal(classifyAwaitingReason("needs_approval"), "approval");
    assert.equal(classifyAwaitingReason("等待输入文件路径"), "input");
    assert.equal(classifyAwaitingReason("等待确认"), "other");
    const status = mapStatus({
      agentId: "agent-1",
      isRunning: false,
      live: {
        isRetrying: true,
        awaiting: { reason: "needs_approval" },
        activity: { kind: "tool", tool: "shell", detail: "secret token=abcd" },
        lastTurnSettlement: { outcome: "success", settledAtMs: 1_700_000_000_000n },
        boxHandoffRequestId: "req-1",
        boxHandoffInstruction: "A".repeat(80) + " and password=super-secret",
      },
      client: { lastActivityAtMs: 1_700_000_000_100n, unreadCount: 3, unreadThreadCount: 1 },
    });
    assert.equal(status.live?.activity?.tool, "shell");
    assert.equal(status.live?.activity?.kind, "tool");
    assert.equal((status.live?.activity as { detail?: string } | undefined)?.detail, undefined);
    assert.equal(status.live?.last_turn_settlement?.settled_normally, true);
    assert.equal(status.live?.last_turn_settlement?.settled_at_ms, "1700000000000");
    assert.equal(status.live?.box_handoff?.present, true);
    assert.equal(status.live?.box_handoff?.instruction_hidden, true);
    assert.equal(status.live?.box_handoff?.instruction_preview, undefined);
    assert.equal(status.client?.unread_count, 3);
    const signals = waitingSignals(status);
    assert.deepEqual(signals.map((s) => s.kind), ["approval", "box_handoff", "retrying"]);
    assert.match(waitingReason(status) ?? "", /审批/);
    assert.match(waitingReason(status) ?? "", /桌面交接/);
    assert.match(waitingReason(status) ?? "", /正在重试/);
    assert.equal(botCategory(status), "waiting");
    assert.equal(classifySettlementOutcome("failed"), false);
    assert.equal(classifySettlementOutcome("weird-token"), undefined);
    const unknownSettle = mapTurnSettlement({ outcome: "box_updating", settled_at_ms: "9" });
    assert.equal(unknownSettle?.settled_normally, undefined);
    assert.equal(unknownSettle?.outcome, "box_updating");
  });

  it("collapses a long handoff instruction and never keeps install URLs", () => {
    const long = sanitizeBoxHandoff({
      box_handoff_request_id: "hid-1",
      box_handoff_instruction: "请在桌面上打开报表并继续处理后面这一长串说明文字，不要把原文整段展开。" + "续".repeat(20),
    });
    assert.equal(long?.present, true);
    assert.ok((long?.instruction_preview ?? "").endsWith("…"));
    assert.ok((long?.instruction_preview ?? "").length <= 41);
    assert.equal(long?.instruction_hidden, true);
    const channels = mapChannelConnections({
      slackConnections: [
        {
          agentId: "agent-1",
          connected: true,
          workspaceName: "Acme",
          installUrl: "https://slack.com/apps/install/secret",
          reinstallUrl: "https://slack.com/apps/reinstall/secret",
        },
      ],
      teamsConnections: [
        {
          agentId: "agent-1",
          installState: 5,
          tenantDisplayName: "Acme Corp",
          tenantId: "tid-should-not-be-required-in-view",
        },
        {
          agentId: "agent-2",
          installState: 0,
        },
      ],
    });
    const slack = channels.find((c) => c.channel === "slack");
    const teamsOk = channels.find((c) => c.channel === "teams" && c.agent_id === "agent-1");
    const teamsUnknown = channels.find((c) => c.agent_id === "agent-2");
    assert.equal(slack?.connected, true);
    assert.equal(slack?.workspace_or_tenant, "Acme");
    assert.equal(JSON.stringify(channels).includes("https://"), false);
    assert.equal(JSON.stringify(channels).includes("install"), false);
    assert.equal(teamsOk?.connected, true);
    assert.equal(teamsOk?.label, "已安装");
    assert.equal(teamsUnknown?.connected, false);
    assert.equal(teamsUnknown?.state, "unknown");
    assert.equal(teamsUnknown?.label, "未知");
  });

  it("formats Shanghai datetimes and does not guess todo timestamp units", () => {
    const stamped = formatShanghaiDateTime(1_700_000_000_000);
    assert.match(stamped ?? "", /上海时间/);
    const todoMs = formatUnspecifiedEpoch("1700000000000");
    assert.equal(todoMs?.assumed, "ms");
    assert.match(todoMs?.text ?? "", /按毫秒时间戳解读/);
    const raw = formatUnspecifiedEpoch("10");
    assert.equal(raw?.assumed, "unknown");
    assert.match(raw?.text ?? "", /单位未标明/);
    const mapped = mapTodo({ id: "t1", content: "x", status: 1, created_at: 10n, updated_at: 1_700_000_000_000n });
    assert.equal(mapped?.created_at, "10");
    assert.equal(mapped?.updated_at, "1700000000000");
    const session = mapSession({
      agentId: "a",
      sessionId: "s",
      kind: "main",
      lastActivityAtMs: 11n,
    });
    assert.equal(session.last_activity_at_ms, "11");
  });

  it("never paints an unknown or stale computer as green running", () => {
    const missing = presentComputer(undefined, { failed: true });
    assert.equal(missing.tone, "unknown");
    assert.equal(missing.label, "未知");
    const stale = presentComputer({ state: "running", state_code: 3 }, { stale: true });
    assert.equal(stale.tone, "unknown");
    assert.doesNotMatch(stale.label, /^运行中$/);
    const live = presentComputer({ state: "running", state_code: 3 });
    assert.equal(live.live_verified, false);
    assert.match(live.label, /未实时核验/);
  });
});

describe("dashboard poller signal frame", () => {
  it("exposes the six signal groups, distinguishes empty lists from failures, and keeps install URLs out of SSE", async () => {
    const state = createEmptyMockState();
    state.bots.push({ id: "1", agentId: "agent-1", name: "demo", title: "Demo Bot", viewerSessionId: "sess-1" });
    state.statuses.push({
      agentId: "agent-1",
      isRunning: false,
      live: {
        agentId: "agent-1",
        isRunning: false,
        isRetrying: true,
        sessionId: "sess-1",
        awaiting: { reason: "needs_approval" },
        activity: { kind: "tool", tool: "Read", detail: "should-not-leak" },
        lastTurnSettlement: { outcome: "success", settledAtMs: 1_700_000_000_000n },
        boxHandoffRequestId: "handoff-1",
        boxHandoffInstruction: "do not expand this long desk instruction " + "x".repeat(80),
      },
      client: { lastActivityAtMs: 1_700_000_000_500n, unreadCount: 2 },
    });
    state.sessions.push({
      agentId: "agent-1",
      sessionId: "sess-1",
      kind: 1,
      lastActivityAtMs: 1_700_000_000_400n,
    });
    state.todos.push({
      id: "todo-1",
      content: "整理资料",
      status: 1,
      agentId: "agent-1",
      createdAt: 1_700_000_000_000n,
      updatedAt: 1_700_000_000_200n,
    });
    state.slackConnections = [
      {
        agentId: "agent-1",
        connected: true,
        workspaceName: "Acme",
        installUrl: "https://slack.com/apps/install/secret-token",
      },
    ];
    state.teamsConnections = [{ agentId: "agent-1", installState: 1 }];
    const dash = await started(state);
    const sse = await connectSse(dash);
    try {
      const frame = await waitFor(() => {
        const current = dash.poller.current;
        return current.connection.sources?.length ? current : undefined;
      });
      const row = frame.bots[0];
      assert.ok(row);
      const kinds = new Set(row.waiting_signals?.map((s) => s.kind));
      assert.ok(kinds.has("approval"));
      assert.ok(kinds.has("box_handoff"));
      assert.ok(kinds.has("retrying"));
      assert.equal(row.status?.live?.activity?.tool, "Read");
      assert.equal(row.status?.live?.activity?.detail, undefined);
      const slack = row.channels?.find((c) => c.channel === "slack");
      const teams = row.channels?.find((c) => c.channel === "teams");
      assert.equal(slack?.connected, true);
      assert.equal(teams?.connected, false);
      assert.equal(frame.computer.live_verified, false);
      assert.notEqual(frame.computer.tone, "running");
      const sources = Object.fromEntries((frame.connection.sources ?? []).map((s) => [s.id, s]));
      assert.equal(sources.bots?.result, "ok");
      assert.equal(sources.bots?.empty, undefined);
      assert.ok(frame.connection.last_successful_upstream_at_ms);
      assert.equal(payloadLooksSecret(frame), false);
      assert.doesNotMatch(JSON.stringify(frame), /slack.com\/apps\/install/);
      assert.doesNotMatch(JSON.stringify(frame), /do not expand this long desk instruction x{20}/);

      const emptyState = createEmptyMockState();
      const emptyDash = await started(emptyState);
      const emptySse = await connectSse(emptyDash, "empty-client");
      try {
        const emptyFrame = await waitFor(() => {
          const current = emptyDash.poller.current;
          const bots = current.connection.sources?.find((s) => s.id === "bots");
          return bots?.result === "ok" ? current : undefined;
        });
        const emptyBots = emptyFrame.connection.sources.find((s) => s.id === "bots");
        assert.equal(emptyFrame.bots.length, 0);
        assert.equal(emptyBots?.result, "ok");
        assert.equal(emptyBots?.empty, true);
      } finally {
        emptySse.close();
        await emptyDash.close();
      }

      const focus = await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({
          client_id: "signals-client",
          agent_id: "agent-1",
          timeline_visible: false,
        }),
      });
      assert.equal(focus.status, 200);
      const okDetail = await waitFor(() => {
        const d = dash.poller.getDetail("agent-1");
        return d?.todos?.some((t) => t.id === "todo-1") ? d : undefined;
      });
      assert.equal(okDetail.sessions[0]?.last_activity_at_ms, "1700000000400");
      const todoOk = okDetail.sources?.find((s) => s.id === "todos");
      assert.equal(todoOk?.result, "ok");
      assert.notEqual(todoOk?.empty, true);

      state.failTodos = true;
      const failedDetail = await waitFor(() => {
        const d = dash.poller.getDetail("agent-1");
        const todos = d?.sources?.find((s) => s.id === "todos");
        return d && todos?.result === "error" ? d : undefined;
      });
      assert.ok(failedDetail.todos_error);
      assert.equal(failedDetail.todos?.[0]?.id, "todo-1");
      const todosSource = failedDetail.sources?.find((s) => s.id === "todos");
      assert.equal(todosSource?.stale, true);
      assert.notEqual(todosSource?.empty, true);

      state.failListAgents = true;
      const failed = await waitFor(() => {
        const current = dash.poller.current;
        const bots = current.connection.sources?.find((s) => s.id === "bots");
        return bots?.result === "error" ? current : undefined;
      }, 8_000);
      const failedBots = failed.connection.sources.find((s) => s.id === "bots");
      assert.equal(failed.bots.length, 1, "failed read must keep the previous list");
      assert.equal(failedBots?.result, "error");
      assert.notEqual(failedBots?.empty, true);
      assert.equal(failedBots?.stale, true);
      assert.equal(failed.connection.retrying, true);
    } finally {
      sse.close();
      await dash.close();
    }
  });
});
