# tools/protocol

Offline helpers for re-deriving the protocol from a new official Grok Bot build. Python 3 stdlib only.
They read files, never execute bundle code, never use the network, never write into the source directory.

| Script | Does | Limits |
|---|---|---|
| `asar_extract.py list/extract` | Lists / copies named members out of `app.asar` (handles `.unpacked`) | Refuses `..`/absolute members and output inside the ASAR's directory; no integrity check beyond your own hashes |
| `fingerprint.py` | sha256 + stable string anchors (login, poll, refresh, policy error, headers, sidebar base, service name) with nearest minified function name; opaque ≥24-char tokens redacted | Heuristic function naming; anchors list must be extended if the App renames literals |
| `used_surface.py` | Derives RPCs used in `src/` and diffs their request/response messages (transitively) + enums between two `snapshot.json`; exit 1 on breaking | Needs `snapshot.json` from upstream `extract_proto.py`; only `GrokBotService`; does not judge semantic changes of unchanged fields |

Not automated here: downloading the build, `.proto` generation / protoc / codegen / wire cross-check (use upstream
`grokbot-proto/scripts/restore.sh`), and any live verification. See `docs/protocol/static-restore.md`.

Tests: `npm run test:protocol-tools` (= `python3 -m unittest discover -s tools/protocol`).
