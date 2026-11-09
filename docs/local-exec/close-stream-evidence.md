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

## Attached source read/drop semantics (not implemented in this batch)

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

## Remaining staged minimum, not a claim of completion

1. Preserve the exact Ki producer/consumer primitive and gated next-pull, prefetch, return/throw/close tests as a distinct component. No generic bounded queue substitutes for it.
2. Integrate at the shared exec-manager/heartbeat boundary, **not** by attaching exec streams to oee. This spans handlers shared with Box and UC, producer errors/finally, callback consumption, and cancellation ownership. Current public Emit accepts void or Promise and existing heartbeat tests intentionally keep a job alive after Emit failure; original UC callback is synchronous void, and a consumer throw closes the iterable through for-await return. Static Ki alone does not establish a compatible mapping for that public async failure contract. Replacing the wrapper without resolving this would invent behavior and invalidate existing fixed expectations. This batch stops at that integration boundary rather than claim an unwired primitive or file API completes exec close.
3. Separately, when transfer work is authorized, add the exact source attachment/readAhead/identity/drop semantics plus exhaustion cleanup. Do not turn on download/non-exec approval functionality as a side effect.

This batch therefore fixes a proved cancellation ordering issue and records the precise remaining channel integration, rather than calling all close/async-stream replication complete.


## t150 continuation: scoped UC production-channel integration

The earlier sections describe the t149 boundary and retained cancellation fixes. This continuation implements the Ki-style primitive and connects **UC only**, without changing the legacy/public Box wrapper or reply admission policy.

Additional original Box evidence: 137251–137262 constructs the same v_ executor; 137519–137528 converts its results and synchronously calls enqueue; 137292–137294 pushes to an unbounded outbox then starts flush. Thus original Box also consumes Ki synchronously. Current Box differs: BoxProvider.emitExec -> post -> ReplyQueue.enqueue returns a Promise for bounded admission (src/box/provider.ts:175–179; transport/replies.ts:32–41), not a Promise for POST success. Silently discarding this Promise would lose current backpressure/failure guarantees. **Box is deliberately not migrated** in this batch, and this is not claimed equivalent to original Box.

New `exec/output-channel.ts` implements the linked writers, pending readers, next-pull acknowledgement, prefetch exception, close/throw/return distinctions and error identity from 14896–14972. No capacity bound or disk storage is added. Its UC wrapper arms the heartbeat before producer work; heartbeat writes rearm only after next-pull acknowledgement, and producer finally clears the timer and closes the channel (98141–98193). Terminal messages do not themselves close the channel: a gated producer can still emit a heartbeat after streamClose, matching the original lifetime instead of the legacy early suppression.

`dispatchExec` has an optional pullOutput selector, enabled only by UserComputerProvider. The native UC consumer synchronously converts each frame, pushes to UcReplyLanes and starts its existing flush, matching 136337–136348 / 178665–178671. Its producer/inflight can finish with Submit still pending; close separately waits flush and drains queued terminal frames. Existing batching, fairness, 3x200ms retries, closing budgets and cancel-lane selection are untouched. File source attachment is not involved.

The public Emit type remains void-or-Promise. For the explicit test/legacy consumer extension, a returned Promise is awaited as *admission*, not network receipt. Sync/async consumer errors cause for-await iterator.return to settle channel writers; the wrapper cancels the registered execution context through cancelRequest, analogous to 136349–136350. Producer failures are observed, never left as an unhandled fire-and-forget rejection. An arbitrary external producer body cannot be force-settled by an iterable; consumer failure does not join such an external body. Registered production shell cancellation remains responsible for ending the work. Tests verify queued/delivered channel writers and the cancellable producer finish without deadlock.

Remaining limitation: existing handlers generate their own terminal/error frames rather than being fully converted into original wE async generators. Unexpected producer failures still reach the existing outer requestError fallback; this is not a claim that every wE metrics/error-conversion/cwd-preparation path is identical. Current Box retains its documented legacy early terminal heartbeat suppression and bounded admission. Attached download source support remains out of scope. No standing/multi-account/approval/newline-cwd/ownership-policy work is included.

## t151 continuation

The earlier t149/t150 unimplemented attached-source notes are historical. `uc-download-evidence.md` records the subsequently implemented **UC outer download** read-file chain, attachment ownership/retry rules and remaining cancellation/setup races. Exec Ki and Box behavior remain separate.
