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

## Deviations and gaps
- **Shutdown:** close() also ends the backoff wait, so stop() can await start(). The original start() is fire-and-forget.
- **Timers stay referenced:** the original's qr unrefs its timers. The port does not, to avoid the daemon exiting while it waits.
- **onConnectionStale is not wired:** in the original it is ge (D:179267–179275), which exchanges the UC credential for a new connection with the backend. That exchange RPC was not ported, so the option exists but index.ts does not pass it.
- **Data outbox is not aligned:** the original flush POSTs the whole outbox, 3 tries per batch with a 120 s deadline, and drops after that. The port still uses ReplyQueue, which retries indefinitely and pauses the lane on 401/403.
