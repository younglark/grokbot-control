# 版本兼容矩阵与未验证项

| App version | Schema source | Used surface vs 0.78.4 | Auth anchors | Live |
|---|---|---|---|---|
| 0.78.4 (macOS) | upstream grokbot-proto `49fd8ce` | identical (previous vendor) | not analysed on this build | — |
| 0.79.2 (Linux amd64) | `extract_proto.py` run 2026-11-07 | **0 breaking**, additive only | analysed (auth-flow.md) | 2026-11-07: login (`redirectTarget=cli`) + ListGrokBotAgents / GetGrokBotUserRuntimeSettings / ListGrokBotAgentStatuses OK (**with 0.78.4 vendor**) |
| 0.79.3 (Linux amd64) | `extract_proto.py` + protoc + protoc-gen-es, 2026-11-07 | **0 breaking**, additive only; identical to 0.79.2 | `fingerprint.py`: same anchors as 0.79.2, only minified names differ | not run with this vendor; offline only |
| **0.79.4 (Linux amd64) — current vendor** | `extract_proto.py` + `npm run generate`, 2026-11-11 ([delta](app-0.79.4-delta.md)) | **0 breaking**; used surface identical to 0.79.3. Full schema: +2 optional fields on `CompleteMcpOAuth{Request,Response}` (not used here) | `fingerprint.py`: same 67 anchors as 0.79.3 after normalisation | not run; offline only |

## Remaining risks (unverified)
- Refresh: needs a user-approved public `GBT_OAUTH_CLIENT_ID`; never tested live.
- All write RPCs untested live: `id` vs `agent_id` for Delete/Update; `source`/`initiator`/`send_source` = 0 on send;
  sidebar base-conflict error code; whether writes need App client headers.
- `viewer_session_id` came back empty for at least one bot; default session for `message send` must come from `session list`.
- Transcript `limit=0` semantics; streaming RPCs not used.
- Second login implementation present in 0.79.2/0.79.3 bundles (not analysed).
- Vendor is 0.79.4; the new 0.79.x fields are encodable/decodable but **not exposed** by SDK/CLI/MCP (no evidence of required semantics).
- App-side wire cross-check (`compare.mjs`/`cross-wire.mjs`) not run: it executes the App bundle. Replaced by `verify_generated.mjs` (generated code vs statically extracted snapshot) + contract tests.
- 0.79.3 and 0.79.4 vendors have had no live call.
- macOS vs Linux bundles for the same version not byte-compared.
- Third-party use of the desktop client identity / protocol is not an official API and may change or be disallowed.

## Create / sidebar drift（0.78.4 vs App 0.79.x，静态）

| 项 | 状态 |
|---|---|
| `CreateGrokBotTemporalAgent` 的 I/O = `CreateGrokBotAgentRequest` | 已使用 |
| App 另传 visibility / teamId / botBuilderRequested | 0.79.3 起 vendor 已有字段 18/19/20，语义未验证，本实现**不发送** |
| `ListGrokBotSubagents`（不是 ListGrokBotAgentSubagents） | 已对齐生成客户端 |
| `sidebar_sections_base` 冲突的线上错误码 | App 映射为 SaveConflict；精确码待真机 |
| delete bot 后 sidebar 是否残留引用 | 未证实 |
