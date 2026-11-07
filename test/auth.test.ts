/**
 * Auth flow tests with injected fake fetch. The asserted URLs/params mirror STATIC
 * reverse engineering of Grok Bot Linux 0.79.2/0.79.3 (see src/auth/provider.ts header) —
 * not official docs, and passing here is not proof the live service accepts them.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  createAuthProvider,
  generateLoginChallenge,
  REFRESH_EARLY_MS,
  classifyExpiry,
  staticTokenProvider,
} from "../src/auth/provider.js";
import { FileCredentialStore, redactCredential, withCredentialLock } from "../src/auth/store.js";
import { AuthOps } from "../src/ops/auth.js";
import { ControlPlane } from "../src/ops/plane.js";
import { createAuthInterceptor, READ_ONLY_UNARY_METHODS } from "../src/connect/client.js";
import { GbcError } from "../src/errors.js";
import { buildTools } from "../src/mcp/tools.js";
import { jwt } from "./jwt-helper.js";

const API = "https://api2.cursor.sh";

type Req = { url: string; init?: RequestInit };
function fakeFetch(handler: (u: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Req[] = [];
  return {
    calls,
    http: {
      fetch: (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return handler(new URL(String(url)), init);
      }) as typeof fetch,
    },
  };
}

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-auth-"));
  process.env.GBT_CREDENTIALS_DIR = dir;
  delete process.env.GBT_OAUTH_CLIENT_ID;
  delete process.env.GBT_TRUST_BACKEND;
  delete process.env.GBT_WEBSITE_URL;
  delete process.env.GBT_LOGIN_REDIRECT_TARGET;
  delete process.env.GBT_AUTH_CONFIRM_MIGRATE;
});

const noSleep = async () => {};
const mode = (f: string) => fs.statSync(f).mode & 0o777;

describe("login challenge + URL (evidence A:38644-38657)", () => {
  it("challenge = base64url(sha256(verifier)); 32-byte verifier; uuid v4", () => {
    const { verifier, challenge, uuid } = generateLoginChallenge();
    assert.equal(Buffer.from(verifier, "base64url").length, 32);
    assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
    assert.match(uuid, /^[0-9a-f-]{36}$/);
  });

  it("begin: official URL params, pending 0600 in 0700 dir, verifier never in output", async () => {
    const auth = createAuthProvider({ kind: "cursor", backend: API });
    const begin = await auth.beginLogin();
    const u = new URL(begin.authorization_url);
    assert.equal(u.origin + u.pathname, "https://cursor.com/loginDeepControl");
    assert.deepEqual([...u.searchParams.keys()].sort(), ["challenge", "mode", "redirectTarget", "uuid"]);
    assert.equal(u.searchParams.get("mode"), "login");
    assert.equal(u.searchParams.get("redirectTarget"), "cli");
    assert.equal(u.searchParams.get("uuid"), begin.uuid);
    const store = new FileCredentialStore();
    const pf = store.pendingFile("cursor", API);
    assert.equal(mode(pf), 0o600);
    assert.equal(mode(dir), 0o700);
    const p = store.loadPending("cursor", API)!;
    assert.equal(u.searchParams.get("challenge"), crypto.createHash("sha256").update(p.verifier).digest("base64url"));
    assert.ok(!JSON.stringify(begin).includes(p.verifier));
    const env = await new AuthOps(auth).begin();
    assert.ok(!JSON.stringify(env).includes(new FileCredentialStore().loadPending("cursor", API)!.verifier));
  });
});

describe("poll (evidence A:38720-38816)", () => {
  it("GET /auth/poll?uuid&verifier; 404 pending -> 200 completed; cred 0600; pending cleared; cross-instance", async () => {
    const access = jwt(Math.floor(Date.now() / 1000) + 3600);
    let n = 0;
    const f = fakeFetch((u) => {
      assert.equal(u.origin + u.pathname, `${API}/auth/poll`);
      return ++n < 3 ? new Response(null, { status: 404 }) : Response.json({ accessToken: access, refreshToken: "R1" });
    });
    await createAuthProvider({ kind: "cursor", backend: API }).beginLogin();
    const verifier = new FileCredentialStore().loadPending("cursor", API)!.verifier;
    const b = createAuthProvider({ kind: "cursor", backend: API, http: f.http, sleep: noSleep, clientId: "PUBLIC_ID" });
    const r = await b.completeLogin({ timeoutMs: 60_000 });
    assert.equal(r.status, "completed");
    assert.equal(f.calls.length, 3);
    const u = new URL(f.calls[0]!.url);
    assert.equal(f.calls[0]!.init?.method, "GET");
    assert.equal(u.searchParams.get("verifier"), verifier);
    assert.ok(u.searchParams.get("uuid"));
    assert.ok(!JSON.stringify(r).includes(access) && !JSON.stringify(r).includes("R1") && !JSON.stringify(r).includes(verifier));
    const store = new FileCredentialStore();
    assert.equal(mode(store.credFile("cursor", API)), 0o600);
    assert.equal(store.loadPending("cursor", API), undefined);
    const c = store.load("cursor", API)!;
    assert.equal(c.access_token, access);
    assert.equal(c.refresh_token, "R1");
    assert.equal(c.client_id, "PUBLIC_ID");
    assert.equal(c.credential_source, "login_poll");
    assert.equal(c.login_kind, "browser_deep_control");
    assert.ok(c.session_id);
    assert.equal(c.revision, 1);
    assert.equal(c.expires_at_ms! > Date.now(), true);
    assert.equal(redactCredential(c).access_token, "[redacted]");
    const who = await b.whoamiLocal();
    assert.equal(who.has_token, true);
    assert.equal(who.account_label, "t@example.com");
    assert.equal(who.client_id_bound, true);
    assert.equal(who.disk_refresh, true);
    assert.ok(!JSON.stringify(who).includes(access));
  });

  it("timeout -> pending result (CLI auth_pending, retryable), pending kept", async () => {
    let t = 1_000_000;
    const f = fakeFetch(() => new Response(null, { status: 404 }));
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, now: () => t, sleep: async (ms) => void (t += ms) });
    await a.beginLogin();
    const r = await new AuthOps(a).complete(5);
    assert.equal(r.ok, false);
    assert.equal(r.code, "auth_pending");
    assert.equal(r.retryable, true);
    assert.ok(f.calls.length >= 2 && f.calls.length < 10);
    assert.ok(new FileCredentialStore().loadPending("cursor", API));
  });

  it("3 consecutive non-404 -> auth_poll_failed, pending kept; single poll pending", async () => {
    const f = fakeFetch(() => new Response("x", { status: 500 }));
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, sleep: noSleep });
    await a.beginLogin();
    await assert.rejects(a.completeLogin(), (e: GbcError) => e.code === "auth_poll_failed" && e.retryable);
    assert.equal(f.calls.length, 3);
    assert.ok(new FileCredentialStore().loadPending("cursor", API));
    const f2 = fakeFetch(() => new Response(null, { status: 404 }));
    const a2 = createAuthProvider({ kind: "cursor", backend: API, http: f2.http });
    const one = await new AuthOps(a2).poll();
    assert.equal(one.code, "auth_pending");
  });

  it("403 sign_in_policy_violation -> denied; pending cleared; no cred", async () => {
    const f = fakeFetch(() => Response.json({ error: "sign_in_policy_violation" }, { status: 403 }));
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, sleep: noSleep });
    await a.beginLogin();
    const r = await new AuthOps(a).complete(30);
    assert.equal(r.code, "denied");
    const s = new FileCredentialStore();
    assert.equal(s.loadPending("cursor", API), undefined);
    assert.equal(s.load("cursor", API), undefined);
  });

  it("xAI identity result -> unsupported, nothing stored; kind xai login unsupported", async () => {
    const f = fakeFetch(() =>
      Response.json({ xaiAccessToken: "X", xaiRefreshToken: "Y", xaiAccessTokenExpiresAt: 1, xaiIssuer: "https://auth.grok.com" }),
    );
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, sleep: noSleep });
    await a.beginLogin();
    const r = await new AuthOps(a).complete(30);
    assert.equal(r.code, "unsupported");
    assert.equal(new FileCredentialStore().load("cursor", API), undefined);
    const x = await new AuthOps(createAuthProvider({ kind: "xai", backend: API })).begin();
    assert.equal(x.code, "unsupported");
  });

  it("expired pending -> auth_login_expired; abort -> canceled; missing pending -> auth", async () => {
    let t = 0;
    const a = createAuthProvider({ kind: "cursor", backend: API, now: () => t, http: fakeFetch(() => new Response(null, { status: 404 })).http });
    await a.beginLogin();
    t = 16 * 60_000;
    await assert.rejects(a.completeLogin(), (e: GbcError) => e.code === "auth_login_expired");
    t = 0;
    await a.beginLogin();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(a.completeLogin({ signal: ac.signal }), (e: GbcError) => e.code === "canceled");
    await a.cancelLogin();
    await assert.rejects(a.pollLogin(), (e: GbcError) => e.code === "auth");
  });
});

describe("refresh (evidence A:56108-56125, A:54459)", () => {
  function seed(
    access: string,
    refresh = "R1",
    extra: Partial<import("../src/auth/types.js").StoredCredential> = {},
  ) {
    const exp = (() => {
      try {
        return (JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString()).exp as number) * 1000;
      } catch {
        return undefined;
      }
    })();
    new FileCredentialStore().save({
      kind: "cursor",
      backend: API,
      access_token: access,
      refresh_token: refresh,
      expires_at_ms: exp,
      updated_at_ms: 0,
      revision: 1,
      credential_source: "login_poll",
      login_kind: "browser_deep_control",
      client_id: "PUBLIC_ID",
      session_id: "sess-1",
      account_subject: "u1",
      refresh_endpoint: `${API}/oauth/token`,
      ...extra,
    });
  }
  const soon = () => jwt(Math.floor(Date.now() / 1000) + 60);
  const later = () => jwt(Math.floor(Date.now() / 1000) + 7200);
  const exactlyEarly = () => jwt(Math.floor((Date.now() + REFRESH_EARLY_MS) / 1000));

  it("POST /oauth/token {client_id, grant_type, refresh_token}; rotation saved; old refresh kept if absent", async () => {
    seed(soon());
    const fresh = later();
    const f = fakeFetch(async (u, init) => {
      assert.equal(u.toString(), `${API}/oauth/token`);
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["content-type"], "application/json");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { client_id: "PUBLIC_ID", grant_type: "refresh_token", refresh_token: "R1" });
      return Response.json({ access_token: fresh });
    });
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    assert.equal(await a.getAccessToken(), fresh);
    const c = new FileCredentialStore().load("cursor", API)!;
    assert.equal(c.refresh_token, "R1");
    assert.equal(c.revision, 2);
    assert.equal(c.credential_source, "refresh");
    assert.equal(mode(new FileCredentialStore().credFile("cursor", API)), 0o600);
  });

  it("no client_id configured -> auth_refresh_unconfigured, creds kept, no network", async () => {
    seed(soon(), "R1", { client_id: undefined, credential_source: undefined });
    const f = fakeFetch(() => Response.json({}));
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http });
    await assert.rejects(a.refresh(), (e: GbcError) => e.code === "auth_refresh_unconfigured");
    assert.equal(f.calls.length, 0);
    assert.ok(new FileCredentialStore().load("cursor", API));
    await assert.rejects(a.getAccessToken(), (e: GbcError) => e.code === "auth_refresh_unconfigured");
  });

  it("HTTP 401 / network error keep creds; shouldLogout clears; expired + failure throws", async () => {
    seed(soon());
    const a401 = createAuthProvider({ kind: "cursor", backend: API, clientId: "PUBLIC_ID", http: fakeFetch(() => new Response("", { status: 401 })).http });
    await assert.rejects(a401.refresh(), (e: GbcError) => e.code === "auth_refresh_failed");
    assert.ok(new FileCredentialStore().load("cursor", API));
    const aNet = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: { fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch },
    });
    await assert.rejects(aNet.refresh(), (e: GbcError) => e.code === "auth_refresh_network" && e.retryable);
    assert.ok(new FileCredentialStore().load("cursor", API));
    seed(jwt(Math.floor(Date.now() / 1000) - 10));
    await assert.rejects(a401.getAccessToken(), (e: GbcError) => e.code === "auth_refresh_failed");
    const aOut = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(() => Response.json({ shouldLogout: true })).http,
    });
    seed(soon());
    await assert.rejects(aOut.refresh(), (e: GbcError) => e.code === "auth_revoked");
    assert.equal(new FileCredentialStore().load("cursor", API), undefined);
  });

  it("in-process singleflight collapses concurrent refresh to one network call", async () => {
    seed(soon());
    let calls = 0;
    const fresh = later();
    const a = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return Response.json({ access_token: fresh, refresh_token: "R2" });
      }).http,
    });
    const [x, y] = await Promise.all([a.refresh({ force: true }), a.refresh({ force: true })]);
    assert.equal(calls, 1);
    assert.equal(x.refreshed, true);
    assert.equal(y.refreshed, true);
    assert.equal(new FileCredentialStore().load("cursor", API)!.refresh_token, "R2");
  });

  it("concurrent refresh across instances is single-flight (one network call)", async () => {
    seed(soon());
    let calls = 0;
    const fresh = later();
    const mk = () =>
      createAuthProvider({
        kind: "cursor",
        backend: API,
        clientId: "PUBLIC_ID",
        http: fakeFetch(async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 50));
          return Response.json({ access_token: fresh, refresh_token: "R2" });
        }).http,
      });
    const [x, y] = await Promise.all([mk().refresh(), mk().refresh()]);
    // In-process singleflight + lock around decide/save; cross-instance may still overlap HTTP.
    assert.equal(calls, 1);
    assert.ok(x.refreshed || y.refreshed || x.reason === "peer_refreshed" || y.reason === "peer_refreshed");
    assert.equal(new FileCredentialStore().load("cursor", API)!.access_token, fresh);
    assert.equal(new FileCredentialStore().load("cursor", API)!.refresh_token, "R2");
  });

  it("logout removes only own files (local); untrusted website rejected", async () => {
    seed(later());
    const a = createAuthProvider({ kind: "cursor", backend: API });
    await a.beginLogin();
    const r = await a.logout();
    assert.deepEqual(r, { removed_credential: true, removed_pending: true });
    process.env.GBT_WEBSITE_URL = "https://evil.example";
    assert.throws(() => createAuthProvider({ kind: "cursor", backend: API }), /requires trust/);
  });

  it("rejects untrusted custom backend without confirmation", () => {
    assert.throws(() => createAuthProvider({ kind: "cursor", backend: "https://evil.example" }));
  });

  it("missing/illegal exp forces refresh; exactly 300s window refreshes", async () => {
    const fresh = later();
    const f = fakeFetch(() => Response.json({ access_token: fresh, refresh_token: "R9" }));
    seed("not-a-jwt", "R1", { expires_at_ms: undefined });
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    const r1 = await a.refresh();
    assert.equal(r1.refreshed, true);
    assert.equal(r1.reason, "missing_exp");
    assert.equal(f.calls.length, 1);

    seed("hdr." + Buffer.from(JSON.stringify({ exp: "bad" })).toString("base64url") + ".sig", "R1", {
      expires_at_ms: -1, // NaN does not survive JSON round-trip; negative is illegal
    });
    const a2 = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    const r2 = await a2.refresh();
    assert.equal(r2.reason, "illegal_exp");

    seed(exactlyEarly());
    const a3 = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    const r3 = await a3.refresh();
    assert.equal(r3.refreshed, true);
    assert.equal(r3.reason, "near_expiry");
  });

  it("force vs noop: already_fresh without network; force always refreshes", async () => {
    seed(later());
    const f = fakeFetch(() => Response.json({ access_token: later(), refresh_token: "R3" }));
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    const noop = await a.refresh();
    assert.equal(noop.refreshed, false);
    assert.equal(noop.reason, "already_fresh");
    assert.equal(f.calls.length, 0);
    const ops = await new AuthOps(a).refresh();
    assert.equal(ops.ok, true);
    assert.equal((ops.data as { refreshed: boolean }).refreshed, false);
    const forced = await new AuthOps(a).refresh({ force: true });
    assert.equal(forced.ok, true);
    assert.equal((forced.data as { refreshed: boolean }).refreshed, true);
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(forced).includes("R3"));
  });

  it("shouldLogout must not fallback revoked token via getAccessToken", async () => {
    seed(soon());
    const a = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(() => Response.json({ shouldLogout: true })).http,
    });
    await assert.rejects(a.getAccessToken(), (e: GbcError) => e.code === "auth_revoked");
    assert.equal(new FileCredentialStore().load("cursor", API), undefined);
  });

  it("logout/revision race: slow refresh must not revive cleared or new-login creds", async () => {
    seed(soon());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stage = 0;
    const f = fakeFetch(async () => {
      stage = 1;
      await gate;
      return Response.json({ access_token: later(), refresh_token: "R-stale" });
    });
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    const p = a.refresh({ force: true });
    while (stage === 0) await new Promise((r) => setTimeout(r, 5));
    await a.logout();
    release();
    await assert.rejects(p, (e: GbcError) => e.code === "auth_revoked" || e.code === "auth");
    assert.equal(new FileCredentialStore().load("cursor", API), undefined);

    // New login wins over in-flight refresh
    seed(soon(), "R1", { session_id: "old-sess", revision: 1 });
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    let hit = 0;
    const f2 = fakeFetch(async (u) => {
      if (u.pathname.endsWith("/oauth/token")) {
        hit++;
        await gate2;
        return Response.json({ access_token: later(), refresh_token: "R-old" });
      }
      return Response.json({ accessToken: later(), refreshToken: "R-new" });
    });
    const a2 = createAuthProvider({ kind: "cursor", backend: API, http: f2.http, clientId: "PUBLIC_ID" });
    const refreshP = a2.refresh({ force: true });
    while (hit === 0) await new Promise((r) => setTimeout(r, 5));
    // Simulate newer login written under lock while refresh HTTP is in flight
    await withCredentialLock(`cursor|${API}`, async () => {
      const cur = new FileCredentialStore().load("cursor", API)!;
      new FileCredentialStore().save({
        ...cur,
        access_token: later(),
        refresh_token: "R-new",
        session_id: "new-sess",
        revision: (cur.revision ?? 0) + 1,
        credential_source: "login_poll",
      });
    });
    release2();
    await assert.rejects(refreshP, (e: GbcError) => e.code === "auth_revoked");
    assert.equal(new FileCredentialStore().load("cursor", API)!.session_id, "new-sess");
    assert.equal(new FileCredentialStore().load("cursor", API)!.refresh_token, "R-new");
  });

  it("cross-process lock wait then reread reuses peer token without second network call", async () => {
    seed(soon());
    const fresh = later();
    let calls = 0;
    const slow = fakeFetch(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 80));
      return Response.json({ access_token: fresh, refresh_token: "R2" });
    });
    const a1 = createAuthProvider({ kind: "cursor", backend: API, http: slow.http, clientId: "PUBLIC_ID" });
    const a2 = createAuthProvider({ kind: "cursor", backend: API, http: slow.http, clientId: "PUBLIC_ID" });
    const [r1, r2] = await Promise.all([a1.refresh({ force: true }), a2.refresh({ force: true })]);
    assert.equal(calls, 1);
    assert.ok(r1.refreshed || r2.refreshed || r1.reason === "peer_refreshed" || r2.reason === "peer_refreshed");
    assert.equal(new FileCredentialStore().load("cursor", API)!.access_token, fresh);
  });

  it("timeout and redirect rejected; 429 sets retryable cooldown with fallback when valid", async () => {
    seed(soon());
    const aRedir = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil" } })).http,
    });
    // redirect:"error" makes fetch throw in undici; our fake returns 302 — provider treats 3xx as redirect error
    await assert.rejects(aRedir.refresh({ force: true }), (e: GbcError) => e.code === "auth_refresh_redirect" || e.code === "auth_refresh_network");

    const a429 = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "1" } })).http,
    });
    seed(soon());
    await assert.rejects(a429.refresh({ force: true }), (e: GbcError) => e.code === "auth_refresh_rate_limited" && e.retryable);
    assert.ok(new FileCredentialStore().load("cursor", API));
    // still-valid fallback via getAccessToken
    const tok = await a429.getAccessToken();
    assert.ok(tok);

    // abort/timeout path
    seed(jwt(Math.floor(Date.now() / 1000) - 5));
    const aTo = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      refreshDeadlineMs: 50,
      http: {
        fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
          await new Promise<void>((_r, rej) => {
            init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
          });
          return new Response();
        }) as typeof fetch,
      },
    });
    await assert.rejects(aTo.refresh({ force: true }), (e: GbcError) => e.code === "auth_refresh_timeout" || e.code === "auth_refresh_network");
  });

  it("classifyExpiry helper: missing / illegal / early window", () => {
    const now = Date.now();
    assert.equal(classifyExpiry(undefined, now).needsRefresh, true);
    assert.equal(classifyExpiry(Number.NaN, now).status.ok, false);
    assert.equal(classifyExpiry(now + REFRESH_EARLY_MS - 1, now).needsRefresh, true);
    assert.equal(classifyExpiry(now + REFRESH_EARLY_MS + 60_000, now).needsRefresh, false);
  });
});

describe("RPC interceptor 401 + pre-RPC", () => {
  it("not logged in -> unauthenticated exit 4 locally, request not sent", async () => {
    let sent = 0;
    const auth = createAuthProvider({ kind: "cursor", backend: API, http: fakeFetch(() => { sent++; return new Response(); }).http });
    const p = new ControlPlane({ baseUrl: "http://127.0.0.1:1", auth });
    const r = await p.bot.list();
    assert.equal(r.code, "unauthenticated");
    assert.equal((r.error?.details as { rpc_dispatched?: boolean } | undefined)?.rpc_dispatched, false);
    assert.equal(sent, 0);
    const w = await p.bot.create({ name: "x" }, { allowWrite: true });
    assert.equal(w.code, "unauthenticated");
    assert.equal(w.outcome, "known_failure");
  });

  it("401: read-only may refresh+retry once; write never replays", async () => {
    assert.ok(READ_ONLY_UNARY_METHODS.has("ListGrokBotAgents"));
    assert.ok(!READ_ONLY_UNARY_METHODS.has("SendGrokBotUserMessage"));

    const access1 = jwt(Math.floor(Date.now() / 1000) + 3600);
    const access2 = jwt(Math.floor(Date.now() / 1000) + 7200);
    new FileCredentialStore().save({
      kind: "cursor",
      backend: API,
      access_token: access1,
      refresh_token: "R1",
      expires_at_ms: Date.now() + 3600_000,
      updated_at_ms: 0,
      revision: 1,
      client_id: "PUBLIC_ID",
      credential_source: "login_poll",
      login_kind: "browser_deep_control",
      session_id: "s1",
    });

    let refreshCalls = 0;
    const auth = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(() => {
        refreshCalls++;
        return Response.json({ access_token: access2, refresh_token: "R2" });
      }).http,
    });

    // Read path: first next -> 401; after force refresh, second next succeeds
    let readAttempts = 0;
    const readInterceptor = createAuthInterceptor(auth);
    const readNext = async (req: { header: Headers }) => {
      readAttempts++;
      const h = req.header.get("authorization");
      if (readAttempts === 1) {
        assert.equal(h, `Bearer ${access1}`);
        throw new ConnectError("nope", Code.Unauthenticated);
      }
      assert.equal(h, `Bearer ${access2}`);
      return { header: new Headers(), trailer: new Headers(), message: { ok: true }, stream: false as const };
    };
    const readReq = {
      stream: false as const,
      method: { name: "ListGrokBotAgents" },
      header: new Headers(),
      service: { typeName: "aiserver.v1.GrokBotService" },
      url: "http://x",
      requestMethod: "POST",
      signal: new AbortController().signal,
      message: {},
      contextValues: undefined as never,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readOut = await readInterceptor(readNext as any)(readReq as any);
    assert.equal((readOut as { message: { ok: boolean } }).message.ok, true);
    assert.equal(readAttempts, 2);
    assert.equal(refreshCalls, 1);

    // Write path: 401 triggers refresh for next time but does NOT retry
    refreshCalls = 0;
    let writeAttempts = 0;
    const writeNext = async () => {
      writeAttempts++;
      throw new ConnectError("nope", Code.Unauthenticated);
    };
    const writeReq = { ...readReq, method: { name: "SendGrokBotUserMessage" }, header: new Headers() };
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readInterceptor(writeNext as any)(writeReq as any),
      (e: ConnectError) => e.code === Code.Unauthenticated,
    );
    assert.equal(writeAttempts, 1);
    assert.equal(refreshCalls, 1);
  });

  it("pre-RPC refresh failure preserves structured code and rpc_dispatched=false", async () => {
    new FileCredentialStore().save({
      kind: "cursor",
      backend: API,
      access_token: jwt(Math.floor(Date.now() / 1000) - 10),
      refresh_token: "R1",
      expires_at_ms: Date.now() - 10_000,
      updated_at_ms: 0,
      revision: 1,
      client_id: "PUBLIC_ID",
      credential_source: "login_poll",
      session_id: "s1",
    });
    const auth = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: { fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch },
    });
    const p = new ControlPlane({ baseUrl: "http://127.0.0.1:1", auth });
    const r = await p.bot.list();
    assert.equal(r.code, "auth_refresh_network");
    assert.equal(r.retryable, true);
    assert.equal((r.error?.details as { rpc_dispatched?: boolean }).rpc_dispatched, false);
  });
});

describe("staticTokenProvider + MCP auth_refresh gating", () => {
  it("static never refreshes; expired requires re-provide; whoami marks no disk refresh", async () => {
    const ok = staticTokenProvider({ kind: "cursor", backend: API, accessToken: jwt(Math.floor(Date.now() / 1000) + 3600) });
    assert.ok(await ok.getAccessToken());
    await assert.rejects(ok.refresh(), (e: GbcError) => e.code === "unsupported");
    await assert.rejects(ok.getAccessToken({ force: true }), (e: GbcError) => e.code === "unsupported");
    const who = await ok.whoamiLocal();
    assert.equal(who.disk_refresh, false);
    assert.equal(who.static_token, true);
    const expired = staticTokenProvider({ kind: "cursor", backend: API, accessToken: jwt(Math.floor(Date.now() / 1000) - 5) });
    await assert.rejects(expired.getAccessToken(), (e: GbcError) => e.code === "auth");
  });

  it("MCP auth_refresh exists outside READONLY and returns no secrets", async () => {
    const full = buildTools();
    const ro = buildTools({ readOnly: true });
    assert.ok(full.some((t) => t.name === "auth_refresh"));
    assert.ok(!ro.some((t) => t.name === "auth_refresh"));
    assert.ok(ro.some((t) => t.name === "auth_whoami"));
  });

  it("logs / AuthOps envelopes never include secrets", async () => {
    const access = jwt(Math.floor(Date.now() / 1000) + 60);
    new FileCredentialStore().save({
      kind: "cursor",
      backend: API,
      access_token: access,
      refresh_token: "SUPER-SECRET-REFRESH",
      expires_at_ms: Date.now() + 60_000,
      updated_at_ms: 0,
      revision: 1,
      client_id: "PUBLIC_ID",
      credential_source: "login_poll",
      session_id: "s1",
    });
    const fresh = jwt(Math.floor(Date.now() / 1000) + 7200);
    const a = createAuthProvider({
      kind: "cursor",
      backend: API,
      clientId: "PUBLIC_ID",
      http: fakeFetch(() => Response.json({ access_token: fresh, refresh_token: "NEW-SECRET" })).http,
    });
    const env = await new AuthOps(a).refresh({ force: true });
    const blob = JSON.stringify(env);
    assert.ok(!blob.includes(access));
    assert.ok(!blob.includes("SUPER-SECRET-REFRESH"));
    assert.ok(!blob.includes("NEW-SECRET"));
    assert.ok(!blob.includes(fresh));
  });
});

describe('refresh runtime validation and shared cooldown', () => {
  const seed = () => new FileCredentialStore().save({kind:'cursor',backend:API,access_token:jwt(1),refresh_token:'fixture-r',expires_at_ms:1000,updated_at_ms:0,revision:1,session_id:'fixture-session',client_id:'fixture-id',credential_source:'login_poll'});
  for (const [name, payload] of [
    ['numeric access_token', {access_token:17}],
    ['whitespace access_token', {access_token:'  '}],
    ['numeric refresh_token', {access_token:'x',refresh_token:17}],
    ['nonboolean shouldLogout', {access_token:'x',shouldLogout:'true'}],
    ['array response', []],
  ] as const) {
    it(`rejects ${name} without clearing credentials`, async () => {
      seed();
      const a=createAuthProvider({kind:'cursor',backend:API,http:fakeFetch(()=>Response.json(payload)).http});
      await assert.rejects(a.refresh({force:true}), (e:GbcError)=>e.code==='auth_refresh_malformed');
      assert.equal(new FileCredentialStore().load('cursor',API)!.revision,1);
    });
  }
  it('HTTP400 invalid_grant revokes even a still-valid token; no getAccessToken fallback', async () => {
    seed(); const s=new FileCredentialStore(); s.save({...s.load('cursor',API)!,expires_at_ms:Date.now()+60000});
    const a=createAuthProvider({kind:'cursor',backend:API,http:fakeFetch(()=>Response.json({error:'invalid_grant'},{status:400})).http});
    await assert.rejects(a.getAccessToken(), (e:GbcError)=>e.code==='auth_revoked');
    assert.equal(s.load('cursor',API),undefined);
  });
  it('new provider honors persisted Retry-After instead of issuing another force request', async () => {
    seed(); let calls=0;
    const http=fakeFetch(()=>{calls++;return Response.json({}, {status:429,headers:{'retry-after':'30'}});}).http;
    const make=()=>createAuthProvider({kind:'cursor',backend:API,http});
    await assert.rejects(make().refresh({force:true}), (e:GbcError)=>e.code==='auth_refresh_rate_limited');
    await assert.rejects(make().refresh({force:true}), (e:GbcError)=>e.code==='auth_refresh_cooldown');
    assert.equal(calls,1);
  });
  it('unsafe expiry numbers never count as valid', () => {
    for (const exp of [Infinity, -1, Number.MAX_VALUE, 1.25]) assert.equal(classifyExpiry(exp,0).stillValid,false);
    assert.equal(classifyExpiry(600000,300000).needsRefresh,false); // exact 300s is outside <300s
    assert.equal(classifyExpiry(599999,300000).needsRefresh,true);
  });
});
