# Box JSON channel upload

Static 0.79.3 evidence (`daemon.formatted.cjs`, D:; offline main.cjs SHA256 5c1424ed…6be). "Box" = local-exec Box JSON control plane (`BoxProvider`), never Box.com. Synthetic fake peer only; official binary not run. （当时的摘录放在 `/tmp/exec-t154-evidence/`，属于临时目录，可能已不存在。）

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

## Tests

`test/box-upload-discover-ai-tool.test.cjs`: Box upload success (non-empty + empty), size refusal Od text, path escape, schema-invalid drop, ask refusal under forced none; oversized single block and split unterminated block → kJe with requestId and the stream continues.

## 剩余差异

无。当时记录的差异后来都已处理：hello 改为 connect 后立即发送（[box-hello.md](box-hello.md)）；Box messages-op 和 Mwr 解析失败回复已实现（[box-messages-op.md](box-messages-op.md)）；cp 写入器已移植（[cp-write.md](cp-write.md)）。原记录见 [history](../../history/local-exec-evidence-rounds.md)。
