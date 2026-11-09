# ls / ripgrep parity (t154)

## Evidence

- `Tft` (132604) registers `mk` (lsExecutor, 99032) as `await n9({root, path}); await l.execute(...)` where `l = new __(r, n, t)` (LocalLsExecutor, class 129394).
- `LocalLsExecutor.execute` (129400–129483): path `i = er(r.path, workspacePath)` (er 15130: `file://`→path via DLt 15122, leading `~` → homedir via zNe 15119, resolve against root). Then `stat(i)`:
  - ENOENT → `uae(i)` (15087, `<…>/.cursor/projects/<id>/terminals` exactly) ? `"No active terminals."` : `` `Path does not exist: ${i}` ``
  - other error → `la(m)` (107835) message
  - not a directory → `` `Path is not a directory: ${i}` ``
  - otherwise `getDirectoryTree` → `buildTreeFromRipgrepStream` (129495–129542) → `kO` (107439): `rg --files --hidden --no-require-git --no-config --color=never [--threads N] [--iglob !x]... --cursor-ignore …` via `yer` → `Ud(nl(), …)`.
- `nl()` (19007–19013) throws `"Ripgrep path not configured. Call configureRipgrepPath() at startup."` because `Z2` is declared (19015) and never assigned anywhere in the bundle (`configureRipgrepPath` has no definition/call). The throw propagates through the disposal stacks to execute's catch → `LsResult.error{path:i, error}`. Previously confirmed by the isolated official oracle (`scenario-matrix.md` rows 21/62).

## Decision (t154, superseded by t196)

- t154 implemented only the reachable part (stat preamble + unchanged RIPGREP_UNCONFIGURED). That default is unchanged.

## t196: configured-ripgrep path ported (`packages/local-exec-daemon/src/exec/ls-ripgrep.ts`)

Default stays the 0.79.3 App state: `Z2` unset → `nl()` throws the same text → `LsResult.error`. Nothing auto-configures:
no PATH probe and no read of `CURSOR_RIPGREP_PATH` (the bundle only *writes* that variable, in `b0` D:19002–19005; no reader
exists). `configureRipgrepPath(p)` / `getRipgrepPath()` are added only because the `nl()` message names the setter; it stores
`p` as given (like `Z2`, no validation). There is no reset hook.

When configured, `handleLs` follows LocalLsExecutor.execute (D:129400–129483) after the stat preamble:

| Step | Original | Ours |
|---|---|---|
| policy / timeout | `Kc(r.sandboxPolicy)`, `r.timeoutMs ?? Q4r(5000)`, `e.withTimeout(l)` (D:129444–129446, withTimeout D:18402) | `Kc`, `timeoutMs ?? 5000`, `withTimeoutSignal` (timer `unref`'d; original never clears it — no other effect) |
| tree | getDirectoryTree (D:129484) → buildTreeFromRipgrepStream (D:129495–129542; addPathToTree…sortTreeChildren to D:129609), X4r=2500 (D:129392) | `buildTreeFromRipgrepStream` |
| ignore service | `t9` (D:132442–132466, passed by Tft D:132607): every method a constant `false` / `[]` / `{}` | `noopIgnoreService` — exact port, not a stub |
| exclude globs | `[...r.ignore, ...getRepoBlockExcludeGlobs()]` | same (`LsArgs.ignore` + `[]`) |
| `kO` argv | (`_er` D:107392, `kO` D:107439, `Eer` D:107528) `--files --hidden --no-require-git --no-config --color=never` + `--threads N` (`_er`: `CURSOR_RIPWALK_THREADS`, 0 → none, else min(2, availableParallelism)) + `--case-sensitive` (ls passes `caseSensitive:!0`) + `--iglob !g` per exclude + `--cursor-ignore f` per `PO(files)` (D:107439–107540) | same; `PO([])` → no `--cursor-ignore` (non-empty input unreachable with t9 → throws "not ported") |
| spawn | `yer` → `Ud(nl(), argv, {cwd: root}, policy)` (D:107400): `nl()` first, env = `Md(process.env)` (D:18901: drop `ELECTRON_RUN_AS_NODE`, `AGENT_HOST_DAEMON_*`, `SSH_CLIENT`, `SSH2_CLIENT`); **no `b0`**; non-`insecure_none` → `ol` unsupported (D:20798–20812) | same order; sandbox via existing `assertSandboxSupported` |
| stream | `Eer` UTF-8 `StringDecoder` line batches; race each batch with abort; abort → `didTimeout=true`, kill rg on dispose | same |
| rg failure | zero lines, not aborted, exit ∉ {0,1} → ``Ripgrep failed (exit ${x}) with no results${stderr ? `: ${stderr}` : ""}``; spawn error rejects `processExit` | same |
| per line | skip empty; `w = resolve(root, line)`; `ml(w)` (D:107881, `np` D:15136 realpath-of-longest-prefix) null → skip; isCursorIgnored / isRepoBlocked (t9 → false) | same |
| tree build | `addPathToTree` / `ensureDirectoryPath` / `sortTreeChildren` (localeCompare), budget `charactersUsed = root.length` + file-name lengths ≤ 2500; on first overflow mark ancestor chain `childrenWereProcessed=false`, then per-file `fullSubtreeExtensionCounts[extname]` / `numFiles` on cached chain with `Ts` int32 clamp | line-for-line port |
| result | `didTimeout` → `LsResult.timeout{directoryTreeRoot}` else `success`; any throw → `error{path, message \|\| "Unknown error occurred"}` | same |

`b0` is also applied to every shell spawn env (`Ko` D:21095; snapshot + command) — identity when unconfigured, so the
unconfigured path is unchanged; when configured with an absolute path it prepends the rg dir to PATH (keeping the existing
PATH key name, `IGe`/`mWt`) and sets `CURSOR_RIPGREP_PATH`.

Wire plumbing: `dispatchExec` now passes `lsArgs.ignore`, `lsArgs.timeoutMs`, `lsArgs.sandboxPolicy` (LsArgs fields 2/5/4).

### Not ported (unchanged gaps, all shared with the shell spawn path)
- `Ud` `enableSharedBuildCache` env merge (`CE` D:19166) and the `spawnWorkload` wrapper (`t$t` D:16797: cgroup / long-cwd hop).
- `p6` ripwalk telemetry (no sink installed → no-op).
- Outer exec cancellation: original `withTimeout` derives from the exec ctx, so a cancel would surface as `timeout`; our ls has no per-request cancel (as before).
- `fer`/`ler` cursor-ignore expansion (unreachable: t9 returns `[]`).

### Tests
`packages/local-exec-daemon/test/t196-ls-ripgrep-tree.test.cjs` (8): unconfigured text (also with a sandbox policy — `nl()` wins),
`b0`, exact argv/cwd/env via a fake rg, rg failure text + spawn ENOENT, sandbox `ol` text, timeout partial tree, real `/usr/bin/rg`
sorted tree + `.gitignore` + `lsArgs.ignore` via `dispatchExec`, 2500-char budget overflow. The box's `/usr/bin/rg` 14.1.1 is a test
tool only; the App ships no `rg`.
