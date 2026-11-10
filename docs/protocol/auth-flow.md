# Auth flow (independent Cursor browser login)

Implementation: `packages/grokbot-control/src/auth/provider.ts`, `src/auth/store.ts`, `src/ops/auth.ts`. Contract table and CLI/MCP
commands: [protocol-map.md](protocol-map.md) (section Auth). This page records
**where the evidence lives** so it can be re-found in a new build.

| Step | Behaviour | Stable anchor (search the extracted bundle) | 0.79.2 location (A=main-app.cjs) | Level |
|---|---|---|---|---|
| Challenge | verifier = base64url(32 random bytes); challenge = base64url(sha256(verifier)); uuid | `randomBytes(32)` next to `"/loginDeepControl"` | fn `Rdn` (prettified A:38644) | S, O |
| Login URL | `{website}/loginDeepControl?challenge&uuid&mode=login&redirectTarget=<t>[&supportsSelectedTeamLogin=true]`; website default `https://cursor.com` | `"/loginDeepControl"`, `"redirectTarget"` | `Rdn`; library default target `cli` (A:38845) | S, O, **L** (`cli`, 2026-11-07) |
| Poll | `GET {api}/auth/poll?uuid=&verifier=`; 404 = pending; 1 s×1.2^i ≤ 10 s; ≤ 150 tries; 3 consecutive non-404 → stop | `` `${n}/auth/poll` `` | fns `Aze`, `xdn`, `Odn` | S, O, **L** |
| Policy denial | 403 `{error:"sign_in_policy_violation"}` | `sign_in_policy_violation` | constant `Nh` | S, O |
| Result | `{accessToken, refreshToken}`; xAI identity `{xaiAccessToken, …}` → unsupported here | `xaiAccessToken` | fns `Cdn`, `mze` | S, O, **L** (cursor kind) |
| Refresh | `POST new URL("/oauth/token", backend)` JSON `{client_id, grant_type:"refresh_token", refresh_token}`; response `{access_token?, refresh_token?, shouldLogout?, error?}`; refresh 300 s before JWT `exp` | `"/oauth/token"` | method `runRefreshAccessToken`; schema `zWe` | S, O (not L) |
| client_id | App picks a **public** id per backend host (dev vs prod) | look near `"/oauth/token"` → `authClientIdentityFor` → selector in main-core | main-core selector (C:35866-35869) | S |
| API-key exchange | `POST /auth/exchange_user_api_key` (not implemented here) | `/auth/exchange_user_api_key` | fn `Pdn` | S |

Boundaries:
- **client_id is not embedded** in this repo; refresh requires `GBT_OAUTH_CLIENT_ID`. Which public id a third-party
  tool should use is a policy decision for the user, not something to copy blindly from the bundle.
- 0.79.2 main-app.cjs also contains a **second login implementation** (anchor `loginPollUrl`, `startLogin()` with a
  `"delivered"` result, near offset ~1.14 MB). Not analysed; check it first on the next version bump.
- Device policy header `x-cursor-mdm-signin-policy` and App client headers are not sent/forged.
- App credential storage (`sand-secrets.json` under Electron userData) is documented only so it is NOT reused.


## Token auto-refresh state machine

State machine (minimal, App-aligned):

1. **Provenance**: stored credentials bind `kind`, `login_kind`, `credential_source`, backend, `refresh_endpoint`,
   optional `client_id` / issuer / account subject / `session_id` / `revision` / expiry. `client_id` comes from
   `GBT_OAUTH_CLIENT_ID` or a login-persisted binding — never hardcoded, never guessed from JWT. Legacy files
   without binding require explicit config (and optional `GBT_AUTH_CONFIRM_MIGRATE=1`).
2. **getAccessToken**: missing/illegal exp, within 5 min of exp, or `force` → refresh; else return. In-process
   singleflight + cross-process credential lock; re-read under lock; reuse peer refresh.
3. **Refresh POST**: fixed HTTPS `{backend}/oauth/token`, `redirect:error`, 20s deadline, schema requires
   non-empty `access_token`; absent `refresh_token` keeps old. Atomic save only if session/account/revision
   unchanged (CAS).
4. **Failures**: network/timeout/5xx/429 keep creds + per-session cooldown; caller deadline does not abort the
   IdP exchange (background writeback; `rpc_dispatched=unknown`). Fallback when old token still valid (also for
   unconfigured/client_mismatch/malformed/redirect — not only `retryable`). `shouldLogout`/policy: rescue newer
   pair under lock, else conditional clear — never fallback revoked token; `invalid_grant` after an ambiguous
   timeout keeps creds. New access JWT `sub` must match expected account subject or the rotation is refused.
5. **logout/login/save** share `withCredentialLock` with refresh; native advisory-lock ownership is OS-managed (Linux OFD / macOS flock / Windows LockFileEx; see [auth-lock.md](../control-plane/auth-lock.md)); never stale-break/unlink lock files.
6. **CLI/MCP**: `auth refresh` vs `--force` / `force:true`; whoami offline; AuthOps returns non-secret metadata;
   MCP `auth_refresh` excluded from READONLY.
7. **RPC 401**: pass the rejected bearer into force refresh; if disk already rotated, adopt without another
   network refresh. Write RPCs never auto-replayed; read-only unary whitelist may refresh+retry once.
   Pre-RPC failures annotate `rpc_dispatched=false`.
8. **staticTokenProvider**: never auto-refresh / no disk refresh; expired → re-provide/login.
