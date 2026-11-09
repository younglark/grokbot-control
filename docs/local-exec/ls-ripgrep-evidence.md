# ls / ripgrep parity (t154)

## Evidence

- `Tft` (132604) registers `mk` (lsExecutor, 99032) as `await n9({root, path}); await l.execute(...)` where `l = new __(r, n, t)` (LocalLsExecutor, class 129394).
- `LocalLsExecutor.execute` (129400–129483): path `i = er(r.path, workspacePath)` (er 15130: `file://`→path via DLt 15122, leading `~` → homedir via zNe 15119, resolve against root). Then `stat(i)`:
  - ENOENT → `uae(i)` (15087, `<…>/.cursor/projects/<id>/terminals` exactly) ? `"No active terminals."` : `` `Path does not exist: ${i}` ``
  - other error → `la(m)` (107835) message
  - not a directory → `` `Path is not a directory: ${i}` ``
  - otherwise `getDirectoryTree` → `buildTreeFromRipgrepStream` (129495–129542) → `kO` (107439): `rg --files --hidden --no-require-git --no-config --color=never [--threads N] [--iglob !x]... --cursor-ignore …` via `yer` → `Ud(nl(), …)`.
- `nl()` (19007–19013) throws `"Ripgrep path not configured. Call configureRipgrepPath() at startup."` because `Z2` is declared (19015) and never assigned anywhere in the bundle (`configureRipgrepPath` has no definition/call). The throw propagates through the disposal stacks to execute's catch → `LsResult.error{path:i, error}`. Previously confirmed by the isolated official oracle (`scenario-matrix.md` rows 21/62).

## Decision

- Implemented the reachable part: the stat preamble (existing dir → unchanged RIPGREP_UNCONFIGURED; missing → "Path does not exist"; terminals dir → "No active terminals."; file → "Path is not a directory"; other errno → message), and `er`-style resolution for the reported path.
- **Not implemented**: the ripgrep tree build (2500-char budget X4r, 5000 ms default timeout Q4r, extension counts, localeCompare sort, cursor-ignore/repo-block filters). It is unreachable in 0.79.3; implementing it would add behavior the original never exhibits. If a future build assigns `Z2`, the plan is: port `kO` argv exactly, `Eer` line splitting, `addPathToTree`/`ensureDirectoryPath`/`sortTreeChildren` budget logic, timeout → `LsResult.timeout`.
- Existing path guard (`assertRealpathUnderRoot`, an n9 equivalent) stays before the preamble; how the original exec manager surfaces an `n9` throw for ls remains unverified (unchanged).
