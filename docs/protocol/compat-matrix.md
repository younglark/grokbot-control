# Compatibility matrix & remaining risks

| App version | Schema source | Used surface vs vendor (0.78.4) | Auth anchors | Live |
|---|---|---|---|---|
| 0.78.4 (macOS) | upstream grokbot-proto `49fd8ce` | identical (vendor = this) | not analysed on this build | — |
| 0.79.2 (Linux amd64) | `extract_proto.py` run 2026-11-07 | **0 breaking**, additive only | analysed (auth-flow.md) | 2026-11-07: login (`redirectTarget=cli`) + ListGrokBotAgents / GetGrokBotUserRuntimeSettings / ListGrokBotAgentStatuses OK |

## Remaining risks (unverified)
- Refresh: needs a user-approved public `GBT_OAUTH_CLIENT_ID`; never tested live.
- All write RPCs untested live: `id` vs `agent_id` for Delete/Update; `source`/`initiator`/`send_source` = 0 on send;
  sidebar base-conflict error code; whether writes need App client headers.
- `viewer_session_id` came back empty for at least one bot; default session for `message send` must come from `session list`.
- Transcript `limit=0` semantics; streaming RPCs not used.
- Second login implementation present in 0.79.2 bundle (not analysed).
- Vendored code is 0.78.4; 0.79.2-only fields are not exposed. Full `restore.sh` wire cross-check not run for 0.79.2.
- macOS vs Linux bundles for the same version not byte-compared.
- Third-party use of the desktop client identity / protocol is not an official API and may change or be disallowed.
