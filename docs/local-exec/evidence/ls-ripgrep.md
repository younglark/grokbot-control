# ls / ripgrep parity

## Evidence

- `Tft` (132604) registers `mk` (lsExecutor, 99032) as `await n9({root, path}); await l.execute(...)` where `l = new __(r, n, t)` (LocalLsExecutor, class 129394).
- `LocalLsExecutor.execute` (129400–129483): path `i = er(r.path, workspacePath)` (er 15130: `file://`→path via DLt 15122, leading `~` → homedir via zNe 15119, resolve against root). Then `stat(i)`:
  - ENOENT → `uae(i)` (15087, `<…>/.cursor/projects/<id>/terminals` exactly) ? `"No active terminals."` : `` `Path does not exist: ${i}` ``
  - other error → `la(m)` (107835) message
  - not a directory → `` `Path is not a directory: ${i}` ``
  - otherwise `getDirectoryTree` → `buildTreeFromRipgrepStream` (129495–129542) → `kO` (107439): `rg --files --hidden --no-require-git --no-config --color=never [--threads N] [--iglob !x]... --cursor-ignore …` via `yer` → `Ud(nl(), …)`.
- `nl()` (19007–19013) throws `"Ripgrep path not configured. Call configureRipgrepPath() at startup."` because `Z2` is declared (19015) and never assigned anywhere in the bundle (`configureRipgrepPath` has no definition/call). The throw propagates through the disposal stacks to execute's catch → `LsResult.error{path:i, error}`. Previously confirmed by the isolated official oracle (`scenario-matrix.md` rows 21/62).

## Earlier decision (superseded by the next section)

- t154 implemented only the reachable part (stat preamble + unchanged RIPGREP_UNCONFIGURED). That default is unchanged.

## Configured-ripgrep path ported (`packages/local-exec-daemon/src/exec/ls-ripgrep.ts`)

Default stays the 0.79.3 App state: `Z2` unset → `nl()` throws the same text → `LsResult.error`. Nothing auto-configures:
no PATH probe and no read of `CURSOR_RIPGREP_PATH` (the bundle only *writes* that variable, in `b0` D:19002–19005; no reader
exists). `configureRipgrepPath(p)` / `getRipgrepPath()` are added only because the `nl()` message names the setter; it stores
`p` as given (like `Z2`, no validation). There is no reset hook.

When configured, `handleLs` follows LocalLsExecutor.execute (D:129400–129483) after the stat preamble:

| Step | Original | Ours |
|---|---|---|
| policy / timeout | `Kc(r.sandboxPolicy)`, `r.timeoutMs ?? Q4r(5000)`, `e.withTimeout(l)` (D:129444–129446, withTimeout D:18402) | `Kc`, `timeoutMs ?? 5000`, `withTimeoutSignal(l, execCtx)` — timer cleared only on abort, not `unref`'d (t198, exactly as the original) |
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

### Remaining items (each checked for reachability first)

| Item | Reachable in 0.79.3? | Evidence | Result |
|---|---|---|---|
| `CE` shared build cache env | **Yes** via the wire: `SandboxPolicy.enable_shared_build_cache` (field 9) → `Kc` keeps it for insecure_none (D:106557–106566); shell: `E_` `b={perRepo:Kc(...)}` (D:130852, 131015) → `vi`→`Pme`→`fKt` keeps it (`r3`, D:19951, 20180–20205); background `$3` same (D:110741–110750); ls passes `Kc` straight to `kO`→`Ud` | `Ud` D:20800–20803: `r.env=Md(r.env)`; if set, `env={...Md(process.env), ...CE(), ...r.env}`; `CE` D:19166–19193 (dir `tmpdir/cursor-sandbox-cache/<IWt 16-byte hex, once per process>`, nothing created) | **Ported** (`spawn-workload.ts` `Ud`/`CE`), used by ls, shellStream, backgroundShell |
| `Md` env strip on every exec spawn | **Yes** (always) | `Ud` D:20800, `Md` D:18901 | **Ported** for shell spawns too (before only ls); previously the shell child kept `SSH_CLIENT`/`SSH2_CLIENT`/`AGENT_HOST_DAEMON_*` |
| `spawnWorkload` cgroup wrapper | **Yes, env-gated**: `Yn=t$t(ZUt(platform, process.env.CURSOR_WORKLOAD_CGROUP))` at module init (D:16842–16845); the App's main-core.cjs 0.79.3 never sets it (static grep of `/tmp/exec-t166-evidence/app-0793/main-core.cjs`: 0 hits), so only an inherited env arms it | `ZUt` D:16758 (linux, `/^\/sys\/fs\/cgroup\/[A-Za-z0-9_/.-]+$/`, no `..`, `cgroup.procs` W_OK via `YUt` D:16749); `Oae` D:16745; `t$t` D:16797–16829 | **Ported** |
| FUSE cwd hop | **Yes, env-gated**: `FR()` = `CURSOR_SPAWN_CWD_HOP==="1"` (D:15347, `nDe` D:15585), also never set by main-core; cwd must be on a `fuse`/`fuseblk`/`fuse.*` mount per `/proc/self/mountinfo` (`u2` D:15311, `HLt`) | `_ae` D:15327–15346, `UR` D:15630, `eBt` D:15440–15500 (exit 79 + marker `cursor-fuse-cwd:cd` → `error` ENOENT `working directory is not accessible: …`), `xae` D:15541 | **Ported** (ChildProcess branch only; the pty `tBt` / promise branches of `oDe` D:15544 have no caller in our spawn paths — VKt always passes `child_process.spawn`) |
| `BNe` oom_score_adj | **Yes** on Linux for every `Yn` spawn (`t$t(t, e=BNe)`, `e$t` D:16778) | `BNe` D:15066: `writeFileSync(/proc/<pid>/oom_score_adj,"0")`, errors ignored | **Ported** |
| `Xi(ctx, "exec_daemon.spawn.cwd_hop")` span events (D:22945, `yae` D:15632) | Reachable but tracing only | no wire/log effect | Not ported (recorded) |
| `p6` ripwalk telemetry | **No**: `z0e` is declared (D:107305) and only read (`f6` D:107306, `p6` D:107309); no assignment anywhere in the bundle | grep `z0e` → 4 hits, none an assignment | Not ported |
| `fer`/`ler` cursor-ignore expansion | **No**: `__` is constructed once, `new __(r, n, t)` with `n = new t9()` (D:132607–132612); `t9.listCursorIgnoreFilesByRoot` always `Promise.resolve([])` (D:132452); so `PO([])` (D:107298) never calls `fer` (D:107288) / `ler` (D:107271) | — | Not ported (`PO` throws "not ported" for non-empty input, which cannot occur) |
| ls outer cancel | **Yes**: `handleExecRequest` runs `execManager.handle(u, o)` with `[u,l]=baseCtx.withCancel()` (D:136333–136350); `handleCancel` (D:136353–136364) calls `r.cancel()`; LocalLsExecutor's `e.withTimeout(l)` child (`_I` D:18324) inherits that abort → `kO` sets `didTimeout` → `LsResult.timeout` with the partial tree | — | **Ported**: `cancelRequest(requestId)` aborts the ls ctx (UC/Box cancel paths already call it) |
| timer `unref` | — | original `withTimeout` never clears on success and never unrefs (D:18402–18417) | **Reverted**; the pending ≤5 s timer only delays a test process's natural exit, it does not break it (full suite green) |

Still not ported (shared with shell): `Ko`'s process-tree kill on the signal argument (D:21096+) — our shell/background handlers keep their own abort/kill paths.

### Tests
`packages/local-exec-daemon/test/t196-ls-ripgrep-tree.test.cjs` (8) and `test/t198-spawn-workload-ls-cancel.test.cjs` (7: ZUt/Oae, armed cgroup with a fake `cgroup.procs`, `_ae` with injected mountinfo, a real FUSE hop + cd-failure on the box's FUSE mount (skips without one), `Ud` Md/CE, shellStream CE via `dispatchExec`, ls cancel → timeout): unconfigured text (also with a sandbox policy — `nl()` wins),
`b0`, exact argv/cwd/env via a fake rg, rg failure text + spawn ENOENT, sandbox `ol` text, timeout partial tree, real `/usr/bin/rg`
sorted tree + `.gitignore` + `lsArgs.ignore` via `dispatchExec`, 2500-char budget overflow. The box's `/usr/bin/rg` 14.1.1 is a test
tool only; the App ships no `rg`.
