# Restored schema — Grok Bot 0.79.3 + daemon Exec closure (Linux amd64, commit 4739412)

Derived from immutable `schema-0.79.3` (proto.cjs extract) by **additive** merge of inner
`ExecServerMessage` / `ExecClientMessage` and necessary closure types restored from the App
`daemon` bundle compact `$()` / `ee()` descriptors (pretty-printed analysis copy; text parse only).

- Does **not** overwrite `schema-0.79.3/`.
- Does **not** renumber or remove existing proto.cjs field numbers.
- Top-level `FileDiff` / `GitDiff` moved package-file from `aiserver.v1.proto` → `aiserver.v1_2.proto`
  so `agent.v1` can reference `GetDiffRequest`/`GetDiffResponse` without an import cycle
  (same package `aiserver.v1`; nested `EditFileResult.FileDiff` unchanged in `aiserver.v1.proto`).
- **P1 fix:** top-level `FileDiff` shape matches parent freeze / daemon `FileDiff|` (`from`/`to`/`chunks`→`FileDiff.Chunk`/`added`/`removed`/…), not the nested `EditFileResult.FileDiff` (`ChunkDiff`/`editor`/`hit_timeout`) layout that e0bf830 briefly used.
- Provenance: `SOURCE.json` + `NOTICE`; hashes in `../schema-0.79.3-daemon-exec.sha256.json`.

Not an official schema; not a drop-in claim for the official daemon.
