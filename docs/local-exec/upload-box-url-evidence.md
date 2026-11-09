# UC upload / Box download / URL transfer (t153)

Static 0.79.3 evidence from the existing locally formatted daemon source (`daemon.formatted.cjs`, not committed). Synthetic isolation only. Not full drop-in. No official complete daemon execution and no real network transfer.

## 1) UC outer upload — implemented this batch

- Request mapping D:178874–178881 (`v9r`): `{kind:'upload', path, bytes:data, approvalId, authorization:c5}`. Frozen `GrokBotUserComputerUpload` fields path(1), approval_id(2), data(3), standing(4), approval(5).
- Authorization D:k6r 136398–136399 → `{action:'write-file', target:path}` through the same global Qce/AUe chain as exec/download. No default allow. Refusal is `fileError` (136453–136456), not exec throw.
- Execution D:136374–136382: byte-length check against `maxFileBytes` (default 100 MiB) **before** path resolve; `n9` path gate; `cp` write; success `{kind:'file', requestId}` with no bytes.
- Success framing D:Y_ 179080–179091: undefined/empty bytes → one `file` response with empty data, seq=0, last=true. Not an attached source.
- Write primitive D:cp 80591–80602 / yLe mkdir / temp+rename / default mode hLe=438 (0o666), preserve existing mode. Current `writeUploadFile` approximates this (no original in-process lock table); same class of approximation as the existing approval writer note.
- Cancel/close: same non-exec branch as download — no post-authorization cancelled check in original `v_.handle` (135989–136030). Existing UC close/dropStreams behavior is unchanged (upload has no attached source).

## 2) Box channel download — implemented this batch (different from UC)

- This is the **local-exec Box JSON control plane** (`BoxProvider` / `ReplyQueue`), not any Box.com SaaS plugin.
- Request conversion D:Nwr 137564–137566: download keeps path/approvalId but **forces `authorization:{kind:'none'}`**. Server standing/approval flags on the JSON event are therefore never trusted as SA.
- Executor still runs `isLocalUseBlocked` with k6r read-file description (135989–136009). Ceiling, effective permission, and matching local approvals still apply under authorization none.
- Result path D:137519–137544: `file-stream` is **not** attached to UC oee. `enqueueWholeFile` awaits `iqe` (97895–97906) to materialize every chunk, then enqueues one JSON `{kind:'file', bytesBase64}` (or file-error).
- Current implementation: Box provider calls `downloadRefusal` with `serverAuthoritative:false` + authorization none, then `handleDownload` → `prepareDownload` + `readWholeFile` → `prepareBoxExecFrame` bytesBase64. Existing Never/Ask/symlink integration expectations remain.
- Box upload exists in original Nwr (137571–137578); implemented in t154, see `box-upload-evidence.md`.

## 3) URL transfer — evidence only, not implemented

- Frozen request oneofs `put_file_to_url` (13) and `get_file_from_url` (14) and response `urlTransfer` (sha256/size_bytes) exist in generated proto. Capability flag `url_file_transfer` exists.
- Original UC mapping D:v9r 178890–178892 returns **undefined** for both put/get. Correction (t154): undefined is not a silent drop — the poll loop (178512–178516) enqueues `w9r(case, requestId)` when `frame.requestId` is non-empty; for put/get that is the default branch (178791–178792) `control throw{id:0, error:z2}` ("does not understand that request frame"). The item is ACKed and never admitted (no inflight/backlog). t154 aligns UC to this (`Queued.unsupported`).
- No handler body for performing HTTP PUT/GET, hashing, or emitting `urlTransfer` was found on the local-exec admission path. Response-size accounting mentions `urlTransfer` (177413–177414, 178818) but that is not an implementation of the transfer.
- Therefore this batch does **not** invent a network transfer, fake a capability, or change the frozen baseline. A later stage would need explicit original handler evidence beyond v9r ignore, plus an offline fake-peer plan that never hits the public internet.

## Remaining gaps

- (t154: Box upload and discover-ai-tool now implemented.) messages/local-tool, standing-grant subject actions, multi-account, exact cp lock table, full official write fsync edge cases.
- Historical ownership 20s timeout root cause still unknown; original ownership race preserved.
- Existing UC download attached-source path, Ki producer channel, cancel-terminal ordering, retry/fairness/256/8MiB/1MiB, newline-cwd security fix, and approval quirks are retained.
