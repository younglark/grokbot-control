# local-exec-daemon 审查修复轮次（历史）

> 存档：原 `packages/local-exec-daemon/REVIEW-FIXES.md`，t89u 起各轮审查发现、红/绿证据和当时剩余缺口的逐轮记录。很多“剩余缺口”后来已修复；当前状态以 [local-exec/remaining-diffs.md](../local-exec/remaining-diffs.md) 为准。

原标题：cf2ba0c review repairs — t89u worktree (including independent follow-up)

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

### Round 5 review (HEAD 434f1cc) → fix (2026-11-08, Asia/Singapore) — **修正待独立复验**

| Item | Reproduced (before) | Fix | After |
|---|---|---|---|
| P2 init-timeout regression | /tmp/independent-r3-init-timeout/probe.cjs on a 434f1cc worktree build: leader gone, same-group background (stdout not redirected) still `S` after the 10 s timeout, marker=true | timeout and shutdown both use one `cleanupInitGroup(handle)`: leader unreaped → group SIGKILL; leader exited → /proc reap (empty/reused → retire, no signal); no-op once retired. Close path unchanged: one reap then permanent retirement | same probe, real default 10 s, run twice: marker=false; background null in one run, in the other still listed in state `R` at the instant of return (SIGKILL already sent, not yet reaped), never wrote. New real regression (600 ms injected timeout) fails with the old timeout line, passes now |

Path audit (all same-handle paths): close → reapInitGroup once + retire; timeout → cleanupInitGroup; shutdown → cleanupInitGroup then await close; signalInitGroup retires before signalling, so a later path never signals again.
Counts: `npm test` 99 pass / 0 fail; run_all.sh 46 / 36 / 10 / 0 diff, lifecycle PASS, RC=0; stale-lifecycle 0 signals; initgroups no live process, marker false.
Risks: finish("") does not wait for the killed residue to be reaped (signal is sent before finish); residue that left the group via setsid is not tracked; theoretical reuse window between leader reap and the first cleanup relies on the pid==pgid guard. Not drop-in.

## t103u batch: UC keepalive (2026-11-08, Asia/Singapore) — **执行方自测，待独立复验**

Baseline: previous batch independently accepted; 56ee14c pushed. This batch is local commit d8b1d87 (not pushed).

Choice: plan listed `sendKeepAlives / keepAliveDueAt` as the remaining UC transport gap next to superviseBacklog (already done); it is bounded, has static evidence (D:L178601–178661, A9r L178849, constants L177848–177854) and is testable offline with the existing fake UC peer. Approval/standing/scope needs a settings/authorization oracle and was left for a later batch.

Official oracle (unchanged 0.79.3 main.cjs in bwrap, synthetic credential, fake Connect peer): `scripts/oracles/uc-keepalive.cjs` scenarios backlog / cancel / stall / exhausted; goldens in `keepalive-official/`, ours in `keepalive-ours/`; `keepalive-diff.py` compares keepalive id sequences exactly, offsets within 300 ms, the cancelled-backlog frame, and step status.

| Behavior | Official (measured) | Ours before | Ours now |
|---|---|---|---|
| keepalive frames | messagesAccepted for backlog / queued-reply / submitting ids; not for running requests with nothing queued; first ≈1.47 s after enqueue, then +3.0 s | none | same **for the keepalive subset only** (4/4 scenarios: keepalive ids/offsets, sh8 frame, step status; data submits were NOT compared — corrected in t104 review round) |
| ResourceExhausted on keepalive | next keepalive +5 s | n/a | same |
| cancel of backlog item | keepalives stop; throw "Cancelled before it started on the user's computer." | silently removed | same |
| slow data submit (7 s) | single submit waits (deadline 120 s) | re-submitted the same frame every ≈2.4 s (2 s timeout) | 120 s deadline, single submit |
| submit batching | several frames per submit | one frame per submit | **unchanged, documented deviation** |

Tick is serial like official hc/yre (next tick 500 ms after the previous completes). Auth error on a keepalive closes admission like other UC calls. Not verified against official: keepalive under Watch reconnect/credential rotation, stuck-submit ≥120 s cutoff (unit-tested only), more than 256 due ids.
Counts: `npm test` 107 pass / 0 fail (99 + 8 new: 6 unit, 2 bwrap oracle runs); r3 strict differential unchanged 46 / 36 / 10 / 0 diff, lifecycle PASS, RC=0.

## t103u review round (reviewer blocked 5bb3443: 4×P2 + 1×P3) — **执行方自测，待独立再审**

Not pushed, no amend/rebase, no real backend. Each item was first reproduced against 5bb3443 with the reviewer's evidence (/tmp/independent-uc-keepalive-103/review/evidence.json), then fixed. The reviewer's original probe scripts (/tmp/independent-uc-ka-{pressure,rotation,cancel}) were re-run unchanged against the new build.

| Item | Reproduced on 5bb3443 | Official (0.79.3 oracle) | Fix | Measured now |
|---|---|---|---|---|
| P2-1 closing frames under reply pressure | `pressure`: daemon exit 1 at 5.8 s, unhandled "reply producer capacity exceeded" | survives | closing replies (busy / cancelled-before-start / backlog drained / unsupported) go through `emitClosing`→`sendClosing`; async rejection is caught and deferred to a bounded queue (128, overflow logged), retried in order from the keepalive tick | `pressure` daemon alive, death gate pass; reviewer's probe: childExit null; unit test: 200 rejections → 0 unhandled, 128 kept, overflow logged, flushed in order |
| P2-2 stale credential 401 | `rotation`: old keepalive 401 closed the new channel (no events after old401) | channel-identity check in `rejectCredential` | `rejectCredential(ch)` acts only if `this.channel === ch` (poll, keepalive, watch); reply lane raises 401 only for the current channel | keepalives with new credential continue after old401 (official and ours: 3 keepalives, `sh8`+`post`); reviewer's probe: keepalive at old401+504 ms |
| P2-3 non-cancellable 120 s submit | `stall-cancel`: request `two` got no data in window | `replies.drop` + `submitAbort`: old submit closed +4 ms, `two` first frame +7 ms | per-submit AbortController; `ReplyQueue.drop(isCancelled)` drops queued replies of cancelled ids and aborts the in-flight submit only if every item in it is cancelled; `stop()` aborts too. Non-cancelled slow submits keep the 120 s deadline. Also: queued frames now merge into one submit (official `replies.take()`), and poll drains back-to-back while acks are pending (official pollOnce loop) | reviewer's probe: abort +5 ms, `two` first frame +11 ms (official same run +4 / +7); comparator `stall-cancel` SAME |
| P2-4 death gate | daemon SIGKILL mid-run still produced pass | n/a | scenario marks fail if daemon dies before cleanup (exit code 3); `run-background.py` exits non-zero on missing/failed results; comparator requires all results pass | `--kill-at=3000` negative test: scenario fail, runner ≠0, comparator ≠0 |
| P3 comparator | deleting all data submits still SAME | n/a | per request id: presence, same id set, ordered decoded messages (start…exit/streamClose) must match after the explicit rules below | negative tests: all data deleted / one id missing / no exit / no streamClose / changed stdout / inconsistent exec id / no abort / late next request / no keepalive after stale 401 / dead daemon / cancelled id still keepalived → all non-zero |

Explicit allowed differences in `keepalive-diff.py` (anything else fails):
- chunking/batching: consecutive stdout/stderr chunks of one id are concatenated; submit batch boundaries are ignored (data is compared per request id); `localExecutionTimeMs` removed.
- EXEC-ID: inner exec id is a local admission sequence (differs between fresh official runs); each side must use one id per request and distinct ids across requests.
- EXEC-HEARTBEAT (**open deviation, newly surfaced**): official writes `{"heartbeat":{"id":N}}` while an exec runs (D:L98140–98153); ours does not. Only that exact message is removed and its count printed (backlog/cancel/rotation: official 16, ours 0).
- pressure: which of 8 identical streaming shells reaches the first 10 s-delayed submit races in both daemons; only count and first message kind of ids with data are compared; pre-cancel keepalive id sets must be equal and no cancelled id may be keepalived after cancel+300 ms.

Goldens: official re-recorded fresh for all 7 scenarios (old 4 had no data fields); fresh official keepalive ids/offsets consistent with the previous official goldens (backlog differs only in `localExecutionTimeMs`). Official main.cjs SHA256 5c1424ed… equals `dist/local-exec-daemon/main.cjs` extracted from the 0.79.3 app.asar. Tests compare ours only against official goldens; `keepalive-ours/` is reference only.

Counts: `npm test` 118 pass / 0 fail (107 + 11: 7-scenario bwrap oracle instead of 2, P2-1/P2-2/P2-3/merge/P3/death-gate tests); r3 strict differential 46 / 36 / 10 / 0 diff, lifecycle PASS, RC=0.

Unverified / open: exec heartbeat not implemented; rotation keepalive is a ±1 tick (500 ms) boundary race (ours was one tick late in 1 of 7 rotation runs, official 0 of 4); batching limit 256 frames per submit is our choice (official take() limit not measured); closing-frame retry budget (official `closingSince`/x9r) not reproduced; >256 due ids, stuck ≥120 s cutoff and real backend behavior not tested. Not drop-in.

## t103u review round 2 (reviewer blocked fa46d0f: P2-1, P2-2, P3) — **执行方自测，待独立再审**

Not pushed / no amend / no real backend. Evidence index /tmp/independent-t104/review/evidence.json; each item reproduced first.

| Item | Reproduced on fa46d0f | Fix | Measured now |
|---|---|---|---|
| P2-1 busy overflow | reviewer probe (8 active + 64 backlog + 200 busy, first submit stalled 10 s): official acked 200 / terminal 200; ours acked 200 / terminal 184, busy184–199 dropped after ACK | Closing replies are stored synchronously (`ReplyQueue.offer`) or in the bounded deferral list (128); if neither can hold the terminal frame the work stays retryable: busy/parse-error queue item is **not acknowledged** (removed from pendingAcks/seen → redelivered), a cancel that would orphan backlog closings stays unacknowledged, a stale-backlog item stays in the backlog, an unsupported-kind job waits in its own slot. No unbounded queue, no higher limit. Deferred closings are held + keepalive-eligible (official `replies.requestIds()`). | reviewer probe unchanged: ours acked 200 / terminal 200, no drop log; new `overflow` oracle scenario official vs ours 3×3 runs: 9/9 SAME (all 200 acked = terminal, same error text, none started); reviewer component `deferred-closing-keepalive`: afterDue true, keepalive sent |
| P2-2 rotation in the catch window | reviewer component (RPC 401 → `queueMicrotask(updateChannel)`): rotated, but blocked=true, new signal aborted, failure 401 | `HttpStatusError(401, channel)` carries the channel identity; the ReplyQueue asks the owner at the point it would set `failure`; the owner refuses when the identity is no longer current, and the batch is retried at once on the current channel | reviewer component: blocked false, aborted false, failure undefined; in-process regression with real start/stop: same reply resubmitted with the new credential; current-channel 401 still fails the lane |
| P3 stall-cancel | fresh 6 SAME / 1 FAIL: official had `hi` stdout for the cancelled `one`, ours not; 3 later pairs SAME | Root cause: official `replies.drop(requestId)` removes queued frames too, so whether `hi` survives depends on whether `echo` output was read before or after the cancel (race in both daemons). Probe now uses `sleep 30` for `one` (nothing emitted between start and cancel). | 3 official × 3 ours: 9/9 SAME; official vs official 6/6 SAME |
| P3 rotation third keepalive | ours 7471 vs official 6963 (+508 ms) in 1 of 7 | Located (instrumented ours, 20 runs, not committed): keepalive due = heard + 3000 ms, picked by the 6th serial 500 ms tick, i.e. a sub-ms tie; Node timers fire against libuv's integer-ms clock while dues use `performance.now()`. Measured per-tick gaps 499.1–501.6 ms, 6th-tick margin +0.2…+5.7 ms; a negative margin defers by exactly one tick. Official uses the same mechanism (yre/qr.schedule setTimeout + monotonicNow, c9r 500, u9r 3000). Comparator: named rule TICK-BOUNDARY — exactly one shift of 500 ± 50 ms, never on the first keepalive, at most once per run, later keepalives must keep the shifted cadence; general tolerance stays 300 ms. | repeats this round: official 0/20 late, ours 0/20 late (20 official + 20 ours independent runs; the "400" figure was 400 cross-pairings of those 40 runs, NOT 400 runs; strict SAME, TICK-BOUNDARY=0) + 0/20 instrumented; overall ours 1/47, official 0/27. Negative tests: +400, +620, +1000, first-keepalive shift, two shifts → all fail; +508 → SAME with TICK-BOUNDARY=1 |

Kept: closed items from the previous round (pressure unhandled rejection, stale keepalive 401, submit cancel/partial batch/stop abort, death gate 3 s/7 s, 13 data negatives). Counts: `npm test` 122 pass / 0 fail (118 + 4 new; overflow added to the bwrap oracle loop); r3 46 / 36 / 10 / 0 diff, lifecycle PASS, RC=0. Goldens: overflow and stall-cancel re-recorded from fresh official runs; others unchanged.

Unverified / open: exec heartbeat (official 16, ours 0) still not implemented; why ours missed one tick in 1/47 runs while official 0/27 is not proven (hypothesis only: ours also runs a 250 ms poll setInterval in the same timers phase); redelivery of unacknowledged items depends on the server keeping unacked queue items (true for the fake peer; real backend not tested); unsupported-kind job retry and cancel-without-room paths unit-tested only. Not drop-in.


## Round 3 (t106, on 7877ec3) — independent review of the rotation item did NOT pass

Status split:
- **Closed (confirmed by reviewer, not touched this round):** both P2 groups, stall-cancel stabilisation, 122 tests / 46 cases, overflow 9 pairs.
- **Rotation late tick (P3) — previous round's claim was wrong.** Independent evidence (/tmp/independent-t105/review/evidence.json): 26 independent pairs, official 0/26 late, ours 3/26 late (~505 ms, e.g. 6982 vs 7487). Our comparator reported those as default SAME via TICK-BOUNDARY=1; accepting a synthetic +500 as SAME was masking, not a fix.

Comparator fix (keepalive-diff.py): a one-tick (500 ± band) shift on keepalive #i>0 is now `UNRESOLVED tick-boundary` → FAIL, rc≠0. 300 ms gate unchanged. Negative tests: +400, +500, +508, +620, +1000, shifted cadence, first-keepalive shift → all fail. Reviewer's late file → FAIL rc=1.

Root cause (dynamic, offline synthetic instrumentation of both sides via NODE_OPTIONS preload; not committed):
- keepalive due = heard + 3000 is picked by the 6th 500 ms tick, a sub-ms tie. Official schedules ticks via setTimeout + performance.now and has **no fast poll timer** (Watch/notify/heartbeat-driven polls + S9r 30 s safety poll).
- Ours had a 250 ms poll setInterval. Before fix (16 official + 16 ours instrumented runs): mean per-tick lateness official 0.465–0.57 ms vs ours 0.24–0.30 ms; 6th-tick margin official +3.16…+8.15 ms, ours −0.15…+3.6 ms (1 late run, margin −0.15 → gap 3503). Timer fires within 2 ms before a tick: ours 250 ms interval ×9, 1000 ms interval ×6; official none.
- Experiment (only interval → 30 s): mean lateness 0.535 ms, KA3−KA2 3005–3007.

Fix (provider.ts): poll interval = `UC_SAFETY_POLL_MS` 30 000 (official S9r); polling otherwise event-driven. Side effect found by overflow (acked/terminal 128): unacked busy items need a re-poll → `unackedWaiting` triggers one poll when closing room frees. No tolerance widened, nothing sent early.

After fix:
- npm test 124/124 (122 + 2 new: timer-shape regression asserting intervals == [30000]; unacked re-poll).
- r3 differential 46 cases: 36 same / 10 allowed / 0 diff, lifecycle PASS.
- 7 scenarios + overflow vs official goldens: all SAME (overflow 200/200).
- Strict rotation: **20 independent pairs (20 fresh official + 20 fresh ours runs)** all SAME, TICK-BOUNDARY=0.
- 10 instrumented ours runs: 6th-tick margin +2.76…+4.70 ms (all positive), mean per-tick lateness 0.45 ms (110 ticks), KA3−KA2 3004–3007.

Risks / not proven:
- Cause supported by dynamic data, not a deterministic proof; the regression test pins the timer shape, not the sub-ms phase.
- index.ts 1000 ms setInterval (tryStartBox) remains and still co-fires occasionally.
- Admission now waits for Watch events / 30 s safety poll instead of 250 ms polling; unacked redelivery depends on server.
- Pending independent re-review; no compatibility/acceptance/drop-in claimed.

## Round 4 (t107, on cd72af6) — P2 cancel behind overflow (fix pending independent re-review)

Reviewer evidence (/tmp/independent-t106/cancel-behind-overflow): first Submit (target only) stalls 10 s; then 8 active (stdout flood) + 64 backlog + 200 busy, then cancel target. Official: busy ACK 200, target aborted 4–5 ms after cancel, USER_ABORT exit. Ours (cd72af6): busy ACK 128, no cancel ACK/abort/exit within 3 s (cancel only +7004 ms after the submit recovered).

Reproduced locally on cd72af6 (1/1 FAIL, same signature).

Root cause: the reply lane is full of stdout during the stall, so busy closing replies went to the deferral list capped at 128. Busy #128+ were left unACKed (correct: no ACK-then-drop), but the peer queue is FIFO and only advances on ACK, so the unACKed busy items sat at its head and the cancel behind them was never delivered. Official ACKs everything because its reply lanes (oee.push) hold closings without a cap.

Constraint analysis: with no-ACK-then-drop and a FIFO queue that only advances on ACK, a control behind K unACKable items needs K held closing replies. So bounded memory cannot guarantee control reachability for an arbitrarily long flood during a reply stall; any bound has a K beyond which the cancel waits for the lane to recover (then it is delivered — nothing is dropped). Official avoids this only by being unbounded. No new fields/endpoints exist in the frozen proto to bypass FIFO (Poll has ack_ids/limit only), and official uses no persistence for replies, so no SQLite was added. **[Superseded t108: "nothing is dropped" refuted (atomic-cancel loss); the bounded-memory constraint was self-imposed — per user direction t104u the queue now matches the original (unbounded), see Round 5.]**

Fix (provider.ts): closing replies are small and fixed-shape (requestId + shared constant text). The deferral is now budgeted by accounted bytes (`closingCost` = 96 + 2·len(requestId), total ≤ 1 MiB = 1/8 of the 8 MiB lane) and count (≤ 8192) instead of 128 entries: ≥ 4681 closings even with 64-char ids. Beyond the budget behaviour is unchanged (unACK, redelivered). **[Correction t108] "never dropped" was refuted by the reviewer: the cancel path estimated room at 224 B/entry and ignored storeClosing()==false, so a 2000-char backlog target was removed and its cancel ACKed with no terminal (atomic-cancel component; backlog-terminal-loss probe, ours terminal 0/official 1). Also the original P2 was NOT closed: 520 busy × 1024-char ids exceeded the budget (ours ACK 489, cancel blocked; official ACK 520, +4 ms). Round 4 was a 200-case capacity mitigation only.** Not changed: poll limit (an earlier closed test pins it), queue semantics, fake peer, pressure, timing, comparator.

After fix:
- cancel-overflow probe (scenario added to scripts/oracles/uc-keepalive.cjs as in the reviewer's probe; assert-cancel.py added; runner no longer truncates stdout at 64 KiB): final code: 4 independent ours runs (3 probe + 1 in npm test) all PASS, busyAcked 200, abort 5–6 ms after cancel (3 earlier runs of a discarded poll-limit-64 variant also passed, not counted), USER_ABORT exit; 3 official runs PASS (abort 4–6 ms) + 1 in npm test.
- npm test 127/127 (124 + budget regression + cancel-overflow oracle official + ours).
- r3 46/36/10/0, lifecycle PASS; 8 scenarios vs golden in npm test; overflow 3 fresh pairs SAME 200/200; rotation 5 fresh strict pairs SAME, TICK-BOUNDARY=0.

Risks: bounded ⇒ a flood larger than the budget (~4.7k+ busy during one reply stall) still delays control until recovery (documented limit, not equivalent to official); real backend redelivery/order not tested; up to ~1 MiB extra memory.


## Round 5 (t108, on 16ca778) — atomic cancel fix, then queue aligned with the original (t104u direction)

1. Atomic backlog cancel (dfac2f9, 0e8beb3): the cancel now builds the actual closing frames, reserves them by real requestId cost (all or nothing) before removing backlog entries and ACKing; on failure nothing is removed and the cancel stays unACKed. Reviewer component: before backlog 0/cancelled/ACKed/no terminal → after backlog 1, not cancelled, no ACK. Regression with the reviewer's exact prefill (4677×64 + 1024-char target, two entries, no half-save).

2. The user then directed (t104u): match the original daemon instead of our self-imposed bounded-memory design (no disk outbox). Original mechanism (daemon.formatted.cjs):
   - Reply storage `oee` (L177276–177400): `lanes = Map<requestId,{frames}>`, `push` appends with **no cap**; `take()` builds ONE submit by rounds, one frame per lane per round, limit X7e=256 frames / K_=8 MiB / j2=1 MiB file bytes; taken lanes rotate to the end; `requeue` puts frames back at the front; `drop(requestId)` deletes the lane.
   - Producers: `enqueue(e)` = `replies.push` + `flush()`, synchronous — executors are never backpressured.
   - `flush()` (L178671) serial, one submit at a time; `submit` retries (submitRetry) then keeps only closing frames past budget rules and drops the rest (L178707–178760).
   - Poll (L178457–178557): limit tgt=64 always; **every** polled id goes to pendingAcks immediately (ACKed on next poll); cancel: cancelledIds + `replies.drop` + submitAbort when the submitting batch is all cancelled + closing (Gl) for each cancelled backlog entry; busy (inflight≥8 && backlog≥64) → closing F5e enqueued; loop while page full or acks pending.
   So the original's reply queue is unbounded in memory; it ACKs everything, which is why a cancel behind 520 long busy ids is reachable.

   Our deviation sources: ReplyQueue storage cap 256 frames / 8 MiB with producer waiters (shared with the Box lane), closing deferral list + unACK fallback, runBacklog gated by `replies.available`, poll limit min(64, free slots), FIFO batch order.

   Change (this commit): the UC lane is constructed with unbounded storage (Infinity) and a separate per-submit batch limit 256 frames / 8 MiB; batches are filled round-robin per request lane; poll limit is tgt=64. Consequently offer() always succeeds, busy/cancel closings are always held, every polled item is ACKed, producers never wait. Box lane unchanged. Deferral/unACK code remains only as a fallback when the lane is stopped (not reached in normal operation).

   Remaining deviations at t108 (**[t109: the first two were real P2s found by the reviewer — finite 503 kept stdout, persistent 503 retried past 30 s, lane 256 of 257 in batch 4 vs official 2; fixed in Round 6. Listing them was not alignment.]**): ours retries a failed submit indefinitely instead of the original's retry budget + drop of non-closing frames; cross-batch lane rotation is approximated by first-queued order; file-byte (j2) limit not modelled (UC file streams not implemented).

After (final code):
- cancel-overflow-long (520 × 1024-char busy, active cancel): ours 3/3 probe runs + 1 npm-test run PASS, busy ACK 520, abort 10–11 ms (official 4–5 ms, 3 + 1 runs). Before: ours ACK 489, no cancel.
- cancel-overflow-backlog (488 long busy, 2000-char backlog target): ours 3/3 + 1 PASS (terminal retained, never started); official 1 + 1 PASS.
- cancel-overflow (200): official/ours PASS in npm test. Atomic component: no loss.
- npm test 133/133; r3 46/36/10/0, lifecycle PASS; 8 UC scenarios vs golden pass; overflow 3 fresh pairs 200/200; rotation 5 fresh strict pairs SAME, TICK-BOUNDARY=0.

Risk (limited to the reply-queue storage mechanism above; at t108 the retry/order mechanisms still differed, see Round 6; not a claim about the whole UC transport): reply memory is unbounded while the backend is slow/stalled (a flood of polled items or chatty stdout accumulates in RAM; no producer backpressure). Real backend untested.


## Round 6 (t109, on 7fd03de) — submit retry/drop and cross-batch lane order aligned with the original

Reviewer evidence (/tmp/independent-t108): P2-R finite 503 ×3 → official keeps only exit+streamClose ("keeping 2 of 3"), ours re-sent stdout; persistent 503 → official stops at ~32.1 s (30 s closing budget), ours still sending all 3 frames at 35.6 s. P2-F 257 lanes × 3 frames → lane 256 first in batch 2 (official) vs 4 (ours); batches 256/256/256/10 on both.

Original mechanism (daemon.formatted.cjs):
- submitRetry `Pu({maxAttempts: sxe=3, initialDelayMs=maxDelayMs=egt=200})` (L177931, L78223 runWithRetry): 3 attempts, fixed 200 ms; dataDeadline E0=120 s per attempt.
- submit (L178707–178760): Unauthenticated → requeue whole batch + rejectCredential(channel), not counted as an attempt; aborted (cancel submitAbort) → return 0, batch gone; exhausted → for each frame skip cancelled ids, x9r budget (L178795: shellStream exit/rejected/permissionDenied/sandboxUnsupported/backgrounded, any other client message case, control throw/streamClose → oxe 30 s; fileError/urlTransfer/last seq-0 file → E0 120 s; messages* → Gpe 180 s; localToolResult → a9r 180 s; stdout/stderr/accepted/… → undefined = drop); budget measured from `closingSince.get(frame) ?? submittingSince` (first submit of that frame object, kept across requeues); expired frames dropped; kept frames requeued at the front; log "keeping K of N … dropping the rest[, including X closing frames past their retry budget]".
- flush (L178671): serial; if kept>0 and readyCount===kept → closingRetry `Pu(until-signal, 500 ms → ×2 → 4 s)` then flush; any new enqueue flushes immediately; closingRetryAttempt reset on a successful submit.
- oee take/requeue (L177289–177330): lanes Map persists across batches; lanes taken from are deleted and re-inserted at the end; requeue inserts at the front.

Change: new `src/uc/reply-lanes.ts` (UcReplyLanes) implements the above (UC only; Box keeps transport/replies.ts, whose earlier t108 batch changes were reverted). Boundaries: cancel → drop lanes + abort the in-flight batch when all its ids are cancelled (batch gone, not classified); stale-channel 401 → requeue and retry at once on the current channel (fencing kept); current 401 → requeue and pause until resume() (rotation); stop() during an attempt or a retry wait requeues the batch (held for drain), never treated as a cancel. Generated proto/runtime unchanged; safe-cwd deviation untouched.

After (final code):
- Reviewer probes re-run with ours: retry-drop accepted [start, exit, streamClose] (official same; before: + stdout); retry-expiry last data attempt 32 378 ms (official 32 476; before: still sending at 35.6 s), accepted [start] both; fairness-native and -fast: lane 256 in batch 2 (official 2; before 4), sizes 256/256/256/10 (official -native run 256/256/256/18 — batch tail count differs with timing, first-batch position equal).
- New repo scenarios retry-probe / retry-expiry / fairness-native + official goldens + check-mechanism.py; attempt times retry-probe ours 301/805/1008/1212/1716 vs official 321/824/1027/1231/1735 ms. Independent ours runs with the final reply-lanes code: retry-probe 5/5 PASS (1 manual + 2 loop + 2 npm test), fairness-native 5/5, retry-expiry 3/3 (1 manual + 2 npm test); plus 4 reviewer-probe re-runs above.
- Observed difference not addressed: in retry-expiry the official made one extra closing round at ~15.7 s (an early flush, likely its Watch silence watchdog t9r=15 s reconnect, which ours does not implement); the final expiry time is the same.
- Unit regressions (deterministic clock): 3×200 ms then keep 2 of 3; 30 s expiry with backoff 500/1000/2000/4000/4000; 257-lane take order + requeue front; cancel/stale 401/current 401/stop boundaries.
- npm test 139/139 (133 − 1 replaced lane test + 4 unit + 3 oracle); r3 46/36/10/0, lifecycle PASS; overflow 3 fresh pairs 200/200.
- Rotation: 5 fresh strict pairs → 4 SAME, **1 FAIL** (ours keepalives 1063/3570/6577 ms after enqueue vs official 1453/3957/6961, the whole ours schedule ~390 ms early; cause not determined). 10 further ours runs: first keepalive 1467–1484 ms after enqueue (normal). Reported as an unexplained 1/15, not rerun to green.

Not done (later): file 1 MiB / UC file streams, heartbeat, approvals. Real backend untested.


## Round 7 (t110, on d7828f9) — resume wake across flush mutex; mechanism comparator tightened

Independent review closed Round 6 retry/fair P2s. New P2: after Submit 401, `updateChannel→resume` two microtasks later was swallowed by the flush mutex — reply stalled (not dropped) until a later enqueue. New P3: `check-mechanism.py` passed after deleting all attempts, retargeting accepted requestIds, or truncating fair batches to the first two (busyLane256 still in batch 2).

P2 reproduce (reviewer probe, 3/3 before fix): `beforeNudge` creds=["old"], drained=false, ready=1, flushing=false; only after emitting a wake frame did the new credential appear. assert-rotation.py exit 1.

Official semantics (daemon.formatted.cjs): flush is one-owner (`if (!this.flushing)` L178674); Unauthenticated requeues and `rejectCredential` (proven=false) then submit returns 0; the flush loop exits on `!proven` and `finally` clears flushing; a later Watch `connected` (L178388–178403) sets proven and calls `flush()` — i.e. the wake is a *later* flush after the mutex is free, not a nested call. Our `resume()` from `updateChannel` can land while the 401 flush is still between `return -1` and `finally`, so a bare `if (flushing) return` drops the wake.

Fix (UC only):
- `UcReplyLanes.flush` records `flushRequested=true` on every call; if the mutex is held it returns; the owner clears the flag per turn and, in `finally`, starts another flush when the flag is set again (same shape as official `requestPoll` while `polling`).
- `resume()` still clears `failure` then `flush()` (so the request is recorded even mid-flight).
- Watch `connected` also `resume()`s (official connected→flush), covering wakes that arrive after the previous flush finished.
- Regression: real `start`/`stop` + fake client, Submit 401, two `queueMicrotask`s then `updateChannel`; 3/3 must drain on the new channel without a nudge (ported from the reviewer probe).

P3: `check-mechanism.py` now requires non-empty attempts with status/frames/t, matching accepted (requestId, kind) sets, matching per-attempt frame sets and status sequences, retry recovered set exactly start/exit/streamClose on `retry-target`; fair requires ≥4 batches, first-three sizes 256, total busyLane frames 257×3, first-batch index equal for busyLane0/128/255/256 (256 must be batch 2), and busyLane0 batch sequence equal. Negatives that previously passed now FAIL (empty attempts / retargeted ids / truncated fair). Original 22 timing/data negatives untouched; 300 ms keepalive gate unchanged.

Author's Round 6 rotation pair-4 FAIL (~390 ms early) kept as recorded — this round's 5 fresh pairs reported as-is, not rerun-to-green. Watch 15 s reconnect extra flush noted with evidence, not backfilled into Round 6.

After (final code):
- Reviewer race probe 3/3: beforeNudge drained=true, creds=["old","new"], ready=0 (was drained=false, creds=["old"], ready=1). assert-rotation.py exit 0.
- Unit: 3× real start/stop two-microtask rotation drain; check-mechanism negatives FAIL as required.
- Mechanism oracles vs golden: retry-probe PASS, fairness-native PASS (1 each this round + covered in npm test).
- npm test 141/141 (139 + resume race + comparator negatives) — author run only. **Corrected in Round 8:** the independent full run was 140 pass / 1 fail (backlog), and the `flushRequested` design above broke the closing backoff; both superseded below.
- r3 46/36/10/0, lifecycle PASS; overflow 2 fresh pairs 200/200.
- Rotation this round: 5/5 fresh strict SAME (TICK-BOUNDARY=0). Author Round 6 pair-4 FAIL (~390 ms early) remains on record; not erased, gate not loosened. Cumulative fresh pairs this agent since that FAIL: 5 SAME + prior 4 SAME + 1 FAIL = 1 FAIL / 10 in the post-FAIL window (Round 6 reported 1/15 including the 10 solo ours runs).

file 1 MiB / UC file streams / heartbeat / approvals out of scope. Real backend untested. No drop-in claim.

## Round 8 (t110 independent review of 0325924) — pending independent re-verification

### P2: flush state transitions mirrored from official (L178671)
- Removed `flushRequested`. Root cause: a flag set by frames queued during a hanging first Submit survived the 3×503 exhaustion, so after `closingRetryWait` (500 ms) was scheduled the owner re-flushed immediately: recovery delay 2/3/3 ms vs official 504/505/503 ms, and extra early terminal frames in expiry.
- Now identical to official: `if (flushing) return`; loop { re-check stopped/failure; take; submit; if kept>0 && readyCount===kept → `closingRetryWait ??= backoff`; return }; `finally flushing=false`. kept<0 (current-credential 401) leaves the loop; the resume after a credential fix calls flush again. Watch `connected` → `proven=true; flush()` (official L178388–178403) instead of resume().
- Frames enqueued after the batch is taken are picked up by the same loop's next take (official immediate behaviour); frames enqueued during backoff call flush (not flushing) → immediate.
- Regression `flush state machine: frames queued while the first Submit hangs, then 3×503 …` uses a manual clock (sleeps resolve only when released). It **FAILS on 0325924** ("no re-submit before the closing backoff elapses") and passes now. The t110 resume race test still passes.
- Original probe retry-probe ×3: recovery delays 504/505/504 ms; check-mechanism PASS ×3; retry-expiry PASS; fairness-native PASS.

### P3: check-mechanism compares full content
- Normalization (explicit): drop `localExecutionTimeMs` recursively; times compared only where stated. Everything else (requestId, ids, exit codes, payloads) is compared exactly.
- accepted must equal the concatenation of the HTTP-200 attempts' frames (both sides); retry: status sequence + per-attempt frames equal; expiry: run-length-collapsed (status, frames) sequence equal (official makes one extra flush at a ~15 s Watch silence reconnect: 34 vs 31 attempts) and last attempt within ±1.5 s; fair: busyLane multiset exactly busyLane0..256 ×3, batch count and each batch's lane sequence equal.
- Negatives that previously PASSED now FAIL: lane1→lane2, lane1→999, swapped lanes 1/2, retry exit.code 37, accepted streamClose.id 999; plus empty attempts, retarget, truncation (8/8 FAIL, test `check-mechanism: full-content negatives FAIL`).

### Backlog full-run failure (kept, not masked)
- Independent full run: third KA at 6382 ms with ids [sh3, sh8]; golden has 2 KAs [sh8]. Evidence kept at /tmp/independent-t110/full-backlog-failure.
- Serial reruns (bounded): ours 8/8 and official 8/8 match golden (2 KAs, [sh8]). Contended (3 ours + 3 official concurrently + 4 busy-loop CPUs, ×3): ours 9/9, official 9/9 match. Not reproduced.
- Analysis: KA eligibility is identical to official (backlog ∪ lanes.keys() ∪ submitting-not-stuck). Official emits per-shell heartbeat frames at ~3.3 s and ~6.3 s (dataSeq), which refresh each request's heard time, so sh3 is not due when its exit burst is in flight. Ours does not emit heartbeats (out of scope), so sh3's due time is ~start+3 s, already passed at exit. In the failing run sh3's **stdout** frame (not exit — corrected in Round 9) was in the 1-frame submit at 6380 ms (burst lasted 6380–6512 ms under parallel load vs ~25–50 ms serial), and a KA at 6382 included sh3. The client-side due time of sh3 is an inference from the submit log, not a recorded value. This is a latent divergence from the heartbeat deviation, exposed by load. Not fixed (heartbeat excluded by scope). Test scheduling was not changed.

### Counts (this round, author run — not independent)
- Targeted: 6/6. Full npm test: 142 tests, 142 pass, 0 fail, rc 0 (single run; the independent run of the previous HEAD was 140/1, and the backlog race above can still fail under load).

## Round 9 (t112 independent review of b48082b) — pending independent re-verification

Scope per t112: official exec heartbeat (now in scope), strict retry/expiry/fair gates, Watch-startup failure. No file/approval work.

### Reproduction first (HEAD b48082b, before changes)
- Peer-side control (daemon unchanged) added as scenarios `hb-hold-exit` (`sleep 6.4`, hold first Submit with sh3 exit 1500 ms) and `hb-hold-burst` (`sleep 6; echo`, hold first Submit with sh3 stdout). b48082b: KA at 6817/6794 named sh0–sh8 incl. sh3; official: only [sh8]. Recorded b48082b runs kept as `scripts/oracles/keepalive-negative/*-b48082b.json` (they now FAIL the gate).
- Reviewer gate files (/tmp/independent-t112/gates): previously PASSING expiry negatives (1 non-terminal attempt, 4 attempts, early closing, +100 attempts) and the real 0325924 early retry all FAIL under the new check-mechanism.

### P2 heartbeat (official wE.handle L98140–98153, finally L98187–98193, zHt=3000 L98040)
- `withExecHeartbeat` wraps read/ls/shellStream (handlers that run inside the official exec manager; permission refusals and unsupported types get no heartbeat, as official). First heartbeat 3000 ms after handler start; next timer armed only after the previous write settled; failed write (sync or async) swallowed and ends the chain without aborting the job; completion/throw/cancel/shutdown clear the timer. Heartbeat is an ordinary control frame in the reply lane; keepalive credit only via successful Submit → noteHeard (unchanged). Deviation: the wrapper stops on emitting streamClose/throw (official clears in finally; a write after close would reject there).
- Tests `test/exec-heartbeat.test.cjs` (7): cadence (mock timers), slow consumer, async+sync error, no frame after close, real shell sleep 3.4, cancel + shutdown, no heartbeat for refused/unsupported.
- keepalive-diff no longer filters official heartbeats; heartbeat frames are compared like data. New negatives: heartbeat removed / one missing / after streamClose / wrong id → FAIL.
- Found by the stricter fair gate (no busyLane filter): ours ordered start frames by child 'spawn' event and by async settings/stat completion, so active lanes were reordered (3/3 FAIL). Official yields `start` before spawning (L130994) and reads permission from memory. Fix: emit start before spawn; settings reads chained FIFO; cwd stat synchronous. **[Corrected t108u–t113u: the original reads settings.json synchronously per request (existsSync/readFileSync, L82271/L82881), not from memory; the FIFO chain was replaced, see t108u–t113u batch.]** fairness-native 5/5 PASS after.

### P3 check-mechanism (rewritten)
- retry/expiry: each side must satisfy the official model — rounds of exactly 3 attempts 200±50 ms apart (or ending in 200); next scheduled round after closing backoff 500·2^k capped 4000 ±50 ms from the exhausted round; a shorter gap only as a wake round with a Watch request ≤150 ms before it (harness now records `watches`); wake rounds do not move the timer and must repeat the preceding frames. Scheduled rounds compared to official: count, (status, normalized frames), start offset ±300 ms. No collapsing.
- fair: every batch ≤256 frames, full id sequence and every frame's normalized content equal official (harness now records frames); busyLane multiset exact.
- Goldens retry-probe / retry-expiry / fairness-native re-recorded (official 0.79.3, same sha256) because the old ones lacked watches/frames.
- 20 negatives in `check-mechanism: full-content negatives` all FAIL with the intended reason (listed in test).

### KA gate for hb-hold (evidence-based)
- First version (“no KA may name sh0–sh7”) was wrong: under load the official daemon also named running execs (one loaded official run: KA 8069 [sh8, sh0..sh7]). Replaced by the official A9r rule evaluated on each side's own submit log: named id must still have frames queued/in flight, due (last successful Submit carrying it + 3000) ≤ T+1500, some named id due; plus strict pre-hold KAs and the sh8 rule.
- Serial: ours 6/6 SAME, fresh official 6/6 SAME. Loaded (3 rounds × 2+2 with CPU hogs): all 12 SAME under the evidence rule, but ours 3/6 named sh6/sh7 at ~6.8 s while official 0/6 did in that set. **Unresolved distribution difference**: ours' heartbeats leave in separate 1-frame submits (timers spread by admission), so late execs' heartbeats get queued behind the held batch more often than official's (which batched 7). Not fixed.

### Watch-startup failure (independent full run 141/1, overflow `deadline`)
- Wait condition: first Watch request within 8000 ms after the key handoff. The old harness discarded daemon output on that path, so the cause cannot be reconstructed from the record; the 40 s test duration exceeds 8 s + 2.5 s cleanup, i.e. the whole probe stalled, consistent with host contention but not proven.
- Not reproduced: 16 overflow runs (8 concurrent ×2) all opened Watch at 330–549 ms.
- Change: harness now emits a structured `startupFailure` (spawn/key marks, first HTTP rows, daemon exit/diedEarly, loadavg/freemem, output tail). Deadline unchanged. (It immediately diagnosed a real case while preparing the b48082b worktree: `Cannot find module 'zod'`, exit 1 at 99 ms.)

### Counts (author runs, not independent)
- r3: 46 cases, 36 same / 10 allowed / 0 diff, lifecycle PASS (no heartbeats in r3 probes on either side).
- rotation 10/10, backlog 3/3, cancel 3/3 SAME (heartbeats compared, 16=16).
- Full npm test (no external probes in parallel): run1 148/1 (P3 test still stripped heartbeats; fixed), run2/run3 151/1 (fairness-native: start order, fixed), run4/run5 151/1 (hb-hold-burst under suite load, first KA rule; rule replaced). Final run (run6, after all changes): 152 tests, 151 pass, **1 fail**, rc 1 — `oracle cancel-overflow-backlog (ours)`: no `throw` terminal for the cancelled backlog target within the observation window (only a keepalive frame for it); daemon alive, all 488 busy ACKed, cancel ACKed. Evidence /tmp/t112/full6.tap, /tmp/t112/full6-cancel-overflow-backlog-ours.json. Serial reruns 2/2 PASS; cause under suite load not determined; not masked, not fixed.
- Not claimed: a stable green suite. Every full run this round had exactly one failure.
- Historical records kept: t110 backlog failure, author pair-4 rotation FAIL, independent t112 141/1 overflow failure.


## t108u–t113u batch (2026-11-08, Asia/Shanghai) — **执行方自测，非独立验收；不宣称 drop-in**

Static evidence: daemon.formatted.cjs 0.79.3 (local analysis copy, not in repo). Real backend / official binary not run.

- Settings read: per-request synchronous read like the original settings store (getLocalToolPermission → load() → readText → existsSync/readFileSync, L82881/L82271); FIFO `settingsChain` removed; no cache, no shared promise.
- Await boundaries: UC `handleQueued` reads synchronously, then one await (original `await isLocalUseBlocked`, L136318) before exec id + heartbeat arm; shell handler awaits once before cwd checks / first `prepareShell` (original `await Sft`, L132620). A Poll batch's heartbeat timers are no longer split by the first shell's ~3.7 ms synchronous prepare.
- Permission (UC only): after that await, blocked first → control `throw{id:0,error}` (x9, L136410), no exec id consumed; then cancelled → `streamClose{id:0}` (O6r, L136419); then exec id. never → Xh (L81193), ask/serverAuthoritative → i5 (L81199). Box keeps its file-error refusal. The stop check after the await is our own guard, not an original path.
- Throw cwdState (Aft L132554–132566): shell / background-shell probe `workingDirectory` (empty → root) → `exists` / `missing` (ENOENT/ENOTDIR); other probe error or 1 s timeout → field omitted; other request kinds → `unset`. Permission refusals carry no cwdState.
- Diagnostics: optional `UC_TRACE_FILE` JSONL trace (no-op when unset; sync append perturbs timing); harness adds performance.now timeline, Submit receive/response/HTTP status and per-frame target location (Date.now `t` kept); `UC_SKIP_OFFICIAL=1` skips the 3 official-binary cancel-overflow cases.
- Tests: settings-sync-admission, uc-permission-order, cwd-state-throw; review-fixes refusal assertion tightened to the original frame. Full `UC_SKIP_OFFICIAL=1` suite before commit: see commit message.
- Remaining gaps: approvals/grants and serverAuthoritative authorization not implemented (fail closed); non-global actions under always unsupported; Ki write resolves on consumer pull vs ours on enqueue, and the original may leave one frameless timer after close (mechanism only); heartbeat Submit batching is timer/RTT phase dependent (not a gate); historical failures above remain recorded; 3 official cases skipped in this round.
