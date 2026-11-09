# Box connection constants (t156)

Evidence is D:137179–137185 (constants) and $L (D:137208–137260):

| Constant | Value | Use |
|---|---|---|
| Twr / vwr | 1 s / 10 s | reconnectBackoff Pu, `until-signal` mode, factor 2, no jitter (B7t: `min(max, initial·2^(attempt−1))`) |
| Rwr | 15 s | connectDeadline Gi: covers resolveConnection, fetch, and the response headers |
| Iwr | 35 s | stallWatchdog xh: armed after hello, kicked on every chunk; fires → abort the stream |
| Cwr | 3 | after this many consecutive failed streams, runLoop calls `onConnectionStale` |
| imt / amt | 3 / 200 ms | postRetry |
| ok / E0 | 10 s / 120 s | control / data post deadlines |
| CJe | 10 s | heartbeat |

## runLoop, D:137338–137377
- Starts with `e=1, r=0`.
- streamRequests success (connect) → `e=1, r=0`.
- A throw → `r+=1`. Any abort (stall, moved, deadline, redial) counts as a throw. A normal stream end does not.
- When `r>=3` and onConnectionStale is set → reset r, call it, and log a failure as `stale-connection re-resolve failed`.
- Wait `schedule(e)`, which `wakeFromReconnectBackoff` can interrupt, then `e+=1`.
- Every HTTP status, including 401/403, is retried. The old port stopped permanently on GET 401/403; that is removed.

## Port (`src/box/provider.ts`)
- `start` / `streamRequests` / `redial` / `wakeFromReconnectBackoff` follow the original.
- An injectable `clock` drives all four timers: deadline, backoff, watchdog, heartbeat.
- Tests: `test/uc-messages-op-box-timing.test.cjs` (fake clock; no long real sleeps).

## t158 alignment
- **Timers are unref'd.** The default clock `boxRealClock` calls `setTimeout(...).unref()`, matching qr.schedule (D:78117–78140). Only Pu with keepEventLoopAliveDuringWaits keeps timers referenced (D:78244), and no Box policy sets it. This covers the deadline (Gi D:78186), backoff/postRetry (Pu D:78223), watchdog (xh D:78300) and heartbeat (yre D:78435).
- **close behaves like the original.** close does only `closed=true; abortController?.abort()` (D:137284). It does not wake the backoff wait, and stop() does not drain the outbox. Tests: `await running` became `Promise.race([running, 50ms])`.
- **Data lane follows the original.** The NOT-ORIGINAL ReplyQueue is removed, and the port now matches the original's whole-outbox flush and drop behavior:
  - `enqueue` = push + flush (D:137293–137306).
  - While the outbox is non-empty and not closed, flush POSTs the whole outbox (`{providerId, frames}`) to `${baseUrl}/local-exec/responses`.
  - Each attempt has the 120 s E0 deadline. postRetry makes imt=3 attempts with a fixed 200 ms between them (D:137307–137330).
  - Each attempt resolves the connection via `resolveResponseConnection ?? resolveConnection`.
  - Headers come from cmt: content-type plus headers, then `authorization: Bearer`.
  - After 3 failures it logs `[local-exec-provider] dropping N-frame response batch after 3 failed POSTs: ${xt(cause)}` and discards the batch.
  - xt (D:78680) is ported as `describeError`: `name (code)`, else an `E[A-Z_]+` code from the cause chain, else the name.
  - Errors: a non-ok response throws `SandLocalExecResponsePostError (http_<status>)`; a timeout throws `DeadlineExceededError (deadline_exceeded)`.
  - 401/403 no longer pause the lane.
- **Control POSTs (hello/ping)** use the same postBatch with a 10 s control deadline.
- **SSE request headers** are `{accept:"text/event-stream", ...headers}` (D:cmt 137186).
- Tests: `test/box-lane-local-tool.test.cjs`, covering batching [1] then [2,3], 3×500 drop log, 3×120 s deadline drop, post-stop no-flush, unref, and xt.

## onConnectionStale (t159: implemented — see connection-exchange-evidence.md)
- runLoop (D:137338–137377): after Cwr=3 consecutive failed streams, onConnectionStale is awaited and r is reset. A failure is logged as `[local-exec-provider] stale-connection re-resolve failed: ${xt}`.
- The daemon passes ge (D:179267–179277), which calls O9r: a plain HTTP JSON POST, ported the same way the original does it.
