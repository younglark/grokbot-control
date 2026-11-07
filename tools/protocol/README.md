# tools/protocol

Offline helpers for re-deriving the protocol from a new official Grok Bot build. Python 3 stdlib only.
They read files, never execute App bundle code, never use the network, never write into the source directory.

| Script | Does | Limits |
|---|---|---|
| `asar_extract.py list/extract` | Lists / copies named members out of `app.asar` (handles `.unpacked`) | Refuses `..`/absolute members and output inside the ASAR's directory; no integrity check beyond your own hashes |
| `fingerprint.py` | sha256 + stable string anchors (login, poll, refresh, policy error, headers, sidebar base, service name) with nearest minified function name; opaque ≥24-char tokens redacted | Heuristic function naming; anchors list must be extended if the App renames literals |
| `verify_generated.mjs` (Node) | Imports **generated** protobuf-es JS (never the App bundle) and checks every message/enum/service against `snapshot.json` (numbers, names, kinds, types, repeated/optional, map K/V, RPC I/O/kind) + binary/JSON round-trip of every message; exit 1 on mismatch | Cannot prove equality with the App's own encoder; only checks services present in the generated dir |
| `used_surface.py` | Derives RPCs used in `src/` and diffs their request/response messages (transitively) + enums between two `snapshot.json`; exit 1 on breaking | Needs `snapshot.json` from upstream `extract_proto.py`; only `GrokBotService`; does not judge semantic changes of unchanged fields |

Not automated here: downloading the build, `.proto` generation / protoc / codegen (manual steps in `docs/protocol/update-runbook.md` §4),
App-side wire cross-check (upstream scripts execute the bundle; not used), and any live verification. See `docs/protocol/static-restore.md`.

Tests: `npm run test:protocol-tools` (= `python3 -m unittest discover -s tools/protocol`).
