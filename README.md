# grokbot-control

A repository for a programmable Grok Bot control plane, a compatible local execution daemon, and a **planned** headless node host. Not an official product.

| Area | Code / docs | Status |
|---|---|---|
| SDK + CLI `gbc` + MCP `gbc-mcp` | [packages/grokbot-control](packages/grokbot-control/README.md), [control-plane docs](docs/control-plane/README.md) | Public npm **grokbot-control@0.1.3**; names/exports unchanged |
| `local-exec-daemon` | [packages/local-exec-daemon](packages/local-exec-daemon/README.md), [boundary](docs/local-exec/README.md) | Private; synthetic/offline compatibility implementation, **not complete drop-in** |
| Protocol | [packages/protocol](packages/protocol/README.md), [methods/evidence](docs/protocol/README.md) | Single immutable input; deterministic consumer-local artifacts |
| Headless local computer / Docker | [design](docs/headless/README.md), [future host](packages/headless-node/README.md), [deployment boundary](deploy/headless/README.md) | **Design only**. No registration business, executable, Dockerfile or image deployment |

## Existing public installation (unchanged)

```bash
npx --yes --package=grokbot-control@0.1.3 gbc --help
npx --yes --package=grokbot-control@0.1.3 gbc --mock --json bot list
npx --yes --package=grokbot-control@0.1.3 gbc-mcp
```

## Repository development

Node >=20; one npm workspace lock at the repository root. No installation inside individual packages.

```bash
npm ci
npm run generate:check
npm run build
npm test
npm run test:protocol-tools
npm run smoke:uc
npm run smoke:electron    # optional external lab Electron45.x, not official42.x
npm run verify:package   # creates actual tarball; isolated npm consumer install/bin/SDK checks
npm run gbc -- --help
```

Per-package: `npm test -w grokbot-control`, `npm test -w local-exec-daemon`.
`npm run generate` regenerates control ESM JS and daemon TS→CJS from exactly one frozen source. The private protocol workspace is **build tooling**, never an unpublished runtime dependency. Tarballs include their own generated artifacts, not workspace paths.

The root is private/orchestration-only; never publish it. Existing `v*` release tags and Trusted Publisher remain bound to **`.github/workflows/publish.yml`**; its publish step runs inside `packages/grokbot-control`. No tag/publish/push is part of this reorganization.

See [organization and validation](docs/organization.md), [security/compatibility limits](packages/local-exec-daemon/REVIEW-FIXES.md), and [protocol provenance](packages/protocol/NOTICE.md). Auth remains inside the control package; the daemon does not import CLI/MCP. No real control plane, official-install replacement, Docker deployment or new registration implementation is included.
