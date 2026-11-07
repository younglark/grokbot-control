# Static restore method

Goal: recover the schema and auth entry points from an **official** build without running it, logging in,
or reading any user data. Each step lists what was actually executed for 0.79.2 (2026-11-07).

## 1. Obtain the official build
- Linux feed (JSON with version / commitSha / debUrl): `https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand`
  (source listed by https://docs.x.ai/grok-bot/deployment). Download the `debUrl` **without** following cross-domain redirects;
  record size + sha256. A local sha256 is not a publisher signature.
- macOS: the upstream proto repo restores from `/Applications/Grok Bot.app/Contents/Resources/app.asar`.
- *Executed:* re-hashed the existing 0.79.2 deb (matches manifest). Not re-downloaded.

## 2. Extract without executing
```bash
dpkg-deb -x grok-bot_X_amd64.deb ./extracted      # no maintainer scripts run
python3 tools/protocol/asar_extract.py list "./extracted/opt/Grok Bot/resources/app.asar" --grep 'electron-main/.*\.cjs$'
python3 tools/protocol/asar_extract.py extract "./extracted/opt/Grok Bot/resources/app.asar" /tmp/gb-X \
  package.json dist/electron-main/proto.cjs dist/electron-main/main-app.cjs dist/electron-main/main-core.cjs
```
*Executed:* yes; hashes equal the earlier record (baseline-manifest.md).

## 3. Schema (compact descriptors in proto.cjs)
The App bundles `@bufbuild/protobuf` 1.10.x compact descriptors (`static $()` arrays). Upstream
[`grokbot-proto`](https://github.com/younglark/grokbot-proto) `scripts/extract_proto.py` turns them into `.proto` + `snapshot.json`:
```bash
python3 grokbot-proto/scripts/extract_proto.py /tmp/gb-X/dist/electron-main/proto.cjs /tmp/gb-X/out
# must report: unresolved refs: 0, types relocated: 0
```
Full pipeline with protoc compile, codegen, descriptor compare and wire cross-check:
`grokbot-proto/scripts/restore.sh --proto-cjs /tmp/gb-X/dist/electron-main/proto.cjs ./out --baseline <old>/proto`
(needs `pip install grpcio-tools`, node ≥ 18, and npx package downloads).
*Executed:* `extract_proto.py` (0 unresolved, 0 relocated) and `diff_snapshot.py`. **Not executed:** `restore.sh`
(protoc / codegen / wire cross-check) for 0.79.2.

Limits: restored `.proto` has no original comments, options or file layout; `google.protobuf.*` / OTEL types come from
libraries, not the bundle. Generator versions must match the App's `@bufbuild/protobuf` or enum names/shape drift.

## 4. Auth / transport entry points
```bash
python3 tools/protocol/fingerprint.py /tmp/gb-X/dist/electron-main/main-app.cjs /tmp/gb-X/dist/electron-main/main-core.cjs
```
Prints sha256 and, for each anchor category (login URL, poll, refresh, policy error, client headers, sidebar base, …),
the byte offset, nearest minified function name, and a redacted context line. Minified names (`Rdn`, `Odn`, …) change
every build — re-locate by anchor, then read the function in a prettified copy (`npx prettier --parser babel`), never run it.
*Executed:* yes on 0.79.2 main-app/main-core; anchors match auth-flow.md.

## 5. Map to this repo
```bash
python3 tools/protocol/used_surface.py --src src --old docs/protocol/baselines/used-surface-<old>.json \
  --new /tmp/gb-X/out/snapshot.json -o /tmp/gb-X/used-surface.md      # exit 1 = breaking change in used surface
```
*Executed:* 0.78.4 → 0.79.2: 0 breaking, 14 additive field lines.

## 0.79.3 run (2026-11-07) — current vendor

- Feed opened without login → 0.79.3 / `4739412…`; deb downloaded to a dir outside the repo, hashed, `dpkg-deb -x` (no install, no execution).
- `asar_extract.py` → proto.cjs / main-app.cjs / main-core.cjs (hashes in baseline-manifest.md).
- `extract_proto.py` (text parse, bundle not executed): 0 unresolved / 0 relocated / 0 backward edges.
- `grpc_tools.protoc` descriptor set + protoc-gen-es 1.10.1 / protoc-gen-connect-es 1.6.1 (`target=js`), installed with `npm install` in a temp dir.
- Toolchain reproducibility: regenerating from upstream 0.78.4 `.proto` gives the old vendor byte-for-byte.
- `tools/protocol/verify_generated.mjs`: 0 errors (2923 msgs / 387 enums / 464 GrokBotService RPCs; 2923 round-trips).
- Upstream `compare.mjs` / `cross-wire.mjs` **not run** (they `require()` the App's proto.cjs).
- `fingerprint.py` on main-app.cjs: same auth anchors as 0.79.2; only minified identifiers changed.
- Restored `.proto` live at **`proto/`** (formal protocol source); identical freeze kept under `docs/protocol/baselines/schema-0.79.3/`.
