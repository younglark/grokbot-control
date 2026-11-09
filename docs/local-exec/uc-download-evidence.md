# UC outer download / attached file source (t151)

Scope: one read-file chain only, static 0.79.3 evidence + isolated synthetic tests. Not full drop-in acceptance. No official complete daemon execution. Previous uncommitted cancellation/UC Ki work is retained.

All D references are to the existing locally formatted 0.79.3 daemon source (`daemon.formatted.cjs`, not committed); it is read as text, not executed.

## Which request creates a source

- D:178882–178889 maps **outer UserComputer RequestFrame.download** to `{kind:'download', path, approvalId, authorization:c5(...)}`. It is not an agent ExecServerMessage variant, not URL transfer, and not upload. D:178890–178892 ignores putFileToUrl/getFileFromUrl in this original mapping.
- D:135989–136009 authorizes that request before download; 136384–136392 checks path and preflight size and returns `{kind:'file-stream', chunks:oqe(...)}`. D:178665–178671 attaches that source to the UC replies lane. By contrast exec outputs are consumed synchronously into materialized client/control frames from Ki (136337–136350). They are never attached file sources.
- Box has its own outer download conversion/consumption; it remains unchanged, including its existing download stub. This batch does not implement upload/discover-ai-tool/URL transfer or new exec variants.
- Frozen `src/generated/aiserver.v1_pb.ts`: Download 82815–82865 has path(1), optional approval_id(2), standing(3), approval(4); File 82925–82969 has bytes data(1), uint32 seq(2), bool last(3). Existing generated RequestFrame/ResponseFrame and Connect Submit are sufficient. No generated schema change or handwritten wire codec is necessary or made.

## Authorization BEFORE filesystem access

- k6r D:136400–136405 describes `{action:'read-file', target:path, attachToResourcePath:path}`. Raw requested path is used for approval matching before path resolution, not the canonical path.
- D:135991–135999 awaits isLocalUseBlocked -> j/AUe (179278–179290) -> Qce (81473–81501). `read-file` is global (81062 onward). The implemented `downloadRefusal` reuses the existing global-only Qce/AUe decision, with an explicit download descriptor. No default-allow or bypass for unimplemented non-exec approvals is added.
- Non-SA: ceiling never refuses; effective always allows; otherwise a live matching local approval can allow, even effective never with non-never ceiling. Server flags are ignored. SA: approval flag wins; standing authorizes a global action; otherwise a matching local approval must have current accountScope. Existing expiry, retirement and cross-target resourcePath/undefined-machineId quirks remain unchanged. No local standing-grant feature is added.
- File refusal is fileError, not exec throw/id allocation. Permission is read synchronously per admission, then awaited decision, then path/stat/source creation.

## Source and path ownership

- D:132584–132602 n9 checks lexical containment, realpath(root), and nearest-existing ancestor realpath (kDe 79762–79774). The original `_ft` uses startsWith('..'), even for an ordinary '..name' child; preserved here. If root realpath fails the original returns the lexical target. Check-to-open is not atomic; symlink/path replacement races are not claimed fixed. The newline-cwd security fix is unaffected.
- D:136385–136388 preflight stat rejects a regular file over default 100 MiB (135920). ENOENT/ENOTDIR stat means unknown size (132528–132540), with later open/read returning a structured file error.
- Ype D:97843–97893 owns a lazy, shared open promise and FileHandle. open-time stat gives a known positive regular-file size; otherwise size is unknown. Read fills up to 1 MiB using repeated short reads, accumulates sent bytes, checks maxBytes, and returns last on EOF or exact open-time size. Empty files yield one empty last chunk; exact MiB files need no extra empty chunk. Size changes retain the original open-time-size behavior.
- `read()` converts errors to `{kind:'error',error:message}`; consumer closes on error/last. `close()` is idempotent and fire-and-forget, including eventual handle closure if close wins a pending open. It does not synchronously cancel arbitrary in-flight OS reads; lane identity prevents their late result from being admitted.

## Attached lane, close/cancel and retries

- oee D:177287–177389 owns `{chunks,seq:0,reading}`. Replacement closes the old source. Read ahead starts only with no pending read and no buffered file frame. The result is admitted only for the exact current attachment identity. Terminal/error detaches and closes before onReady/flush; thus its buffered final frame survives dropStreams.
- Stream-only lanes remain held/keepalive-eligible. take rotates a touched lane even if empty but still attached; it starts the next read after taking. While Submit is pending one subsequent chunk may be prefetched. Limits remain 256 frames/8 MiB total/1 MiB file data per batch, non-file first and existing fairness.
- D:177338–177343 drop closes/deletes one whole lane. dropStreams deletes only lanes STILL attached, never all materialized replies. Existing provider close D:178101–178114 drops attached lanes before awaiting flush idle, then control-drains retained terminals when proven. Existing cancel ordering/cancel-terminal fixes are preserved.
- D:178742–178768: after 3 failed normal Submit attempts, any non-replayable file frame (including a last chunk with seq>0) causes source/lane drop and exact y9r fileError replacement. A single-frame file `{seq:0,last:true}` and fileError instead use the existing 120s closing budget. 3x200ms retry bytes, auth pause/requeue, cancellation abort and 30s exec closing budget are unchanged. Close drain still makes one control attempt per batch, not normal retry policy.
- Important original quirk: unlike exec, the non-exec v_.handle branch D:135989–136030 has **no post-authorization cancelled check**. Cancellation while authorization/path setup is pending can precede later attachment; this batch does not invent stronger admission fencing. Cancellation after attachment closes/drops it normally. Similarly an uncooperative setup outliving the existing close deadline is not made magically cancellable. These are known limits, not proof of full lifecycle equivalence.

## Implemented surface and remaining work

`uc/file-source.ts`: source, path/preflight, size limits; `uc/reply-lanes.ts`: attachment/readAhead/identity/drop and exhaustion replacement; `uc/provider.ts`: download mapping + guarded admission; `uc/approvals.ts`: raw read-file descriptor and reuse of existing global decision; `uc/types.ts`: narrower remaining-gap statement. Tests use only temporary synthetic files/authority records and in-memory fake peers, including generated protobuf roundtrips.

No upload, file URL transfer, Box streaming, download-to-agent storage pipeline, non-global approval classes, all-standing/multi-account/ripgrep, disk outbox or new queue limits are added. Historical ownership timeout root cause remains unknown and original ownership race is unchanged. This is not complete drop-in compatibility.

## Actual validation for this batch

- Added 18 fixed-expectation tests in `test/uc-file-source.test.cjs`; target command ran that file plus uc-close-channel, uc-approvals, exec-output-channel: **56/56 passed**, no skips or functional test failures. Download admission/source/Submit tests use an in-process fake peer and generated protobuf roundtrips, not a complete daemon subprocess or real network download service.
- `UC_SKIP_OFFICIAL=1 npm test --workspace=local-exec-daemon`: 269 total, **265 passed / 4 skipped / 0 failed**.
- Root `npm run build`: passed. `UC_SKIP_OFFICIAL=1 npm test`: control **227/227**, daemon **265 passed / 4 skipped / 0 failed** (269 total), organization **6/6**. Each planned functional scope ran once; no test failure was rerun away.
- Development failures are NOT erased: first `node --check` failed for a missing brace in the short-read mock; it was corrected before testing. First daemon build failed TS2322 because frozen generated File.data infers `Uint8Array<ArrayBuffer>` while FileRead initially declared ArrayBufferLike. The source already allocates an owned ArrayBuffer; only its declaration was narrowed, without changing schema, adding a cast or copying frames. A subsequent build validated that specific type correction. Raw failed build and correction notes are retained in local, uncommitted validation evidence; the original syntax diagnostic also remains in the tool transcript.
- Historical evidence untouched; no commit/push. HEAD remained `7cff6e9efa732f5ed4f7ebaaa67d9e690dfe8f5f`.

## Related t153

UC outer **upload** and Box JSON **materialized download** are documented in `upload-box-url-evidence.md`. They are not the same as this attached-source download path. URL transfer remains unimplemented because original v9r ignores those frames.
