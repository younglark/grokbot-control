# discover-ai-tool

Static 0.79.3 evidence (`daemon.formatted.cjs`, D:). Implemented against synthetic fixture homes only; the real `~/.claude` / `~/.codex` were never read by tests.

## Admission

- Sources `QP = ["claude_code","codex"]` (97060), labels `Cjt` (97064). Wire proto `GrokBotUserComputerDiscoverAiTool{source, approval_id?, authorized_by_standing, authorized_by_approval}` (161255; generated class used).
- UC `v9r` (178897–178906): only valid sources map (with `c5` authorization); invalid → `undefined` → poll loop (178512–178516) enqueues `w9r` (178789–178790) `file-error z2` if `frame.requestId` non-empty; not admitted.
- Box schema `rHt` (97436–97441) `source: enum(QP)` → invalid frame dropped; `Nwr` (137565–137566) forces authorization none.
- Authorization `k6r` → `pJe` (97084): `{action:'read-ai-tool-setup', target:'Claude Code'|'Codex'}`; class global (81067/81080). Refusal → `file-error`.
- Execute (136010–136024): `JSON.stringify(await VJe(source,{configDirs}))` UTF-8 as `file` bytes; errors → `file-error Wn(e)`.
- UC reply `Y_` (178966, 179080–179097): bytes split into 1 MiB chunks, seq 0.., `last` on final; Box reply `Dwr` → `bytesBase64`.
- `configDirs` = `{claudeConfigDir: CLAUDE_CONFIG_DIR, codexHome: CODEX_HOME}` captured at daemon start (187322–187325).

## VJe (97585) semantics ported (src/uc/ai-tool-discovery.ts)

- Root: claude default `~/.claude` + `~/.claude.json`; non-blank `CLAUDE_CONFIG_DIR` → root=dir, global=`dir/.claude.json` (JJe 97603). Codex `CODEX_HOME` or `~/.codex`.
- Not found → `Fpe` `{source, found:false, sessionCount:0, items:[]}` (claude: neither root dir nor global file; codex: dir missing).
- Claude (qJe 97606): global `mcpServers` + every project's `mcpServers` (zod-lenient `uHt`), `plugins/installed_plugins.json` keys, `skills/*/SKILL.md`, `commands/**.md` maxDepth 2 (namespaced `a:b:c`), session `.jsonl` count under `projects` depth ≤2, `history.jsonl` `{display,timestamp}`.
- Codex (_Ht 97627): line-oriented `config.toml` `[mcp_servers.X]` scan (AHt 97680), skills, `prompts/*.md` maxDepth 0, `sessions` depth ≤4, history `{text, ts}` with seconds→ms (`<1e12`).
- KJe (97644): dedupe `kind\ntitle`, config items ≤24, history sorted by occurredAtMs desc to fill 40 total, `sessionCount = max(fileCount, historyItems)`, `lastActiveAtMs = max(newest jsonl mtime, newest history)`.
- Sanitizer `bp` (97102): whitespace collapse, 9 secret regexes → `[redacted]`, URLs `[link]`, emails `[email]`, Windows/Unix paths `[path]`, truncate 160 with `…`. History drops slash commands and `[Pasted text #n]`/`[Image #n]` markers.
- FS helpers: ENOENT/ENOTDIR/ELOOP (cause chain) = absent; any other error propagates → `file-error` (verified with EISDIR). readdir sorted by UTF-16 name, first 200; session scan stops at 500 files; history tail 256 KiB with first partial line dropped, single `read` call.
- Zod: the original bundles zod v4 (`Zve` 1779 reports 4.x); port uses `zod/v4` from the pinned `zod@3.25.76` — same API family, minor-version behavior differences not verified.

## Not implemented

- Host-side result validation `ghn` (97072) is not applied on the daemon (original daemon does not validate its own output either).
