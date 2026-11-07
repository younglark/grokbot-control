# Integration validation history (t90u / t93u)

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

The two skips remain generation/PID supersession and full load-pressure oracle (t98u did not convert them). **t98u+:** Exec* freeze + UC inner-id reallocation + generated Exec JSON codec landed; approval/scope, lifecycle and full drop-in gaps remain in REVIEW-FIXES.md. No real control plane or official install replacement occurred. Not a drop-in claim.

### Naming and security checks

All delivery names and environment switches use `local-exec-daemon` / `LOCAL_EXEC_DAEMON_ELECTRON`. Review documents retain `/tmp/compat-t89u-*` **historical log filenames** only; these are not delivery names or commands. Synthetic fixture keys/credentials are intentionally public test materials (NOTICE.md), not real secrets.

`npm audit` reports existing Zod 3.x GHSA-mrhx-c7xc-m3w5 (high), with only a major upgrade suggested. No `audit fix --force` or unreviewed root dependency changes were performed. This warning remains a production-use blocker to assess, not hidden by passing tests.

Logs on the development box: `/tmp/local-exec-daemon-t90u-test.txt`, `/tmp/local-exec-daemon-t90u-uc.txt`, `/tmp/local-exec-daemon-t90u-electron.txt`, `/tmp/grokbot-control-t90u-root-test.txt`, `/tmp/grokbot-control-t90u-pack.json`. Historical t89u red/green numbers are not relabeled as integration runs.


## t93u protocol migration (worktree; no commit/push)

Base HEAD remains `2c4a4bf14411f19662610b34af8fe79699ba0ec3`. Only `local-exec-daemon/` changes; source research directory untouched, root package/lock/CLI/MCP sources unchanged.

| Current check | Actual result |
|---|---|
| `npm ci --ignore-scripts` in subpackage | pass, exact runtime/generator pins in independent lock |
| `npm run generate` twice / `generate:check` | seven files byte-identical; nonmutating check pass |
| Subpackage build / test | **68 tests: 68 pass, 0 fail, 0 skip** (Exec JSON codec era; historical rows below unchanged) |
| UC / Electron smokes | pass; lab Electron45.x, not official42.x |
| Original isolated malformed Poll oracle | pass, exit0/no hard timeout; zero frames/acks from corrupt batch, valid read after peer repair |
| Root build / test | **206 pass, 0 fail, 0 skip** |
| Root pack dry-run | 122 files, same CLI/MCP entries, zero daemon files |
| `git diff --check` | pass |

Runtime exact versions: zod 3.25.76 (unchanged resolution); @bufbuild/protobuf 1.10.1; @connectrpc/connect and connect-node 1.6.1. Generators: @bufbuild/buf 1.50.0; protoc-gen-es 1.10.1; protoc-gen-connect-es 1.6.1. Full verbatim frozen schema provenance/hashes in src/generated/SOURCE.json and NOTICE.md. No handwritten production protobuf/envelope/method paths remain; only business JSON and box SSE remain self-implemented. Test-only wire/oracle implementations stay independent.

First migration run honestly failed **42 pass / 2 fail / 2 skip**: legacy explicit-default Hello byte assertion and mixed structural-wire-corruption assertion. README/REVIEW-FIXES explain both corrections; independently rerun official corrupt-Poll oracle supports the changed transport boundary. Interim expanded run was 49 pass / 0 fail / 2 skip; final enum/auth/cancel additions give 51 pass / 0 fail / 2 skip. Prior t90u counts above remain historical.

Dependency audit now reports **3 high / 1 moderate across 4 packages**, not just the earlier Zod advisory; Connect1.x introduces the undici/busboy chain. Major upgrade/API migration is not silently included. Existing ID, approval/scope, full pressure and preemption gaps remain; no production/drop-in claim. No Page update or external writes in t93u.


## t95u workspace reorganization

Current path is `packages/local-exec-daemon/`; install from repository root with the single root lock. t93u is a separate local commit a9231c2d48fc6cfa2ba76724e151a8e1018c70e1, before layout changes. The reorganization changes no business implementation: canonical protocol tooling emits the same message/service sources and identical shared input hashes; ESM control and TS→CJS daemon retain their module systems. Historical standalone-lock/root-publish commands above are superseded by [current organization/validation](../../docs/organization.md).

Final workspace execution: control206 pass; daemon51 pass/0fail/2skip; organization5 pass; protocol-tools5 pass; UC and lab Electron45 smoke pass; actual 81-file control tarball independently installed with working CLI/mock MCP/SDK. Public tarball has no daemon, full docs archive or unpublished protocol runtime dependency. No headless registration implementation or deployment was added. Audit remains3 high/1moderate. The two commits remain local for independent review; no push/tag/npm publication or Page update.
