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
- `scripts/oracles/uc-bad-frames-{result,manifest}.json`: original unknown outer frame and malformed JSON emit throw-only (default id omitted); valid inner unsupported emits throw+streamClose. Reproduce: `python3 scripts/oracles/run-background.py uc-bad-frames.cjs`. Compat regression compares these saved shapes; when the server sends inner id=1, `nextExecId` also starts at 1 so the reply id remains 1 (tests reset the counter).
- Oracle fixture correction disclosed: an initial `shellId: "synthetic"` was a uint32 decode error, not a valid unsupported handler test; replaced with `"1"`. A separate trial using inner id=7 observed original reallocation to id=1. **t98u:** UC inner-id reallocation is implemented (`allocateExecId` / `nextExecId=1` then assign; do not echo server id). Independent regression: `test/inner-exec-id.test.cjs` (server id=7 → reply id=1; second → 2). Outer `requestId` cancel unchanged.
- `test/followup-fixes.test.cjs`: verifies accepted0/r2/no duplicate refusal retry, exit drain, six-second background semantics and original bad-frame closure policy. Logs: `/tmp/compat-t89u-accepted-drain-green.txt`; full test/smoke logs retain the followup paths above.


## t93u generated protocol migration (uncommitted review worktree)

This section supersedes handwritten-wire descriptions above without relabeling prior t89u/t90u test runs.

| Area | Migration / evidence |
|---|---|
| Production codec / methods | Deleted `src/uc/pb.ts`, raw HTTP UC request helpers, handwritten method paths and envelope parsing. Generated full frozen schema/service in `src/generated/`; runtime/client exact 1.10.1 / Connect 1.6.1, HTTP/1.1 explicitly retained. |
| Reproducibility | `npm run generate` / `generate:check`; buf 1.50.0, protoc-gen-es 1.10.1, protoc-gen-connect-es 1.6.1. Six original files copied byte-for-byte, source hashes in SOURCE.json; seven generated files byte-identical on second generation. No schema subset guessed or service edited. |
| Lifecycle / authority | Existing ReplyQueue, Watch lifetime separation, ack/seen state, 8+64 scheduler, accepted_count terminal refusal, auth rotation, permission ceiling, ownership, box reconnect/auth, process groups and path protection retained. RPC status is explicitly mapped from Connect auth codes; retries still operate on responses, not execution. |
| Runtime adapters | Generated oneof cases, descriptor-derived variant numbers, uint32 acceptedCount and bigint int64. Available inner SandboxPolicy / ShellAbortReason use generated JSON metadata. **t98u:** `ExecServerMessage`/`ExecClientMessage` (+closure) restored in freeze `schema-0.79.3-daemon-exec` from daemon compact descriptors; generated into control+daemon artifacts. UC/box decode with generated `ExecServerMessage.fromJsonString` / `fromJson` and official `ignoreUnknownFields: true` (daemon.formatted.cjs **L136313**: `kd.fromJsonString(e.serverMessageJson, { ignoreUnknownFields: !0 })`). Outbound client/control go through `encodeExecClient*` / `prepareBoxExecFrame` with **no interim fallback**. `handleLs` emits frozen `LsSuccess.directory_tree_root` / `LsDirectoryTreeNode` (proto agent.v1; official LocalLsExecutor ~D:129447–129609). Legacy `{path,entries}` is rejected by encode. Inner-id reallocation matches official `nextExecId`. **P1 follow-up:** top-level `FileDiff` shape corrected. Regressions: `test/inner-exec-id.test.cjs`, `test/exec-codec.test.cjs`. |
| Independent tests | Existing peer imports only independent test wire codec. New generated-protocol.test.cjs covers unknown fields, last-oneof-wins, >2^53 bigint, canonical/unknown enum JSON, split envelopes/endstream metadata, malformed framing, auth statuses and Watch abort. Existing cancellation, accepted0 successor/drain, 503 recovery and credential rotation regressions stay green. |
| Explicit changed assertion: Hello | The legacy independent golden explicitly emits false field7 and empty field9. Canonical proto3 generated writer omits both. Hello comparison now normalizes only those default-valued fields using the independent codec; original golden unchanged, Submit still exact-byte comparison. This is equivalent protobuf, not hiding a field mismatch. |
| Explicit changed assertion: corrupt binary | Previous mixed-batch test combined valid protobuf containing bad JSON/null/missing oneof with structurally truncated protobuf. Kept the former per-item ack/error checks; moved invalid-wire case to a dedicated runtime transport-error/repaired-response test. No partial parse/salvage in production. Isolated official `uc-truncated-poll` observes zero dispatch/acks for corrupt batch then successful valid read after repair, exit0/hard_timeout=false, original SHA256 5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be. D:178491–178518 also places generated Poll decoding before per-item processing and restores acks on transport error. A permanently corrupt server response can stall progress; do not call prefix salvage an official requirement. |
| Audit / remaining | 4 affected packages, 3 high/1 moderate (Zod plus Connect-node/undici/busboy chain); no forced major-version upgrade. Existing generation/PID race and full pressure oracle remain skipped. Approval/scope/account switch, full sessions/files, official Electron42/App and general inner-ID parity remain unproven. No drop-in/exactly-once claim. |

Validation: child **53 tests / 51 pass / 0 fail / 2 skip**; clean locked install, generation check, build, UC smoke and Electron smoke pass. Root build/test **206 pass / 0 fail / 0 skip**; pack dry-run keeps original CLI/MCP and excludes daemon. Logs: `/tmp/local-exec-daemon-t93u-test-final.txt`, `-uc-final.txt`, `-electron-final.txt`; root `/tmp/grokbot-control-t93u-test.txt`, `-pack.json`. Original corrupt-Poll oracle result/manifest checked in under `scripts/oracles/` (no official binary included). Work left uncommitted for independent review; Page unchanged.

### t95u review handoff before reorganization

Per the supplied independent-review outcome, t93u has no blocking finding and is committed separately before any moves. **t98u closed:** inner ExecServerMessage/ExecClientMessage freeze coverage + UC inner-id reallocation (see above). Remaining nonblocking follow-ups: audit advisories, pressure/preemption oracle skips, approval/scope parity, full drop-in. Historical statements saying “uncommitted” above describe the t93u validation stage.

## Exec JSON codec P2 follow-up (post-4a53eb8)

Independent review of `4a53eb8` found **no P1**; two P2s fixed in a **new local commit** (not amend):

| ID | Issue | Fix |
|----|-------|-----|
| P2-1 | `encodeExecClientMessageJson` blank catch too wide — any client encode failure (e.g. legal fields + `typoExtra`) silently passed through | Catch narrowed: only interim ls (`lsResult.success.entries` and no `directory_tree_root` / `directoryTreeRoot`) may fall back; other failures rethrow. Regressions in `test/exec-codec.test.cjs`. |
| P2-2 | Box outbound `emitExec` bypassed Exec* encode | `emitExec` → `prepareBoxExecFrame`: keeps box outer `{kind,requestId,message,...}` shape; inner `message` goes through `encodeExecClientMessage` / `encodeExecClientControlMessage`. Regression proves typoExtra throws on box path. |

Optional P3: README/INTEGRATION test counts set to measured **64 tests: 62 pass / 0 fail / 2 skip**; official `ignoreUnknownFields` cited at daemon.formatted.cjs **L136313**.

Preserved: inner-id reallocation, cancel-by-requestId, accepted_count=0, Watch reconnect, ceiling, process-group cancel, FileDiff shape. Not claimed as drop-in.

## LsSuccess directory_tree_root (post-ebfc679)

| Evidence | Fact |
|----------|------|
| Freeze `agent.v1.proto` | `LsSuccess.directory_tree_root = 1` → `LsDirectoryTreeNode` (`abs_path=1`, `children_dirs=2`, `children_files=3`, `children_were_processed=4`, `full_subtree_extension_counts=5`, `num_files=6`; nested `File.name=1`, optional `terminal_metadata=2`) |
| Official daemon | `LocalLsExecutor` success `new G5({ directoryTreeRoot: f })` (daemon.formatted.cjs ~**L129463**); tree built via ripgrep stream (~**L129484–129609**) |
| Compat implementation | Shallow `readdir` → same JSON camelCase shape via generated `ExecClientMessage.toJson()`; **not** official rg/ignore/character-budget/depth. Not drop-in. |
| Codec | Removed production interim `{entries}` encode fallback; `isInterimLsListingMessage` retained for regressions that assert rejection. |

## Ownership PID superseded + UC busy (post-5f43dc8)

| Topic | Official evidence | Compat action |
|-------|-------------------|---------------|
| PID superseded | `Jae`+`hce` (D:**L79879–79880**, **L81004–81009**); ownership tick sets `supersededForMs` then `FDe` (D:**L179498–179515**, **L79882–79896**) | Implemented: discovery other live pid → `supersededForMs`; exit reason `superseded`. Regression forks daemon and rewrites discovery to parent pid. |
| Generation | Env `SAND_LOCAL_EXEC_GENERATION` (D:**L78804**, **L187205**) published into discovery (D:**L179215**). No daemon-side generation compare in FDe. | Publish only; **not a pending feature** (official also does not compare). |
| Busy 8+64 | `rgt=8`, `_9r=64` (D:**L177859–177860**); when inflight≥8 and backlog≥64 → `F5e` busy string (D:**L135896–135897**, **L178548–178552**) | Already in `pollOnce`; new regression saturates active+backlog and asserts busy text + no admit. |
| superviseBacklog 15s discard / 5s nudge | D:**L178589–178599** | **Implemented** (post-ab9fed0 / 25abe34); `sendKeepAlives` / `keepAliveDueAt` remain residual. |

## superviseBacklog 15s/5s (post-ab9fed0)

| Evidence | Fact |
|----------|------|
| Timers | `m9r=5e3`, `h9r=15e3` (D:**L177855–177856**); keepAliveTick `intervalMs: c9r=500` (D:**L177956**, **L178004–178005**) |
| Semantics | `superviseBacklog`: if backlog nonempty and `now-lastPolledAt > 15s` drain with A9 closing text (D:**L135894–135895**, **L178589–178598**); else if `>= 5s` `requestPoll()` (D:**L178599**) |
| Compat | Implemented on UC provider (`superviseBacklog`, `lastPolledAt`); regressions with injectable now. Full `sendKeepAlives` / `keepAliveDueAt` still residual. |

Also: superseded process regression asserts stdout `received superseded, shutting down`. UC busy test fills via poll path (hanging handleQueued) and is named admission-gate (not e2e load).

## UC backlog admit: promote-before-busy + stall ceiling (post-edc41ff)

| | Official | Lab compat |
|--|----------|------------|
| Busy predicate | `inflight >= 8 && backlog >= 64` (D:**L178548–178552**) | After `runBacklog()` promote, `backlog.length >= 64` → busy |
| Promote | `startRequest.finally` always pulls while `inflight < 8` (D:**L178576–178583**) | `runBacklog()` still gated on `replies.available` (reply-lane backpressure); called **before** each admit busy check so a recovered lane frees slots in-poll |
| Stall | Rare (finally always promotes) | If replies unavailable and backlog already 64, refuse admit so backlog **never > 64** (lab compensation — **not** claimed identical to official predicate) |

Regressions: stall hard-cap; promote-then-admit when `replies.available` + `active<8` + full backlog.



## t101u independent review → fixes (2026-11-08, Asia/Singapore)

Review blocked e984310 (acceptance **failed**). Fixed in d75f9f0 (code+tests) and 2ee10eb (harness); **awaiting re-review**.

| Item | Official oracle | Fix | Status |
|---|---|---|---|
| P1-1 cancel/timeout during first snapshot | start + USER_ABORT, marker absent | lifecycle registered on entry (cancel/shutdown cover snapshot wait, spawn, run, close); no spawn after cancel; timeout armed at spawn (official reports USER_ABORT with timeout=100ms) | matches |
| P1-2 newline cwd injection | official **executes** injected line | cwd is a length-prefixed data field parsed only by Node | intentional security deviation |
| P2-3 request/helper vars | unset next call | name-based exclusion list from dump_bash_state | matches (vars-read) |
| P2-4 partial dump | official keeps old state (grep missing) | START/END + size cap, atomic commit; builtin-only dump | functions/aliases preserved; LAST=x vs official unset = documented deviation |
| P2-5 multi-line alias | exact round-trip | BASH_ALIASES[%q]=%q | matches |
| P2-6 errexit/nounset/pipefail | not persisted | filtered like official | matches |
| P2-7 symlink root | runs in canonical root | logical-or-canonical root check, realpath escape guard kept | matches |
| P3 harness | — | strict diff (ids/envelopes, case set, probe failure → non-zero), deviations.json | run_all.sh RC=0: 39 cases, 32 same, 7 allowed |

Tests: `npm test` in packages/local-exec-daemon → 77 pass / 0 fail / 0 skip.

### Round 2 review → fixes (2026-11-08, Asia/Singapore) — **修正待独立再审**

Reproduced first from evidence (/tmp/independent-r3-lifecycle, -locale, -cwdpersist), then fixed in 10d37df (code + regressions) and 5993cfa (gate).

| Item | Evidence before fix | Fix | After |
|---|---|---|---|
| P2 shutdown vs shared init | lifecycle probe: init bash alive / profile continued after shutdownShells | `terminateInitialSnapshot()` SIGKILLs the init process group (interactive bash ignores SIGTERM; TERM let profile continue) and awaits close; only daemon shutdown calls it, per-request cancel does not | probe: initAliveAtReturn=false, initContinuedAfterShutdown=false, commandRan=false; test "ordinary cancel does not kill shared init" passes |
| P2 emit failure | rejected notice emit left task registered (shutdown never settled) | guarded emitter (sync throw→rejection, first failure latches, aborts job, later emits no-op); body in try/catch/finally that clears timer, unregisters, resolves done | shutdownSettled=true; emit calls bounded (≤2 / ≤3 in tests) |
| P2 locale | official NEXT=C.UTF-8; ours NEXT=C (dump `local LC_ALL=C` overwrote the saved user value) | dump locals renamed `__gb_*` (excluded from dump); byte length via `$(LC_ALL=C; printf ${#PWD})` subshell | matches official golden locale-save/locale-read |
| P2 cwd semantics | official golden cwdpersist reuses `sub` | session cwd reused when workingDirectory omitted; explicit overrides; re-validated against root each use, outside/missing → root; newline never in script | cwdpersist 2/2 same; tests cover explicit override, `cd /tmp` escape, newline |
| P2 deviations.json | per-case whitelist hid any change | field-level rules pinning exact official/ours values (12 rules, 10 cases) | negative tests for all 10 cases |
| P3 run_r3/diff gate | run_r3 exit 0 on probe failure | non-zero on probe exit/empty results; diff requires expected case set + results/events correspondence | negative tests pass |

Counts: `npm test` 95 pass / 0 fail; run_all.sh 46 cases, 36 same, 10 allowed, 0 diff, lifecycle PASS, RC=0.
Unresolved / not claimed: whether the official daemon strips inherited CURSOR_* env at spawn (unverified); behavior of official when session cwd is deleted or outside root (we fall back to root silently, unverified); not drop-in.

### Round 3 review (HEAD eb79982) → fixes (2026-11-08, Asia/Singapore) — **修复待审**

Reviewer confirmed prior items closed (95 pass / 46 cases). Two remaining items, reproduced first:

| Item | Reproduced (before) | Fix | After |
|---|---|---|---|
| P2 init group residue after leader exit | /tmp/independent-r3-initgroups/probe.cjs: init leader gone; profile background (stdio redirected) still `S`, PGID/SID = init pid; marker written after shutdown | `reapInitGroup(pgid)`: at init completion (close) and at shutdown, SIGKILL the init group if members remain. Only signals when /proc shows members with pgrp==sid==pgid and no process with pid==pgid (a live pid==pgid means the id was reused by someone else; the kernel does not reuse an id while its group has members). Per-request cancel never calls it | probe: background gone before and after shutdown, marker not written; regression fails on pre-fix code, passes now; reuse-guard test leaves a foreign group leader alive |
| P3 runner ignores step status | /tmp/independent-r3-runner-negative: probe exit 0 with `status: fail` → FAILED_STEP_RUNNER_EXIT=0 | run_r3.py checks every result; any non-`pass` → non-zero | same probe → exit 2; regression with pass control (0) and failed step (non-zero) |

Counts: `npm test` 98 pass / 0 fail; run_all.sh 46 cases, 36 same, 10 allowed, 0 diff, lifecycle PASS, RC=0. Not drop-in.
Note: reaping at init completion means background jobs started by the user's login profile do not survive the snapshot; official behavior for that case was not measured.

### Round 4 review (HEAD 6a3fc20) → fix (2026-11-08, Asia/Singapore) — **修正待独立复验**

| Item | Reproduced (before) | Fix | After |
|---|---|---|---|
| P2 stale PGID reclaim | /tmp/independent-r3-pgidguard/stale-lifecycle.cjs (kill//proc/spawn intercepted): original group empty at close, number later reused by an unrelated session whose leader exited → shutdown sent SIGKILL to -70001 twice | `InitGroup` ownership handle {pgid, retired}. Retired permanently on first cleanup signal, when found empty / reused (pid==pgid), and at init close. After retirement no path signals the number; /proc look-alikes are never ownership proof. Leader-alive shutdown and the pre-close timeout signal only via the handle | same probe: 0 signals. Regression (subprocess simulation, no real signals): empty→reuse→0 signals; surviving original residue → exactly one SIGKILL at close, none at shutdown |

Counts: `npm test` 98 pass / 0 fail (the earlier reapInitGroup(number) unit test replaced by the ownership simulation); run_all.sh 46 cases, 36 same, 10 allowed, 0 diff, lifecycle PASS, RC=0; /tmp/independent-r3-initgroups probe: no live process, marker not written.
Remaining limits: residue that leaves the group (setsid/own pgrp) is not tracked; between leader reap and the close handler a fully-empty group could in theory be reused before the one close-time check (the pid==pgid guard still applies); login-profile background jobs do not survive init (official not measured). Not drop-in.
