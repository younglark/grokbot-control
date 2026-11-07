# t90u repository integration validation

- Delivery name/package/bin: `local-exec-daemon`, in `local-exec-daemon/`.
- Root repository base: `44f783b` (`grokbot-control@0.1.3`); root package.json, package-lock.json, SDK/CLI/MCP sources and publication workflow are unchanged.
- Reviewed independent source: local `cf2ba0c` plus t89u worktree repairs. New delivery excludes the source .git, node_modules, dist, official binaries/bundles and real credentials.
- Independent subpackage, **not** a root npm workspace. Has its own dependency lock and private UNLICENSED metadata; see NOTICE.md. Root `npm pack --dry-run` retains CLI/MCP and intentionally excludes this subpackage.

## Actual integration checks

| Check | Result |
|---|---|
| Subpackage `npm ci --ignore-scripts` / build | pass |
| Subpackage `npm test` | 46 tests: **44 pass, 0 fail, 2 skip** |
| `smoke:uc` | pass, synthetic loopback only |
| `smoke:electron` | pass, external lab Electron 45.x + xvfb (not official 42.x acceptance) |
| Root `npm ci --ignore-scripts` / build | pass |
| Root `npm test` | **206 pass, 0 fail, 0 skip** |
| Root `npm pack --dry-run --json` | pass, 122 files; existing CLI and MCP entry points present; no publication/tag |
| `git diff --check` | pass |

The two skips are generation/PID supersession and full load-pressure oracle. Known UC inner-id allocation, approval/scope, lifecycle and full drop-in gaps remain in REVIEW-FIXES.md. No real control plane or official install replacement occurred.

### Naming and security checks

All delivery names and environment switches use `local-exec-daemon` / `LOCAL_EXEC_DAEMON_ELECTRON`. Review documents retain `/tmp/compat-t89u-*` **historical log filenames** only; these are not delivery names or commands. Synthetic fixture keys/credentials are intentionally public test materials (NOTICE.md), not real secrets.

`npm audit` reports existing Zod 3.x GHSA-mrhx-c7xc-m3w5 (high), with only a major upgrade suggested. No `audit fix --force` or unreviewed root dependency changes were performed. This warning remains a production-use blocker to assess, not hidden by passing tests.

Logs on the development box: `/tmp/local-exec-daemon-t90u-test.txt`, `/tmp/local-exec-daemon-t90u-uc.txt`, `/tmp/local-exec-daemon-t90u-electron.txt`, `/tmp/grokbot-control-t90u-root-test.txt`, `/tmp/grokbot-control-t90u-pack.json`. Historical t89u red/green numbers are not relabeled as integration runs.
