# Protocol workspace (private build tooling, not a runtime package)

The only canonical schema is [baselines/schema-0.79.3](baselines/schema-0.79.3/). All 14 archived files were moved byte-for-byte during t95u. A later reviewed P3 corrects README links only and updates its documentation hash; all .proto and snapshot bytes/hashes remain original. Current hashes are pinned in `baselines/schema-0.79.3.sha256.json`. The former `proto/*.proto` were checked byte-identical and removed as redundant source copies. **Never overwrite an existing frozen version**: upgrades create a new version directory/hash manifest and explicit generator target change.

Provenance: [NOTICE.md](NOTICE.md), [original restore record](RESTORE.md), [method/upgrade evidence](../../docs/protocol/README.md). The restore record is historical, not a current command recipe.

From the repository root:

```bash
npm ci
npm run generate
npm run generate:check
npm run test:protocol-tools
```

One generator (`scripts/generate.cjs`) consumes six verbatim files in the complete frozen package/service graph and produces:

- `../grokbot-control/vendor/proto-gen`: ESM JavaScript, shipped **inside** grokbot-control's tarball with NOTICE, local module metadata and SOURCE.json.
- `../local-exec-daemon/src/generated`: TypeScript compiled by that package to CommonJS; shipped only with a separately authorized daemon distribution.

Both SOURCE.json files are identical: same canonical input path, input SHA256 and exact tools. Buf1.50.0, protobuf-es1.10.1, Connect1.6.1; versions are enforced against installed metadata. `--check` generates into a temporary directory and byte-compares both consumers without modifying their outputs. No symlink to the frozen input and no App execution/network in codegen.

Generated **artifacts may be duplicated** per consumer/module format. Hand-maintained schema/tooling is not duplicated. Neither public package may have a `workspace:`/`file:` or private protocol runtime dependency. This is essential for independent npm installation.

The current frozen archive lacks inner ExecServerMessage/ExecClientMessage coverage; investigating that is a separate work item, NOT repaired by this layout change. Existing schema-license and compatibility limits remain.
