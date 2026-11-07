import { GbcError } from "../errors.js";
import { FileCredentialStore, withRefreshLock } from "./store.js";
import type { AuthBeginResult, AuthKind, AuthProvider, StoredCredential } from "./types.js";

export type AuthHttp = {
  fetch: typeof fetch;
};

/**
 * Independent auth bootstrap (loginDeepControl-style + poll).
 * NOT RFC 8628 Device Authorization — product-custom PKCE-ish + poll.
 * Real network auth is opt-in; default tests inject fake fetch.
 *
 * STATUS: begin/poll/refresh implemented against injectable fetch.
 * Live login against production backends is **not verified** this turn.
 */
export function createAuthProvider(opts: {
  kind: AuthKind;
  backend: string;
  http?: AuthHttp;
  store?: FileCredentialStore;
  /** Trust custom backends (required when backend is not default allowlist). */
  trustCustomBackend?: boolean;
}): AuthProvider {
  const defaults = [
    "https://api2.cursor.sh",
    "https://api3.cursor.sh",
    "https://agentn.global.api5.cursor.sh",
  ];
  const backend = opts.backend.replace(/\/$/, "");
  if (!defaults.includes(backend) && !opts.trustCustomBackend && process.env.GBT_TRUST_BACKEND !== "1") {
    throw new GbcError(
      "denied",
      `backend ${backend} is not in the default allowlist; pass trustCustomBackend / --trust-backend or GBT_TRUST_BACKEND=1 (exactly "1")`,
      { exitCode: 7, hint: "Prevents sending tokens to an untrusted host (RFC9700-style binding)." },
    );
  }
  const store = opts.store ?? new FileCredentialStore();
  const http = opts.http ?? { fetch: globalThis.fetch.bind(globalThis) };
  let memoryVerifier: string | undefined;

  return {
    kind: opts.kind,
    backend,
    async getAccessToken() {
      const c = store.load(opts.kind, backend);
      if (!c) return undefined;
      if (c.expires_at_ms && c.expires_at_ms < Date.now() + 30_000) {
        try {
          const refreshed = await this.refresh();
          return refreshed.access_token;
        } catch {
          return c.access_token;
        }
      }
      return c.access_token;
    },
    async beginLogin() {
      memoryVerifier = crypto.randomUUID();
      const state = crypto.randomUUID();
      // Shape mirrors product custom poll bootstrap; path may differ per kind — live unverified.
      const authorization_url = `${backend}/auth/loginDeepControl?kind=${encodeURIComponent(opts.kind)}&state=${state}`;
      return {
        authorization_url,
        poll_token: memoryVerifier,
        state,
        note:
          "Custom poll login (not RFC8628 device flow). Live auth against production is unverified. Completing browser login is out of scope for automated agents unless separately authorized.",
      } satisfies AuthBeginResult;
    },
    async pollLogin(pollToken: string) {
      if (!memoryVerifier || pollToken !== memoryVerifier) {
        throw new GbcError("auth", "invalid or expired poll token (held in-memory only)", { exitCode: 4 });
      }
      const res = await http.fetch(`${backend}/auth/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll_token: pollToken, kind: opts.kind }),
      });
      if (res.status === 204 || res.status === 202) return { pending: true as const };
      if (!res.ok) {
        throw new GbcError("auth", `poll failed HTTP ${res.status}`, { exitCode: 4, retryable: res.status >= 500 });
      }
      const body = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        account_label?: string;
      };
      const cred: StoredCredential = {
        kind: opts.kind,
        backend,
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at_ms: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
        account_label: body.account_label,
        updated_at_ms: Date.now(),
      };
      store.save(cred);
      memoryVerifier = undefined;
      return cred;
    },
    async refresh() {
      return withRefreshLock(backend, async () => {
        const cur = store.load(opts.kind, backend);
        if (!cur?.refresh_token) {
          throw new GbcError("auth", "no refresh_token stored", { exitCode: 4 });
        }
        const res = await http.fetch(`${backend}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: cur.refresh_token, kind: opts.kind }),
        });
        if (!res.ok) {
          throw new GbcError("auth", `refresh failed HTTP ${res.status}`, {
            exitCode: 4,
            retryable: res.status >= 500,
          });
        }
        const body = (await res.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        const next: StoredCredential = {
          ...cur,
          access_token: body.access_token,
          refresh_token: body.refresh_token ?? cur.refresh_token,
          expires_at_ms: body.expires_in ? Date.now() + body.expires_in * 1000 : cur.expires_at_ms,
          updated_at_ms: Date.now(),
        };
        store.save(next);
        return next;
      });
    },
    async logout() {
      store.clear(opts.kind, backend);
      memoryVerifier = undefined;
    },
    async whoamiLocal() {
      const c = store.load(opts.kind, backend);
      return {
        kind: opts.kind,
        backend,
        account_label: c?.account_label,
        has_token: Boolean(c?.access_token),
      };
    },
  };
}

/** Injected token provider for tests / CI — never logs the token. */
export function staticTokenProvider(opts: {
  kind: AuthKind;
  backend: string;
  accessToken: string;
}): AuthProvider {
  return {
    kind: opts.kind,
    backend: opts.backend,
    async getAccessToken() {
      return opts.accessToken;
    },
    async beginLogin() {
      throw new GbcError("unsupported", "static token provider has no login flow", { exitCode: 9 });
    },
    async pollLogin() {
      throw new GbcError("unsupported", "static token provider has no poll", { exitCode: 9 });
    },
    async refresh() {
      throw new GbcError("unsupported", "static token provider cannot refresh", { exitCode: 9 });
    },
    async logout() {
      /* no-op */
    },
    async whoamiLocal() {
      return { kind: opts.kind, backend: opts.backend, has_token: true, account_label: "static" };
    },
  };
}
