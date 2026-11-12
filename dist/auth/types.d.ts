export type AuthKind = "cursor" | "xai";
/**
 * Login URL preset. Default `cli` keeps the library redirectTarget (A:38845; live 2026-11-07).
 * `bot` matches the official App login URL shape: redirectTarget=sand (A:49834) and
 * supportsSelectedTeamLogin=true (Rdn). This is a URL-shape option only — it does not
 * read App credentials, invent a team id, or send x-cursor-team-id / App client headers.
 */
export declare const LOGIN_MODES: readonly ["cli", "bot"];
export type LoginMode = (typeof LOGIN_MODES)[number];
/** How the local credential was obtained. */
export type LoginKind = "browser_deep_control" | "static" | "unknown";
/** Last writer of the stored credential pair. */
export type CredentialSource = "login_poll" | "refresh" | "migrated" | "static";
/**
 * Disk credential. Tokens never leave AuthOps/CLI/MCP envelopes.
 * Provenance fields bind refresh to a backend/client; old files without them
 * require GBT_OAUTH_CLIENT_ID and/or GBT_AUTH_CONFIRM_MIGRATE=1.
 */
export type StoredCredential = {
    kind: AuthKind;
    /** Backend base URL this credential is bound to. */
    backend: string;
    access_token: string;
    refresh_token?: string;
    /** From JWT `exp` when present and finite. */
    expires_at_ms?: number;
    account_label?: string;
    updated_at_ms: number;
    /** Monotonic CAS counter; bumps on every successful save under the credential lock. */
    revision?: number;
    refresh_cooldown_until_ms?: number;
    login_kind?: LoginKind;
    credential_source?: CredentialSource;
    /** Origin+path of the refresh POST (e.g. https://api2.cursor.sh/oauth/token). */
    refresh_endpoint?: string;
    /** Public OAuth client_id bound at login/refresh; never guessed from JWT. */
    client_id?: string;
    /** Optional JWT iss (display/binding only; unverified). */
    issuer?: string;
    /** Optional JWT sub (account subject binding). */
    account_subject?: string;
    /** Local session binding id; changes on each completed login. */
    session_id?: string;
};
/** Pending browser login (0600 file, expires). Contains the secret verifier — never print. */
export type PendingLogin = {
    v: 1;
    kind: AuthKind;
    backend: string;
    website: string;
    uuid: string;
    verifier: string;
    redirect_target: string;
    /** URL preset used to build authorization_url. Absent on legacy pending files. */
    login_mode?: LoginMode;
    /** Whether supportsSelectedTeamLogin=true was included. Absent on legacy pending files. */
    supports_selected_team_login?: boolean;
    created_at_ms: number;
    expires_at_ms: number;
};
/** Safe to print: no verifier / tokens. */
export type AuthBeginResult = {
    authorization_url: string;
    uuid: string;
    expires_at_ms: number;
    login_mode: LoginMode;
    redirect_target: string;
    supports_selected_team_login: boolean;
    note: string;
};
export type AuthCompleteResult = {
    status: "completed";
    kind: AuthKind;
    backend: string;
    account_label?: string;
    expires_at_ms?: number;
    revision?: number;
    session_id?: string;
} | {
    status: "pending";
    expires_at_ms: number;
    note: string;
};
export type RefreshReason = "forced" | "near_expiry" | "missing_exp" | "illegal_exp" | "already_fresh" | "peer_refreshed";
/** Non-secret refresh outcome for CLI/MCP/AuthOps. */
export type RefreshResult = {
    refreshed: boolean;
    reason: RefreshReason;
    kind: AuthKind;
    backend: string;
    expires_at_ms?: number;
    revision: number;
    account_label?: string;
    session_id?: string;
    credential_source?: CredentialSource;
    login_kind?: LoginKind;
    client_id_bound: boolean;
    refresh_endpoint?: string;
    note?: string;
};
export type WhoamiLocal = {
    kind: AuthKind;
    backend: string;
    account_label?: string;
    has_token: boolean;
    expires_at_ms?: number;
    refresh_configured: boolean;
    pending_login: boolean;
    revision?: number;
    session_id?: string;
    credential_source?: CredentialSource;
    login_kind?: LoginKind;
    client_id_bound: boolean;
    refresh_endpoint?: string;
    disk_refresh: boolean;
    static_token: boolean;
};
export type AuthProvider = {
    kind: AuthKind;
    backend: string;
    getAccessToken(opts?: {
        force?: boolean;
    }): Promise<string | undefined>;
    /** Start independent browser login; persists pending state (0600). Per-call opts override provider/env defaults. */
    beginLogin(opts?: {
        loginMode?: LoginMode;
        redirectTarget?: string;
    }): Promise<AuthBeginResult>;
    /** Single poll attempt against the persisted pending login. */
    pollLogin(): Promise<AuthCompleteResult>;
    /** Poll until completed, timeout, cancel or 3 consecutive non-404 failures. */
    completeLogin(opts?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<AuthCompleteResult>;
    cancelLogin(): Promise<{
        had_pending: boolean;
    }>;
    /**
     * Refresh when near expiry / missing exp, or when force=true. Never prints tokens.
     * `rejectedAccessToken`: on 401 recovery, pass the bearer the server rejected; if disk
     * already has a different access token, adopt it without another force rotation.
     */
    refresh(opts?: {
        force?: boolean;
        signal?: AbortSignal;
        rejectedAccessToken?: string;
    }): Promise<RefreshResult>;
    /** Local only: removes this tool's own credential + pending files. Does not revoke server-side. */
    logout(): Promise<{
        removed_credential: boolean;
        removed_pending: boolean;
    }>;
    /** Pure: no network. */
    whoamiLocal(): Promise<WhoamiLocal>;
};
