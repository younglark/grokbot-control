export type AuthKind = "cursor" | "xai";

export type StoredCredential = {
  kind: AuthKind;
  /** Backend base URL this credential is bound to. */
  backend: string;
  access_token: string;
  refresh_token?: string;
  /** From JWT `exp` when present. */
  expires_at_ms?: number;
  account_label?: string;
  updated_at_ms: number;
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
  created_at_ms: number;
  expires_at_ms: number;
};

/** Safe to print: no verifier / tokens. */
export type AuthBeginResult = {
  authorization_url: string;
  uuid: string;
  expires_at_ms: number;
  note: string;
};

export type AuthCompleteResult =
  | { status: "completed"; kind: AuthKind; backend: string; account_label?: string; expires_at_ms?: number }
  | { status: "pending"; expires_at_ms: number; note: string };

export type AuthProvider = {
  kind: AuthKind;
  backend: string;
  getAccessToken(): Promise<string | undefined>;
  /** Start independent browser login; persists pending state (0600). */
  beginLogin(): Promise<AuthBeginResult>;
  /** Single poll attempt against the persisted pending login. */
  pollLogin(): Promise<AuthCompleteResult>;
  /** Poll until completed, timeout, cancel or 3 consecutive non-404 failures. */
  completeLogin(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<AuthCompleteResult>;
  cancelLogin(): Promise<{ had_pending: boolean }>;
  refresh(): Promise<StoredCredential>;
  /** Local only: removes this tool's own credential + pending files. Does not revoke server-side. */
  logout(): Promise<{ removed_credential: boolean; removed_pending: boolean }>;
  /** Pure: no network. */
  whoamiLocal(): Promise<{
    kind: AuthKind;
    backend: string;
    account_label?: string;
    has_token: boolean;
    expires_at_ms?: number;
    refresh_configured: boolean;
    pending_login: boolean;
  }>;
};
