# 仓库 workspace 重组记录（历史）

> 存档：原 `docs/organization.md`，t95u 把仓库重组为 npm workspaces 时的目录说明与验证记录。当前目录与规则以 [architecture.md](../architecture.md) 和根 [README](../../README.md) 为准。

原标题：Repository organization and validation — t95u

## Actual tree / responsibilities

```text
package.json                 private workspace orchestrator; never published
package-lock.json            ONLY install lock (all three executable/tool workspaces)
packages/
  grokbot-control/            public grokbot-control@0.1.3 (ESM)
    src/{auth,connect,ops,sync,cli,mcp,dto,testing}
    test/                    original control tests
    vendor/proto-gen/        local ESM artifacts + SOURCE + original NOTICE
    package.json             gbc / gbc-mcp / SDK exports unchanged
  local-exec-daemon/         private local-exec-daemon@0.2.0-p2 (TS→CJS)
    src/{bootstrap,box,exec,state,transport,uc,generated}
    test/                    independent wire peer/goldens and lifecycle tests
    scripts/                 UC/Electron smoke, isolated research oracle harnesses
  protocol/                  private tooling workspace, NOT a runtime dependency
    baselines/schema-0.79.3/ original 14 archived files, unchanged bytes
    baselines/schema-0.79.3.sha256.json
    scripts/generate.cjs     the only generation implementation
    {README,NOTICE,RESTORE}.md
  headless-node/README.md    design ONLY; no package/executable/business
deploy/headless/README.md   design ONLY; no Dockerfile/image/deployment
docs/{control-plane,local-exec,headless,protocol}/
tools/protocol/             offline extraction/verification methods
scripts/verify-package.mjs actual pack + independent consumer test
test/organization.test.mjs  cross-package boundary tests
.github/workflows/
   publish.yml               original filename and v* / OIDC binding retained
   auth-native-lock.yml      native lock matrix retained, test cwd corrected
   workspaces.yml            control + daemon + codegen + package offline regression
```

Auth stays inside control. CLI and MCP stay in the same public package/shared SDK. Daemon never imports the CLI/MCP. Headless, once separately implemented, would use SDK + daemon **process**, not impose a new task layer or change App handoff. No registration functionality or successful-start placeholder is introduced here.

## Protocol and independent publication

The former root `proto/*.proto` was proven byte-identical to the frozen 0.79.3 archive, then removed as redundant. That archive was moved unchanged from docs/protocol/baselines to packages/protocol/baselines; **all 14 original SHA256s remain pinned**, including README/snapshot. Old research hashes and fixtures are retained; absolute source paths inside historical fixtures remain provenance, not runtime paths. Restore method and upgrade evidence stay in docs/protocol.

`npm run generate` emits two consumer-local artifact sets from one input/tool chain: control ESM JavaScript, daemon TypeScript compiled to CommonJS. Both SOURCE.json files are identical. All six control JS outputs are byte-identical to pre-move a9231c2; the daemon message/service TS outputs are likewise unchanged. `generate:check` checks bytes without modifying outputs; codegen also rejects changes to pinned frozen inputs. New schema versions must use new versioned directories, not mutate 0.79.3.

The private protocol workspace owns development tooling only. Neither runtime consumer depends on a `workspace:`/`file:` package or imports a sibling package at runtime. Control's tarball includes local generated JS/NOTICE/module metadata/SOURCE, so `npm install grokbot-control` resolves from normal registry dependencies without this monorepo.

## Publication / lifecycle

- Public package name/version remain grokbot-control@0.1.3, bins gbc/gbc-mcp, SDK exports unchanged. Daemon name/bin remain local-exec-daemon and private.
- Root package is private, orchestration-only, with an explicit prepublishOnly refusal. No package is published in this work.
- publish.yml filename, Trusted Publisher workflow binding, v* trigger and OIDC permission are preserved. Only build/test target and publish working directory change to the public package. No workflow rename/tag/push.
- Public files allowlist is now **dist, vendor/proto-gen, README.md**: no daemon, research fixtures, frozen schema archive or accidental full docs tree. Package README links to canonical online docs.
- `prepack` remains `npm run build`, a maintainer packing step with dev tooling available. There is **no prepare/install/postinstall** on the public package: installing the packed tarball does not need TypeScript, workspace generators, schema files or sibling packages. Native dependency lifecycle remains upstream-owned.
- MCP retains original behavior: `gbc-mcp --help` with closed stdin exits0, but has **no human help handler** (empty stdout); this reorganization does not add one. The isolated package test additionally verifies an actual mock MCP initialize response.

## Commands / evidence

Run from the root: `npm ci`, `npm run generate:check`, `npm run build`, `npm test`, `npm run test:protocol-tools`, `npm run smoke:uc`, `npm run smoke:electron`, `npm run verify:package`.

Validation is recorded after final execution below. Earlier t89u/t90u/t93u counts in the moved review documents remain historical and are not relabeled. The first local commit is the t93u protocol migration; the second is organization-only. Both stay local for review.

## Nonblocking risks (unchanged)

Audit reports 4 affected packages (3 high / 1 moderate): Zod and Connect-node's undici/busboy chain. No forced major upgrade is hidden in a move. Daemon still has inner-ID allocation, missing inner Exec frozen schema, approval/scope, complete sessions/files, PID preemption and pressure/keepalive gaps; this work does not research or solve them. Electron45.x lab smoke is not official42.x/App drop-in acceptance. Headless identity/registration/supervision and Docker deployment are only design. No official install or real account was accessed.


## Final executed validation (t95u)

| Check | Actual result |
|---|---|
| Normal clean root `npm ci` | pass (not --ignore-scripts); one root lock |
| Workspace build / typecheck via build | pass |
| Control tests | **206 pass / 0 fail / 0 skip** |
| Daemon tests | **53 tests: 51 pass / 0 fail / 2 skip** |
| Organization boundary tests | **5 pass / 0 fail / 0 skip** |
| Combined npm test | **264 tests: 262 pass / 0 fail / 2 skip** |
| Python protocol tools | **5 pass** |
| Static generated verifier | 2923 messages + 387 enums + 464 GrokBotService RPCs; 2923 roundtrips; 0 errors; six non-GrokBotService definitions not generated |
| Root generate:check | both consumers: seven files byte-identical |
| UC smoke | pass, synthetic loopback only |
| Electron smoke | pass, external lab45.x; NOT official42.x acceptance |
| Real pack + isolated normal install | pass, **81 files**; actual npm bin resolution, CLI help, mock MCP initialize and SDK import |
| Lifecycle / contents | prepack builds for maintainer; no consumer prepare/install/postinstall; only runtime dist/vendor/README/package metadata; no private/file/workspace runtime dependency |
| Source/hash checks | 57 business/generated source files unchanged byte-for-byte vs migration commit; all 14 frozen archive hashes unchanged; six control ESM JS files byte-identical |
| Markdown current-link check / git diff --check | pass; archived frozen README/RESTORE retains historical context |

The daemon skips remain generation/PID preemption and full pressure oracle. They are not counted as passes. No headless registration or Docker execution/deployment was tested because it does not exist.

Latest real tarball: `/tmp/gbc-independent-consumer-KqtTve/grokbot-control-0.1.3.tgz`; independent consumer result: `/tmp/gbc-independent-consumer-KqtTve/result.json`. The temporary artifacts are outside the repository and are not committed.

Logs: `/tmp/grokbot-control-t95u-{ci-final,codegen-final,build-final,test-final,protocol-tools-final,uc-final,electron-final,package-final}.txt`; generated static verifier `/tmp/grokbot-control-t95u-generated.txt`; audit `/tmp/grokbot-control-t95u-audit.json`.

## Reviewed P3 link cleanup

After the independently clean-cloned t95u review (262 pass / 2 skip, tarball install passed), only the frozen directory README links and public auth-lock guidance URLs were corrected. The README documentation hash changed from `b98258f680d9921be3bdc47027641cb5ff555c337c02787fa9abde2422b2719b` to `9cc2ad68e907bc2ce7d37173e9c5d50b4a49ea7f08496fa9ed99431b71e8cfac`; **no .proto or snapshot content/hash changed**. Previous “all14 unchanged” statements describe the t95u move, not this later README-only correction. Link regression now covers the frozen README; auth-lock failure/help assertions require the full public GitHub docs/control-plane URL because npm does not ship docs. No behavior expansion or push.
