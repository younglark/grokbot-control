# Box connection exchange (O9r / ge) — t159

Evidence lines refer to D: daemon.formatted.cjs. The port lives in `src/state/connection-exchange.ts`, `src/state/connection.ts`, `src/index.ts` and `src/box/provider.ts`.

## Original
- **O9r (D:179117–179145).** `fetch(new URL("/sand-box/local-exec-connection", backendUrl), {method:"POST", headers:{"content-type":"application/json", ...mb(client)}, body: JSON.stringify({credential})})`.
  - A fetch throw → `unavailable transport xt(e)`.
  - `!ok` → `status http_<n>`.
  - A json() throw → `body xt(e)`.
  - A non-object reply (Ke) → `shape "reply is not an object"`.
  - An empty or non-string baseUrl → `shape "reply has no baseUrl"`.
  - Otherwise `connected {baseUrl, token: non-empty string or undefined, headers: M9r(networkToken, gatewayPortToken)}`.
  - M9r: networkToken → `x-anyrun-network-token` (UDe D:79877); otherwise gatewayPortToken → `x-anyrun-port-token` ($De D:79878); otherwise undefined.
  - It is plain HTTP, not a proto RPC, so it is ported the same way.
- **mb (D:79034).**
  - Headers: `user-agent` (FAt), `x-cursor-client-type: sand` (kAt), `x-cursor-client-version` (VPe: x.y.z from SAND_CLIENT_APP_VERSION, else 0.79.3, plus -dev/-lab), `x-sand-box-namespace` (ese), `x-cursor-client-os`.
  - `x-cursor-client-source: sand-desktop` (BAt, because the client is eke(env, "desktop") D:187314).
- **ge (D:179267–179277).**
  1. Reads the sealed credential (ILe). It returns early if `credential` (the top-level Box credential, GFt D:80896) is undefined, or if X() is true.
  2. Calls O9r.
  3. If the result is unavailable, logs `[local-exec-daemon] connection exchange unavailable (<reason>): <detail>`. Otherwise calls vLe(connection, {path: XR, fileKeyBase64}).
- **X (D:179262).** True when some credential channel has serverAuthoritative, or has a scope not in x (the refused scopes).
- **Box wiring (D:179316–179332).** Te is always constructed and started.
  - resolveConnection: X() → throw lee(C9r), otherwise we().
  - resolveResponseConnection: we.
  - onConnectionStale: ge.
  - we: RLe → null → throw lee(P9r).
  - Box variant = HPe(client.boxNamespace).
- **When it fires.** runLoop counts consecutive failed streamRequests (reset on connect). At ≥3 (Cwr D:137183) it awaits onConnectionStale and resets the count; the backoff follows. Since runLoop is serial and ge has no coalescing of its own, calls never overlap.
- **Installation.** vLe (D:80967) writes the file through cp, mode 0600. With the IPC key the file is sealed (vDe AES-256-GCM `{sandSealedFile:1,data}`); without a key it is plain JSON. The next dial reads it again through RLe (D:80974; RDe opens a sealed file only with the key, plain text passes through).
- **onLoopEvent (D:179404–179412).**
  - connected → x.delete(scope) and Te.redial().
  - disconnected/unauthorized → x.add(scope) and Te.wakeFromReconnectBackoff().
  - channel-missing → wake.
  - A change in x republishes discovery (`rejectedAccountScopes`, sorted, D:179205).

## Port differences (remaining, after t160)
- t160 closed four of the earlier gaps: QPe validation, UC reasons, plaintext credentials and servingAt. See uc-transport-hello-evidence.md.
- The UC runLoop still uses this port's own backoff after each reason. The original's per-reason branches are not ported: renew on silent/network-change (D:178266–178290), channelRetry on unauthorized, and backendReturn sleeps.

## Tests
- `test/t159-exchange-obsidian-cp.test.cjs`, run against a fake local HTTP server: mb headers, request shape, every result kind, sealed/plain connection file, and the Cwr=3 stale trigger on a fake clock.
- `test/uc-lifecycle.test.cjs` (t159 cases): Box always constructed, C9r/P9r, ge gating, the write with the IPC key, the unavailable log, and onLoopEvent plus rejectedAccountScopes.
