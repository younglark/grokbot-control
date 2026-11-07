# Protocol workspace (private build tooling, not a runtime package)

Immutable App proto.cjs archive remains [baselines/schema-0.79.3](baselines/schema-0.79.3/) (hashes in `baselines/schema-0.79.3.sha256.json`). **t98u generator input:** [baselines/schema-0.79.3-daemon-exec](baselines/schema-0.79.3-daemon-exec/) — additive ExecServerMessage/ExecClientMessage (+closure) from daemon compact descriptors; parent `schema-0.79.3` untouched. Hashes: `baselines/schema-0.79.3-daemon-exec.sha256.json`. **Never overwrite an existing frozen version**: upgrades create a new version directory/hash manifest and explicit generator target change.

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

**t98u:** inner ExecServerMessage/ExecClientMessage (+closure) restored in `schema-0.79.3-daemon-exec` (daemon `$()`/`ee()` evidence; not hand-copied field numbers). Parent `schema-0.79.3` unchanged. Existing schema-license and compatibility limits remain; not a drop-in claim.
