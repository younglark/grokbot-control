# Baseline manifest

## Schema baseline used by `vendor/proto-gen` (what the code is compiled against) — **0.79.3**

`vendor/proto-gen` is **本仓库从App恢复生成** (regenerated in this repo from the App; not a byte copy of upstream).

**Immutable App proto.cjs archive = [packages/protocol/baselines/schema-0.79.3](../../packages/protocol/baselines/schema-0.79.3/)** (sibling SHA256 manifest). **Current generator input = [schema-0.79.3-daemon-exec](../../packages/protocol/baselines/schema-0.79.3-daemon-exec/)** — additive Exec* closure from daemon compact descriptors; parent archive untouched.

| Item | Value | Level |
|---|---|---|
| Release feed | `https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand`, opened 2026-11-07 with `curl`, no login → `version` 0.79.3, `commitSha` `473941287261c3efa92c6b2a0bf7e1caad1a2ef2` | S |
| Package URL | `https://downloads.cursor.com/grokbot/stable/473941287261c3efa92c6b2a0bf7e1caad1a2ef2/linux/x64/grok-bot_0.79.3_amd64.deb` (HTTP 200, Last-Modified 2026-11-07 07:20:22 Asia/Singapore) | S |
| deb | 112699168 bytes, sha256 `eee0d637cd68becd2202f765d1302443d4096c52eb632c2177ef0ded29e7168d` (locally computed; no publisher signature verified). `dpkg-deb`: Package grok-bot, Version 0.79.3, amd64 | S |
| `app.asar` sha256 | `5e13b57664c39a36a84d75dcfcd94f7321a38beab18fa417d1df322e5b2fabe9` | S |
| `dist/electron-main/proto.cjs` | 1534590 bytes, sha256 `929f17d21f4646c745a9fc4c4a43b55ff686288b5637dc310587471a20f12f8a` | S |
| `dist/electron-main/main-app.cjs` | 3503781 bytes, sha256 `d54cc236e295d9bb8ee850769b6fceb0079036e4dd117d7f487d35124a268209` | S |
| `dist/electron-main/main-core.cjs` | 1160950 bytes, sha256 `910cc6bf1145a05efb01185d315e800e28d6242bfef01cae6e945e6aa908e34d` | S |
| App `package.json` | version 0.79.3, `@bufbuild/protobuf` 1.10.1, `@connectrpc/connect` ^1.6.1 | S |
| Extraction | upstream `extract_proto.py` @ grokbot-proto `49fd8ce` (sha256 `ab3ec2012ade9527387e772b36445bc97a506e42b6a4179e5e1bc5343ca52301`): 2923 messages, 387 enums, 7 services, 662 RPCs; unresolved 0, relocated 0, backward cross-file edges 0 | S |
| snapshot.json | sha256 `ab22284058282cd8fd861dbdd08a0fbf7cf6de6c2978f4b69beeaed7d5aeed37` (archived gzipped: `baselines/schema-0.79.3/snapshot.json.gz`, sha256 `eaecc638…4212`) | S |
| Descriptor set | `grpc_tools.protoc` (grpcio-tools 1.85.1 / libprotoc 35.1 / Python protobuf 7.36.2): 834442 bytes, sha256 `ab4e09d428dd87a6c2c4aea422f0e515375bf1138a5790bd4beb8c1b701c293f` (not committed) | O |
| Codegen | `@bufbuild/protoc-gen-es` 1.10.1, `@connectrpc/protoc-gen-connect-es` 1.6.1, `target=js`, Node v24.22.1 | O |
| Pipeline reproducibility | same toolchain on upstream 0.78.4 `.proto` → the previous 6 vendor files byte-identical and `desc.pb` identical | O |
| Static consistency | `tools/protocol/verify_generated.mjs vendor/proto-gen <snapshot>`: 2923 messages, 387 enums, 464 GrokBotService RPCs match; 2923/2923 binary+JSON round-trips; 0 errors. Negative control (0.78.4 code vs 0.79.3 snapshot) fails as expected | O |
| App-side wire cross-check | **not run**: upstream `compare.mjs`/`cross-wire.mjs` `require()` the App bundle, which this project does not execute | — |

| Vendored file | sha256 (0.79.3) | vs 0.78.4 |
|---|---|---|
| agent.v1_pb.js | `62ea215374df3e66578923a969cfcf044ba5d324369f48fab6cb4a50c521316c` | changed |
| aiserver.v1_pb.js | `a4aa38429919eeef419fe54b8f21b3b68c11c3de881558ee81e9a37206e2eefc` | changed |
| aiserver.v1_2_pb.js | `ac248083e869d3690c736102320544514a2e951f77981aeda3f8206ef88891af` | same |
| anyrun.v1_pb.js | `3d753b7a260ab3926ef22b14109db0161f7721f9062b0d876f10b4f2b6d64d83` | same |
| internapi.v1_pb.js | `6bad66a292c08afd74be5c222e635a148000c81234ec214eae9161d1f4b1ca1b` | same |
| svc_aiserver.v1.GrokBotService_connect.js | `88228cd0b039c8260290e4f53477454b2fa0353ec39ec5754620239144314f72` | changed |

Current first-class sources: `packages/protocol/baselines/schema-0.79.3/*.proto`; restore/provenance records: `packages/protocol/RESTORE.md`, `packages/protocol/NOTICE.md`. Historical hashes below remain unchanged.
Archived freeze: `baselines/schema-0.79.3/*.proto` + `snapshot.json.gz`, `used-surface-0.79.3.json`,
`used-surface-diff-0.78.4-to-0.79.3.md`, `full-schema-diff-0.78.4-to-0.79.3.txt`, `full-schema-diff-0.79.2-to-0.79.3.txt`.
Installer, `app.asar` and bundle files are **not** committed.

## Previous vendor baseline (0.78.4, kept for comparison)

| Item | Value |
|---|---|
| Upstream | https://github.com/younglark/grokbot-proto @ `49fd8ce62136f72d268a04249f1748e0055d3d2d`, App 0.78.4 (macOS), 2736 msgs / 349 enums / 607 RPCs |
| Vendor file sha256 | agent `e6f109fe…8baf3`, aiserver `5ca35dc5…f8f33`, aiserver_2 `ac248083…891af`, anyrun `3d753b7a…d64d83`, internapi `6bad66a2…ca1b`, GrokBotService `61daae0c…e679a4` |
| Used-surface baseline | `baselines/used-surface-0.78.4.json` |

## Earlier App build: 0.79.2 (auth analysis; schema comparison)

| Item | Value | Level |
|---|---|---|
| Source | Official release feed `https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand` (opened 2026-11-07, version 0.79.2, commitSha `676f0815a4013954f4c8e3f4ac413acfbac0376c`) | S (recorded in analysis notes) |
| Package | `grok-bot_0.79.2_amd64.deb`, 112699424 bytes | re-hashed 2026-11-07 |
| deb sha256 | `0039b3832ad8743a95bb6c2a4f050e1ffbd491fc72dbbf71fdb8208799502217` (locally computed; **not** a verified publisher signature) | re-hashed |
| `opt/Grok Bot/resources/app.asar` sha256 | `cec56658c6879644f861ffef870561dca2e1dd9415985fcb2ccf43ff9977df89` | computed 2026-11-07 |
| `dist/electron-main/proto.cjs` | 1534017 bytes, sha256 `57ccef6a451a88cecb3d533df0b16991db577316e1572b19c118aa438fb15bf5` | re-extracted with `tools/protocol/asar_extract.py`, matches earlier record |
| `dist/electron-main/main-app.cjs` | 3506377 bytes, sha256 `b5f976ea3fba4e9564f4c9a828705a708774aa4f329a1133348e4a4eee5d8529` | same |
| `dist/electron-main/main-core.cjs` | 1160957 bytes, sha256 `310fac66118d490db826c9a17a4936ef11492a55c73d0d097480e28174f11e2f` | same |
| App `package.json` | `@bufbuild/protobuf` 1.10.1, `@connectrpc/connect` ^1.6.1 | extracted |
| 0.79.2 schema (upstream `extract_proto.py`) | 2922 messages, 387 enums, 7 services, 661 RPCs; unresolved refs 0, relocated 0 | S, run 2026-11-07 |

Prettified copies used for line-number citations (`A` = main-app, `C` = main-core) were produced with
prettier; their line numbers drift between versions — use the string anchors in auth-flow.md instead.

## Status

- **The vendored code is the 0.79.3 schema** (regenerated 2026-11-07). Used surface 0.78.4 → 0.79.3: 0 breaking, additive only;
  0.79.2 → 0.79.3: no change in the used surface (full schema: +1 message, +1 field, +1 RPC `SetOnePasswordPreviousIntegration`).
- The 2026-11-07 live read-only check (login + ListGrokBotAgents / GetGrokBotUserRuntimeSettings / ListGrokBotAgentStatuses) was
  done with the **old 0.78.4 vendor**. The 0.79.3 vendor is verified **offline only**.
- macOS builds were not analysed for 0.79.x.

## Current layout

Runtime vendor path is `packages/grokbot-control/vendor/proto-gen`; daemon output is `packages/local-exec-daemon/src/generated`. Both come from `npm run generate` (Buf 1.50.0, see [update-runbook.md](update-runbook.md)); the vendor hashes in the table above are a historical record of the original grpcio-tools run (the workspace generator reproduced them byte-for-byte at the move, a9231c2). The input later switched to `schema-0.79.3-daemon-exec` (additive Exec* types), so current output hashes may differ; the source of truth is now `SOURCE.json` (input hashes + tool versions) plus `npm run generate:check` (byte check of outputs).

## Daemon bundle (local-exec-daemon parity source)

| Item | Value |
|---|---|
| `dist/local-exec-daemon/main.cjs` (0.79.3) | sha256 `5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be`; identical in the Linux deb and the macOS 0.79.3 App |
| `dist/local-exec-daemon/messages-worker.cjs` | 121022 bytes, sha256 `b6f5c672…667b` (matches asar integrity) |
| Formatted copy used for **D:** line numbers | `daemon.formatted.cjs`, 187 625 lines, sha256 `ad69a772b5a725c051ac423138889dc0e328de023d6414f7da9a3885c520684c` (prettier, babel parser; not committed) |
