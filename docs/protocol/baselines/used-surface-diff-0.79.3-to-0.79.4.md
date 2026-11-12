# Used-surface diff (aiserver.v1.GrokBotService) — 0.79.3 → 0.79.4

Command (run 2026-11-11, text only):

```bash
# old side regenerated from the CURRENT src against the frozen 0.79.3 snapshot, so both sides cover the same 20 RPCs
# (the archived used-surface-0.79.3.json was taken when src used 15 RPCs)
python3 tools/protocol/used_surface.py --src packages/grokbot-control/src \
  --new <(gunzip -c packages/protocol/baselines/schema-0.79.3/snapshot.json.gz) --write-subset /tmp/used-0.79.3-currentsrc.json
python3 tools/protocol/used_surface.py --src packages/grokbot-control/src \
  --old /tmp/used-0.79.3-currentsrc.json --new <0.79.4 snapshot.json> --write-subset docs/protocol/baselines/used-surface-0.79.4.json
```

RPCs used by `packages/grokbot-control/src`: 20 (subset: 20 RPCs, 70 messages, 24 enums).

## Messages

(none changed)

## Enums

(none changed)

**Summary:** 0 breaking change(s) in the used surface; the 0.79.3 and 0.79.4 subsets are identical (sorted-JSON equal).
The only schema change in 0.79.4 (`CompleteMcpOAuthRequest.oauth_error`, `CompleteMcpOAuthResponse.continue_authorization_url`)
is outside the control plane's used surface — see `full-schema-diff-0.79.3-to-0.79.4.txt`.
