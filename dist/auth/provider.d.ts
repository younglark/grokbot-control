import { FileCredentialStore } from "./store.js";
import type { AuthKind, AuthProvider } from "./types.js";
/**
 * Independent Cursor browser login (product-custom challenge + poll; NOT RFC 8628).
 *
 * Protocol source: STATIC reverse engineering of Grok Bot Linux 0.79.2 / 0.79.3
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
 * This tool does NOT embed it; refresh requires explicit GBT_OAUTH_CLIENT_ID config
 * or a client_id persisted at login / confirmed migration.
 */
export declare const DEFAULT_BACKENDS: string[];
export declare const DEFAULT_WEBSITE = "https://cursor.com";
export declare const POLICY_VIOLATION = "sign_in_policy_violation";
export declare const REFRESH_EARLY_MS = 300000;
export declare const REFRESH_DEADLINE_MS = 20000;
export declare const PENDING_TTL_MS: number;
export type AuthHttp = {
    fetch: typeof fetch;
};
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
    /** Override refresh HTTP deadline (default 20s). */
    refreshDeadlineMs?: number;
};
export declare function generateLoginChallenge(): {
    verifier: string;
    challenge: string;
    uuid: string;
};
export declare function buildLoginUrl(website: string, p: {
    challenge: string;
    uuid: string;
    redirectTarget: string;
}): string;
/** JWT payload (unverified decode — only for exp/email display; never trust for auth / client_id). */
export declare function decodeJwtPayload(token: string): {
    exp?: number;
    email?: string;
    sub?: string;
    iss?: string;
} | null;
export declare function refreshEndpointFor(backend: string): string;
export type ExpStatus = {
    ok: true;
    expires_at_ms: number;
} | {
    ok: false;
    reason: "missing_exp" | "illegal_exp";
};
/** Classify stored / JWT exp. Never invents an expiry. */
export declare function classifyExpiry(expires_at_ms: number | undefined, nowMs: number): {
    status: ExpStatus;
    needsRefresh: boolean;
    stillValid: boolean;
};
export declare function createAuthProvider(opts: AuthProviderOptions): AuthProvider;
/** Injected token provider for tests / mock — never logs the token; never disk-refreshes. */
export declare function staticTokenProvider(opts: {
    kind: AuthKind;
    backend: string;
    accessToken: string;
}): AuthProvider;
