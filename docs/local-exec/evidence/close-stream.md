# Close / async-stream boundary audit (0.79.3)

Narrow static evidence and synthetic tests, not full drop-in acceptance. No official package execution in this batch. The remaining async-stream work cannot be inferred from the old `dropStreams` comment alone.

## Two different mechanisms, not one missing exec attachment

All original references below are to the existing formatted `daemon.formatted.cjs`.

1. **Exec producer channel: Ki**, 14896–14972, used by wE at 98141. `wE.handle` iterates handler outputs and awaits `p.write` (98157–98164); heartbeats also await that write before rearming (98143–98153). The consumer is `handleExecRequest`'s `for await` at 136337–136348, calling its callback synchronously. That callback reaches UC `enqueue` at 178665–178671, where exec client/control messages become ordinary materialized frames. **Ki is not attached to an oee lane.**
2. **Attached file source: oee.stream**, 177287–177291. It accepts `chunks.read()/close()`, not a Ki iterable. Only `file-stream` is attached by UC enqueue (178665–178670). Its producer is download -> oqe -> Ype (136384–136392, 97892–97893, 97843–97878). `Ype.read()` converts read throws into `{kind:'error'}`. Current UC rejects non-exec transfer requests rather than running this producer (`provider.handleQueued`). Wiring a file producer now would expand into the expressly excluded download module.

`UcReplyLanes.enqueue` returning a resolved promise after pushing materialized exec frames is consistent with the **UC queue callback** not awaiting network submit. It is not evidence of Ki's producer-write completion semantics. The current shared `withExecHeartbeat` passes Emit through directly, so that earlier exec-channel boundary remains a genuine difference.

## Write completion and close semantics established by the original

- Ki write with no waiting reader queues a linked writer. Initial `next()` delivers its value but leaves that write pending; a later `next()` acknowledges it (14915–14917, 14943–14958). A waiting reader also does not normally acknowledge a write until another pull. Exception: if additional prefetched reads remain, write resolves immediately (14922–14929).
- `close()` resolves the delivered outstanding writer, rejects queued writers with WriteIterableClosedError, resolves pending readers as done, and rejects later writes. `throw(error)` rejects delivered/queued writers and readers with that error. Iterator `return()` closes pending operations; it does not wait for Submit. Repeated close/throw through the public channel is inert (14903–14940, 14960–14967).
- Six gated static-component experiments verified these cases with only synthetic values. They execute only the extracted Ki function with an Error stand-in, never the official package. They are component evidence, not end-to-end original-runtime evidence.
- Exec streamClose is a producer message, **not** the closing operation on Ki. The producer clears its heartbeat and closes Ki in finally (98187–98193), after the terminal write is acknowledged. Current `withExecHeartbeat` closes its wrapper as soon as streamClose/throw is emitted (handlers 485–510); this earlier suppression is a documented real deviation. Do not silently reclassify that behavior as equivalent.
- Consumer acknowledgement and producer/inflight completion do not promise server acceptance. UC enqueue starts flushing without awaiting it; Submit retry/budgets and process close's flush/control drain are separate phases. This is why changing Emit to await network delivery would be wrong.

## Attached source read/drop semantics (implemented later, see [uc-download.md](uc-download.md))

- oee lanes hold `{frames, stream?}`, retain stream-only lanes, and read ahead only when no file frame is already buffered (177315–177323, 177358–177363). Each source starts at seq=0. A completed read is admitted only if the lane still points at the same stream identity; error/last removes the source and closes it (177365–177389). That identity check suppresses a pending read completing after replace/drop.
- Replacing a stream closes the old source; dropping a request closes its source and removes that whole lane. `dropStreams()` drops **only lanes still carrying attached sources**, not all materialized replies (177287–177291, 177338–177343). A normal completed stream clears attachment before its final buffered frame is drained. Making today's no-op clear every lane would incorrectly erase exec cancel terminals.
- File-Submit exhaustion also needs source cleanup plus a file-error replacement (178742–178768). Implementing attachment without this path would not be complete. File producer/limits are not expanded here. Four additional static-oee synthetic experiments verified selective drop with pending reads, one-file readAhead plus final-frame survival, replacement identity, and structured read-error survival; these are not tests of an implemented attachment API in this repository.

## Close order: already implemented, not missing wholesale

Original 178009–178025: reentry returns immediately; set closing; optional withdraw starts immediately; dispose keepalive; abandon backlog/cancel active; close outage ledger; await poll idle; await inflight drain; drop attached sources + await flush idle + one control Submit per batch; closed=true; dispose renewal hold; abort Watch; await withdrawal last. Details: 178027–178049, 178051–178134. Late Poll can invoke a new drain at 178447–178450; no corresponding invented late-inflight drain should be added to startRequest finally (178574–178587).

Current provider.stop 362–428 already has the corresponding stages for its allocated state, deadlines, no-withdraw default, explicit withdraw, reentry, late Poll, and unproven close. `pauseForClose` mirrors the original `closing` flush gate: it must not abort a normal Submit in flight. The current implementation has no outage-ledger/renewal-hold resource to dispose, not a hidden resource automatically equivalent to the original. The file attachment no-op is a transfer-layer gap, not a reason to reorder exec close or discard terminal frames.

The original can time out awaiting a flush and then attempt a control drain; this batch does not invent a stronger global flush lock or change that policy. Existing 256-frame/8MiB/1MiB-file batching, 3x200ms retry, 30s closing budget, fairness and flush-owner tests remain intact.

## Concrete exec cancellation bug fixed here

Original 178518–178526 drops old replies/aborts an all-cancelled submit **before** calling executor.handle(cancel) at 178557/178568–178569. Previously provider.pollOnce called cancelRequest first and then dropped the lane. A synchronous cancellation hook could enqueue its new terminal immediately, after which the drop erased that new terminal along with stale data.

Production changes are limited to cancellation: move the existing drop/abort before cancelRequest, and select only the current request lane for deletion while checking all previously cancelled IDs for Submit abort. Previously the global cancelled set was also used to delete queued lanes, so cancelling B could erase a retained terminal from already-cancelled A; original 178521 deletes only the current request. The optional second predicate keeps the existing one-argument drop API compatible. Four fixed-expectation synthetic tests cover (a) synchronous terminal retained with old lane removed, and (b) in-flight cancelled Submit aborted before a new terminal is enqueued, with that terminal drained once on close, (c) retained A terminal surviving cancel B, and (d) a mixed Submit aborting only after both IDs are cancelled while both new terminals survive. No new queue, outbox, retry budget, or terminal-clearing policy was introduced. The newline-cwd fix, approval quirks, and ownership publication race are unchanged.

## 当前实现（2026-11 状态）

- Ki 原语已移植为 `src/exec/output-channel.ts`（linked writers、pending readers、next-pull 确认、prefetch 例外、close/throw/return 区分）。UC 和 Box 都通过 `dispatchExec({pullOutput:true})` 同步消费 Ki。Box 原先有界的 ReplyQueue 准入已换成无界 outbox（D:137292–137306），见 [port-coverage.md](../port-coverage.md) §4 F1。
- 附带文件源（oee 的 attach/readAhead/identity/drop 和 Submit 耗尽后的替换）已随 UC 外层 download 实现，见 [uc-download.md](uc-download.md)。
- 仍有差异：各 handler 自己生成 terminal/error 帧，没有完全改写成原版 wE async generator；意外的 producer 失败仍走外层 requestError 兜底。

逐轮推进记录（t149–t151、t175）已移到 [history/local-exec-evidence-rounds.md](../../history/local-exec-evidence-rounds.md)。
