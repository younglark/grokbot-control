# cf2ba0c review repairs — t89u worktree (including independent follow-up)

Historical t89u review was worktree-only (no push/Page/install/account changes). Under t90u, the reviewed work is integrated into `local-exec-daemon/` in grokbot-control, with an authorized repository commit/push. Original test statistics below remain historical; integration validation is recorded separately.

## Follow-up repair matrix

| Finding | Repair and independent evidence | Remaining limit |
|---|---|---|
| P1-A Watch/provider lifetime | `uc/provider.ts start` now owns reconnect loop and preserves tasks, queue-id seen, pending acks, presence and reply lane across Watch close. `index.ts` no longer stop/recreates provider on connection end. Actual shutdown closes admission, awaits abort-result emission, drains boundedly, then stops lane. Box stop likewise waits its active jobs. Tests close Watch mid-shell and verify done/exit after reconnect; shutdown verifies aborted exit + streamClose + Withdraw. | Explicit shutdown has 1s task and 1.5s reply drain deadlines; offline/auth-rejected peer cannot guarantee delivery at process exit. No on-disk reply durability. |
| P1-B malformed Poll item | Per-item decoding/JSON/oneof validation; preserves decoded queue/request identity even from a truncated protobuf prefix. Bad identified items get a throw response and ack; same-batch valid item executes. Repros include invalid JSON, JSON null, missing oneof, truncated frame. | An item whose queue id itself is corrupt/missing cannot be safely acknowledged. Whole malformed outer Poll envelope remains a transport error, not a request. |
| P1-C ceiling | `settings.ts effectivePermission` implements official nI rank never < ask < always, defaults Ask. Independent 4×4 truth-table fixture and unknown-value fail-closed test; live tightening prevents subsequent command. UC policy Watch is reannounced without resetting task state. | Unknown/malformed settings fall back Ask, which this implementation cannot approve; no execution. Already-running tasks are not retroactively revoked. |
| P2-A transient/auth recovery | `transport/replies.ts` retains bounded lane bytes and retries transient failure indefinitely with capped 2s backoff, rather than treating five 503s as auth loss. Saturation backpressures producers and admission, not lane reset. 401/403 pauses same lane. Same-machine/backend/scope synthetic credential rotation resumes with fresh credential wrapping the SAME response payloads. HTTP-success accepted_count below the sent batch size is a terminal server refusal: log once, complete that batch, continue; it is NOT retried. Only network/HTTP failures retain/retry bytes. | 8 MiB/256 queued replies plus bounded pending-producer credits (64/8 MiB). A single oversized response or producer-credit overflow is an explicit error, not supported unlimited output. Ambiguous HTTP can replay a reply; no cross-restart exactly-once. Cross-account/scope replacement remains unsupported/fail-closed. |
| P2-B normal background/pipe | **Original oracles measured first:** 4s background drains naturally (~4056ms). Both `sleep 6 & echo hi` and delayed `(sleep 6; echo later) & echo hi` return exit at ~5.04s, with background PID alive at exit; 2.5s later streamClose is present and no `later` stdout arrived. Keep the observed five-second normal drain (not a new safety policy), never TERM/KILL normal background just to force exit. Abort/timeout/shutdown remain independently bounded. | These finite measurements do not prove every shell/background variant, job state, output FD or future runtime. Complete resource/session lifecycle remains incomplete. |
| P2-C independent peer | `test/helpers/uc-fake-peer.cjs` imports **only independent** `wire-oracle.cjs`, not production pb. Python-generated frozen-proto goldens compare production Hello and Submit bytes; Withdraw field3 presence must match Watch; accepted_count has independent 0800/0801/0802 fixtures. Watch break, bad batch, ceiling, six-503 recovery, 401 rotation, accepted0 recovery and no re-execution tests added. | This is an independently coded finite schema subset, not full generated protobuf conformance or real-server acceptance. |
| P3 capacity / duplicate IDs | Poll limit follows free 8+64 admission capacity (minimum one control slot so cancellation stays reachable). Queue-id acks separate from request-id inflight dedup. Independent loopback test verifies limit=2 and two queue IDs targeting same active request. Official `startRequest` silently returns for inflight duplicate; preserved rather than inventing a response. Backlog is not a persistent dedup ledger. | Full official stale-backlog expiry, fairness, keepalive/overload variant parity and cross-restart semantics remain unverified. |
| P3 fd race | Read resolves canonical path, opens O_NOFOLLOW, fstats the actual handle and on Linux validates `/proc/self/fd/<fd>` relative to real root before reading. Injected parent-directory swap opens an outside fd; regression verifies refusal and no outside bytes. | NOT openat2/dirfd confinement: Linux procfs dependency; path rename/mount/content races, ls/cwd races and other platforms not fully closed. fstat alone is NOT claimed sufficient. Filesystem guards are NOT shell sandboxing. |

## Original review matrix (retained, not silently closed)

| Finding | State |
|---|---|
| P1-1 | Dedicated POSIX process group, TERM/KILL escalation, 750ms cancellation bound and shutdown cleanup of active groups; `sleep 300 & wait` regression. Deliberate setsid escape/complete long-lived background tracking are outside this shell subset. |
| P1-2 | cwd errors caught, spawn error listener, throw+streamClose and async transport isolation. Invalid cwd then valid next request; injected spawn ENOENT tested. |
| P1-3 | read/ls/cwd realpath/relative boundary, sibling root2 symlink refusal. Read fd race strengthened above; not full portable sandbox. |
| P1-4 | All documented outer oneof fields parsed; field6 cancels active/backlog. Unsupported error mapping no longer silent. Upload/download/retire/messages/local-tool/discover/URL business paths remain incomplete vs original. |
| P1-5 | Bounded reply lane, checked HTTP/accepted count, transient recovery and authentication distinction. No durable recovery/exactly-once claim. |
| P2-1 | Poll loop, ack confirmation cleanup, 8+64 admission and cancel at capacity. Full pressure oracle remains skipped. |
| P2-2 | Per-admission settings + effective ceiling, conservative authoritative Ask, same-scope credential rotation. Full approval/standing/account-switch semantics absent, not advertised as working. UC policy re-Hello added; Box policy announcement refresh beyond new welcome is still incomplete. |
| P2-3 | Supervisor/lease shutdown enabled by default with attached transports, bounded inflight grace and aggregate Box+UC inflight count. Box SSE reconnect + synthetic token/custom headers tested. Generation/PID supersession still skipped. |
| P3 timeout | Correct TIMEOUT vs USER_ABORT enum, cancel/timeout regressions retained. |
| P3 Hello | UC empty kind field9 and aiToolSetup false; Hello independent golden. Box kind remains required transport discriminator hello. |
| P3 unary / int64 | Raw unary protobuf is never guessed as envelope; bounded BigInt varint parsing with truncation checks; independent timestamp fixture. |
| P3 Read size/binary | Bounded UTF-8 text subset, stat byte size, explicit binary/invalid-UTF8/oversize refusal. Full original image/PDF/stream/range support remains absent. |

## Reproducible evidence

- `test/followup-fixes.test.cjs`: first baseline **6 tests, 1 pass / 5 fail** captured before production repairs at `/tmp/compat-t89u-followup-red.txt`. Five failures were ceiling, Watch lifecycle, poisoned batch, fifth-failure cutoff, and normal background timing. The latter expected timing was corrected ONLY after measuring original behavior, not to hide a local-exec-daemon discrepancy.
- `test/fixtures/uc-wire.json`: independent Python input fixtures, every request oneof and enqueued_at_ms=1794055511678; frozen proto path/SHA256 recorded.
- `test/fixtures/uc-outbound-goldens.json`: independent Python Hello/Submit/accepted_count goldens, frozen proto path/SHA256 recorded.
- `scripts/oracles/background-result.json`: isolated original result. `python3 scripts/oracles/run-background.py` reruns with readonly original input, bwrap network/PID/mount isolation and 25s hard deadline; precise runner process-group cleanup, no other project writes.
- Official static source: `/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs`: nI (permission/ceiling), startRequest (inflight duplicate), f0 (timeout), FDe (ownership), Y_ (Submit encoding), w9r/z2 (unsupported).

## Commands / results

```
npm run build
npm test
npm run smoke:uc
npm run smoke:electron
```

Final full run: **46 tests, 44 pass / 0 fail / 2 skip**. Build, smoke:uc and smoke:electron exited 0. Logs: `/tmp/compat-t89u-followup-all.txt`, `/tmp/compat-t89u-followup-uc.txt`, `/tmp/compat-t89u-followup-electron.txt`. Skips remain generation/PID supersession and full pressure oracle. No complete drop-in claim.

## Latest independent acceptance/drain follow-up

- New red log `/tmp/compat-t89u-accepted-drain-red.txt`: accepted0 head-of-line blocking reproduced. The second initial test expected a 6s wait; that premise was **refuted by original oracle**, so production drain policy was not changed to satisfy it.
- `uc/provider.ts`: successful Submit with accepted_count < sent count now follows original `a.acceptedCount < n.length` log-only behavior, then the lane advances. Independent r1=0/r2=1 fixture verifies r1 result/close are each submitted once, r2 completes and shutdown drains; transient six-503 and credential-rotation tests remain separate.
- `scripts/oracles/background-long-{result,manifest}.json`: original 6s cases, readonly input SHA256 and precise PID namespace cleanup. Reproduce: `python3 scripts/oracles/run-background.py background-long.cjs` (25s hard timeout).
- `scripts/oracles/uc-bad-frames-{result,manifest}.json`: original unknown outer frame and malformed JSON emit throw-only (default id omitted); valid inner unsupported emits throw+streamClose. Reproduce: `python3 scripts/oracles/run-background.py uc-bad-frames.cjs`. Compat regression directly compares these saved response shapes, using the same canonical inner id=1.
- Oracle fixture correction disclosed: an initial `shellId: "synthetic"` was a uint32 decode error, not a valid unsupported handler test; replaced with `"1"`. A separate trial using inner id=7 observed original reallocation to id=1. General UC inner-id allocation parity is not repaired/claimed by this closure-policy test and remains an explicit gap; final source/fixture/test use identical id=1, no silent ID normalization.
- `test/followup-fixes.test.cjs`: verifies accepted0/r2/no duplicate refusal retry, exit drain, six-second background semantics and original bad-frame closure policy. Logs: `/tmp/compat-t89u-accepted-drain-green.txt`; full test/smoke logs retain the followup paths above.
