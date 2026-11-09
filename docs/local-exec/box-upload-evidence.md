# Box JSON channel upload (t154)

Static 0.79.3 evidence (`daemon.formatted.cjs`, D:; offline main.cjs SHA256 5c1424ed…6be). "Box" = local-exec Box JSON control plane (`BoxProvider`), never Box.com. Synthetic fake peer only; official binary not run. Excerpts: `/tmp/exec-t154-evidence/`.

## Original mechanism

| Step | Original | Lines |
|---|---|---|
| Wire schema | `{kind:'upload', requestId, path, bytesBase64, approvalId?}` (zod object; unknown kinds ignored by `Upe`, schema failure throws → frame dropped with `console.error`) | rHt 97417–97423, MJe 97455–97460 |
| SSE reader | blocks split on `\n\n`; block longer than `maxUploadFrameBytes` → `rejectOversizedFrame`; unterminated buffer longer than limit → reject, keep last char, skip until next blank line | 137431–137475 |
| Frame limit | `OJe(maxFileBytes) = ceil(max*4/3) + 64 KiB` (default max 100 MiB) | OJe 97402, v_ ctor 135920–135921 |
| Oversized reply | regex `"requestId"\s*:\s*"([^"\\]+)"` over first 4096 chars; if found → `file-error` with `kJe` text; else nothing | 137476–137485, kJe 97399 |
| Event parse | `data:` lines, `slice(5).trim()`, joined with `\n`, one `JSON.parse` | dispatchEventBlock 137486–137510 |
| Conversion | `Buffer.from(bytesBase64,'base64')` (lenient), `LL(...)`, **authorization `{kind:'none'}`** (server flags never trusted) | Nwr 137571–137578, LL 135875–135884 |
| Dedupe | `withInflight`: requestId already in flight → ignored; inflight count reported | 136032–136042 |
| Authorization | `k6r` → `{action:'write-file', target:path}` via isLocalUseBlocked (Qce/AUe). Refusal → `file-error` | 135989–136004, 136398–136399 |
| Execute | `n.length > maxFileBytes` → `file-error Od(...)` **before** `n9`; `n9` path gate; `cp` write; success `{kind:'file', requestId}` | upload() 136374–136382 |
| Errors | thrown → `file-error` with `Wn(e)` (message) | emitFileResult 136365–136372 |
| Reply | `Dwr`: `file` without bytes → `{kind:'file', requestId}` (no `bytesBase64` key) | 137583–137599 |

## Implemented (src/box/provider.ts)

- `openSse` rewritten to the original reader (StringDecoder streaming decode like TextDecoder `stream:true`; removed our invented 8 MiB SSE cap that destroyed the stream; oversized → `rejectOversizedFrame`, skip-to-blank-line).
- `dispatchEventBlock`: `data:` prefix 5 + trim, join `\n`, one JSON parse (previously per-line `data: `).
- `upload`: schema check → base64 → `withInflight` → `uploadRefusal` (SA false, authorization none) → `writeUploadFile(root, path, bytes, maxFileBytes)` (size check first, then n9 port, temp+rename) → `{kind:'file', requestId}`.
- `download` also moved under `withInflight` and schema check (original same v_.handle branch).
- `maxFileBytes` option (original `options.maxFileBytes`, default 104857600) and exported `maxUploadFrameBytes` / `uploadFrameTooLarge`.

## Not implemented / retained differences

- `cp` lock table (yI/gUe) and exact fsync edge cases: still the existing `writeUploadFile` approximation (documented in t153).
- Box hello is still posted on `welcome` (original posts hello right after connect, 137410–137430); pre-existing difference, unchanged.
- `Mwr` messages-op parse-failure reply is not added (Box messages-op is not implemented).
- Exec frames keep the existing `seen` set (not changed this batch).

## Tests

`test/box-upload-discover-ai-tool.test.cjs`: Box upload success (non-empty + empty), size refusal Od text, path escape, schema-invalid drop, ask refusal under forced none; oversized single block and split unterminated block → kJe with requestId and the stream continues.

## t154 test record (box-upload / discover-ai-tool / ls)

- New file first run: 9 tests, 5 pass / 4 fail — all 4 were wrong expectations written by hand (QJe counts depth-2 files because recursion is `a < e`; a 200×`a` title is hex-like and hits Ojt[8] `[redacted]` first). Implementation unchanged; expectations corrected from the original code; second run 9/9. ls test added → 10/10.
- Target set (new + uc-upload-box-download + review-fixes + exec-codec): 36/36.
- Root build passed. Root full run 1: control 227/227; daemon 287 total, 262 pass / 24 fail / 1 skip — all 24 in `uc-lifecycle.test.cjs`, cause `unmocked module ./uc/ai-tool-discovery` (vm harness strict module map vs. new `index.ts` import); organization not run (`&&` chain). Fix: harness mock entry. That file alone 26/26. Root full run 2: control 227/227, daemon 287 total 286 pass / 1 skip / 0 fail, organization 6/6.
- **Incident**: both root runs were launched without `UC_SKIP_OFFICIAL=1`, so the 3 `oracle cancel-overflow* (official)` tests in `uc-keepalive.test.cjs` executed the offline lab official `main.cjs` (bwrap, fake peer) — 6 executions total. Earlier batches set `UC_SKIP_OFFICIAL=1` (4 skips). No lab files were modified; no process left running.
