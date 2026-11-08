# local-exec-daemon

Independent **compatible** local-exec daemon targeting Grok Bot App **0.79.3** behavior.

This is **not** an official binary, **not** an in-place App replacement yet, and **must not** be pointed at real account control planes during development.

Plan page: [local-exec-daemon 0.79.3：兼容替代实现长期计划](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/8c2b08c2-4ad3-4553-9b2e-967b57185dba)

## Status (t93u generated protocol migration; partial compatibility)

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
| backgroundShell / ls ripgrep parity | ls uses readdir (differs from official Ripgrep) |
| GUI / Messages / helpers | Out of scope |
| SQLite | Not introduced |

## Commands

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

## Differences vs official 0.79.3

1. **ls**: official builds `LsSuccess.directory_tree_root` via ripgrep (`configureRipgrepPath`); we emit the same frozen schema shape from a **shallow `readdir`** (not official ignore/budget/depth). Without rg, official returns Ripgrep-not-configured.
2. **download**: Always mode returns explicit “not implemented” after path checks; Never/Ask match official refusal text.
3. **bundle**: no tree-sitter / Sentry in this skeleton; shell uses `/bin/bash -lc`.
4. **UserComputer**: generated frozen service/messages + `@bufbuild/protobuf` and Connect HTTP/1.1 client; independent loopback validation only. Inner Exec* JSON codec + id realloc + 8/64 busy text covered. Exec approval chain (t117u, `src/uc/approvals.ts`): server `authorized_by_*` honoured only on a serverAuthoritative channel; local `local-tool-approvals.json` (read-only, schema/1 h `recordedAtMs` expiry/retirements/Yce, SA accountScope check; any read error → refuse); retire-approval persisted without reply; SA mode change recreates the provider. Original behaviours kept and flagged: effective never without ceiling never still honours a matching approval, records without `recordedAtMs` never expire, Yce resourcePath match and undefined machineId compare. No signature/expiry checks exist in the original and none are invented; no approval writer/self-grant API. Gaps: approvals for upload/download/discover-ai-tool/messages/local-tool, standing grants, multi-account, renew/reject, ack durability.
5. **Electron**: smoke uses lab Electron **45.2.3**; official App embeds **42.11.16** — not a drop-in claim.
6. **Ownership**: discovery PID superseded matches official FDe/Jae/hce; `SAND_LOCAL_EXEC_GENERATION` is published into discovery only — daemon does **not** compare generation numbers to exit (App-side).

## t89u review repairs and independent follow-up

See [REVIEW-FIXES.md](REVIEW-FIXES.md) for every original/follow-up finding, red/green evidence and explicit remaining gaps.

- Watch connections can end/reconnect without stopping UC tasks, resetting queue-id acks or dropping replies. Actual shutdown closes admission, waits for abort exit/close and bounded reply drain, then withdraws presence.
- Settings are hot-read at admission using the strictest permission/ceiling (official `nI`). Unknown/corrupt settings fail closed to unapproved Ask. UC policy is reannounced by replacing only Watch.
- Transient reply failures retain bounded in-memory bytes and retry with capped backoff, not a five-failure permanent stop. Saturation backpressures shell output/admission. Same-scope synthetic credential rotation can resume a 401-paused lane. A successful HTTP Submit with insufficient accepted_count is a logged final refusal and advances the lane, not a retryable transport error. Explicit process shutdown cannot guarantee delivery to an offline peer; there is no disk durability/exactly-once claim.
- Independent peer codec plus Python-generated frozen-proto outbound goldens validate Hello/Submit/Withdraw/accepted_count. No test peer import of production generated modules. Proto3 default-valued scalars may be omitted on the wire: the independent Hello golden compares field semantics, retaining the original explicit-zero fixture; Submit bytes remain compared exactly.
- Shell cancellation/shutdown use process-group TERM/KILL. Isolated original oracles wait ~4s for the 4s background; two 6s cases exit at ~5.04s while the background remains alive, with no delayed stdout in a further 2.5s observation. The five-second normal pipe drain matches these original cases; cancellation/timeout/shutdown use separate bounded cleanup. No claim covers every background/resource/session variant.
- Read: bounded UTF-8 text only (8 MiB); stat size, O_NOFOLLOW open and Linux `/proc/self/fd` location validation before reading. Explicitly rejects binary/invalid UTF-8/oversize. Not full streaming/range/image/PDF compatibility or portable openat2 confinement. ls/cwd/path races remain; **file guards are not a shell sandbox**.
- Original bad-frame oracle distinguishes outer decode/unknown throw-only from valid inner unsupported throw+streamClose. **t98u:** UC inner-id reallocation matches official (`nextExecId=1` then assign; not echo). Independent test `test/inner-exec-id.test.cjs`. Bad-frame fixtures still use server id=1 (reply id=1 after counter reset).
- Remaining major gaps: full approval/scope/account-switch lifecycle, background resource/session management, official rg ls depth/ignore/budget, sendKeepAlives/keepAliveDueAt parity, complete file types and real App/official Electron 42.x acceptance.

## Offline lab alignment

Mirrored behaviors from `/workspace/local-exec-offline-lab-0793` (oracle shapes, not official binary):

- IPC fatal modes + SIGTERM discovery clear
- box Hello/read/shell/unsupported/path/cancel/Never/Ask/symlink
- UC sealed credential + Watch→Poll→Submit with real read bytes
- Electron utilityProcess postMessage handoff

## Safety

- Synthetic credentials only in tests.
- Do not commit real keys, cookies, or account tokens.
- Do not replace the official App install until P6-style acceptance exists.

## Layout

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

## Repository integration (t90u)

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

All fixture credentials and `Buffer.alloc(32, 7)` / other fixed keys are **synthetic test data, not real secrets**. No account tokens, official binaries, original application bundles or generated private SDKs are included. See [NOTICE.md](NOTICE.md) for provenance and license limits.

### Dependency advisories (t93u)

The exact 1.x transport versions match the root package; the lock retains reviewed Zod 3.x. `npm audit` reports **4 affected packages (3 high, 1 moderate)**: Zod GHSA-mrhx-c7xc-m3w5 and Connect-node's transitive undici / @fastify/busboy advisory chains. Suggested fixes cross major versions (Connect-node 2.x / Zod 4.x); this migration does not force-upgrade root or unreviewed APIs. Passing tests is not a security clearance; assess these before production use. Audit evidence: `/tmp/local-exec-daemon-t93u-audit.json` on the development box.

## Generated protocol (t93u)

- Runtime: retained `zod@3.25.76` (now exact pin, unchanged resolution), `@bufbuild/protobuf@1.10.1`, `@connectrpc/connect@1.6.1`, `@connectrpc/connect-node@1.6.1` (exact pins, same as root).
- Build tools retain their lock resolutions as exact pins: TypeScript 5.9.3, @types/node 22.20.5.
- Development generators: `@bufbuild/buf@1.50.0`, `@bufbuild/protoc-gen-es@1.10.1`, `@connectrpc/protoc-gen-connect-es@1.6.1` (exact pins in the repository-root workspace lock).
- `npm run generate` delegates to `packages/protocol/scripts/generate.cjs` and reads **verbatim** frozen `../protocol/baselines/schema-0.79.3/`: full GrokBotService plus its five package files. No reduced handwritten proto, renamed field, changed oneof or reduced service declaration. Full generation (~6.7 MB TS) deliberately preserves the complete service/dependency graph rather than editing it to four RPCs. `src/generated/SOURCE.json` records input SHA256 and tool versions; no App execution or network is used by generation.
- `npm run generate:check` regenerates into a temporary directory and byte-compares all seven files without modifying tracked output. Build clears only this subpackage's `dist/` first, so deleted hand-written `pb.js` cannot linger.
- Production Watch/Poll/Submit/Withdraw use generated `GrokBotService`, `createClient` and `createConnectTransport({httpVersion: "1.1", useBinaryFormat: true})`. Library owns protobuf, varints, paths, framing, endstream and Connect status; there is no production handwritten protobuf or envelope fallback. ReplyQueue retains generated binary messages in memory and updates authority fields through generated types on credential rotation.
- Business adapters explicitly map generated oneofs and derive variant numbers from descriptor metadata. Int64 uses canonical bigint/string conversion. **t98u:** Inner `ExecServerMessage` / `ExecClientMessage` (+necessary closure) are restored in freeze `packages/protocol/baselines/schema-0.79.3-daemon-exec` from App daemon compact descriptors (not hand-guessed field numbers) and regenerated into `src/generated`. Outer UC frames still carry `serverMessageJson` / `messageJson` strings; UC path decodes/encodes inner bodies with generated `ExecServerMessage` / `ExecClientMessage` / `ExecClientControlMessage` (`src/exec/exec-codec.ts`, `ignoreUnknownFields: true` inbound). Outbound client encode is strict (no interim ls fallback): `handleLs` emits frozen `LsSuccess.directoryTreeRoot` / `LsDirectoryTreeNode` (shallow readdir; not official ripgrep depth/ignore/budget). Legacy `{path,entries}` fails encode. Box outbound uses the same codec via `prepareBoxExecFrame`. Available `SandboxPolicy` and `ShellAbortReason` use generated JSON/enum metadata.
- Independent test `wire-oracle.cjs`, Python-origin goldens and isolated original-oracle helper `scripts/oracles/pb.cjs` intentionally remain handwritten **test/research-only**, never imported by `src/`.
- Valid protobuf items with bad JSON/null/missing or unknown oneof remain per-item throw + ack, preserving later valid items. **Structurally truncated protobuf is a different boundary:** the runtime rejects the whole Poll, restores prior acks, and dispatches none. The old handwritten prefix-salvage behavior was not official parity. New isolated unmodified official oracle confirms zero frames/zero acks for the corrupt batch and successful read after peer repair: `python3 scripts/oracles/run-background.py uc-truncated-poll.cjs`. Results/manifests are beside that script; a permanently corrupt peer response can still prevent progress, as in the observed official case. No custom wire salvage was reintroduced.
- Current validation: **68 tests: 68 pass / 0 fail / 0 skip** (post Exec JSON codec; re-measure after each change); UC/Electron smoke pass; root **206 pass / 0 fail / 0 skip**. See INTEGRATION.md and REVIEW-FIXES.md for historical numbers, explicit changed assertions and remaining skips. No commit/push, Page update, npm publication, official installation change or real control plane in this migration.

## t95u organization-only update

Use the root `npm ci`; there is no child lock. All codegen dependencies live in the private protocol tooling workspace. `npm run generate:check` at repository root checks control ESM JS and daemon TS→CJS against one immutable baseline/input hash. Neither consumer has a protocol workspace runtime dependency. Historical t90u/t93u standalone-package/lock statements describe their original validation stage and are superseded by this section. Current acceptance is recorded in ../../docs/organization.md.
