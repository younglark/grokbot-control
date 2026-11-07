# Baseline manifest

## Schema baseline used by `vendor/proto-gen` (what the code is compiled against)

| Item | Value | Level |
|---|---|---|
| Upstream restore repo | https://github.com/younglark/grokbot-proto | — |
| Commit | `49fd8ce62136f72d268a04249f1748e0055d3d2d` ("Record Grok Bot 0.78.4: protocol unchanged"); equals remote `main` on 2026-11-07 | verified (`git ls-remote`) |
| App version of that schema | `0.78.4` (macOS build; `APP_VERSION`) | S |
| Upstream stats | 2736 messages, 349 enums, 7 services, 607 RPCs | S (upstream README) |
| Generators | `@bufbuild/protoc-gen-es` 1.10.1, `@connectrpc/protoc-gen-connect-es` 1.6.1 | upstream `codegen/package.json` |
| Runtime | `@bufbuild/protobuf` 1.10.1, `@connectrpc/connect` 1.6.1 | `package.json` |

`vendor/proto-gen/*.js` are **byte-identical** to upstream `codegen/src/js/` at that commit (checked with `cmp`, 2026-11-07):

| File | sha256 |
|---|---|
| agent.v1_pb.js | `e6f109fe88c7f849b6c7120d6175efad92bab98eb1d1dd6c3338e2bf56d8baf3` |
| aiserver.v1_pb.js | `5ca35dc53923a3db921ba2712e77b63d00098f7694a61bbe9443e4dab94f8f33` |
| aiserver.v1_2_pb.js | `ac248083e869d3690c736102320544514a2e951f77981aeda3f8206ef88891af` |
| anyrun.v1_pb.js | `3d753b7a260ab3926ef22b14109db0161f7721f9062b0d876f10b4f2b6d64d83` |
| internapi.v1_pb.js | `6bad66a292c08afd74be5c222e635a148000c81234ec214eae9161d1f4b1ca1b` |
| svc_aiserver.v1.GrokBotService_connect.js | `61daae0c68499c8f4a1783ba7a0ebdb11d9c475555cd88d4869dd1ab08e679a4` |

## App build used for auth analysis and the 0.79.2 schema comparison

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

- **The vendored code is still the 0.78.4 schema.** The 0.79.2 used-surface diff is additive only
  (see [baselines/used-surface-diff-0.78.4-to-0.79.2.md](baselines/used-surface-diff-0.78.4-to-0.79.2.md)),
  so the current client is wire-compatible for what it uses, but new 0.79.2 fields are not exposed.
- The macOS 0.79.2 build was not re-analysed here; Linux and macOS share the bundle layout but this was not byte-compared.
