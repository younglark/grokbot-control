/**
 * Local `gbc dashboard` HTTP/SSE server tests. Synthetic mock data only.
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
import { LIMIT_MAX } from "../src/ops/limits.js";

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

function bot(i: number, running = false, awaiting?: string) {
  const agentId = `agent-${String(i).padStart(4, "0")}`;
  return {
    agent: {
      id: String(i),
      agentId,
      name: `bot-${i}`,
      title: `Bot ${i}`,
      description: "",
    },
    status: {
      agentId,
      isRunning: running,
      live: {
        agentId,
        isRunning: running,
        sessionId: `sess-${i}`,
        ...(awaiting ? { awaiting: { reason: awaiting, tabId: "t", sinceMs: 1n } } : {}),
      },
    },
  };
}

function fixtureUi(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-dash-ui-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>gbc fixture</title></head><body>gbc 本地监视器</body></html>\n",
  );
  return dir;
}

async function started(state: MockState, loggedIn = true): Promise<StartedDashboard> {
  return startDashboardServer({
    plane: planeOf(state, loggedIn),
    host: "127.0.0.1",
    port: 0,
    sessionToken: "testsessiontoken",
    uiRoot: fixtureUi(),
  });
}

function req(
  target: StartedDashboard | string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const base = typeof target === "string" ? target : `http://127.0.0.1:${target.bind.port}`;
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: {
          host: init.headers?.host ?? `${url.hostname}:${url.port}`,
          ...init.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    if (init.body) r.write(init.body);
    r.end();
  });
}

async function sseFrame(
  dash: StartedDashboard,
  pred: (frame: Record<string, unknown>) => boolean = () => true,
  ms = 8_000,
): Promise<Record<string, unknown>> {
  const url = new URL("api/events", dash.url);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      r.destroy();
      reject(new Error("SSE timeout"));
    }, ms);
    const r = http.get(
      {
        hostname: "127.0.0.1",
        port: dash.bind.port,
        path: url.pathname,
        headers: { host: `127.0.0.1:${dash.bind.port}`, accept: "text/event-stream" },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          const re = /event: (?:snapshot|update)\ndata: (\{.*\})\n/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(buf))) {
            const frame = JSON.parse(m[1]!) as Record<string, unknown>;
            if (pred(frame)) {
              clearTimeout(t);
              r.destroy();
              resolve(frame);
              return;
            }
          }
        });
      },
    );
    r.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

describe("dashboard HTTP routes and security", () => {
  it("refuses the page and API without the session prefix; bad Host/Origin are 403", async () => {
    const state = createEmptyMockState();
    const dash = await started(state);
    try {
      const missing = await req(dash, "/");
      assert.equal(missing.status, 404);
      assert.ok(!missing.body.includes("<!doctype") && !missing.body.includes("gbc"));
      const apiMissing = await req(dash, "/api/events");
      assert.equal(apiMissing.status, 404);
      const badHost = await req(dash, dash.sessionPath, { headers: { host: "evil.example" } });
      assert.equal(badHost.status, 403);
      const badOrigin = await req(dash, dash.sessionPath, {
        headers: {
          host: `127.0.0.1:${dash.bind.port}`,
          origin: "https://evil.example",
        },
      });
      assert.equal(badOrigin.status, 403);
      const ok = await req(dash, dash.sessionPath);
      // UI may be missing if dist/dashboard is not built; still must not 403 on a good Host.
      assert.notEqual(ok.status, 403);
    } finally {
      await dash.close();
    }
  });

  it("only exposes read-only HTTP routes (no official write RPCs)", async () => {
    const state = createEmptyMockState();
    const dash = await started(state);
    try {
      const postRoot = await req(dash, dash.sessionPath, { method: "POST" });
      assert.ok(postRoot.status === 405 || postRoot.status === 404);
      const del = await req(dash, `${dash.sessionPath}api/bots`, { method: "DELETE" });
      assert.ok(del.status === 405 || del.status === 404);
      const exec = await req(dash, `${dash.sessionPath}api/ExecuteSandMcpTool`, { method: "POST" });
      assert.ok(exec.status === 405 || exec.status === 404);
      const set = await req(dash, `${dash.sessionPath}api/SetHardLimit`, { method: "POST" });
      assert.ok(set.status === 405 || set.status === 404);
    } finally {
      await dash.close();
    }
  });

  it("SSE snapshot has no secrets and lists up to 1000 bots with a truncation banner", async () => {
    const state = createEmptyMockState();
    for (let i = 0; i < 1001; i++) {
      const { agent, status } = bot(i, i < 3, i === 4 ? "waiting for approval" : undefined);
      state.bots.push(agent);
      state.statuses.push(status);
    }
    const dash = await started(state);
    try {
      const frame = (await sseFrame(dash, (f) => Array.isArray(f.bots) && (f.bots as unknown[]).length > 0 || Boolean(f.list_truncated))) as {
        bots: unknown[];
        list_truncated: boolean;
        counts: { total: number };
        auth: unknown;
        connection: unknown;
      };
      assert.equal(frame.bots.length, LIMIT_MAX);
      assert.equal(frame.list_truncated, true);
      assert.equal(payloadLooksSecret(frame), false);
      const raw = JSON.stringify(frame);
      assert.doesNotMatch(raw, /mock-token|access_token|refresh_token|verifier|Bearer /i);
      assert.ok(state.callCounts);
      assert.equal(state.callCounts!.listGrokBotAgents >= 1, true);
      // One batch list, not the CLI default of 50
      assert.ok(frame.counts.total === LIMIT_MAX);
    } finally {
      await dash.close();
    }
  });

  it("unauthenticated --mock still serves and does not hammer upstream", async () => {
    const state = createEmptyMockState();
    state.bots.push(bot(1).agent);
    const dash = await started(state, false);
    try {
      const frame = (await sseFrame(dash, (f) => Boolean((f.auth as { banner?: string })?.banner))) as { auth: { banner?: string; logged_in: boolean } };
      assert.equal(frame.auth.logged_in, false);
      assert.equal(frame.auth.banner, "login_required");
      const before = { ...state.callCounts };
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(state.callCounts?.listGrokBotAgents ?? 0, before.listGrokBotAgents ?? 0);
      assert.equal(state.callCounts?.getSandUsageStatus ?? 0, before.getSandUsageStatus ?? 0);
      assert.equal(state.callCounts?.listGrokBotAgentStatuses ?? 0, before.listGrokBotAgentStatuses ?? 0);
      assert.equal(state.callCounts?.getSandBoxRunState ?? 0, before.getSandBoxRunState ?? 0);
    } finally {
      await dash.close();
    }
  });
});

describe("usage mock fixtures via official GetSandUsageStatus wrapper", () => {
  it("covers near-exhausted, exhausted, unlimited, enterprise-shared, and failure", async () => {
    for (const name of ["near_exhausted", "exhausted", "unlimited", "enterprise_shared"] as const) {
      const state = createEmptyMockState();
      state.usageFixture = name;
      const p = planeOf(state);
      const res = await p.usage.status();
      assert.equal(res.ok, true, name);
      assert.equal(res.simulated, true);
      if (name === "unlimited") assert.equal(res.data!.included_limit_zero, true);
      if (name === "exhausted") {
        assert.equal(res.data!.usage_percent, 100);
        assert.equal(res.data!.has_available_usage, false);
      }
      if (name === "enterprise_shared") assert.equal(res.data!.uses_pooled_enterprise_allowance, true);
      if (name === "near_exhausted") assert.equal(res.data!.usage_percent, 92);
    }
    const fail = createEmptyMockState();
    fail.usageFixture = "failure";
    const res = await planeOf(fail).usage.status();
    assert.equal(res.ok, false);
    assert.equal(res.retryable, true);
  });
});
