/**
 * Auth flow tests with injected fake fetch. The asserted URLs/params mirror STATIC
 * reverse engineering of Grok Bot Linux 0.79.2 (see src/auth/provider.ts header) —
 * not official docs, and passing here is not proof the live service accepts them.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuthProvider, generateLoginChallenge } from "../src/auth/provider.js";
import { FileCredentialStore, redactCredential } from "../src/auth/store.js";
import { AuthOps } from "../src/ops/auth.js";
import { ControlPlane } from "../src/ops/plane.js";
import { GbcError } from "../src/errors.js";
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
    // Process A begins; process B (fresh instance, only shared files) completes.
    await createAuthProvider({ kind: "cursor", backend: API }).beginLogin();
    const verifier = new FileCredentialStore().loadPending("cursor", API)!.verifier;
    const b = createAuthProvider({ kind: "cursor", backend: API, http: f.http, sleep: noSleep });
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
    assert.equal(c.expires_at_ms! > Date.now(), true);
    assert.equal(redactCredential(c).access_token, "[redacted]");
    const who = await b.whoamiLocal();
    assert.equal(who.has_token, true);
    assert.equal(who.account_label, "t@example.com");
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
  function seed(access: string, refresh = "R1") {
    new FileCredentialStore().save({
      kind: "cursor",
      backend: API,
      access_token: access,
      refresh_token: refresh,
      expires_at_ms: (JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString()).exp as number) * 1000,
      updated_at_ms: 0,
    });
  }
  const soon = () => jwt(Math.floor(Date.now() / 1000) + 60);
  const later = () => jwt(Math.floor(Date.now() / 1000) + 7200);

  it("POST /oauth/token {client_id, grant_type, refresh_token}; rotation saved; old refresh kept if absent", async () => {
    seed(soon());
    const fresh = later();
    const f = fakeFetch(async (u, init) => {
      assert.equal(u.toString(), `${API}/oauth/token`);
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["content-type"], "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), { client_id: "PUBLIC_ID", grant_type: "refresh_token", refresh_token: "R1" });
      return Response.json({ access_token: fresh });
    });
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http, clientId: "PUBLIC_ID" });
    assert.equal(await a.getAccessToken(), fresh);
    const c = new FileCredentialStore().load("cursor", API)!;
    assert.equal(c.refresh_token, "R1");
    assert.equal(mode(new FileCredentialStore().credFile("cursor", API)), 0o600);
  });

  it("no client_id configured -> auth_refresh_unconfigured, creds kept, no network", async () => {
    seed(soon());
    const f = fakeFetch(() => Response.json({}));
    const a = createAuthProvider({ kind: "cursor", backend: API, http: f.http });
    await assert.rejects(a.refresh(), (e: GbcError) => e.code === "auth_refresh_unconfigured");
    assert.equal(f.calls.length, 0);
    assert.ok(new FileCredentialStore().load("cursor", API));
    // Not yet expired: getAccessToken still returns the current token.
    assert.ok(await a.getAccessToken());
  });

  it("HTTP 401 / network error keep creds; shouldLogout clears; expired + failure throws", async () => {
    seed(soon());
    const a401 = createAuthProvider({ kind: "cursor", backend: API, clientId: "c", http: fakeFetch(() => new Response("", { status: 401 })).http });
    await assert.rejects(a401.refresh(), (e: GbcError) => e.code === "auth_refresh_failed");
    assert.ok(new FileCredentialStore().load("cursor", API));
    const aNet = createAuthProvider({ kind: "cursor", backend: API, clientId: "c", http: { fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch } });
    await assert.rejects(aNet.refresh(), (e: GbcError) => e.code === "auth_refresh_network" && e.retryable);
    assert.ok(new FileCredentialStore().load("cursor", API));
    seed(jwt(Math.floor(Date.now() / 1000) - 10));
    await assert.rejects(a401.getAccessToken(), (e: GbcError) => e.code === "auth_refresh_failed");
    const aOut = createAuthProvider({ kind: "cursor", backend: API, clientId: "c", http: fakeFetch(() => Response.json({ shouldLogout: true })).http });
    await assert.rejects(aOut.refresh(), (e: GbcError) => e.code === "auth_revoked");
    assert.equal(new FileCredentialStore().load("cursor", API), undefined);
  });

  it("concurrent refresh across instances is single-flight (one network call)", async () => {
    seed(soon());
    let calls = 0;
    const fresh = later();
    const mk = () =>
      createAuthProvider({
        kind: "cursor",
        backend: API,
        clientId: "c",
        http: fakeFetch(async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 50));
          return Response.json({ access_token: fresh, refresh_token: "R2" });
        }).http,
      });
    const [x, y] = await Promise.all([mk().refresh(), mk().refresh()]);
    assert.equal(calls, 1);
    assert.equal(x.access_token, fresh);
    assert.equal(y.access_token, fresh);
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
});

describe("RPC interceptor", () => {
  it("not logged in -> unauthenticated exit 4 locally, request not sent", async () => {
    let sent = 0;
    const auth = createAuthProvider({ kind: "cursor", backend: API, http: fakeFetch(() => { sent++; return new Response(); }).http });
    const p = new ControlPlane({ baseUrl: "http://127.0.0.1:1", auth });
    const r = await p.bot.list();
    assert.equal(r.code, "unauthenticated");
    assert.equal(sent, 0);
    const w = await p.bot.create({ name: "x" }, { allowWrite: true });
    assert.equal(w.code, "unauthenticated");
    assert.equal(w.outcome, "known_failure");
  });
});
