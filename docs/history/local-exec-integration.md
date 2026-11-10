# local-exec-daemon 集成验证记录（历史）

> 存档：t90u/t93u/t95u 阶段把 daemon 并入本仓库、迁移到生成协议时的验证记录，以及整理前的旧版包 README。其中的状态、测试数字和差异列表都已过时；当前状态以 [local-exec/overview.md](../local-exec/overview.md) 和 [remaining-diffs.md](../local-exec/remaining-diffs.md) 为准。

原标题：Integration validation history (t90u / t93u)

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

Current path is `packages/local-exec-daemon/`; install from repository root with the single root lock. t93u is a separate local commit a9231c2d48fc6cfa2ba76724e151a8e1018c70e1, before layout changes. The reorganization changes no business implementation: canonical protocol tooling emits the same message/service sources and identical shared input hashes; ESM control and TS→CJS daemon retain their module systems. Historical standalone-lock/root-publish commands above are superseded by [current organization/validation](workspace-reorg.md).

Final workspace execution: control206 pass; daemon51 pass/0fail/2skip; organization5 pass; protocol-tools5 pass; UC and lab Electron45 smoke pass; actual 81-file control tarball independently installed with working CLI/mock MCP/SDK. Public tarball has no daemon, full docs archive or unpublished protocol runtime dependency. No headless registration implementation or deployment was added. Audit remains3 high/1moderate. The two commits remain local for independent review; no push/tag/npm publication or Page update.


## 附：旧版包 README（t89u–t95u 阶段，2026-11 整理时移出）

> 以下为整理前 `packages/local-exec-daemon/README.md` 原文，状态表与差异列表已过时，仅作历史参考。

### local-exec-daemon

Independent **compatible** local-exec daemon targeting Grok Bot App **0.79.3** behavior.

This is **not** an official binary, **not** an in-place App replacement yet, and **must not** be pointed at real account control planes during development.

Plan page: [local-exec-daemon 0.79.3：兼容替代实现长期计划](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/8c2b08c2-4ad3-4553-9b2e-967b57185dba)

### Status (t93u generated protocol migration; partial compatibility)

| Area | Status |
|------|--------|
| Node IPC handoff (`sand-local-exec-file-key`) | Done |
| Electron `utilityProcess` + `parentPort` handoff | Done (smoke via lab Electron 45.x; official 42.x not claimed) |
| Discovery / supervisor freshness | Done |
| settings `version:1` + Never/Ask/Always | Done |
| `SAND_LOCAL_EXEC_GENERATION` → discovery.generation | Done |
| Lease file `local-exec-update-lease.json` load + ownership helper | Done (full preempt race skipped) |
| box SSE `/local-exec/requests` + POST responses | Done |
| read / shellStream / cancel / unsupported | Done |
| Path / symlink guards | Done |
| Sealed credential AES-GCM `sandSealedFile:1` | Done (synthetic keys only) |
| UserComputer Connect Watch/Poll/Submit/Withdraw | Done against lab-style fake peer |
| backgroundShell / ls ripgrep parity | Done: default = official unconfigured-rg error; after `configureRipgrepPath()` the original ripgrep tree path (t196) |
| GUI / Messages / helpers | Out of scope |
| SQLite | Not introduced |

### Commands

```bash
cd /workspace/grokbot-control
npm ci
cd packages/local-exec-daemon
npm run generate
npm run generate:check
npm run build
npm test
npm run smoke:uc
npm run smoke:electron   # uses lab Electron at offline-lab path; skip if missing
```

Environment (synthetic only):

- `SAND_DATA_ROOT` / `SAND_USER_DATA_DIR` — settings, discovery, connection, sealed credential, lease
- `SAND_LOCAL_EXEC_ROOT` — filesystem root for path guards
- `SAND_LOCAL_EXEC_GENERATION` — optional integer published on discovery
- Supervisor freshness (90s), update lease and bounded inflight grace govern shutdown by default, including with attached transports. No opt-in environment gate.
- `SAND_DISABLE_TELEMETRY=1`

### Differences vs official 0.79.3

1. **ls**: 0.79.3 official never assigns `Z2` / never calls `configureRipgrepPath` (Linux/macOS App packages also ship no `rg` binary). Reachable path for an existing directory is `LsResult.error` with `Ripgrep path not configured. Call configureRipgrepPath() at startup.` — we match that. That stays the default. t196 also ports the configured path (`configureRipgrepPath()` → `kO` argv, `Md` env, `Eer` streaming, 2500-char budget tree, `timeoutMs ?? 5000` → `LsResult.timeout`), for parity if a build ever assigns `Z2`. t198: all exec spawns (ls, shellStream, backgroundShell, snapshot) go through the original `Ko`/`Ud` path — `Md`, `CE` shared build cache, `spawnWorkload` cgroup/FUSE-cwd hop, `BNe`; ls cancel → `LsResult.timeout` (see `docs/local-exec/ls-ripgrep-evidence.md`).
2. **download**: Always mode returns explicit “not implemented” after path checks; Never/Ask match official refusal text.
3. **bundle**: no tree-sitter / Sentry in this skeleton; shell uses `/bin/bash -lc`.
4. **UserComputer**: generated frozen service/messages + `@bufbuild/protobuf` and Connect HTTP/1.1 client; independent loopback validation only. Inner Exec* JSON codec + id realloc + 8/64 busy text covered. Exec approval chain (t117u, `src/uc/approvals.ts`): server `authorized_by_*` honoured only on a serverAuthoritative channel; local `local-tool-approvals.json` (read-only, schema/1 h `recordedAtMs` expiry/retirements/Yce, SA accountScope check; any read error → refuse); retire-approval persisted without reply; SA mode change recreates the provider. Original behaviours kept and flagged: effective never without ceiling never still honours a matching approval, records without `recordedAtMs` never expire, Yce resourcePath match and undefined machineId compare. No signature/expiry checks exist in the original and none are invented; no approval writer/self-grant API. Gaps: approvals for upload/download/discover-ai-tool/messages/local-tool, standing grants, multi-account, renew/reject, ack durability.
5. **Electron**: smoke uses lab Electron **45.2.3**; official App embeds **42.11.16** — not a drop-in claim.
6. **Ownership**: discovery PID superseded matches official FDe/Jae/hce; `SAND_LOCAL_EXEC_GENERATION` is published into discovery only — daemon does **not** compare generation numbers to exit (App-side).

### t89u review repairs and independent follow-up

See [local-exec-review-rounds.md](local-exec-review-rounds.md) for every original/follow-up finding, red/green evidence and explicit remaining gaps.

- Watch connections can end/reconnect without stopping UC tasks, resetting queue-id acks or dropping replies. Actual shutdown closes admission, waits for abort exit/close and bounded reply drain, then withdraws presence.
- Settings are hot-read at admission using the strictest permission/ceiling (official `nI`). Unknown/corrupt settings fail closed to unapproved Ask. UC policy is reannounced by replacing only Watch.
- Transient reply failures retain bounded in-memory bytes and retry with capped backoff, not a five-failure permanent stop. Saturation backpressures shell output/admission. Same-scope synthetic credential rotation can resume a 401-paused lane. A successful HTTP Submit with insufficient accepted_count is a logged final refusal and advances the lane, not a retryable transport error. Explicit process shutdown cannot guarantee delivery to an offline peer; there is no disk durability/exactly-once claim.
- Independent peer codec plus Python-generated frozen-proto outbound goldens validate Hello/Submit/Withdraw/accepted_count. No test peer import of production generated modules. Proto3 default-valued scalars may be omitted on the wire: the independent Hello golden compares field semantics, retaining the original explicit-zero fixture; Submit bytes remain compared exactly.
- Shell cancellation/shutdown use process-group TERM/KILL. Isolated original oracles wait ~4s for the 4s background; two 6s cases exit at ~5.04s while the background remains alive, with no delayed stdout in a further 2.5s observation. The five-second normal pipe drain matches these original cases; cancellation/timeout/shutdown use separate bounded cleanup. No claim covers every background/resource/session variant.
- Read: bounded UTF-8 text only (8 MiB); stat size, O_NOFOLLOW open and Linux `/proc/self/fd` location validation before reading. Explicitly rejects binary/invalid UTF-8/oversize. Not full streaming/range/image/PDF compatibility or portable openat2 confinement. ls/cwd/path races remain; **file guards are not a shell sandbox**.
- Original bad-frame oracle distinguishes outer decode/unknown throw-only from valid inner unsupported throw+streamClose. **t98u:** UC inner-id reallocation matches official (`nextExecId=1` then assign; not echo). Independent test `test/inner-exec-id.test.cjs`. Bad-frame fixtures still use server id=1 (reply id=1 after counter reset).
- Remaining major gaps: full approval/scope/account-switch lifecycle, background resource/session management, sendKeepAlives/keepAliveDueAt parity, complete file types and real App/official Electron 42.x acceptance. (ls ripgrep tree is unreachable in the 0.79.3 App; the configured path is ported in t196.)

### Offline lab alignment

Mirrored behaviors from `/workspace/local-exec-offline-lab-0793` (oracle shapes, not official binary):

- IPC fatal modes + SIGTERM discovery clear
- box Hello/read/shell/unsupported/path/cancel/Never/Ask/symlink
- UC sealed credential + Watch→Poll→Submit with real read bytes
- Electron utilityProcess postMessage handoff

### Safety

- Synthetic credentials only in tests.
- Do not commit real keys, cookies, or account tokens.
- Do not replace the official App install until P6-style acceptance exists.

### Layout

```
src/
  index.ts                 entry (box + UC)
  bootstrap/handoff.ts     IPC / parentPort
  settings.ts              Zod settings
  state/                   discovery, connection, lease
  box/provider.ts          box SSE transport
  exec/                    handlers + path guard
  uc/                      sealed, credential, generated-client business adapter
  generated/               frozen protobuf-es messages + Connect service + SOURCE.json
scripts/
  uc-smoke.cjs
  electron-smoke.cjs
  electron-host/min-app/   utilityProcess host
test/                      node:test suites
```

### Repository integration (t90u)

This private npm workspace lives at `packages/local-exec-daemon/`. The public control workspace is `packages/grokbot-control/`; the root is private orchestration only. There is one root lock; daemon artifacts are never bundled into the control tarball. Public names/bins remain unchanged. From the repository root:

```bash
npm ci
cd packages/local-exec-daemon
npm run build
npm test
npm run smoke:uc
npm run smoke:electron
```

Electron smoke accepts `LOCAL_EXEC_DAEMON_ELECTRON=/absolute/path/to/electron`; it skips when absent. The developer-only fallback points to an existing offline lab; no Electron binary is shipped. Original-daemon oracle runners require the separate research-only lab and are **not** part of normal npm tests. Runtime code has no import of that lab.

All fixture credentials and `Buffer.alloc(32, 7)` / other fixed keys are **synthetic test data, not real secrets**. No account tokens, official binaries, original application bundles or generated private SDKs are included. See [NOTICE.md](../../packages/local-exec-daemon/NOTICE.md) for provenance and license limits.

### Dependency advisories (t93u)

The exact 1.x transport versions match the root package; the lock retains reviewed Zod 3.x. `npm audit` reports **4 affected packages (3 high, 1 moderate)**: Zod GHSA-mrhx-c7xc-m3w5 and Connect-node's transitive undici / @fastify/busboy advisory chains. Suggested fixes cross major versions (Connect-node 2.x / Zod 4.x); this migration does not force-upgrade root or unreviewed APIs. Passing tests is not a security clearance; assess these before production use. Audit evidence: `/tmp/local-exec-daemon-t93u-audit.json` on the development box.

### Generated protocol (t93u)

- Runtime: retained `zod@3.25.76` (now exact pin, unchanged resolution), `@bufbuild/protobuf@1.10.1`, `@connectrpc/connect@1.6.1`, `@connectrpc/connect-node@1.6.1` (exact pins, same as root).
- Build tools retain their lock resolutions as exact pins: TypeScript 5.9.3, @types/node 22.20.5.
- Development generators: `@bufbuild/buf@1.50.0`, `@bufbuild/protoc-gen-es@1.10.1`, `@connectrpc/protoc-gen-connect-es@1.6.1` (exact pins in the repository-root workspace lock).
- `npm run generate` delegates to `packages/protocol/scripts/generate.cjs` and reads **verbatim** frozen `../protocol/baselines/schema-0.79.3/`: full GrokBotService plus its five package files. No reduced handwritten proto, renamed field, changed oneof or reduced service declaration. Full generation (~6.7 MB TS) deliberately preserves the complete service/dependency graph rather than editing it to four RPCs. `src/generated/SOURCE.json` records input SHA256 and tool versions; no App execution or network is used by generation.
- `npm run generate:check` regenerates into a temporary directory and byte-compares all seven files without modifying tracked output. Build clears only this subpackage's `dist/` first, so deleted hand-written `pb.js` cannot linger.
- Production Watch/Poll/Submit/Withdraw use generated `GrokBotService`, `createClient` and `createConnectTransport({httpVersion: "1.1", useBinaryFormat: true})`. Library owns protobuf, varints, paths, framing, endstream and Connect status; there is no production handwritten protobuf or envelope fallback. ReplyQueue retains generated binary messages in memory and updates authority fields through generated types on credential rotation.
- Business adapters explicitly map generated oneofs and derive variant numbers from descriptor metadata. Int64 uses canonical bigint/string conversion. **t98u:** Inner `ExecServerMessage` / `ExecClientMessage` (+necessary closure) are restored in freeze `packages/protocol/baselines/schema-0.79.3-daemon-exec` from App daemon compact descriptors (not hand-guessed field numbers) and regenerated into `src/generated`. Outer UC frames still carry `serverMessageJson` / `messageJson` strings; UC path decodes/encodes inner bodies with generated `ExecServerMessage` / `ExecClientMessage` / `ExecClientControlMessage` (`src/exec/exec-codec.ts`, `ignoreUnknownFields: true` inbound). Outbound client encode is strict: `handleLs` matches the reachable official path (`LsResult.error` + RIPGREP_UNCONFIGURED for an existing directory; other preamble errors unchanged). Legacy `{path,entries}` fails encode. Box outbound uses the same codec via `prepareBoxExecFrame`. Available `SandboxPolicy` and `ShellAbortReason` use generated JSON/enum metadata.
- Independent test `wire-oracle.cjs`, Python-origin goldens and isolated original-oracle helper `scripts/oracles/pb.cjs` intentionally remain handwritten **test/research-only**, never imported by `src/`.
- Valid protobuf items with bad JSON/null/missing or unknown oneof remain per-item throw + ack, preserving later valid items. **Structurally truncated protobuf is a different boundary:** the runtime rejects the whole Poll, restores prior acks, and dispatches none. The old handwritten prefix-salvage behavior was not official parity. New isolated unmodified official oracle confirms zero frames/zero acks for the corrupt batch and successful read after peer repair: `python3 scripts/oracles/run-background.py uc-truncated-poll.cjs`. Results/manifests are beside that script; a permanently corrupt peer response can still prevent progress, as in the observed official case. No custom wire salvage was reintroduced.
- Current validation: **68 tests: 68 pass / 0 fail / 0 skip** (post Exec JSON codec; re-measure after each change); UC/Electron smoke pass; root **206 pass / 0 fail / 0 skip**. See INTEGRATION.md and REVIEW-FIXES.md for historical numbers, explicit changed assertions and remaining skips. No commit/push, Page update, npm publication, official installation change or real control plane in this migration.

### t95u organization-only update

Use the root `npm ci`; there is no child lock. All codegen dependencies live in the private protocol tooling workspace. `npm run generate:check` at repository root checks control ESM JS and daemon TS→CJS against one immutable baseline/input hash. Neither consumer has a protocol workspace runtime dependency. Historical t90u/t93u standalone-package/lock statements describe their original validation stage and are superseded by this section. Current acceptance is recorded in workspace-reorg.md (formerly docs/organization.md).
