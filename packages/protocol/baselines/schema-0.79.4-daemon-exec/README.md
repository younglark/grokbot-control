# Restored schema — Grok Bot 0.79.4 + daemon Exec closure (Linux amd64, commit 7b5e3d8)

Derived from immutable `schema-0.79.4` (proto.cjs extract) by the same **additive** Exec* merge that produced
`schema-0.79.3-daemon-exec` from `schema-0.79.3` (parent → daemon-exec hunks re-applied verbatim; no renumbering,
no removals).

Why the 0.79.3 closure carries over unchanged: the 0.79.4 `dist/local-exec-daemon/main.cjs` has the same size as 0.79.3
and differs in 76 bytes only — the Sentry debug id (3 places) and the bundled fallback version string `"0.79.3"` →
`"0.79.4"`. All 129 added types in `exec-closure-meta.json` have byte-identical compact descriptor strings in both
bundles, and all 13 `exec_compacts` entries occur verbatim in the 0.79.4 bundle (see `SOURCE.json`).

- Does **not** overwrite `schema-0.79.4/` or either 0.79.3 directory.
- Top-level `FileDiff` / `GitDiff` stay in `aiserver.v1_2.proto` as in 0.79.3 (import-cycle break; nested
  `EditFileResult.FileDiff` unchanged in `aiserver.v1.proto`).
- Result: identical to `schema-0.79.3-daemon-exec` except the two additive `CompleteMcpOAuth*` fields in `aiserver.v1.proto`.
- Provenance: `SOURCE.json` + `NOTICE`; hashes in `../schema-0.79.4-daemon-exec.sha256.json`.

Not an official schema; not a drop-in claim for the official daemon.
