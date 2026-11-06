export type AuthKind = "cursor" | "xai";

export type StoredCredential = {
  kind: AuthKind;
  /** Backend base URL this credential is bound to. */
  backend: string;
  access_token: string;
  refresh_token?: string;
  expires_at_ms?: number;
  account_label?: string;
  updated_at_ms: number;
};

export type AuthBeginResult = {
  authorization_url: string;
  /** Held in memory only — never persisted or logged. */
  poll_token: string;
  state: string;
  note: string;
};

export type AuthProvider = {
  kind: AuthKind;
  backend: string;
  getAccessToken(): Promise<string | undefined>;
  beginLogin(opts?: { openBrowser?: boolean }): Promise<AuthBeginResult>;
  pollLogin(pollToken: string): Promise<StoredCredential | { pending: true }>;
  refresh(): Promise<StoredCredential>;
  logout(): Promise<void>;
  /** Pure: no network. */
  whoamiLocal(): Promise<{ kind: AuthKind; backend: string; account_label?: string; has_token: boolean }>;
};
