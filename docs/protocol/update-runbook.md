# Runbook: official App released a new version

1. **Keep the old baseline.** Do not overwrite `docs/protocol/baselines/*` or `vendor/proto-gen` until the end.
2. **Download + verify** the official build (static-restore.md §1). Record version, commitSha, size, sha256 in
   baseline-manifest.md. Stop if the source is not official.
3. **Extract** with `tools/protocol/asar_extract.py` into a temp dir outside the repo (§2).
4. **Schema:** run upstream `extract_proto.py` (must be 0 unresolved / 0 relocated) and `diff_snapshot.py` against
   the previous snapshot. Prefer the full `restore.sh` (protoc + descriptor compare + wire cross-check) when tooling allows.
5. **Used-surface diff:** `tools/protocol/used_surface.py --old baselines/used-surface-<old>.json --new <new>/snapshot.json`.
   - BREAKING (removed/renumbered/retyped field, RPC removed or I/O changed) → fix `src/ops/*` mapping before anything else.
   - additive → decide per field whether SDK/CLI/MCP should expose it; old clients stay wire-compatible.
6. **Auth anchors:** `tools/protocol/fingerprint.py` on main-app/main-core. Re-read login URL params, poll status
   handling, refresh endpoint/body, policy error, any new login implementation. Update auth-flow.md + `src/auth/*`
   only from evidence; keep client_id configurable, never forge device/policy headers.
7. **Regenerate vendor:** update the upstream proto repo (or a local run of `restore.sh`), copy the 6 used files from
   `codegen/src/js/` into `vendor/proto-gen/`, update `vendor/proto-gen/NOTICE.md` + manifest hashes, keep generator and
   runtime versions equal to the App's `@bufbuild/protobuf`.
8. **Write new baseline:** `used_surface.py --src src --new <new>/snapshot.json --write-subset baselines/used-surface-<new>.json`
   and commit the diff report next to it.
9. **Regression:** `npm run build && npm run typecheck && npm test && npm run test:protocol-tools`.
   Offline/mock passing ≠ live.
10. **Live checks, in order, each with explicit user approval:** independent browser auth (`auth login-begin` /
    `auth complete`) → read-only (`auth whoami`, `bot list`, `sidebar list`, `bot status`) → only then a single
    approved write test on a disposable resource. Never blind-retry a write with an unknown outcome; reconcile first.
11. Update compat-matrix.md and the evidence levels in surface-map.md.
