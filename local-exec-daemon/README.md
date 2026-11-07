# local-exec-daemon

Independent **compatible** local-exec daemon targeting Grok Bot App **0.79.3** behavior.

This is **not** an official binary, **not** an in-place App replacement yet, and **must not** be pointed at real account control planes during development.

Plan page: [local-exec-daemon 0.79.3：兼容替代实现长期计划](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/8c2b08c2-4ad3-4553-9b2e-967b57185dba)

## Status (P2 skeleton; t89u reviewed implementation, partial compatibility)

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
cd /workspace/grokbot-control/local-exec-daemon
npm install
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

1. **ls**: official returns Ripgrep-not-configured until `configureRipgrepPath`; we list with `readdir`.
2. **download**: Always mode returns explicit “not implemented” after path checks; Never/Ask match official refusal text.
3. **bundle**: no tree-sitter / Sentry in this skeleton; shell uses `/bin/bash -lc`.
4. **UserComputer**: Connect protobuf hand-rolled (no `@connectrpc` codegen yet); works with lab fake peer. Gaps: backlog pressure, standing/approval, multi-account, renew/reject.
5. **Electron**: smoke uses lab Electron **45.2.3**; official App embeds **42.11.16** — not a drop-in claim.
6. **Ownership / generation preempt**: helper + env publish only; dual-daemon race not automated.

## t89u review repairs and independent follow-up

See [REVIEW-FIXES.md](REVIEW-FIXES.md) for every original/follow-up finding, red/green evidence and explicit remaining gaps.

- Watch connections can end/reconnect without stopping UC tasks, resetting queue-id acks or dropping replies. Actual shutdown closes admission, waits for abort exit/close and bounded reply drain, then withdraws presence.
- Settings are hot-read at admission using the strictest permission/ceiling (official `nI`). Unknown/corrupt settings fail closed to unapproved Ask. UC policy is reannounced by replacing only Watch.
- Transient reply failures retain bounded in-memory bytes and retry with capped backoff, not a five-failure permanent stop. Saturation backpressures shell output/admission. Same-scope synthetic credential rotation can resume a 401-paused lane. A successful HTTP Submit with insufficient accepted_count is a logged final refusal and advances the lane, not a retryable transport error. Explicit process shutdown cannot guarantee delivery to an offline peer; there is no disk durability/exactly-once claim.
- Independent peer codec plus Python-generated frozen-proto outbound goldens validate Hello/Submit/Withdraw/accepted_count. No test peer import of production pb.
- Shell cancellation/shutdown use process-group TERM/KILL. Isolated original oracles wait ~4s for the 4s background; two 6s cases exit at ~5.04s while the background remains alive, with no delayed stdout in a further 2.5s observation. The five-second normal pipe drain matches these original cases; cancellation/timeout/shutdown use separate bounded cleanup. No claim covers every background/resource/session variant.
- Read: bounded UTF-8 text only (8 MiB); stat size, O_NOFOLLOW open and Linux `/proc/self/fd` location validation before reading. Explicitly rejects binary/invalid UTF-8/oversize. Not full streaming/range/image/PDF compatibility or portable openat2 confinement. ls/cwd/path races remain; **file guards are not a shell sandbox**.
- Original bad-frame oracle distinguishes outer decode/unknown throw-only from valid inner unsupported throw+streamClose. General UC inner-id reallocation parity remains unimplemented; fixture comparisons use identical id=1.
- Remaining major gaps: full approval/scope/account-switch lifecycle, background resource/session management, generation/PID preemption, overload/keepalive parity, complete file types and real App/official Electron 42.x acceptance.

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
  uc/                      sealed, credential, Connect provider, pb
scripts/
  uc-smoke.cjs
  electron-smoke.cjs
  electron-host/min-app/   utilityProcess host
test/                      node:test suites
```

## Repository integration (t90u)

This independent private subpackage lives at `local-exec-daemon/` beside the existing root CLI/MCP. It is not an npm workspace and is not automatically bundled into the root published package; root name and entry points remain unchanged. From the repository root:

```bash
cd local-exec-daemon
npm ci
npm run build
npm test
npm run smoke:uc
npm run smoke:electron
```

Electron smoke accepts `LOCAL_EXEC_DAEMON_ELECTRON=/absolute/path/to/electron`; it skips when absent. The developer-only fallback points to an existing offline lab; no Electron binary is shipped. Original-daemon oracle runners require the separate research-only lab and are **not** part of normal npm tests. Runtime code has no import of that lab.

All fixture credentials and `Buffer.alloc(32, 7)` / other fixed keys are **synthetic test data, not real secrets**. No account tokens, official binaries, original application bundles or generated private SDKs are included. See [NOTICE.md](NOTICE.md) for provenance and license limits.

### Dependency advisory (integration check)

The reviewed lock retains Zod 3.x for behavior parity. `npm audit` currently reports GHSA-mrhx-c7xc-m3w5 (high; constrained-collection memory exhaustion), with a major-version-only fix at Zod 4.6.6+. This integration does not silently force-upgrade the reviewed implementation or the root dependencies. Track the advisory before production use; no real control-plane deployment is part of this package.
