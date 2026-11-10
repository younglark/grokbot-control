# UC transport, hello capabilities, watch reasons, servingAt, credential, QPe

## 1. Hello golden check (D:178137–178175, gE D:97145)
- **Original.** `hello()` always constructs `capabilities` itself:
  - `{...(i ? {messagesOp} : {}), ...(i || u ? {localStandingGrants} : {}), messagesOpGeneration: gE (=4), aiToolSetup: true, mobileLocalTools: [...], ...(u ? {localToolAppConsent, localToolGrantSeen} : {}), ...(helperName ? {localToolHelperName} : {})}`.
  - i = `executor.messages.available()` = y5 (Dpt D:135886, sidecar found).
  - With no sidecar and no tools, field 8 is exactly `42 04 10 04 20 01` (messages_op_generation=4, ai_tool_setup=true). It is never empty.
- **Before t160.**
  - The fixture's helloHex (an independent Python construction) had no field 8.
  - The t159 port emitted an empty field 8 when the caller passed no capabilities.
  - The t159 test relaxed "empty == default". **That was not what the original sends.**
- **Fix.**
  - The provider now builds every capabilities field on each Watch, like the original (`withLocalToolCapabilities`), and index no longer passes capabilities.
  - The golden fixture now includes field 8 (`helloCapabilitiesNote`).
  - The test asserts the field-8 bytes `10042001` strictly. The loose normalization is removed; only the earlier default filters for fields 7 and 9 remain.

## 2. UC Connect client (E9r D:179040–179055, renewConnection D:178319)
- The client is created on construction and on every channel change.
- connect-node uses HTTP/1.1 with an `http(s).Agent({keepAlive: true, timeout: s9r = 5000})`.
- An interceptor sets every `mb(client)` header (D:79034) on every request of that client: Watch, Poll, Submit, keepalive and withdraw. The client comes from `eke(process.env, "desktop").backend`, passed in from index.
- The 8 MiB read/write limits are this port's own setting and are kept.

## 3. servingAt (lgt m = p D:179176; Rt D:179462–179478)
- startedAt is now taken after the handoff and after eke; servingAt starts equal to startedAt.
- After a completed standing tick (refreshUc + rehelloIfChanged), when not shutting down: `servingAt = now`, then publish.
- UC start no longer sets servingAt.

## 4. Watch reasons (watch D:178342–178420; runLoop D:178245–178262)
- **l() priority:**
  1. closed → "closed";
  2. credentialRejected → "unauthorized";
  3. renewRequested → "network-change";
  4. rehelloRequested → "lifetime";
  5. a fired watchdog → "silent" if connected, else "stall".
- **Endings:**
  - Normal end → `l() ?? "lifetime"`.
  - A throw → l(); else Connect Canceled → "stall"; else log `[user-computer-provider] watch stream failed: ${xt}` and rethrow. The runLoop maps Unauthenticated → "unauthorized" and anything else → "error".
- **Watchdogs (xh, unref'd):** connect e9r = 35 s from dial; silence t9r = 15 s after connected. Every event kicks them.
- **Flags:**
  - credentialRejected is set by rejectCredential (Poll, keepalive, Watch, or reply-lane 401).
  - rehelloRequested is set by every rehello (standing or localTools change, channel change, rotation).
  - "network-change" is never produced, because this port has no network-change renewal.
- **Effect on x (D:179404–179412):** only `disconnected/unauthorized` adds the scope; `connected` removes it.

## 5. Credential read (ILe D:80986, RDe D:79701)
- A sealed envelope opens only with the IPC key; plain JSON passes through.
- JSON.parse failure, or a GFt schema/refine failure → null.
- ENOENT → null; other read errors throw.

## 6. QPe (D:79103–79131), reachable at startup
- cqr runs `eke(process.env, "desktop")` after the handoff (D:187314).
- With `SAND_ISOLATED_DEPLOYMENT=1`, a non-http(s) backend (`SAND_BACKEND_URL ?? CURSOR_API_BASE_URL`) or website (`SAND_CURSOR_WEBSITE_URL ?? CURSOR_WEBSITE_URL`) throws IsolatedDeploymentConfigError (hb D:79094).
- The outer catch writes `[sand-local-exec-daemon] fatal: IsolatedDeploymentConfigError` and exits with 1 (D:187341–187348).
- Ported: `validateIsolatedDeployment`, `exitFatal(error)`.
- QPe's `refuses` egress predicate is not used by the daemon paths ported here.

## Tests
- `test/t160-uc-client-watch.test.cjs`: mb headers on a Watch to a fake peer; reasons lifetime / unauthorized / error / closed / rehello; watchdogs stall / silent with unref'd timers; provider-built capabilities; plaintext and sealed credential; QPe and the fatal text.
- `test/uc-lifecycle.test.cjs` (t160 cases).
- `test/followup-fixes.test.cjs` (strict field 8).

## runLoop per-reason backoff (D:178223–178289)

- `lifetime`: redial immediately.
- `silent`: `renew` builds a fresh E9r client and emits `{kind:"renewed",cause}` (D:178314), then waits `silentRenewalBackoff` (Pu: r9r = 2000 ms, max X1t = 60000 ms, full jitter, `random()*min(60000, 2000*2^(r-1))`). r becomes 1 if the Watch heard any event after `connected` (D:178381), otherwise r+1.
- `stall`/`error`: wait `reconnectBackoff` (Q8r = 1000 ms doubling to 60000 ms, no jitter); e += 1, and `connected` resets e to 1 (D:178249).
- `unauthorized`, backendReturn early wake, renew `pollAbort` and `network-change`: see [uc-unauthorized-renewal.md](uc-unauthorized-renewal.md).
- The 8 MiB UC transport read/write cap is removed: L1t sets none, so the defaults are 0xFFFFFFFF (D:174740–174748).

The silent wait uses jitter, so the `retry-expiry` oracle pins `random` (see [remaining-diffs.md](../remaining-diffs.md) #12). The original t160/t162 round notes are in [history](../../history/local-exec-evidence-rounds.md).
