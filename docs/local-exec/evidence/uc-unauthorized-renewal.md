# UC unauthorized / backend return / network change

Evidence: `daemon.formatted.cjs` (cited as D:line). Tests: `packages/local-exec-daemon/test/t162-uc-unauthorized-renewal.test.cjs`,
plus the updated tests in `uc-lifecycle`, `uc-keepalive`, `uc-close-channel`, and `followup-fixes`. All tests use synthetic data only.

## Unauthorized and credential rejection
- **runLoop `unauthorized` (D:178278–178283).** The loop sets `channel = undefined`, `proven = false` and `e = 1`, then runs `sleep(channelRetry, 1)`.
  - channelRetry is Q1t = 10 s (D:177841). It is a plain unref'd sleep (qr.schedule, D:78137), so a backend return does not wake it.
  - The next pass calls `resolveChannel()` again. Because `channel` is undefined, it applies the result: `channel = n`, `renewConnection(n)`, `proven = false` (D:178243). This retries the same credential, or picks up a rotated one.
- **Removed: this port's `admissionClosed` fencing.** That covers the 100 ms admission loop, the `blocked` getter, the admission gates in poll, keepalive, backlog and runBacklog, and the reply-lane "credential pause/resume" path. The original gates only on `channel`/`client`/`proven`/`closed`/`closing`:
  - pollOnce D:178448;
  - sendKeepAlives D:178625;
  - flush D:178671;
  - superviseBacklog D:178589.
- **`rejectCredential(e)` (D:178423–178428).** It only acts when `channel === e` (object identity). It sets `proven = false` and `credentialRejected = true`, and aborts the running Watch's own `abortController`.
  - When no Watch is running, it only clears `proven`. The next Watch resets the flag (D:178347–178351).
  - The Watch catch block no longer rejects on its own. Unauthenticated maps to `unauthorized` in the runLoop (D:178250–178253).
- **Credential errors (`sgt`, D:178782).** Only `Unauthenticated` counts. PermissionDenied is an ordinary failure (this port used to treat it as a credential error).
- **Submit 401 (D:178734).** `replies.requeue(n); rejectCredential(e); return 0`. The lane does not pause: the flush loop re-checks `proven` and stops. A stale channel's 401 retries at once on the current channel. The batch flushes on the next `connected` (D:178396).
- **Rejected scopes `x` (D:179404–179412), unchanged.**
  - `disconnected:unauthorized` adds the scope, wakes the Box dial, and publishes.
  - `connected` removes it, redials the Box, and publishes.
  - The new `renewed` event logs `user-computer watch renewed on a new connection after …`.
- **`rehello()` (D:178421)** now aborts only the running Watch's controller. `rehelloIfChanged` with a missing channel calls `rehello()` (D:178185–178191).
- **`updateChannel`** is a test/compat entry only; production rotates through `resolveChannel`. It mirrors the `!ngt` branch without renewConnection (same backendUrl).
- **Added `createClient` option** (D:178321, `options.createClient ?? E9r`).

## Backend return (v1t D:176417–176450, w8r D:176402–176416)
- **Failure state.**
  - `noteFailure` runs when a Watch throws (D:178252). It sets the "backend down" state using w8r:
    - TypeError `fetch failed`;
    - ConnectError rawMessage `HTTP nnn` with nnn in S8r {502,503,504,520–527,530};
    - otherwise, an errno anywhere in the cause chain decides via membership in _8r (ECONNREFUSED…EAI_AGAIN);
    - otherwise, ConnectError Unavailable.
  - `noteSilence` runs on stall/silent (D:178259). `noteAnswered` runs on connected (D:178249).
- **`sleepUnlessBackendReturns` (D:178334)** arms a signal. `noteBackendReturn` only wakes an armed sleep after a down state, after `random() * 2000` ms (g8r). It is used for `reconnectBackoff` and `silentRenewalBackoff`, not for channelRetry.
- **Trigger (He, D:179436–179441).** Each standing tick reads `<dataRoot>/local-exec-backend-return.json` (wTe D:78800):
  - It uses `_d(..., up(JFt), {failOpen:true})` with no file key (OLe D:81014). Plain `{at:number}` is accepted; a sealed file, garbage, or any error gives null.
  - When `at` is newer than the last value seen (initially startedAt), it calls `noteBackendReturn` on each provider.

## renew and pollAbort (D:178314–178318, 178458–178484)
- `renew` aborts `pollAbort`, builds a new client (`renewConnection`), and emits `{kind:"renewed", cause}`.
- An aborted poll puts its acks back at the front of the queue and asks for another poll, which goes through the new client.
- After a poll returns, `channel !== e || !proven` puts the acks back and returns.

## network-change (reachable on Linux)
- **Trigger (ut, D:179448–179456).** `os.networkInterfaces()` is read on every standing tick, before Ve (Rt D:179463).
  - The fingerprint is D9r (D:179161): sorted `name|family|address` of every non-internal address, dropping IPv4 169.254.x.x and IPv6 fe80::/10 (L9r).
  - The first read is the baseline. Any later difference calls `noteNetworkChange()` on each provider. A read error logs `network interface read failed: <xt>`.
- **`noteNetworkChange` (D:178295–178313).**
  - While the 30 s cooldown hold (n9r D:177839, xh unref) is armed, a change is only marked as deferred; it replays when the hold expires, unless the provider is closed.
  - Otherwise it arms the hold. If a Watch is running, it sets `renewRequested` and aborts the Watch, which ends `network-change` (l() order: closed > unauthorized > network-change > lifetime > watchdog). If no Watch is running, it runs `renew(channel, "network-change")` and then `noteBackendReturn()`.
  - The runLoop `network-change` branch runs `renew` and re-Watches with no sleep (D:178273–178276).
  - Close disposes the hold (D:178021).

## Heartbeat poll gate (D:178400)
`heartbeat` now polls only when `pendingRequestCount > 0`. `connected` and `notify` always poll.

## UC transport size limits
- L1t (D:177268) passes only `baseUrl`, `agent`, `interceptors` and `httpVersion: "1.1"`. So connect's defaults apply: readMaxBytes = writeMaxBytes = 0xFFFFFFFF (k7e, D:174740–174748).
- The 8 MiB transport cap that this port added has been removed.
- The original's own 8 MiB result limits stay: K_ (D:177275, messages result → Od), the reply-lane budget, and the PJe/Od file caps.

## 后续状态

本文写作时列出的剩余差异后来已经处理：安全轮询改为只在 Watch 期间运行；outageLedger、`ot` nudge（Linux 上为 no-op）、presence-withdraw-failed 日志已移植或确认；retry-expiry oracle 的随机性已固定。仍保留的只有 close 时提前结束 sleep（线上无区别）。详见 [remaining-diffs.md](../remaining-diffs.md) #4–#8、#12。
