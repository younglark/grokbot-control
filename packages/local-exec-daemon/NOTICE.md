# Provenance and licence boundaries

- `src/`: independent TypeScript implementation of observed local-exec-daemon 0.79.3 contracts. It does not copy or distribute the official daemon bundle, app.asar, native helpers or official credentials. This private research package does **not** claim an upstream licence grant or full drop-in compatibility.
- No distribution licence has been granted for this new package; package metadata deliberately says `UNLICENSED` and `private: true`. This is not a new licence declaration for the root repository.
- Protocol field numbers and fixtures are based on the repository's recovered schema at `../protocol/baselines/schema-0.79.3/aiserver.v1.proto`. See `../protocol/NOTICE.md` for App version, schema provenance and unresolved schema licence. This package generates its own CJS-target artifacts from the same canonical input.
- `test/helpers/wire-oracle.cjs`: independent finite-schema test codec, not the production codec. `test/fixtures/*`: independently generated Python protobuf wire goldens with source SHA256. Absolute source paths in fixture metadata document the original lab, not runtime imports.
- `scripts/oracles/`: research harnesses adapted from the owner's existing offline lab, plus synthetic observations and input hashes. They invoke a separately supplied unmodified original input only inside an isolated namespace, with hard deadlines; the official input is NOT shipped. The small `pb.cjs` helper is lab-authored research code, not an extracted application bundle.
- Fixed AES-GCM keys such as `Buffer.alloc(32, 7)` and credential strings prefixed `synthetic` are **test-only**, intentionally public and never usable for real accounts. Production accepts the normal parent IPC handoff; it has no hardcoded real key or login path.
- Runtime dependency `zod` is MIT; development dependencies `typescript` are Apache-2.0 and `@types/node` MIT. Dependencies are fetched via the repository-root `package-lock.json`; their own package licence files govern them. Electron is optional external test tooling and is not bundled or redistributed.

For third-party schema/distribution questions, follow the root repository's conservative notice rather than assuming recovered protocol facts or the official App carry a permissive licence.


## t93u generated protocol artifacts

`src/generated/*_pb.ts` and `*_connect.ts` are generated in this repository, not copied App code. `scripts/generate.cjs` reads verbatim frozen `../protocol/baselines/schema-0.79.3/{agent.v1,aiserver.v1,aiserver.v1_2,anyrun.v1,internapi.v1,svc_aiserver.v1.GrokBotService}.proto`; SOURCE.json records exact SHA256 and generator versions. The complete original service/type declarations are preserved. This follows the existing reconstructed-schema provenance and unresolved redistribution/license cautions in `../protocol/NOTICE.md`; generation does not grant new rights to the schema.

Tools/runtime: Buf CLI 1.50.0 and Protobuf-ES runtime/protoc-gen-es 1.10.1 (Apache-2.0); Connect runtime/connect-node/protoc-gen-connect-es 1.6.1 (Apache-2.0). All are pinned in the repository-root workspace lock. Standard well-known protobuf types are supplied by the Buf/compiler and Protobuf-ES runtime; no official App runtime binary or bundle is redistributed.

Independent wire fixtures/oracle helpers remain test/research-only, with fixed synthetic credentials. The additional original-daemon corrupt-Poll experiment uses the existing isolated readonly lab, a 25s hard deadline and precise process-group cleanup. Its result/manifest are observations, not official implementation source.
