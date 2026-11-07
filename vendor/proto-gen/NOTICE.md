# Vendored generated protocol clients

**本仓库从App恢复生成** — these files were regenerated *by this repository's maintainers* from a static
extraction of the official Grok Bot desktop App. They are **not** an official xAI/Cursor SDK and are
**not** a byte copy of any upstream repository.

| Item | Value |
|---|---|
| Source App | Grok Bot **0.79.3** Linux amd64 (`grok-bot_0.79.3_amd64.deb`), release commitSha `473941287261c3efa92c6b2a0bf7e1caad1a2ef2` |
| Formal `.proto` source | [`proto/`](../../proto/) (same bytes as `docs/protocol/baselines/schema-0.79.3/*.proto`) |
| Schema input | `dist/electron-main/proto.cjs` from that build's `app.asar`, sha256 `929f17d21f4646c745a9fc4c4a43b55ff686288b5637dc310587471a20f12f8a` (read as text, never executed) |
| Restore method | `extract_proto.py` from https://github.com/younglark/grokbot-proto @ `49fd8ce` (script sha256 `ab3ec201…2301`) → `.proto` |
| protoc | `grpcio-tools` 1.85.1 (libprotoc 35.1) |
| Generators | `@bufbuild/protoc-gen-es` **1.10.1** (`target=js`), `@connectrpc/protoc-gen-connect-es` **1.6.1** (`target=js`) |
| Runtime deps | `@bufbuild/protobuf@1.10.1`, `@connectrpc/connect@1.6.1` (same as the App's `package.json`) |
| Licence of generators/runtime | Apache-2.0 (Buf / Connect) |
| Schema licence | No licence declared; `.proto` restored from compact descriptors — facts from a reverse-engineered schema. Comments/options are not recoverable. |

Pipeline check: the same toolchain applied to upstream's 0.78.4 `.proto` reproduces the previous vendor files
byte-for-byte (and upstream `descriptor/desc.pb`), so differences in these files reflect schema changes only.

Do **not** import from `../grokbot-proto` or absolute `/workspace` paths at runtime.
Hashes and verification: `docs/protocol/baseline-manifest.md`. Regenerate: `docs/protocol/update-runbook.md`.
