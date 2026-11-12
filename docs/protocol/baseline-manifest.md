# Baseline manifest

## Schema baseline used by `vendor/proto-gen` (what the code is compiled against) — **0.79.4**

**Immutable App proto.cjs archive = [packages/protocol/baselines/schema-0.79.4](../../packages/protocol/baselines/schema-0.79.4/)** (sibling SHA256 manifest). **Current generator input = [schema-0.79.4-daemon-exec](../../packages/protocol/baselines/schema-0.79.4-daemon-exec/)** — the 0.79.3 additive Exec* closure re-applied unchanged (daemon descriptors byte-identical; see its `SOURCE.json`). Full comparison: [app-0.79.4-delta.md](app-0.79.4-delta.md).

| Item | Value | Level |
|---|---|---|
| Release feed | `https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand`, opened 2026-11-11 10:24 (UTC+8) with `curl`, no login → `version` 0.79.4, `commitSha` `7b5e3d87b3866229f111269975bc91bd8f3f7243` | S |
| Package URL | `https://downloads.cursor.com/grokbot/stable/7b5e3d87b3866229f111269975bc91bd8f3f7243/linux/x64/grok-bot_0.79.4_amd64.deb` (HTTP 200, Last-Modified 2026-11-10 13:03:03 UTC+8) | S |
| deb | 112689172 bytes, sha256 `cf0fd0032249cf08e75f6dff045766b5195078dd878d1eeed60a68c4d31a7a5a` (locally computed; no publisher signature verified). `dpkg-deb`: Package grok-bot, Version 0.79.4, amd64 | S |
| `app.asar` sha256 | `c35f7482c2f4e0f054c516be88f709b24f2b72007b6f2f700121cf22d644df50` | S |
| `dist/electron-main/proto.cjs` | 1534639 bytes, sha256 `880f89188e42755f2b231edebc87ba86a62c1757f17ad62626d3e2f4373f4d93` | S |
| `dist/electron-main/main-app.cjs` | 3508308 bytes, sha256 `8b68e8a64a5458c50121a45289907e91769d07cd8f8a8a754e768a621c22b831` | S |
| `dist/electron-main/main-core.cjs` | 1161012 bytes, sha256 `986ec9ad362f3fee5ccf7cc74ebd5edaf7cf03d13c8da26700bcfd3e6acf2d25` | S |
| App `package.json` | version 0.79.4, `@bufbuild/protobuf` 1.10.1, `@connectrpc/connect` ^1.6.1 (unchanged) | S |
| Extraction | upstream `extract_proto.py` @ grokbot-proto `49fd8ce` (sha256 `ab3ec201…2301`): 2923 messages, 387 enums, 7 services, 662 RPCs; unresolved 0, relocated 0 | S |
| snapshot.json | sha256 `00712c32f2b611068fb75075ad0615297f648fe6f8e3e2363f1f9fb0a18a0961` (archived gzipped: `baselines/schema-0.79.4/snapshot.json.gz`, sha256 `f6ea0f6a…9152`) | S |
| Schema diff vs 0.79.3 | +2 optional fields: `CompleteMcpOAuthRequest.oauth_error = 3`, `CompleteMcpOAuthResponse.continue_authorization_url = 6`; no message/enum/RPC added or removed (`baselines/full-schema-diff-0.79.3-to-0.79.4.txt`) | S |
| Codegen | `npm run generate` (Buf 1.50.0, protoc-gen-es 1.10.1, protoc-gen-connect-es 1.6.1); only `aiserver.v1_pb.{js,ts}` and `SOURCE.json` change | O |
| Static consistency | `verify_generated.mjs vendor/proto-gen <0.79.4 snapshot>`: 2923 messages, 387 enums, 464 GrokBotService RPCs, 2923/2923 round-trips, 0 errors. Negative control (new code vs 0.79.3 snapshot) reports exactly the 2 changed messages | O |
| Used surface | 0.79.3 → 0.79.4: identical subset (20 RPCs / 70 messages / 24 enums), 0 breaking (`baselines/used-surface-diff-0.79.3-to-0.79.4.md`) | O |
| Auth anchors | `fingerprint.py`: 67 anchor lines on main-app/main-core, identical to 0.79.3 after normalising offsets and minified names | S |

| Vendored file (control ESM, current generator) | sha256 (0.79.4) | vs 0.79.3 output |
|---|---|---|
| agent.v1_pb.js | `94ca898d61d0267746d18fd42c94438c64e476bf4f9a7cd1e9a205764dfc3930` | same |
| aiserver.v1_pb.js | `02f2a3db81c2c86324440e3fb7411456258330fc4a962f0af4ea15f915fb0c9b` | changed (+2 fields) |
| aiserver.v1_2_pb.js | `c3d1add0cc5bc702de676144c748f6dcf7980860c990641956dda095b0c33e71` | same |
| anyrun.v1_pb.js | `3d753b7a260ab3926ef22b14109db0161f7721f9062b0d876f10b4f2b6d64d83` | same |
| internapi.v1_pb.js | `6bad66a292c08afd74be5c222e635a148000c81234ec214eae9161d1f4b1ca1b` | same |
| svc_aiserver.v1.GrokBotService_connect.js | `88228cd0b039c8260290e4f53477454b2fa0353ec39ec5754620239144314f72` | same |

Installer, `app.asar` and bundle files are **not** committed. External copies: `/workspace/grokbot-linux-0.79.4/` (deb, extracted tree, `asar-out/`, `proto-out/`).

## Previous schema baseline — 0.79.3 (frozen, kept)

`vendor/proto-gen` is **本仓库从App恢复生成** (regenerated in this repo from the App; not a byte copy of upstream).

**Immutable App proto.cjs archive = [packages/protocol/baselines/schema-0.79.3](../../packages/protocol/baselines/schema-0.79.3/)** (sibling SHA256 manifest). **Generator input until 2026-11-10 = [schema-0.79.3-daemon-exec](../../packages/protocol/baselines/schema-0.79.3-daemon-exec/)** — additive Exec* closure from daemon compact descriptors; parent archive untouched.

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

0.79.3 first-class sources (now superseded by `schema-0.79.4/`): `packages/protocol/baselines/schema-0.79.3/*.proto`; restore/provenance records: `packages/protocol/RESTORE.md`, `packages/protocol/NOTICE.md`. Historical hashes below remain unchanged.
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

- **The vendored code is the 0.79.4 schema** (regenerated 2026-11-11; 0.79.3 → 0.79.4: +2 optional fields outside the used surface).
- 0.79.3 history: regenerated 2026-11-07. Used surface 0.78.4 → 0.79.3: 0 breaking, additive only;
  0.79.2 → 0.79.3: no change in the used surface (full schema: +1 message, +1 field, +1 RPC `SetOnePasswordPreviousIntegration`).
- The 2026-11-07 live read-only check (login + ListGrokBotAgents / GetGrokBotUserRuntimeSettings / ListGrokBotAgentStatuses) was
  done with the **old 0.78.4 vendor**. The 0.79.3 and 0.79.4 vendors are verified **offline only**.
- macOS builds were not analysed for 0.79.x.

## Current layout

Runtime vendor path is `packages/grokbot-control/vendor/proto-gen`; daemon output is `packages/local-exec-daemon/src/generated`. Both come from `npm run generate` (Buf 1.50.0, see [update-runbook.md](update-runbook.md)); the vendor hashes in the table above are a historical record of the original grpcio-tools run (the workspace generator reproduced them byte-for-byte at the move, a9231c2). The input later switched to `schema-0.79.3-daemon-exec` (additive Exec* types) and on 2026-11-11 to `schema-0.79.4-daemon-exec`, so current output hashes may differ from the historical table; the source of truth is now `SOURCE.json` (input hashes + tool versions) plus `npm run generate:check` (byte check of outputs).

## Daemon bundle (local-exec-daemon parity source)

| Item | Value |
|---|---|
| `dist/local-exec-daemon/main.cjs` (0.79.3) | sha256 `5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be`; identical in the Linux deb and the macOS 0.79.3 App |
| `dist/local-exec-daemon/main.cjs` (0.79.4) | 3998633 bytes (same length), sha256 `c2b2c0edde611b5c3cfaf58a368ae021244f0e8fd873bceaac4f2868cfb66420`; 76 bytes differ from 0.79.3 (Sentry debug id ×3, LAt literal `"0.79.3"`→`"0.79.4"`) |
| `dist/local-exec-daemon/messages-worker.cjs` | 121022 bytes, sha256 `b6f5c672…667b` (matches asar integrity); **identical in 0.79.4** |
| Formatted copy used for **D:** line numbers | `daemon.formatted.cjs`, 187 625 lines, sha256 `ad69a772b5a725c051ac423138889dc0e328de023d6414f7da9a3885c520684c` (prettier, babel parser; not committed) |
| 0.79.4 formatted copy | `/workspace/grokbot-node-analysis-0794/daemon.formatted.cjs`, prettier 3.9.10, 187 625 lines, sha256 `1ca01f7de6f515393fb104511897a9f46efaeb356754033bb9b6808f47707678`; differs from the 0.79.3 copy only on lines 16, 18, 78971, 187625, so every D: line number holds for both. The same prettier reproduces `ad69a772…` from the 0.79.3 bundle |
