# Compatibility matrix & remaining risks

| App version | Schema source | Used surface vs 0.78.4 | Auth anchors | Live |
|---|---|---|---|---|
| 0.78.4 (macOS) | upstream grokbot-proto `49fd8ce` | identical (previous vendor) | not analysed on this build | — |
| 0.79.2 (Linux amd64) | `extract_proto.py` run 2026-11-07 | **0 breaking**, additive only | analysed (auth-flow.md) | 2026-11-07: login (`redirectTarget=cli`) + ListGrokBotAgents / GetGrokBotUserRuntimeSettings / ListGrokBotAgentStatuses OK (**with 0.78.4 vendor**) |
| **0.79.3 (Linux amd64) — current vendor** | `extract_proto.py` + protoc + protoc-gen-es, 2026-11-07 | **0 breaking**, additive only; identical to 0.79.2 | `fingerprint.py`: same anchors as 0.79.2, only minified names differ | not run with this vendor; offline only |

## Remaining risks (unverified)
- Refresh: needs a user-approved public `GBT_OAUTH_CLIENT_ID`; never tested live.
- All write RPCs untested live: `id` vs `agent_id` for Delete/Update; `source`/`initiator`/`send_source` = 0 on send;
  sidebar base-conflict error code; whether writes need App client headers.
- `viewer_session_id` came back empty for at least one bot; default session for `message send` must come from `session list`.
- Transcript `limit=0` semantics; streaming RPCs not used.
- Second login implementation present in 0.79.2/0.79.3 bundles (not analysed).
- Vendor is 0.79.3; the new 0.79.x fields are encodable/decodable but **not exposed** by SDK/CLI/MCP (no evidence of required semantics).
- App-side wire cross-check (`compare.mjs`/`cross-wire.mjs`) not run: it executes the App bundle. Replaced by `verify_generated.mjs` (generated code vs statically extracted snapshot) + contract tests.
- 0.79.3 vendor has had no live call.
- macOS vs Linux bundles for the same version not byte-compared.
- Third-party use of the desktop client identity / protocol is not an official API and may change or be disallowed.
