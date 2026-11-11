/**
 * Phase-2 local `gbc dashboard` detail / timeline / breakdown tests.
 * Synthetic mock data only; UC_SKIP_OFFICIAL is implied by --mock transport.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlPlane } from "../src/ops/plane.js";
import { staticTokenProvider } from "../src/auth/provider.js";
import { loggedOutMockProvider } from "../src/testing/mock-auth.js";
import {
  createEmptyMockState,
  createMockTransport,
  type MockState,
} from "../src/testing/mock-transport.js";
import { startDashboardServer, type StartedDashboard } from "../src/localdash/server.js";
import { payloadLooksSecret } from "../src/localdash/sanitize.js";

function planeOf(state: MockState, loggedIn = true) {
  return new ControlPlane({
    baseUrl: "mock://gbc",
    transport: createMockTransport(state),
    simulated: true,
    auth: loggedIn
      ? staticTokenProvider({ kind: "cursor", backend: "mock://gbc", accessToken: "mock-token" })
      : loggedOutMockProvider({ kind: "cursor", backend: "mock://gbc" }),
  });
}

function fixtureUi(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-dash-ui-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>gbc fixture</title></head><body>gbc 本地监视器</body></html>\n",
  );
  return dir;
}

const FAST = { detailIntervalMs: 80, timelineActiveIntervalMs: 60, timelineIdleIntervalMs: 80 };

async function started(state: MockState, loggedIn = true): Promise<StartedDashboard> {
  return startDashboardServer({
    plane: planeOf(state, loggedIn),
    host: "127.0.0.1",
    port: 0,
    sessionToken: "testsessiontoken",
    uiRoot: fixtureUi(),
    poller: FAST,
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
          ...(init.body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(init.body)) } : {}),
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

async function connectSse(dash: StartedDashboard, client = "client-a"): Promise<{ events: { event: string; data: string }[]; close: () => void }> {
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
        for (const block of parts) {
          const ev = /event: (\w+)/.exec(block)?.[1];
          const data = /data: ([\s\S]+)/.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data });
        }
      });
    },
  );
  // Wait for snapshot
  const start = Date.now();
  while (!events.some((e) => e.event === "snapshot") && Date.now() - start < 5_000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return { events, close: () => r.destroy() };
}

async function waitFor<T>(fn: () => T | undefined, ms = 5_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}

function uiBody(obj: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

function seededState(): MockState {
  const state = createEmptyMockState();
  state.breakdownFixture = "cents_by_source";
  state.bots.push({
    id: "1",
    agentId: "agent-1",
    name: "demo",
    title: "Demo Bot",
    viewerSessionId: "sess-1",
  });
  state.bots.push({
    id: "2",
    agentId: "agent-2",
    name: "other",
    title: "Other Bot",
  });
  state.statuses.push({
    agentId: "agent-1",
    isRunning: true,
    live: { agentId: "agent-1", isRunning: true, sessionId: "sess-1" },
  });
  state.statuses.push({
    agentId: "agent-2",
    isRunning: false,
    live: { agentId: "agent-2", isRunning: false },
  });
  state.sessions.push({ agentId: "agent-1", sessionId: "sess-1", kind: 1 });
  state.sessions.push({ agentId: "agent-1", sessionId: "sess-2", kind: 5 });
  state.todos.push({ id: "todo-1", content: "整理资料", status: 1, agentId: "agent-1" });
  state.tasks.push({ id: "task-1", name: "调研", status: "open", agentId: "agent-1" });
  state.subagents.push({ subagentId: "sub-1", title: "检索助手", agentId: "agent-1" });
  state.transcript.push({
    entryId: "m1",
    seq: 1n,
    entryKind: "message",
    bodyOmitted: false,
    body: uiBody({ id: "m1", kind: "message", role: "user", content: "开始吧", timestampMs: 1_700_000_000_000 }),
    sessionId: "sess-1",
    agentId: "agent-1",
  });
  state.transcript.push({
    entryId: "m2",
    seq: 2n,
    entryKind: "message",
    bodyOmitted: false,
    body: uiBody({ id: "m2", kind: "message", role: "assistant", content: "好的，我来处理。", timestampMs: 1_700_000_000_100 }),
    sessionId: "sess-1",
    agentId: "agent-1",
  });
  state.transcript.push({
    entryId: "m-other",
    seq: 1n,
    entryKind: "message",
    bodyOmitted: false,
    body: uiBody({ id: "m-other", kind: "message", role: "user", content: "另一会话" }),
    sessionId: "sess-2",
    agentId: "agent-1",
  });
  return state;
}

describe("usage breakdown mock RPC", () => {
  it("covers failure, empty, by-source and by-bot, and never sends a team id", async () => {
    for (const name of ["cents_by_source", "cents_by_bot", "ppm_weekly", "ppm_billing", "empty"] as const) {
      const state = createEmptyMockState();
      state.breakdownFixture = name;
      const res = await planeOf(state).usage.breakdown();
      assert.equal(res.ok, true, name);
      assert.equal(res.simulated, true);
      const req = state.lastUsageBreakdownRequest as Record<string, unknown> | undefined;
      assert.ok(req);
      assert.equal(req.enterpriseTeamId ?? req.enterprise_team_id, undefined);
      if (name === "empty") assert.equal(res.data!.kind, "empty");
      if (name === "cents_by_bot") assert.equal(res.data!.by_bot.length, 2);
      if (name === "cents_by_source") assert.equal(res.data!.by_source[0]?.cents, "1234");
    }
    const fail = createEmptyMockState();
    fail.breakdownFixture = "failure";
    const res = await planeOf(fail).usage.breakdown();
    assert.equal(res.ok, false);
    assert.equal(res.retryable, true);
  });
});

describe("detail and timeline polling", () => {
  it("polls sessions/todos/tasks/subagents only for the focused bot and does not amplify the global status poll", async () => {
    const state = seededState();
    const dash = await started(state);
    const sse = await connectSse(dash, "c1");
    try {
      await waitFor(() => (state.callCounts?.listGrokBotAgents ?? 0) >= 1);
      const agentsBefore = state.callCounts!.listGrokBotAgents;
      const statusBefore = state.callCounts!.listGrokBotAgentStatuses;
      const post = await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", timeline_visible: true }),
      });
      assert.equal(post.status, 200);
      const detail = await waitFor(() => {
        const d = dash.poller.getDetail("agent-1");
        return d?.session_view.current_session_id === "sess-1" && d.todos?.length ? d : undefined;
      });
      assert.equal(detail.todos?.length, 1);
      assert.equal(detail.todos?.[0]?.content, "整理资料");
      assert.equal(detail.tasks?.[0]?.name, "调研");
      assert.equal(detail.subagents?.[0]?.title, "检索助手");
      assert.equal(detail.session_view.current_session_id, "sess-1");
      assert.equal(detail.session_view.viewed_session_id, "sess-1");
      assert.ok(detail.usage_breakdown && detail.usage_breakdown.length >= 1);
      assert.equal(payloadLooksSecret(detail), false);
      assert.doesNotMatch(JSON.stringify(detail), /mock-token|access_token|refresh_token|Bearer /i);

      const timeline = await waitFor(() => dash.poller.getTimeline("agent-1", "sess-1"));
      assert.equal(timeline.entries.length, 2);
      assert.equal(timeline.entries[0]?.text, "开始吧");
      assert.equal(payloadLooksSecret(timeline), false);

      const todosAfterFocus = state.callCounts!.listGrokBotAgentTodos;
      assert.ok(todosAfterFocus >= 1);
      await new Promise((r) => setTimeout(r, 220));
      // Only the focused bot is detailed; the other bot is not independently listed.
      assert.equal(dash.poller.getDetail("agent-2"), undefined);
      // Global list/status must not start firing per-bot (still around the original 5s cadence).
      assert.ok(state.callCounts!.listGrokBotAgents - agentsBefore <= 1);
      assert.ok(state.callCounts!.listGrokBotAgentStatuses - statusBefore <= 1);
      assert.ok(state.callCounts!.listGrokBotAgentTodos >= todosAfterFocus);
    } finally {
      sse.close();
      await dash.close();
    }
  });

  it("pauses transcript polling when the timeline leaves the viewport and resumes when it returns", async () => {
    const state = seededState();
    const dash = await started(state);
    const sse = await connectSse(dash, "c1");
    try {
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", timeline_visible: true }),
      });
      await waitFor(() => (state.callCounts?.listGrokBotTranscriptEntries ?? 0) >= 1);
      const before = state.callCounts!.listGrokBotTranscriptEntries;
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", timeline_visible: false }),
      });
      await new Promise((r) => setTimeout(r, 250));
      const paused = state.callCounts!.listGrokBotTranscriptEntries;
      assert.ok(paused - before <= 1, `transcript should pause, grew ${paused - before}`);
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", timeline_visible: true }),
      });
      await waitFor(() => (state.callCounts?.listGrokBotTranscriptEntries ?? 0) > paused);
    } finally {
      sse.close();
      await dash.close();
    }
  });

  it("makes an invalid session switch visible and does not leak credentials", async () => {
    const state = seededState();
    const dash = await started(state);
    const sse = await connectSse(dash, "c1");
    try {
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", view_session_id: "missing", timeline_visible: true }),
      });
      const detail = await waitFor(() => {
        const d = dash.poller.getDetail("agent-1");
        return d?.session_view.switch_error && d.session_view.viewed_session_id === "sess-1" ? d : undefined;
      });
      assert.match(detail.session_view.switch_error ?? "", /未切换/);
      assert.equal(detail.session_view.viewed_session_id, "sess-1");
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", view_session_id: "sess-2", timeline_visible: true }),
      });
      const switched = await waitFor(() => {
        const d = dash.poller.getDetail("agent-1");
        return d?.session_view.viewed_session_id === "sess-2" ? d : undefined;
      });
      assert.equal(switched.session_view.switch_error, undefined);
      const timeline = await waitFor(() => dash.poller.getTimeline("agent-1", "sess-2"));
      assert.equal(timeline.entries.length, 1);
      assert.equal(timeline.entries[0]?.text, "另一会话");
      const raw = JSON.stringify({ detail: switched, timeline });
      assert.doesNotMatch(raw, /mock-token|access_token|refresh_token|verifier|Bearer /i);
    } finally {
      sse.close();
      await dash.close();
    }
  });

  it("does not poll details when unauthenticated", async () => {
    const state = seededState();
    const dash = await started(state, false);
    const sse = await connectSse(dash, "c1");
    try {
      const before = { ...state.callCounts };
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", timeline_visible: true }),
      });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(state.callCounts?.listGrokBotAgentTodos ?? 0, before.listGrokBotAgentTodos ?? 0);
      assert.equal(state.callCounts?.listGrokBotTranscriptEntries ?? 0, before.listGrokBotTranscriptEntries ?? 0);
      assert.equal(state.callCounts?.getGrokBotUsageBreakdown ?? 0, before.getGrokBotUsageBreakdown ?? 0);
    } finally {
      sse.close();
      await dash.close();
    }
  });
});


describe("subscription isolation and evidence freshness", () => {
  it("keeps transcript polling when the graph is visible even if the activity list is hidden", async () => {
    const state = seededState();
    const dash = await started(state);
    const sse = await connectSse(dash, "c1");
    try {
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", timeline_visible: false, graph_visible: true }),
      });
      await waitFor(() => (state.callCounts?.listGrokBotTranscriptEntries ?? 0) >= 1);
      const before = state.callCounts!.listGrokBotTranscriptEntries;
      await waitFor(() => (state.callCounts?.listGrokBotTranscriptEntries ?? 0) > before);
    } finally {
      sse.close();
      await dash.close();
    }
  });

  it("isolates two clients on the same bot in different sessions and does not mix generations", async () => {
    const state = seededState();
    const dash = await started(state);
    const sse1 = await connectSse(dash, "c1");
    const sse2 = await connectSse(dash, "c2");
    try {
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", view_session_id: "sess-1", timeline_visible: true, graph_visible: true }),
      });
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c2", agent_id: "agent-1", view_session_id: "sess-2", timeline_visible: true, graph_visible: true }),
      });
      const t1 = await waitFor(() => dash.poller.getTimeline("agent-1", "sess-1"));
      const t2 = await waitFor(() => dash.poller.getTimeline("agent-1", "sess-2"));
      assert.equal(t1.session_id, "sess-1");
      assert.ok(t1.entries.some((e) => e.text === "开始吧"));
      assert.equal(t2.session_id, "sess-2");
      assert.ok(t2.entries.some((e) => e.text === "另一会话"));
      assert.equal(t1.entries.some((e) => e.text === "另一会话"), false);
      const ev1 = dash.poller.getEvidence("agent-1", "sess-1");
      assert.equal(ev1.entities.some((e) => e.kind === "activity" && e.session_id === "sess-2"), false);
      assert.equal(ev1.entities.some((e) => e.kind === "activity" && e.session_id === "sess-1"), true);

      state.transcriptGeneration = 2;
      const after = await waitFor(() => {
        const tl = dash.poller.getTimeline("agent-1", "sess-1");
        return tl?.generation === 2 && tl.generation_known ? tl : undefined;
      });
      assert.equal(after.generation, 2);
      const ev = dash.poller.getEvidence("agent-1", "sess-1");
      const gens = new Set(ev.entities.filter((e) => e.kind === "activity" && e.session_id === "sess-1").map((e) => e.generation));
      assert.ok(gens.has(1) && gens.has(2));
    } finally {
      sse1.close();
      sse2.close();
      await dash.close();
    }
  });

  it("keeps the last known generation on an error frame and does not refresh freshness", async () => {
    const state = seededState();
    const dash = await started(state);
    const sse = await connectSse(dash, "c1");
    try {
      await req(dash, `${dash.sessionPath}api/focus`, {
        method: "POST",
        body: JSON.stringify({ client_id: "c1", agent_id: "agent-1", view_session_id: "sess-1", timeline_visible: true }),
      });
      const ok = await waitFor(() => {
        const tl = dash.poller.getTimeline("agent-1", "sess-1");
        return tl?.result === "ok" && tl.generation_known ? tl : undefined;
      });
      assert.equal(ok.generation, 1);
      const observed = ok.last_successful_observed_at_ms;
      assert.ok(observed);
      state.failTranscript = true;
      const failed = await waitFor(() => {
        const tl = dash.poller.getTimeline("agent-1", "sess-1");
        return tl?.result === "error" ? tl : undefined;
      });
      assert.equal(failed.generation, 1);
      assert.equal(failed.generation_known, true);
      assert.equal(failed.entries.length, ok.entries.length);
      assert.equal(failed.last_successful_observed_at_ms, observed);
      const ev = dash.poller.getEvidence("agent-1", "sess-1");
      const transcript = ev.observations.find((o) => o.source === "transcript");
      assert.equal(transcript?.last_successful_observed_at_ms, observed);
      assert.equal(transcript?.result, "error");
    } finally {
      sse.close();
      await dash.close();
    }
  });
});
