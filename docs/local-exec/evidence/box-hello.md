# Box hello / heartbeat timing

Source: `daemon.formatted.cjs` (D:), offline copy main.cjs sha256 5c1424ed…6be. Static reading only; the official binary was not run.

| Mechanism | Original | Port (`src/box/provider.ts`) |
|---|---|---|
| When hello goes out | `streamRequests` D:137390–137440: after a successful connect it calls `e()` (backoff reset), awaits `currentSupervised()`, then `void postBatch([hello], controlPostDeadline)`. It does **not** wait for `welcome`. | `openSse(onConnected)` runs when the status is 200, then `onConnected()` → `postControl([hello])` (not awaited) |
| hello fields | `{kind,localRoot,terminalsFolder,computerId,label,supervised?,variant?,capabilities:{messagesOp?:true,messagesOpGeneration:gE=4}}` (gE D:97145). **No `standing`.** | same; `standing` removed |
| `messagesOp` | Only when `messages.available()` = y5 D:84695 = `Ed()!==undefined` (sidecar app lookup D:83034) | `locateSidecar()` port; not found on stock Linux |
| label | v_ constructor D:135918–135920: Box passes no computerLabel → `hostname().trim() \|\| "this computer"` | `src/index.ts` |
| postBatch | Direct POST `{providerId, frames}` with 3 tries (imt) 200 ms apart (amt) and the control deadline ok=10 s. After 3 failures it drops the batch and logs `dropping N-frame response batch after 3 failed POSTs` (D:137295–137324) | `postControl()` |
| heartbeat | `hc`/yre D:78435–78590 with intervalMs CJe=1e4 (D:97387). The first tick runs immediately, and each next tick is scheduled intervalMs after the previous one finishes. A tick sends a `ping{supervised?}` and runs `dialedConnectionState`. If the result is "moved", it aborts the current stream only (D:137380–137386, kwr/Pwr D:137196–137205). | `tick()` and `sameConnection()`; `heartbeatMs` is only a test hook |
| welcome | handleRequest D:137512–137515 only sets providerId | same |
| stream end | `finally` disposes the watchdog and heartbeat and sets `providerId=undefined` (D:137472–137474) | `finally` in `start()` |
| redial | `resolveConnection` re-reads the connection on every dial | `resolveConnection: loadConnection` (index.ts) |

Stall watchdog Iwr 35 s, connect deadline Rwr 15 s, reconnect backoff 1 s→10 s and the X() SA/UC switch inside resolveConnection were ported later; see [box-connection.md](box-connection.md) and [connection-exchange.md](connection-exchange.md).

Tests: `test/box-hello-messages-op.test.cjs` (first 6 tests).
