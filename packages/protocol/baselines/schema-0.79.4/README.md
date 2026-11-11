# Restored schema — Grok Bot 0.79.4 (Linux amd64, commit 7b5e3d8)

`.proto` files: output of upstream `extract_proto.py` (grokbot-proto `49fd8ce`) on the App's `proto.cjs` (static text parse),
with trailing blank lines at EOF trimmed for `git diff --check`. `snapshot.json.gz`: unmodified extractor snapshot (gzip -9n).
Hashes and provenance: [baseline manifest](../../../../docs/protocol/baseline-manifest.md). Not an official schema.

Difference from `schema-0.79.3`: only `aiserver.v1.proto` changes — two additive optional fields,
`CompleteMcpOAuthRequest.oauth_error = 3` and `CompleteMcpOAuthResponse.continue_authorization_url = 6`
(full diff: `docs/protocol/baselines/full-schema-diff-0.79.3-to-0.79.4.txt`). Message/enum/service/RPC counts are unchanged
(2923 / 387 / 7 / 662).

This directory is the **canonical immutable schema input** for 0.79.4. `schema-0.79.3/` stays frozen beside it.
