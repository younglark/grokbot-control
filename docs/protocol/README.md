# Protocol archive & restore method

Everything needed to (1) know which Grok Bot protocol this repo is built on, (2) re-derive it
from a new official App build, and (3) update SDK + CLI + MCP safely.

| Doc | Purpose |
|---|---|
| [baseline-manifest.md](baseline-manifest.md) | Exact upstream proto commit, App versions, file hashes, vendored files |
| [surface-map.md](surface-map.md) | RPCs / messages this repo uses → SDK / CLI / MCP, with evidence level |
| [auth-flow.md](auth-flow.md) | Independent Cursor login / poll / refresh, stable code anchors |
| [static-restore.md](static-restore.md) | How the protocol and auth were recovered statically (download → extract → schema → anchors) |
| [update-runbook.md](update-runbook.md) | Step-by-step when the official App ships a new version |
| [compat-matrix.md](compat-matrix.md) | Version compatibility + remaining risks |
| [canonical schema](../../packages/protocol/baselines/schema-0.79.3/) | **唯一冻结协议源** — unchanged App0.79.3 archive; shared generator feeds both consumer artifacts |
| [baselines/](baselines) | Historical versioned used-surface/diff evidence; frozen schema now lives in packages/protocol/baselines |
| [../../tools/protocol/](../../tools/protocol/README.md) | Offline scripts: ASAR reader, anchor fingerprint, used-surface diff, generated-code verifier |

## Evidence levels (used throughout)

| Tag | Meaning |
|---|---|
| **S** | Static reverse engineering of an official App build (not official API docs) |
| **O** | Verified offline in this repo (fake transport / local fake backend tests) |
| **L** | Confirmed against the live service (state the date and what exactly) |

Mock/offline passing (O) is never evidence of live behaviour (L).

## What is NOT here (by design)

- No App installer, ASAR, full bundle, or prettified bundle copies (download them from the official
  source; see static-restore.md). Only hashes, anchors and small schema-derived data are archived.
- No credentials, tokens, client_id values, account data, bot IDs or login URLs.
- No `.proto` comments: the App ships compact descriptors without source comments; restored `.proto`
  files (upstream repo) cannot recover original comments or proto file layout.
