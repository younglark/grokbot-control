# Restored Grok Bot protocol (`.proto`)

**正式协议源** — first-class restored protobuf sources for this repository. The JavaScript clients in
`vendor/proto-gen/` are generated from these files (same schema, App 0.79.3).

| Item | Value |
|---|---|
| App | Grok Bot **0.79.3** Linux amd64 |
| Release commitSha | `473941287261c3efa92c6b2a0bf7e1caad1a2ef2` |
| Input | App `dist/electron-main/proto.cjs`, sha256 `929f17d21f4646c745a9fc4c4a43b55ff686288b5637dc310587471a20f12f8a` (text parse only; never executed) |
| Extractor | `extract_proto.py` from https://github.com/younglark/grokbot-proto @ `49fd8ce` |
| Label | **本仓库从App恢复** — not an official xAI/Cursor SDK; original comments and options are **not** recoverable |

## Contents

| File | Package / service |
|---|---|
| `agent.v1.proto` | `agent.v1` |
| `aiserver.v1.proto` | `aiserver.v1` (bulk of GrokBot messages) |
| `aiserver.v1_2.proto` | `aiserver.v1` (split file) |
| `anyrun.v1.proto` | `anyrun.v1` |
| `internapi.v1.proto` | `internapi.v1` |
| `svc_aiserver.v1.GrokBotService.proto` | Connect service used by this project |
| `svc_aiserver.v1.*.proto` | Other aiserver services (present for a complete schema; not used by SDK/CLI/MCP) |
| `NOTICE.md` | Provenance and licence notes |

Versioned baseline snapshot (do not delete): `docs/protocol/baselines/schema-0.79.3/` — same `.proto` bytes plus
`snapshot.json.gz`. Keep them in sync when upgrading (`cmp` each file).

## Regenerating `vendor/proto-gen`

See `docs/protocol/update-runbook.md`. Short form (do **not** run App bundle code):

```bash
# after extract_proto.py produced this directory:
python3 -m grpc_tools.protoc -I proto --descriptor_set_out=/tmp/desc.pb proto/*.proto
# then protoc-gen-es 1.10.1 + protoc-gen-connect-es 1.6.1, target=js → copy the 6 used files into vendor/proto-gen/
node tools/protocol/verify_generated.mjs vendor/proto-gen <(gunzip -c docs/protocol/baselines/schema-0.79.3/snapshot.json.gz)
```

Runtime deps stay `@bufbuild/protobuf@1.10.1` / `@connectrpc/connect@1.6.1` (match the App).
