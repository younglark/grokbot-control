import crypto from "node:crypto";
import { GbcError } from "../errors.js";
import { FileCredentialStore, withCredentialLock } from "./store.js";
import type {
  AuthBeginResult,
  AuthCompleteResult,
  AuthKind,
  AuthProvider,
  CredentialSource,
  LoginKind,
  LoginMode,
  PendingLogin,
  RefreshReason,
  RefreshResult,
  StoredCredential,
  WhoamiLocal,
} from "./types.js";
import { LOGIN_MODES } from "./types.js";

/**
 * Independent Cursor browser login (product-custom challenge + poll; NOT RFC 8628).
 *
 * Protocol source: STATIC reverse engineering of Grok Bot Linux 0.79.2 / 0.79.3
 * (/workspace/grokbot-linux-auth-analysis.md; evidence/main-app.pretty.cjs = A,
 * main-core.pretty.cjs = C). Not official public API documentation.
 *  - A:38644-38657 Rdn: verifier = base64url(32 random bytes); challenge =
 *    base64url(SHA256(verifier string)); uuid = randomUUID();
 *    `${website}/loginDeepControl?challenge&uuid&mode=login&redirectTarget[&supportsSelectedTeamLogin=true]`
 *    Library default redirectTarget is `cli` (A:38845; live-verified 2026-11-07). App uses `sand`
 *    (A:49834). Optional loginMode=bot applies the App URL shape (sand + supportsSelectedTeamLogin=true).
 *    Default remains cli and omits the team-login param. Team selection callback, team binding, and
 *    whether x-cursor-team-id is required are NOT live-verified; this tool never invents a team id
 *    or forges App / team headers.
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
 * This tool does NOT embed it; refresh requires explicit GBT_OAUTH_CLIENT_ID config
 * or a client_id persisted at login / confirmed migration.
 */

export const DEFAULT_BACKENDS = [
  "https://api2.cursor.sh",
  "https://api3.cursor.sh",
  "https://agentn.global.api5.cursor.sh",
];
export const DEFAULT_WEBSITE = "https://cursor.com";
export const POLICY_VIOLATION = "sign_in_policy_violation";
export const REFRESH_EARLY_MS = 300_000;
export const REFRESH_DEADLINE_MS = 20_000;
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
  /** Login URL preset: `cli` (default) or `bot` (App-style). Default GBT_LOGIN_MODE || "cli". */
  loginMode?: LoginMode;
  /** redirectTarget login param. Default: GBT_LOGIN_REDIRECT_TARGET, else the selected loginMode preset (cli→cli, bot→sand). */
  redirectTarget?: string;
  /** Test hooks. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Override refresh HTTP deadline (default 20s). */
  refreshDeadlineMs?: number;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function generateLoginChallenge(): { verifier: string; challenge: string; uuid: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, uuid: crypto.randomUUID() };
}

export const LOGIN_MODE_PRESETS: Record<LoginMode, { redirectTarget: string; supportsSelectedTeamLogin: boolean }> = {
  cli: { redirectTarget: "cli", supportsSelectedTeamLogin: false },
  bot: { redirectTarget: "sand", supportsSelectedTeamLogin: true },
};

const REDIRECT_TARGET_RE = /^[A-Za-z0-9._-]+$/;

/** Parse a login mode value. Empty / undefined is unset (caller applies default). */
export function parseLoginMode(raw: string | undefined): LoginMode | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if ((LOGIN_MODES as readonly string[]).includes(v)) return v as LoginMode;
  throw new GbcError("invalid_argument", `invalid login mode ${JSON.stringify(raw)}`, {
    exitCode: 2,
    hint: "Allowed values: cli (default, library redirectTarget=cli) or bot (App-style: redirectTarget=sand and supportsSelectedTeamLogin=true).",
  });
}

/** Parse a redirectTarget token. Empty / undefined is unset. */
export function parseRedirectTarget(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (!REDIRECT_TARGET_RE.test(v)) {
    throw new GbcError("invalid_argument", `invalid redirectTarget ${JSON.stringify(raw)}`, {
      exitCode: 2,
      hint: "redirectTarget must be a non-empty token of letters, digits, '.', '_' or '-'.",
    });
  }
  return v;
}

export type ResolvedLoginParams = {
  loginMode: LoginMode;
  redirectTarget: string;
  supportsSelectedTeamLogin: boolean;
};

/**
 * Resolve login URL params. Precedence: explicit args, then env (GBT_LOGIN_MODE /
 * GBT_LOGIN_REDIRECT_TARGET), then the selected mode's preset. An explicit redirect
 * target (arg or env) is kept across mode changes; a mode-default target is not.
 * supportsSelectedTeamLogin follows the selected mode only (cli omits it, bot sets true).
 */
export function resolveLoginParams(input: {
  loginMode?: string;
  redirectTarget?: string;
  explicitRedirectTarget?: string;
  env?: { GBT_LOGIN_MODE?: string; GBT_LOGIN_REDIRECT_TARGET?: string };
} = {}): ResolvedLoginParams {
  const env = input.env ?? process.env;
  const loginMode = parseLoginMode(input.loginMode) ?? parseLoginMode(env.GBT_LOGIN_MODE) ?? "cli";
  const redirectTarget =
    parseRedirectTarget(input.redirectTarget) ??
    parseRedirectTarget(input.explicitRedirectTarget) ??
    parseRedirectTarget(input.redirectTarget === undefined ? env.GBT_LOGIN_REDIRECT_TARGET : undefined) ??
    LOGIN_MODE_PRESETS[loginMode].redirectTarget;
  return {
    loginMode,
    redirectTarget,
    supportsSelectedTeamLogin: LOGIN_MODE_PRESETS[loginMode].supportsSelectedTeamLogin,
  };
}

export function buildLoginUrl(
  website: string,
  p: { challenge: string; uuid: string; redirectTarget: string; supportsSelectedTeamLogin?: boolean },
): string {
  const u = new URL("/loginDeepControl", website);
  u.searchParams.set("challenge", p.challenge);
  u.searchParams.set("uuid", p.uuid);
  u.searchParams.set("mode", "login");
  u.searchParams.set("redirectTarget", p.redirectTarget);
  if (p.supportsSelectedTeamLogin) u.searchParams.set("supportsSelectedTeamLogin", "true");
  return u.toString();
}

/** JWT payload (unverified decode — only for exp/email display; never trust for auth / client_id). */
export function decodeJwtPayload(token: string): { exp?: number; email?: string; sub?: string; iss?: string } | null {
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

export function refreshEndpointFor(backend: string): string {
  return new URL("/oauth/token", stripSlash(backend) + "/").toString();
}

export type ExpStatus = { ok: true; expires_at_ms: number } | { ok: false; reason: "missing_exp" | "illegal_exp" };

/** Classify stored / JWT exp. Never invents an expiry. */
export function classifyExpiry(expires_at_ms: number | undefined, nowMs: number): {
  status: ExpStatus;
  needsRefresh: boolean;
  stillValid: boolean;
} {
  if (expires_at_ms === undefined || expires_at_ms === null) {
    return { status: { ok: false, reason: "missing_exp" }, needsRefresh: true, stillValid: false };
  }
  if (!Number.isSafeInteger(expires_at_ms) || expires_at_ms <= 0) {
    return { status: { ok: false, reason: "illegal_exp" }, needsRefresh: true, stillValid: false };
  }
  const stillValid = expires_at_ms > nowMs;
  const needsRefresh = expires_at_ms - nowMs < REFRESH_EARLY_MS;
  return { status: { ok: true, expires_at_ms }, needsRefresh, stillValid };
}

function metaFromCred(c: StoredCredential, refreshed: boolean, reason: RefreshReason, note?: string): RefreshResult {
  return {
    refreshed,
    reason,
    kind: c.kind,
    backend: c.backend,
    expires_at_ms: c.expires_at_ms,
    revision: c.revision ?? 0,
    account_label: c.account_label,
    session_id: c.session_id,
    credential_source: c.credential_source,
    login_kind: c.login_kind,
    client_id_bound: Boolean(c.client_id),
    refresh_endpoint: c.refresh_endpoint,
    note,
  };
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
  const explicitRedirectTarget = parseRedirectTarget(opts.redirectTarget) ?? parseRedirectTarget(process.env.GBT_LOGIN_REDIRECT_TARGET);
  const defaultLogin = resolveLoginParams({
    loginMode: opts.loginMode,
    redirectTarget: opts.redirectTarget,
  });
  const refreshUrl = refreshEndpointFor(backend);
  const lockKey = `${kind}|${backend}`;
  const refreshDeadlineMs = Math.min(opts.refreshDeadlineMs ?? REFRESH_DEADLINE_MS, REFRESH_DEADLINE_MS);

  /** In-process singleflight for refresh/getAccessToken (full exchange, never aborted mid-flight). */
  let inflight: Promise<RefreshResult> | undefined;
  /** Soft cooldown after 429 / 5xx / network, keyed by session_id so a re-login is not blocked. */
  const cooldownBySession = new Map<string, number>();
  /**
   * After a caller-visible refresh timeout the IdP exchange may still complete (or may already
   * have rotated the refresh token). Remember the spent RT briefly so a follow-up invalid_grant
   * does not wipe credentials that a still-running exchange (or peer) is about to replace.
   */
  let ambiguousExchange: { session_id?: string; refresh_token: string; until_ms: number } | undefined;

  const sessionKey = (sessionId: string | undefined) => sessionId ?? "";
  const cooldownFor = (sessionId: string | undefined, diskMs?: number) =>
    Math.max(cooldownBySession.get(sessionKey(sessionId)) ?? 0, diskMs ?? 0);
  const setCooldown = (sessionId: string | undefined, until: number) => {
    cooldownBySession.set(sessionKey(sessionId), until);
  };
  const clearCooldown = (sessionId: string | undefined) => {
    cooldownBySession.delete(sessionKey(sessionId));
  };
  const markAmbiguous = (sessionId: string | undefined, refreshToken: string) => {
    ambiguousExchange = { session_id: sessionId, refresh_token: refreshToken, until_ms: now() + 120_000 };
  };
  const isAmbiguousProtect = (sessionId: string | undefined, refreshToken: string | undefined) =>
    Boolean(
      ambiguousExchange &&
        refreshToken &&
        ambiguousExchange.refresh_token === refreshToken &&
        ambiguousExchange.session_id === sessionId &&
        ambiguousExchange.until_ms > now(),
    );
  const clearAmbiguousIf = (sessionId: string | undefined, refreshToken: string | undefined) => {
    if (
      ambiguousExchange &&
      ambiguousExchange.refresh_token === refreshToken &&
      ambiguousExchange.session_id === sessionId
    ) {
      ambiguousExchange = undefined;
    }
  };

  const configuredClientId = () => opts.clientId ?? process.env.GBT_OAUTH_CLIENT_ID?.trim() ?? "";
  const migrateConfirmed = () => process.env.GBT_AUTH_CONFIRM_MIGRATE === "1";

  const requireCursor = (what: string) => {
    if (kind !== "cursor") {
      throw new GbcError("unsupported", `${what}: auth kind "${kind}" is not supported (xAI identity uses a different issuer/refresh path)`, {
        exitCode: 9,
        hint: "Use --auth-kind cursor. Do not mix xAI and Cursor credentials.",
      });
    }
  };

  /** Never let the verifier leak through an error message. */
  const scrub = (msg: string, secrets: string[]) =>
    secrets.reduce((m, s) => (s ? m.split(s).join("[redacted]") : m), msg);

  function resolveClientId(cur?: StoredCredential): { clientId: string; persist: boolean } {
    const fromCred = cur?.client_id?.trim() ?? "";
    const fromCfg = configuredClientId();
    if (fromCred) {
      if (fromCfg && fromCfg !== fromCred) {
        throw new GbcError(
          "auth_refresh_client_mismatch",
          "GBT_OAUTH_CLIENT_ID does not match the client_id bound on the stored credential",
          {
            exitCode: 4,
            hint: "Unset GBT_OAUTH_CLIENT_ID to use the bound id, or re-login / confirm migrate carefully. Credentials kept.",
            details: { rpc_dispatched: false, can_fallback: true },
          },
        );
      }
      return { clientId: fromCred, persist: false };
    }
    if (fromCfg) {
      // Explicit env/opts is configuration. Legacy files without provenance also accept
      // GBT_AUTH_CONFIRM_MIGRATE=1 as an explicit migrate confirmation (optional).
      if (!cur?.client_id && !cur?.credential_source && !migrateConfirmed()) {
        // Still allow: configuring GBT_OAUTH_CLIENT_ID alone is explicit enough.
      }
      return { clientId: fromCfg, persist: true };
    }
    throw new GbcError(
      "auth_refresh_unconfigured",
      "token refresh needs a public OAuth client_id (GBT_OAUTH_CLIENT_ID or login-persisted binding); none configured",
      {
        exitCode: 4,
        hint: "Set GBT_OAUTH_CLIENT_ID, re-login so client_id is persisted, or set GBT_AUTH_CONFIRM_MIGRATE=1 after configuring. Credentials were kept. client_id is never guessed from JWT.",
        details: { rpc_dispatched: false, can_fallback: true },
      },
    );
  }

  function credFromTokens(
    access: string,
    refresh: string | undefined,
    prev: StoredCredential | undefined,
    source: CredentialSource,
    loginKind: LoginKind,
    sessionId: string | undefined,
    clientId: string | undefined,
  ): StoredCredential {
    const jwt = decodeJwtPayload(access);
    let expires_at_ms: number | undefined;
    if (jwt && typeof jwt.exp === "number" && Number.isFinite(jwt.exp) && jwt.exp > 0) {
      if (Number.isSafeInteger(jwt.exp * 1000)) expires_at_ms = jwt.exp * 1000;
    }
    const nextRev = (prev?.revision ?? 0) + 1;
    return {
      kind,
      backend,
      access_token: access,
      refresh_token: refresh ?? prev?.refresh_token,
      expires_at_ms,
      account_label: (typeof jwt?.email === "string" ? jwt.email : undefined) ?? prev?.account_label,
      updated_at_ms: now(),
      revision: nextRev,
      login_kind: loginKind,
      credential_source: source,
      refresh_endpoint: refreshUrl,
      client_id: clientId || prev?.client_id,
      issuer: typeof jwt?.iss === "string" ? jwt.iss : prev?.issuer,
      account_subject: typeof jwt?.sub === "string" ? jwt.sub : prev?.account_subject,
      session_id: sessionId ?? prev?.session_id,
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
        hint: "xAI identity refresh (auth.grok.* /oauth2/token) is not implemented. Do not mix xAI/Cursor.",
      });
    }
    const access = body?.accessToken;
    const refresh = body?.refreshToken;
    if (typeof access !== "string" || access.length === 0 || (refresh !== undefined && typeof refresh !== "string")) {
      return { done: false, transient: true, status: 200 };
    }
    // Persist under credential lock so a concurrent refresh cannot overwrite a fresh login.
    const result = await withCredentialLock(lockKey, async () => {
      const prev = store.load(kind, backend);
      const cid = configuredClientId() || prev?.client_id;
      const session_id = crypto.randomUUID();
      const cred = credFromTokens(access, refresh as string | undefined, prev, "login_poll", "browser_deep_control", session_id, cid || undefined);
      store.save(cred);
      store.clearPending(kind, backend);
      return {
        done: true as const,
        result: {
          status: "completed" as const,
          kind,
          backend,
          account_label: cred.account_label,
          expires_at_ms: cred.expires_at_ms,
          revision: cred.revision,
          session_id: cred.session_id,
        },
      };
    });
    return result;
  }

  function refreshDecision(cur: StoredCredential, force: boolean): { needs: boolean; reason: RefreshReason } {
    if (force) return { needs: true, reason: "forced" };
    const exp = classifyExpiry(cur.expires_at_ms, now());
    if (!exp.status.ok) return { needs: true, reason: exp.status.reason };
    if (exp.needsRefresh) return { needs: true, reason: "near_expiry" };
    return { needs: false, reason: "already_fresh" };
  }

  async function doRefreshLocked(force: boolean, rejectedAccessToken?: string): Promise<RefreshResult> {
    requireCursor("refresh");

    type Snap = {
      cur: StoredCredential;
      decision: { needs: boolean; reason: RefreshReason };
      clientId: string;
      persist: boolean;
      expectedRevision: number;
      expectedSession: string | undefined;
      expectedSubject: string | undefined;
      refreshToken: string;
    };

    const snap = await withCredentialLock(lockKey, async (): Promise<Snap | RefreshResult> => {
      const cur = store.load(kind, backend);
      if (!cur) throw new GbcError("auth", "not logged in", { exitCode: 4 });

      // 401 recovery: if disk already rotated away from the rejected bearer, adopt it.
      if (force && rejectedAccessToken && cur.access_token && cur.access_token !== rejectedAccessToken) {
        return metaFromCred(cur, false, "peer_refreshed", "rejected access token already replaced on disk; adopting without force rotation");
      }

      const decision = refreshDecision(cur, force);
      if (!decision.needs) {
        return metaFromCred(cur, false, "already_fresh", "token still fresh enough; no refresh sent");
      }

      const cooldownUntil = cooldownFor(cur.session_id, cur.refresh_cooldown_until_ms);
      if (cooldownUntil > now()) {
        const exp = classifyExpiry(cur.expires_at_ms, now());
        if (exp.stillValid) {
          return metaFromCred(cur, false, decision.reason, "refresh cooldown active; returning still-valid token");
        }
        throw new GbcError("auth_refresh_cooldown", "token refresh in cooldown and access token is not valid", {
          exitCode: 8,
          retryable: true,
          details: { rpc_dispatched: false, cooldown_until_ms: cooldownUntil },
        });
      }

      if (!cur.refresh_token) {
        throw new GbcError("auth", "no refresh_token stored; log in again", { exitCode: 4, details: { rpc_dispatched: false } });
      }

      if (!cur.client_id && !cur.credential_source && !configuredClientId()) {
        throw new GbcError(
          "auth_refresh_unconfigured",
          "legacy credential has no client_id/provenance; set GBT_OAUTH_CLIENT_ID (and optionally GBT_AUTH_CONFIRM_MIGRATE=1)",
          {
            exitCode: 4,
            hint: "Credentials kept. client_id is never guessed from JWT.",
            details: { rpc_dispatched: false, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
          },
        );
      }
      if (!cur.client_id && !configuredClientId() && !migrateConfirmed()) {
        throw new GbcError(
          "auth_refresh_unconfigured",
          "credential has no bound client_id; configure GBT_OAUTH_CLIENT_ID or GBT_AUTH_CONFIRM_MIGRATE=1 after setting it",
          {
            exitCode: 4,
            details: { rpc_dispatched: false, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
          },
        );
      }

      const endpoint = new URL(refreshUrl);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
          (cur.refresh_endpoint && cur.refresh_endpoint !== refreshUrl)) {
        throw new GbcError("auth_refresh_unconfigured", "refresh endpoint binding must be trusted HTTPS and match stored provenance", {
          exitCode: 4,
          details: { rpc_dispatched: false, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
        });
      }
      const { clientId, persist } = resolveClientId(cur);
      return {
        cur,
        decision,
        clientId,
        persist,
        expectedRevision: cur.revision ?? 0,
        expectedSession: cur.session_id,
        expectedSubject: cur.account_subject,
        refreshToken: cur.refresh_token,
      };
    });

    if ("refreshed" in snap) return snap;

    const { cur, decision, clientId, persist, expectedRevision, expectedSession, expectedSubject, refreshToken } = snap;
    const saveCooldown = async (until: number) => {
      setCooldown(expectedSession, until);
      await withCredentialLock(lockKey, async () => {
        const current = store.load(kind, backend);
        if (current && current.session_id === expectedSession && (current.revision ?? 0) === expectedRevision) {
          store.save({ ...current, refresh_cooldown_until_ms: until });
        }
      });
    };

    // Do NOT abort the IdP exchange on the caller deadline — the server may already have
    // rotated the refresh token (Grok Build refresh_chain / BoundedRefresh semantics).
    let res: Response;
    try {
      res = await http.fetch(refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
        redirect: "error",
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      const until = now() + (aborted ? 5_000 : 10_000);
      await saveCooldown(until);
      const exp = classifyExpiry(cur.expires_at_ms, now());
      // Fetch was dispatched; a transport abort/reset after send is result-unknown, not "not sent".
      throw new GbcError(
        aborted ? "auth_refresh_timeout" : "auth_refresh_network",
        aborted
          ? "token refresh aborted after dispatch; credentials kept (outcome unknown)"
          : "token refresh network error; credentials kept",
        {
          exitCode: 8,
          retryable: true,
          outcome: "unknown",
          details: { rpc_dispatched: "unknown", can_fallback: exp.stillValid, revision: expectedRevision },
        },
      );
    }

    if (res.status >= 300 && res.status < 400) {
      throw new GbcError("auth_refresh_redirect", `token refresh refused redirect HTTP ${res.status}; credentials kept`, {
        exitCode: 4,
        details: { rpc_dispatched: true, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
      });
    }

    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      let wait = 30_000;
      if (ra) {
        const sec = Number(ra);
        if (Number.isFinite(sec) && sec >= 0) wait = Math.min(Math.floor(sec * 1000), 300_000);
        else {
          const when = Date.parse(ra);
          if (Number.isFinite(when)) wait = Math.min(Math.max(0, when - now()), 300_000);
        }
      }
      await saveCooldown(now() + wait);
      const exp = classifyExpiry(cur.expires_at_ms, now());
      throw new GbcError("auth_refresh_rate_limited", `token refresh rate-limited (429); credentials kept; retry after ${wait}ms`, {
        exitCode: 8,
        retryable: true,
        details: { rpc_dispatched: true, can_fallback: exp.stillValid, retry_after_ms: wait, revision: expectedRevision },
      });
    }

    // Body decode is part of the exchange; never abandon mid-read for the caller budget.
    const parsed: unknown = await res.json().catch(() => undefined);
    const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    const terminal = payload?.shouldLogout === true || payload?.error === POLICY_VIOLATION || payload?.error === "invalid_grant";
    if (!res.ok && !terminal) {
      if (res.status >= 500) {
        await saveCooldown(now() + 10_000);
        const exp = classifyExpiry(cur.expires_at_ms, now());
        throw new GbcError("auth_refresh_failed", `token refresh failed HTTP ${res.status}; credentials kept`, {
          exitCode: 8,
          retryable: true,
          details: { rpc_dispatched: true, can_fallback: exp.stillValid, revision: expectedRevision },
        });
      }
      throw new GbcError("auth_refresh_failed", `token refresh failed HTTP ${res.status}; credentials kept`, {
        exitCode: 4,
        details: { rpc_dispatched: true, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
      });
    }

    if (!payload || (payload.shouldLogout !== undefined && typeof payload.shouldLogout !== "boolean") ||
        (payload.error !== undefined && typeof payload.error !== "string")) {
      throw new GbcError("auth_refresh_malformed", "invalid refresh response schema; credentials kept", {
        exitCode: 4,
        details: { rpc_dispatched: true, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
      });
    }
    const body = payload;

    return withCredentialLock(lockKey, async () => {
      if (terminal) {
        const latest = store.load(kind, backend);
        if (latest && (latest.session_id !== expectedSession || latest.account_subject !== expectedSubject)) {
          throw new GbcError("auth_revoked", "terminal response belongs to an old session; new login preserved", { exitCode: 4, details: { revoked: true } });
        }
        if (
          latest &&
          latest.revision !== undefined &&
          latest.revision > expectedRevision &&
          latest.access_token &&
          latest.access_token !== cur.access_token
        ) {
          const peerExp = classifyExpiry(latest.expires_at_ms, now());
          if (peerExp.stillValid) {
            clearAmbiguousIf(expectedSession, refreshToken);
            return metaFromCred(latest, false, "peer_refreshed", "shouldLogout ignored; newer local pair rescued under lock");
          }
        }
        if (!latest || latest.session_id !== expectedSession || (latest.revision ?? 0) !== expectedRevision) {
          throw new GbcError("auth_revoked", "stale refresh cannot revoke changed session", { exitCode: 4, details: { revoked: true } });
        }
        // After a caller-visible timeout the IdP may already have rotated; a follow-up
        // invalid_grant must not wipe credentials while the ambiguous window is open.
        if (body!.error === "invalid_grant" && isAmbiguousProtect(expectedSession, refreshToken)) {
          throw new GbcError(
            "auth_refresh_timeout",
            "invalid_grant after ambiguous refresh timeout; credentials kept pending background/reconcile",
            {
              exitCode: 8,
              retryable: true,
              outcome: "unknown",
              details: { rpc_dispatched: "unknown", can_fallback: classifyExpiry(latest.expires_at_ms, now()).stillValid, revoked: false },
            },
          );
        }
        store.clear(kind, backend);
        clearAmbiguousIf(expectedSession, refreshToken);
        if (body!.error === POLICY_VIOLATION) {
          throw new GbcError("denied", "session revoked by organization policy; local credential removed", {
            exitCode: 7,
            details: { rpc_dispatched: true, revoked: true },
          });
        }
        throw new GbcError("auth_revoked", "server requested logout; local credential removed. Log in again.", {
          exitCode: 4,
          details: { rpc_dispatched: true, revoked: true },
        });
      }

      if (typeof body!.access_token !== "string" || body!.access_token.trim().length === 0) {
        throw new GbcError("auth_refresh_malformed", "token refresh response had no access_token; credentials kept", {
          exitCode: 4,
          details: { rpc_dispatched: true, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
        });
      }
      if (body!.refresh_token !== undefined && typeof body!.refresh_token !== "string") {
        throw new GbcError("auth_refresh_malformed", "token refresh response had invalid refresh_token; credentials kept", {
          exitCode: 4,
          details: { rpc_dispatched: true, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
        });
      }

      // P3-3: refuse to persist an access token whose JWT sub differs from the expected account.
      const newSub = decodeJwtPayload(body!.access_token as string)?.sub;
      if (expectedSubject && typeof newSub === "string" && newSub.length > 0 && newSub !== expectedSubject) {
        throw new GbcError(
          "auth_refresh_subject_mismatch",
          "refresh returned an access token for a different account subject; credentials kept",
          {
            exitCode: 4,
            details: { rpc_dispatched: true, can_fallback: classifyExpiry(cur.expires_at_ms, now()).stillValid },
          },
        );
      }

      const latest = store.load(kind, backend);
      if (!latest) {
        throw new GbcError("auth_revoked", "credential disappeared during refresh (logout won); not saving rotated pair", {
          exitCode: 4,
          details: { rpc_dispatched: true, revoked: true },
        });
      }
      if (latest.session_id !== expectedSession || latest.account_subject !== expectedSubject) {
        throw new GbcError("auth_revoked", "login/account changed during refresh; retry explicitly", { exitCode: 4, details: { revoked: true } });
      }
      if ((latest.revision ?? 0) !== expectedRevision) {
        clearAmbiguousIf(expectedSession, refreshToken);
        return metaFromCred(latest, false, "peer_refreshed", "revision changed during refresh; kept newer credential");
      }
      if (expectedSession && latest.session_id && latest.session_id !== expectedSession) {
        return metaFromCred(latest, false, "peer_refreshed", "session_id changed during refresh; kept newer login");
      }
      if (expectedSubject && latest.account_subject && latest.account_subject !== expectedSubject) {
        return metaFromCred(latest, false, "peer_refreshed", "account subject changed during refresh; kept newer login");
      }

      const next = credFromTokens(
        body!.access_token as string,
        body!.refresh_token as string | undefined,
        latest,
        persist && !latest.client_id ? "migrated" : "refresh",
        latest.login_kind ?? "browser_deep_control",
        latest.session_id,
        persist ? clientId : latest.client_id ?? clientId,
      );
      if (!store.saveIfRevision(next, expectedRevision)) {
        const again = store.load(kind, backend);
        if (again) return metaFromCred(again, false, "peer_refreshed", "CAS lost during save; kept on-disk credential");
        throw new GbcError("auth_revoked", "credential cleared during refresh save", { exitCode: 4, details: { revoked: true } });
      }
      clearCooldown(expectedSession);
      clearAmbiguousIf(expectedSession, refreshToken);
      return metaFromCred(next, true, decision.reason);
    });
  }

  function raceCallerDeadline<T>(exchange: Promise<T>, baseline: StoredCredential | undefined): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const exp = classifyExpiry(baseline?.expires_at_ms, now());
        if (baseline?.refresh_token) markAmbiguous(baseline.session_id, baseline.refresh_token);
        reject(
          new GbcError(
            "auth_refresh_timeout",
            "token refresh timed out (20s); exchange continues in background; credentials kept",
            {
              exitCode: 8,
              retryable: true,
              outcome: "unknown",
              details: {
                rpc_dispatched: "unknown",
                can_fallback: exp.stillValid,
                revision: baseline?.revision ?? 0,
              },
            },
          ),
        );
      }, refreshDeadlineMs);
    });
    return Promise.race([exchange, timeout]).finally(() => clearTimeout(timer));
  }

  function refreshSingleflight(
    force: boolean,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<RefreshResult> {
    const baseline = store.load(kind, backend);

    const startExchange = (forceFlag: boolean, rejected?: string): Promise<RefreshResult> => {
      if (inflight) return inflight;
      const entryBaseline = store.load(kind, backend);
      const p = withCredentialLock(`singleflight|${lockKey}`, async () => {
        const latest = store.load(kind, backend);
        if (!latest || entryBaseline?.session_id !== latest.session_id) {
          throw new GbcError("auth_revoked", "session changed while waiting for refresh; retry explicitly", {
            exitCode: 4,
            details: { revoked: true },
          });
        }
        if (rejected && latest.access_token && latest.access_token !== rejected) {
          return metaFromCred(latest, false, "peer_refreshed", "rejected access token already replaced while waiting");
        }
        if (
          (latest.revision ?? 0) !== (entryBaseline?.revision ?? 0) &&
          classifyExpiry(latest.expires_at_ms, now()).stillValid
        ) {
          return metaFromCred(latest, false, "peer_refreshed");
        }
        return doRefreshLocked(forceFlag, rejected);
      }, { waitMs: 30000, signal }).finally(() => {
        if (inflight === p) inflight = undefined;
      });
      inflight = p;
      // Callers that timed out via raceCallerDeadline must not leave an unhandled rejection.
      void p.catch(() => {});
      return p;
    };

    const run = async (): Promise<RefreshResult> => {
      if (inflight) {
        const joined = await raceCallerDeadline(inflight, baseline);
        if (!force) return joined;
        const after = store.load(kind, backend);
        if (rejectedAccessToken && after?.access_token && after.access_token !== rejectedAccessToken) {
          return metaFromCred(after, false, "peer_refreshed", "rejected token replaced by in-flight refresh");
        }
        if (joined.refreshed) return joined;
        if (joined.reason === "already_fresh") {
          // Force must not reuse a non-force already_fresh no-op (Grok Build semantics).
          return raceCallerDeadline(startExchange(true, rejectedAccessToken), after ?? baseline);
        }
        return joined;
      }
      return raceCallerDeadline(startExchange(force, rejectedAccessToken), baseline);
    };
    return run();
  }

  return {
    kind,
    backend,
    async getAccessToken(getOpts) {
      const force = Boolean(getOpts?.force);
      const c = store.load(kind, backend);
      if (!c) return undefined;
      const decision = refreshDecision(c, force);
      if (!decision.needs) return c.access_token;

      // P2-1 / 04c1893: without client_id, do not fail still-valid tokens just because refresh is unconfigured.
      if (!force && !c.client_id && !configuredClientId()) {
        const exp = classifyExpiry(c.expires_at_ms, now());
        if (exp.stillValid) return c.access_token;
        if (!exp.status.ok && typeof c.access_token === "string" && c.access_token.trim().length > 0) {
          // Missing/illegal exp and no way to refresh: keep using the opaque bearer (logged via note path only).
          return c.access_token;
        }
      }

      try {
        await refreshSingleflight(force);
        const after = store.load(kind, backend);
        return after?.access_token;
      } catch (e) {
        if (!(e instanceof GbcError)) throw e;
        const details = (e.details ?? {}) as { revoked?: boolean; can_fallback?: boolean; revision?: number };
        if (details.revoked || e.code === "auth_revoked" || e.code === "denied") {
          // Never fall back to a revoked token.
          throw e;
        }
        const again = store.load(kind, backend);
        if (!again) throw e;
        // If peer saved a new pair under lock, use it.
        if ((again.revision ?? 0) > (c.revision ?? 0) && again.access_token) {
          const peerExp = classifyExpiry(again.expires_at_ms, now());
          if (peerExp.stillValid || !peerExp.needsRefresh) return again.access_token;
        }
        const exp = classifyExpiry(again.expires_at_ms, now());
        const sameRev = (again.revision ?? 0) === (c.revision ?? 0);
        const fallbackCodes = new Set([
          "auth_refresh_network",
          "auth_refresh_timeout",
          "auth_refresh_failed",
          "auth_refresh_rate_limited",
          "auth_refresh_cooldown",
          "auth_refresh_unconfigured",
          "auth_refresh_malformed",
          "auth_refresh_redirect",
          "auth_refresh_client_mismatch",
          "auth_refresh_subject_mismatch",
        ]);
        // Config / response anomalies are not retryable but must still fall back when the
        // access token is unexpired (regression vs requiring e.retryable).
        if (fallbackCodes.has(e.code) && details.can_fallback !== false && sameRev) {
          if (exp.stillValid) return again.access_token;
          const configCodes = new Set([
            "auth_refresh_unconfigured",
            "auth_refresh_client_mismatch",
            "auth_refresh_malformed",
            "auth_refresh_redirect",
            "auth_refresh_subject_mismatch",
          ]);
          if (
            configCodes.has(e.code) &&
            !exp.status.ok &&
            typeof again.access_token === "string" &&
            again.access_token.trim().length > 0
          ) {
            return again.access_token;
          }
        }
        throw e;
      }
    },
    async beginLogin(call?: { loginMode?: LoginMode; redirectTarget?: string }): Promise<AuthBeginResult> {
      requireCursor("login");
      const login = resolveLoginParams({
        loginMode: call?.loginMode ?? defaultLogin.loginMode,
        redirectTarget: call?.redirectTarget,
        explicitRedirectTarget: call?.redirectTarget !== undefined ? undefined : explicitRedirectTarget,
        env: {},
      });
      const { verifier, challenge, uuid } = generateLoginChallenge();
      const created = now();
      const pending: PendingLogin = {
        v: 1,
        kind,
        backend,
        website,
        uuid,
        verifier,
        redirect_target: login.redirectTarget,
        login_mode: login.loginMode,
        supports_selected_team_login: login.supportsSelectedTeamLogin,
        created_at_ms: created,
        expires_at_ms: created + PENDING_TTL_MS,
      };
      store.savePending(pending);
      const note =
        login.loginMode === "bot"
          ? "Open the URL in a browser and sign in, then run `gbc auth complete`. Bot mode uses the App URL shape (redirectTarget=sand, supportsSelectedTeamLogin=true); it does not read official App credentials, invent a team id, or send team/App headers. Team binding and refresh after this mode are not live-verified. The verifier is stored only in a 0600 pending file and is never printed."
          : "Open the URL in a browser and sign in, then run `gbc auth complete`. The verifier is stored only in a 0600 pending file and is never printed.";
      return {
        authorization_url: buildLoginUrl(website, {
          challenge,
          uuid,
          redirectTarget: login.redirectTarget,
          supportsSelectedTeamLogin: login.supportsSelectedTeamLogin,
        }),
        uuid,
        expires_at_ms: pending.expires_at_ms,
        login_mode: login.loginMode,
        redirect_target: login.redirectTarget,
        supports_selected_team_login: login.supportsSelectedTeamLogin,
        note,
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
    refresh: (o) => refreshSingleflight(Boolean(o?.force), o?.signal, o?.rejectedAccessToken),
    async logout() {
      return withCredentialLock(lockKey, async () => ({
        removed_credential: store.clear(kind, backend),
        removed_pending: store.clearPending(kind, backend),
      }));
    },
    async whoamiLocal(): Promise<WhoamiLocal> {
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
        refresh_configured: Boolean(configuredClientId() || c?.client_id),
        pending_login: pending,
        revision: c?.revision,
        session_id: c?.session_id,
        credential_source: c?.credential_source,
        login_kind: c?.login_kind,
        client_id_bound: Boolean(c?.client_id),
        refresh_endpoint: c?.refresh_endpoint,
        disk_refresh: true,
        static_token: false,
      };
    },
  };
}

/** Injected token provider for tests / mock — never logs the token; never disk-refreshes. */
export function staticTokenProvider(opts: { kind: AuthKind; backend: string; accessToken: string }): AuthProvider {
  const unsupported = async (): Promise<never> => {
    throw new GbcError("unsupported", "static/mock token provider has no login/refresh flow (no disk refresh)", { exitCode: 9 });
  };
  return {
    kind: opts.kind,
    backend: opts.backend,
    async getAccessToken(getOpts) {
      if (getOpts?.force) {
        throw new GbcError("unsupported", "static/mock token provider cannot force-refresh; re-provide the token or log in", {
          exitCode: 9,
          details: { rpc_dispatched: false, disk_refresh: false },
        });
      }
      const jwt = decodeJwtPayload(opts.accessToken);
      if (jwt && typeof jwt.exp === "number" && Number.isFinite(jwt.exp) && jwt.exp * 1000 <= Date.now()) {
        throw new GbcError("auth", "static token expired; re-provide a token or log in (no disk refresh)", {
          exitCode: 4,
          details: { rpc_dispatched: false, disk_refresh: false },
        });
      }
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
        client_id_bound: false,
        disk_refresh: false,
        static_token: true,
        login_kind: "static",
        credential_source: "static",
      };
    },
  };
}
