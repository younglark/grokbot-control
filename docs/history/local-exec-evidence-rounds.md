# local-exec 证据文件中移出的过程记录（历史）

> 存档：从 `docs/local-exec/evidence/` 等文件中移出的单轮测试记录、阶段性计划和已被后续实现推翻的段落，按来源文件分组，原文未改。当前状态以 [local-exec/remaining-diffs.md](../local-exec/remaining-diffs.md) 和各 evidence 文件为准。

## 来自 `local-exec/evidence/close-stream.md`

#### Remaining staged minimum, not a claim of completion

1. Preserve the exact Ki producer/consumer primitive and gated next-pull, prefetch, return/throw/close tests as a distinct component. No generic bounded queue substitutes for it.
2. Integrate at the shared exec-manager/heartbeat boundary, **not** by attaching exec streams to oee. This spans handlers shared with Box and UC, producer errors/finally, callback consumption, and cancellation ownership. Current public Emit accepts void or Promise and existing heartbeat tests intentionally keep a job alive after Emit failure; original UC callback is synchronous void, and a consumer throw closes the iterable through for-await return. Static Ki alone does not establish a compatible mapping for that public async failure contract. Replacing the wrapper without resolving this would invent behavior and invalidate existing fixed expectations. This batch stops at that integration boundary rather than claim an unwired primitive or file API completes exec close.
3. Separately, when transfer work is authorized, add the exact source attachment/readAhead/identity/drop semantics plus exhaustion cleanup. Do not turn on download/non-exec approval functionality as a side effect.

This batch therefore fixes a proved cancellation ordering issue and records the precise remaining channel integration, rather than calling all close/async-stream replication complete.


#### t150 continuation: scoped UC production-channel integration

The earlier sections describe the t149 boundary and retained cancellation fixes. This continuation implements the Ki-style primitive and connects **UC only**, without changing the legacy/public Box wrapper or reply admission policy.

Additional original Box evidence: 137251–137262 constructs the same v_ executor; 137519–137528 converts its results and synchronously calls enqueue; 137292–137294 pushes to an unbounded outbox then starts flush. Thus original Box also consumes Ki synchronously. Current Box differs: BoxProvider.emitExec -> post -> ReplyQueue.enqueue returns a Promise for bounded admission (src/box/provider.ts:175–179; transport/replies.ts:32–41), not a Promise for POST success. Silently discarding this Promise would lose current backpressure/failure guarantees. **Box is deliberately not migrated** in this batch, and this is not claimed equivalent to original Box.

New `exec/output-channel.ts` implements the linked writers, pending readers, next-pull acknowledgement, prefetch exception, close/throw/return distinctions and error identity from 14896–14972. No capacity bound or disk storage is added. Its UC wrapper arms the heartbeat before producer work; heartbeat writes rearm only after next-pull acknowledgement, and producer finally clears the timer and closes the channel (98141–98193). Terminal messages do not themselves close the channel: a gated producer can still emit a heartbeat after streamClose, matching the original lifetime instead of the legacy early suppression.

`dispatchExec` has an optional pullOutput selector, enabled only by UserComputerProvider. The native UC consumer synchronously converts each frame, pushes to UcReplyLanes and starts its existing flush, matching 136337–136348 / 178665–178671. Its producer/inflight can finish with Submit still pending; close separately waits flush and drains queued terminal frames. Existing batching, fairness, 3x200ms retries, closing budgets and cancel-lane selection are untouched. File source attachment is not involved.

The public Emit type remains void-or-Promise. For the explicit test/legacy consumer extension, a returned Promise is awaited as *admission*, not network receipt. Sync/async consumer errors cause for-await iterator.return to settle channel writers; the wrapper cancels the registered execution context through cancelRequest, analogous to 136349–136350. Producer failures are observed, never left as an unhandled fire-and-forget rejection. An arbitrary external producer body cannot be force-settled by an iterable; consumer failure does not join such an external body. Registered production shell cancellation remains responsible for ending the work. Tests verify queued/delivered channel writers and the cancellable producer finish without deadlock.

Remaining limitation: existing handlers generate their own terminal/error frames rather than being fully converted into original wE async generators. Unexpected producer failures still reach the existing outer requestError fallback; this is not a claim that every wE metrics/error-conversion/cwd-preparation path is identical. Current Box retains its documented legacy early terminal heartbeat suppression and bounded admission. Attached download source support remains out of scope. No standing/multi-account/approval/newline-cwd/ownership-policy work is included.


#### t151 continuation

The earlier t149/t150 unimplemented attached-source notes are historical. `uc-download-evidence.md` records the subsequently implemented **UC outer download** read-file chain, attachment ownership/retry rules and remaining cancellation/setup races. Exec Ki and Box behavior remain separate.


#### t175 update
The Box blocker above (ReplyQueue bounded admission) no longer exists: since ba05d14 Box enqueues into a synchronous unbounded outbox (D:137292–137306). Box now calls `dispatchExec({pullOutput:true})`, so Box consumes the same Ki channel as UC and the original Box. See port-coverage.md §4 F1.

## 来自 `local-exec/evidence/box-upload.md`

#### t154 test record (box-upload / discover-ai-tool / ls)

- New file first run: 9 tests, 5 pass / 4 fail — all 4 were wrong expectations written by hand (QJe counts depth-2 files because recursion is `a < e`; a 200×`a` title is hex-like and hits Ojt[8] `[redacted]` first). Implementation unchanged; expectations corrected from the original code; second run 9/9. ls test added → 10/10.
- Target set (new + uc-upload-box-download + review-fixes + exec-codec): 36/36.
- Root build passed. Root full run 1: control 227/227; daemon 287 total, 262 pass / 24 fail / 1 skip — all 24 in `uc-lifecycle.test.cjs`, cause `unmocked module ./uc/ai-tool-discovery` (vm harness strict module map vs. new `index.ts` import); organization not run (`&&` chain). Fix: harness mock entry. That file alone 26/26. Root full run 2: control 227/227, daemon 287 total 286 pass / 1 skip / 0 fail, organization 6/6.
- **Incident**: both root runs were launched without `UC_SKIP_OFFICIAL=1`, so the 3 `oracle cancel-overflow* (official)` tests in `uc-keepalive.test.cjs` executed the offline lab official `main.cjs` (bwrap, fake peer) — 6 executions total. Earlier batches set `UC_SKIP_OFFICIAL=1` (4 skips). No lab files were modified; no process left running.


#### Not implemented / retained differences

- `cp` lock table (yI/gUe) and exact fsync edge cases: still the existing `writeUploadFile` approximation (documented in t153).
- Box hello is still posted on `welcome` (original posts hello right after connect, 137410–137430); pre-existing difference, unchanged.
- `Mwr` messages-op parse-failure reply is not added (Box messages-op is not implemented).
- Exec frames keep the existing `seen` set (not changed this batch).

## 来自 `local-exec/evidence/uc-download.md`

#### Actual validation for this batch

- Added 18 fixed-expectation tests in `test/uc-file-source.test.cjs`; target command ran that file plus uc-close-channel, uc-approvals, exec-output-channel: **56/56 passed**, no skips or functional test failures. Download admission/source/Submit tests use an in-process fake peer and generated protobuf roundtrips, not a complete daemon subprocess or real network download service.
- `UC_SKIP_OFFICIAL=1 npm test --workspace=local-exec-daemon`: 269 total, **265 passed / 4 skipped / 0 failed**.
- Root `npm run build`: passed. `UC_SKIP_OFFICIAL=1 npm test`: control **227/227**, daemon **265 passed / 4 skipped / 0 failed** (269 total), organization **6/6**. Each planned functional scope ran once; no test failure was rerun away.
- Development failures are NOT erased: first `node --check` failed for a missing brace in the short-read mock; it was corrected before testing. First daemon build failed TS2322 because frozen generated File.data infers `Uint8Array<ArrayBuffer>` while FileRead initially declared ArrayBufferLike. The source already allocates an owned ArrayBuffer; only its declaration was narrowed, without changing schema, adding a cast or copying frames. A subsequent build validated that specific type correction. Raw failed build and correction notes are retained in local, uncommitted validation evidence; the original syntax diagnostic also remains in the tool transcript.
- Historical evidence untouched; no commit/push. HEAD remained `7cff6e9efa732f5ed4f7ebaaa67d9e690dfe8f5f`.

## 来自 `local-exec/evidence/uc-unauthorized-renewal.md`

#### Remaining differences (by design / not ported)
- **Sleeps on close.** Every loop sleep in this port also ends early on close/stop. In the original, these timers are just unref'd and the loop exits on its next check; nothing is visible on the wire.
- **Safety poll.** The 30 s safety poll is still a provider-lifetime interval. In the original it runs only while a Watch is connected (`d`, D:178393).
- **Not ported:**
  - outageLedger diagnostics;
  - the `ot` device-tool nudge in Rt;
  - `presence-withdraw-failed` logging.
- **Oracle `retry-expiry`.** This oracle depends on the silent-renewal full jitter (random 0–2 s, then 0–4 s), which the original has too. The number of rounds counted as scheduled versus Watch-woken can vary from run to run, so this golden comparison is inherently probabilistic.

## 来自 `local-exec/evidence/connection-exchange.md`

#### Port differences (remaining, after t160)
- t160 closed four of the earlier gaps: QPe validation, UC reasons, plaintext credentials and servingAt. See uc-transport-hello-evidence.md.
- The UC runLoop still uses this port's own backoff after each reason. The original's per-reason branches are not ported: renew on silent/network-change (D:178266–178290), channelRetry on unauthorized, and backendReturn sleeps.

## 来自 `local-exec/evidence/local-tools.md`

#### Port today and plan
- **Port today:** UC localTool frames fall into the "not understood" closing reply (`control throw z2`). That **differs** from the original, which always maps v9r localTool.
- **Plan, reachable parts in order:**
  - (a) v9r localTool intake.
  - (b) unknown tool → B5e.
  - (c) computer_* → accepted + BL, including the per-conversation queue and the onStillQueued keepalive.
  - (d) mail tools → hke for accounts. For send, the x6r path with xUe spent-sends.
  - (e) Obsidian vault tools (Ipt/ypt/bpt/Apt) need a separate reverse-engineering pass.
- Local-tool replies also need the hello capability fields (mobileLocalTools).

## 来自 `local-exec/evidence/uc-transport-hello.md`

#### t160 follow-up: runLoop per-reason backoff (D:178223–178289)

The single root full-suite run failed `oracle retry-expiry: ours vs official golden (expiry)`
(`scheduled rounds official=11 ours=10`). The cause was the new 15 s silence watchdog. The fake peer
keeps Watch open without heartbeats, so the Watch now ends `silent`. Our old generic 100 ms redial
did not match the official timing; the official golden shows re-Watches at about 16.9 s and 32.6 s.

The fix ports the original branches:
- `lifetime`: redial immediately.
- `silent`:
  - `renew` builds a fresh E9r client and emits `{kind:"renewed",cause}` (D:178314).
  - It then waits `silentRenewalBackoff` (Pu: r9r = 2000 ms, max X1t = 60000 ms, full jitter, so `random()*min(60000, 2000*2^(r-1))`).
  - r becomes 1 if the Watch heard any event after `connected` (D:178381), otherwise r+1.
- `stall`/`error`: wait `reconnectBackoff` (Q8r = 1000 ms doubling to 60000 ms, no jitter). Then e += 1, and `connected` resets e to 1 (D:178249).
- `unauthorized`: e is reset to 1. This port keeps its admissionClosed fencing instead of the original `channel = undefined` + 10 s channelRetry. This difference is kept on purpose.

All of these sleeps are unref'd and end early on close or stop.

Not ported:
- `backendReturn` early wake (sleepUnlessBackendReturns).
- `pollAbort` in renew.
- network-change.

Afterwards, the single oracle test ran once and passed. The silent wait uses jitter, so its timing varies by design.


#### t162 update
- The `unauthorized` branch, backendReturn early wake, renew `pollAbort`, and `network-change` are now ported. See [uc-unauthorized-renewal.md](../local-exec/evidence/uc-unauthorized-renewal.md).
- The 8 MiB UC transport read/write cap is removed: L1t sets none, so the defaults are 0xFFFFFFFF (D:174740–174748).

## 来自 `local-exec/evidence/upload-box-url.md`

#### Remaining gaps

- (t154: Box upload and discover-ai-tool now implemented.) messages/local-tool, standing-grant subject actions, multi-account, exact cp lock table, full official write fsync edge cases.
- Historical ownership 20s timeout root cause still unknown; original ownership race preserved.
- Existing UC download attached-source path, Ki producer channel, cancel-terminal ordering, retry/fairness/256/8MiB/1MiB, newline-cwd security fix, and approval quirks are retained.

## 来自 `local-exec/remaining-diffs.md`

#### 测试
- 新增 `test/t171-remaining-diffs.test.cjs`（5 项）：ledger 的行文本、事件字段及顺序、短 outage 不写事件、channel-missing 去重、X8r 原因映射、Uae 解析、IPC 中非法消息被忽略和 disconnect 返回 null key。
- 随原版语义调整的既有断言：`test/t162-uc-unauthorized-renewal.test.cjs`（connect 时 2 次 poll；30 s 冷却 + 每 Watch 安全轮询两个定时器）、`test/uc-close-channel.test.cjs`（withdraw 走 750 ms deadline signal）、`test/uc-keepalive.test.cjs`（安全轮询是 setTimeout 链而非 interval）、`test/dropin-acceptance.test.cjs`（等 connect 的两次 poll 落定后再做 heartbeat(0) 快照；否则第二次 poll 会取走新入队项并触发 drain 重 poll，造成快照竞态）。
- 已更新：`test/uc-lifecycle.test.cjs`（handoff 新形状、multi-provider 访问器）、`test/electron-handoff.test.cjs`、`test/uc.test.cjs`（原版 superseded 文本、原子且容忍竞争的 fixture）、`test/ownership-oracle.test.cjs` 与 `scripts/oracles/ownership/assertions.cjs`（implementation 模式也要求原版文本）、`test/uc-keepalive.test.cjs`（retry-expiry 固定 random）。
- t175：新增 `test/t175-port-coverage.test.cjs`（7 项）：crash guard（子进程）、clearOwnDiscovery、settings 全 schema/unsupported/bad JSON 日志（子进程，避开每进程去重）、shellTimeoutMs、pullOutput 路径。函数级覆盖表见 `port-coverage.md`。
- t176：新增 `test/t176-background-denylist-sandbox.test.cjs`（6 项）：denylist 单元、shellStream rejected、sandboxUnsupported、BACKGROUND+hardTimeout、backgroundShellSpawnArgs、settings EISDIR rethrow。
- t177：denylist 的 tree-sitter / tree-sitter-bash 写入 `packages/local-exec-daemon/package.json` 正式依赖（公开 npm 0.21.1 / 0.21.0），去掉 App/exec-daemon 路径回退；见 `port-coverage.md` §8。
- t181：后台三组件静态核验不可达（Tft 不传 registry、forceBackground 无调用/未注册），不移植；补 jHt 文案（computerUseArgs/recordScreenArgs，D:98041–98046）。测试 `test/t181-background-reachability.test.cjs`（4 项）。
- t196：新增 `test/t196-ls-ripgrep-tree.test.cjs`（8 项）：未配置同句错误、b0、fake rg argv/cwd/env、rg 失败文案、sandbox 文案、timeout 部分树、真实 rg 排序树与 lsArgs.ignore、2500 字符预算溢出。
- t198：新增 `test/t198-spawn-workload-ls-cancel.test.cjs`（7 项）。
