import crypto from "node:crypto";
import { GbcError } from "../errors.js";
import { FileCredentialStore, withRefreshLock } from "./store.js";
import type {
  AuthBeginResult,
  AuthCompleteResult,
  AuthKind,
  AuthProvider,
  PendingLogin,
  StoredCredential,
} from "./types.js";

/**
 * Independent Cursor browser login (product-custom challenge + poll; NOT RFC 8628).
 *
 * Protocol source: STATIC reverse engineering of Grok Bot Linux 0.79.2
 * (/workspace/grokbot-linux-auth-analysis.md; evidence/main-app.pretty.cjs = A,
 * main-core.pretty.cjs = C). Not official public API documentation.
 *  - A:38644-38657 Rdn: verifier = base64url(32 random bytes); challenge =
 *    base64url(SHA256(verifier string)); uuid = randomUUID();
 *    `${website}/loginDeepControl?challenge&uuid&mode=login&redirectTarget[&supportsSelectedTeamLogin=true]`
 *  - A:38720-38816 Aze/Odn: GET `${api}/auth/poll?uuid=..&verifier=..`; 404 = pending;
 *    max 150 tries, 1s * 1.2^i capped 10s; 3 consecutive non-404 failures stop;
 *    403 {error:"sign_in_policy_violation"} = policy denial.
 *  - A:38584-38593 Cdn: success body {accessToken, refreshToken}; A:38605-38622 mze:
 *    xAI identity body {xaiAccessToken,...} -> UNSUPPORTED here (different refresh path).
 *  - A:56108-56125: refresh POST new URL("/oauth/token", backend) JSON
 *    {client_id, grant_type:"refresh_token", refresh_token}; A:54459 response
 *    {access_token?, refresh_token?, shouldLogout?, error?}; refresh_token defaults to old.
 *  - C:35811 KLe: refresh 300s before JWT exp.
 * client_id: the App selects a public client identifier per backend (C:35866-35869).
 * This tool does NOT embed it; refresh requires explicit GBT_OAUTH_CLIENT_ID config.
 */

export const DEFAULT_BACKENDS = [
  "https://api2.cursor.sh",
  "https://api3.cursor.sh",
  "https://agentn.global.api5.cursor.sh",
];
export const DEFAULT_WEBSITE = "https://cursor.com";
export const POLICY_VIOLATION = "sign_in_policy_violation";
export const REFRESH_EARLY_MS = 300_000;
export const PENDING_TTL_MS = 15 * 60_000;
const POLL_BASE_MS = 1000;
const POLL_FACTOR = 1.2;
const POLL_CAP_MS = 10_000;
const POLL_MAX_TRIES = 150;
const POLL_MAX_CONSECUTIVE_ERRORS = 3;

export type AuthHttp = { fetch: typeof fetch };

export type AuthProviderOptions = {
  kind: AuthKind;
  backend: string;
  /** Browser login site. Default https://cursor.com; custom requires trust. */
  website?: string;
  http?: AuthHttp;
  store?: FileCredentialStore;
  trustCustomBackend?: boolean;
  /** Public OAuth client_id for refresh. Default: GBT_OAUTH_CLIENT_ID (no built-in value). */
  clientId?: string;
  /** redirectTarget login param. Default GBT_LOGIN_REDIRECT_TARGET || "cli" (library default, A:38644 / A:38845; App uses "sand", A:49834). */
  redirectTarget?: string;
  /** Test hooks. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generateLoginChallenge(): { verifier: string; challenge: string; uuid: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, uuid: crypto.randomUUID() };
}

export function buildLoginUrl(website: string, p: { challenge: string; uuid: string; redirectTarget: string }): string {
  const u = new URL("/loginDeepControl", website);
  u.searchParams.set("challenge", p.challenge);
  u.searchParams.set("uuid", p.uuid);
  u.searchParams.set("mode", "login");
  u.searchParams.set("redirectTarget", p.redirectTarget);
  return u.toString();
}

/** JWT payload (unverified decode — only for exp/email display; never trust for auth). */
export function decodeJwtPayload(token: string): { exp?: number; email?: string; sub?: string } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const obj = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof obj === "object" && obj ? obj : null;
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function createAuthProvider(opts: AuthProviderOptions): AuthProvider {
  const backend = stripSlash(opts.backend);
  const trusted = Boolean(opts.trustCustomBackend) || process.env.GBT_TRUST_BACKEND === "1";
  if (!DEFAULT_BACKENDS.includes(backend) && !trusted) {
    throw new GbcError(
      "denied",
      `backend ${backend} is not in the default allowlist; pass trustCustomBackend / --trust-backend or GBT_TRUST_BACKEND=1 (exactly "1")`,
      { exitCode: 7, hint: "Prevents sending tokens to an untrusted host (RFC9700-style binding)." },
    );
  }
  const website = stripSlash(opts.website ?? process.env.GBT_WEBSITE_URL ?? DEFAULT_WEBSITE);
  if (website !== DEFAULT_WEBSITE && !trusted) {
    throw new GbcError("denied", `login website ${website} is not ${DEFAULT_WEBSITE}; requires trust (GBT_TRUST_BACKEND=1)`, {
      exitCode: 7,
    });
  }
  const kind = opts.kind;
  const store = opts.store ?? new FileCredentialStore();
  const http = opts.http ?? { fetch: globalThis.fetch.bind(globalThis) };
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const redirectTarget = opts.redirectTarget ?? process.env.GBT_LOGIN_REDIRECT_TARGET ?? "cli";
  const clientId = () => opts.clientId ?? process.env.GBT_OAUTH_CLIENT_ID?.trim() ?? "";

  const requireCursor = (what: string) => {
    if (kind !== "cursor") {
      throw new GbcError("unsupported", `${what}: auth kind "${kind}" is not supported (xAI identity uses a different issuer/refresh path)`, {
        exitCode: 9,
        hint: "Use --auth-kind cursor.",
      });
    }
  };

  /** Never let the verifier leak through an error message. */
  const scrub = (msg: string, secrets: string[]) =>
    secrets.reduce((m, s) => (s ? m.split(s).join("[redacted]") : m), msg);

  function credFromTokens(access: string, refresh: string | undefined, prev?: StoredCredential): StoredCredential {
    const jwt = decodeJwtPayload(access);
    return {
      kind,
      backend,
      access_token: access,
      refresh_token: refresh ?? prev?.refresh_token,
      expires_at_ms: jwt?.exp ? jwt.exp * 1000 : undefined,
      account_label: jwt?.email ?? prev?.account_label,
      updated_at_ms: now(),
    };
  }

  function loadPendingOrThrow(): PendingLogin {
    const p = store.loadPending(kind, backend);
    if (!p) {
      throw new GbcError("auth", "no pending login; run `gbc auth login-begin` first", { exitCode: 4 });
    }
    if (p.expires_at_ms <= now()) {
      store.clearPending(kind, backend);
      throw new GbcError("auth_login_expired", "pending login expired; run `gbc auth login-begin` again", { exitCode: 4 });
    }
    return p;
  }

  type PollStep = { done: true; result: AuthCompleteResult } | { done: false; transient: boolean; status?: number };

  async function pollOnceRaw(p: PendingLogin, signal?: AbortSignal): Promise<PollStep> {
    const url = `${backend}/auth/poll?uuid=${encodeURIComponent(p.uuid)}&verifier=${encodeURIComponent(p.verifier)}`;
    let res: Response;
    try {
      res = await http.fetch(url, { method: "GET", headers: { "Content-Type": "application/json" }, signal });
    } catch {
      return { done: false, transient: true };
    }
    if (res.status === 404) return { done: false, transient: false, status: 404 };
    if (res.status === 403) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
      if (body?.error === POLICY_VIOLATION) {
        store.clearPending(kind, backend);
        throw new GbcError("denied", "sign-in blocked by organization policy (sign_in_policy_violation)", { exitCode: 7 });
      }
      return { done: false, transient: true, status: 403 };
    }
    if (!res.ok) return { done: false, transient: true, status: res.status };
    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (body && typeof body.xaiAccessToken === "string") {
      store.clearPending(kind, backend);
      throw new GbcError("unsupported", "login returned an xAI identity session; this tool only supports Cursor tokens", {
        exitCode: 9,
        hint: "xAI identity refresh (auth.grok.* /oauth2/token) is not implemented.",
      });
    }
    const access = body?.accessToken;
    const refresh = body?.refreshToken;
    if (typeof access !== "string" || access.length === 0 || (refresh !== undefined && typeof refresh !== "string")) {
      return { done: false, transient: true, status: 200 };
    }
    const cred = credFromTokens(access, refresh as string | undefined);
    store.save(cred);
    store.clearPending(kind, backend);
    return {
      done: true,
      result: { status: "completed", kind, backend, account_label: cred.account_label, expires_at_ms: cred.expires_at_ms },
    };
  }

  async function doRefresh(): Promise<StoredCredential> {
    requireCursor("refresh");
    return withRefreshLock(`${kind}|${backend}`, async () => {
      const cur = store.load(kind, backend);
      if (!cur) throw new GbcError("auth", "not logged in", { exitCode: 4 });
      // Another process may have refreshed while we waited for the lock.
      if (cur.expires_at_ms && cur.expires_at_ms - now() > REFRESH_EARLY_MS) return cur;
      if (!cur.refresh_token) throw new GbcError("auth", "no refresh_token stored; log in again", { exitCode: 4 });
      const cid = clientId();
      if (!cid) {
        throw new GbcError("auth_refresh_unconfigured", "token refresh needs a public OAuth client_id (GBT_OAUTH_CLIENT_ID); none configured", {
          exitCode: 4,
          hint: "Set GBT_OAUTH_CLIENT_ID, or run `gbc auth login` again. Credentials were kept.",
        });
      }
      let res: Response;
      try {
        res = await http.fetch(new URL("/oauth/token", backend + "/").toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: cid, grant_type: "refresh_token", refresh_token: cur.refresh_token }),
        });
      } catch {
        throw new GbcError("auth_refresh_network", "token refresh network error; credentials kept", { exitCode: 8, retryable: true });
      }
      if (!res.ok) {
        throw new GbcError("auth_refresh_failed", `token refresh failed HTTP ${res.status}; credentials kept`, {
          exitCode: res.status >= 500 ? 8 : 4,
          retryable: res.status >= 500,
        });
      }
      const body = (await res.json().catch(() => undefined)) as
        | { access_token?: string; refresh_token?: string; shouldLogout?: boolean; error?: string }
        | undefined;
      if (!body) throw new GbcError("auth_refresh_failed", "token refresh returned a bad payload; credentials kept", { exitCode: 4 });
      if (body.shouldLogout === true) {
        store.clear(kind, backend);
        if (body.error === POLICY_VIOLATION) {
          throw new GbcError("denied", "session revoked by organization policy; local credential removed", { exitCode: 7 });
        }
        throw new GbcError("auth_revoked", "server requested logout; local credential removed. Log in again.", { exitCode: 4 });
      }
      if (!body.access_token) {
        throw new GbcError("auth_refresh_failed", "token refresh response had no access_token; credentials kept", { exitCode: 4 });
      }
      const next = credFromTokens(body.access_token, body.refresh_token ?? cur.refresh_token, cur);
      store.save(next);
      return next;
    });
  }

  return {
    kind,
    backend,
    async getAccessToken() {
      const c = store.load(kind, backend);
      if (!c) return undefined;
      if (c.expires_at_ms && c.expires_at_ms - now() < REFRESH_EARLY_MS) {
        try {
          return (await doRefresh()).access_token;
        } catch (e) {
          // Still valid (inside the early window): keep using it. Expired: surface the error.
          if (c.expires_at_ms > now()) return c.access_token;
          throw e;
        }
      }
      return c.access_token;
    },
    async beginLogin(): Promise<AuthBeginResult> {
      requireCursor("login");
      const { verifier, challenge, uuid } = generateLoginChallenge();
      const created = now();
      const pending: PendingLogin = {
        v: 1,
        kind,
        backend,
        website,
        uuid,
        verifier,
        redirect_target: redirectTarget,
        created_at_ms: created,
        expires_at_ms: created + PENDING_TTL_MS,
      };
      store.savePending(pending);
      return {
        authorization_url: buildLoginUrl(website, { challenge, uuid, redirectTarget }),
        uuid,
        expires_at_ms: pending.expires_at_ms,
        note: "Open the URL in a browser and sign in, then run `gbc auth complete`. The verifier is stored only in a 0600 pending file and is never printed.",
      };
    },
    async pollLogin(): Promise<AuthCompleteResult> {
      requireCursor("poll");
      const p = loadPendingOrThrow();
      const step = await pollOnceRaw(p);
      if (step.done) return step.result;
      if (step.transient) {
        throw new GbcError("auth_poll_failed", `login poll failed${step.status ? ` HTTP ${step.status}` : " (network)"}`, {
          exitCode: 8,
          retryable: true,
        });
      }
      return { status: "pending", expires_at_ms: p.expires_at_ms, note: "Not signed in yet (404 pending)." };
    },
    async completeLogin(o) {
      requireCursor("complete");
      const p = loadPendingOrThrow();
      const deadline = Math.min(p.expires_at_ms, now() + (o?.timeoutMs ?? 300_000));
      let errors = 0;
      for (let i = 0; i < POLL_MAX_TRIES; i++) {
        if (o?.signal?.aborted) throw new GbcError("canceled", "login polling canceled (pending login kept)", { exitCode: 10, outcome: "unknown" });
        let step: PollStep;
        try {
          step = await pollOnceRaw(p, o?.signal);
        } catch (e) {
          if (e instanceof GbcError) throw e;
          throw new GbcError("auth_poll_failed", scrub(String(e), [p.verifier]), { exitCode: 8, retryable: true });
        }
        if (step.done) return step.result;
        if (step.transient) {
          errors++;
          if (errors >= POLL_MAX_CONSECUTIVE_ERRORS) {
            throw new GbcError("auth_poll_failed", `login poll failed ${errors} times in a row${step.status ? ` (last HTTP ${step.status})` : ""}; pending login kept`, {
              exitCode: 8,
              retryable: true,
            });
          }
        } else errors = 0;
        const wait = Math.min(POLL_BASE_MS * POLL_FACTOR ** i, POLL_CAP_MS);
        if (now() + wait > deadline) break;
        await sleep(wait, o?.signal);
      }
      if (p.expires_at_ms <= now()) store.clearPending(kind, backend);
      return { status: "pending", expires_at_ms: p.expires_at_ms, note: "Timed out waiting for browser sign-in; run `gbc auth complete` again." };
    },
    async cancelLogin() {
      return { had_pending: store.clearPending(kind, backend) };
    },
    refresh: doRefresh,
    async logout() {
      return {
        removed_credential: store.clear(kind, backend),
        removed_pending: store.clearPending(kind, backend),
      };
    },
    async whoamiLocal() {
      const c = store.load(kind, backend);
      let pending = false;
      try {
        const p = store.loadPending(kind, backend);
        pending = Boolean(p && p.expires_at_ms > now());
      } catch {
        pending = false;
      }
      return {
        kind,
        backend,
        account_label: c?.account_label,
        has_token: Boolean(c?.access_token),
        expires_at_ms: c?.expires_at_ms,
        refresh_configured: Boolean(clientId()),
        pending_login: pending,
      };
    },
  };
}

/** Injected token provider for tests / mock — never logs the token. */
export function staticTokenProvider(opts: { kind: AuthKind; backend: string; accessToken: string }): AuthProvider {
  const unsupported = async (): Promise<never> => {
    throw new GbcError("unsupported", "static/mock token provider has no login flow", { exitCode: 9 });
  };
  return {
    kind: opts.kind,
    backend: opts.backend,
    async getAccessToken() {
      return opts.accessToken;
    },
    beginLogin: unsupported,
    pollLogin: unsupported,
    completeLogin: unsupported,
    async cancelLogin() {
      return { had_pending: false };
    },
    refresh: unsupported,
    async logout() {
      return { removed_credential: false, removed_pending: false };
    },
    async whoamiLocal() {
      return {
        kind: opts.kind,
        backend: opts.backend,
        has_token: true,
        account_label: "static",
        refresh_configured: false,
        pending_login: false,
      };
    },
  };
}
