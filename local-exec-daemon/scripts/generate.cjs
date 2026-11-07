'use strict';
// Reproduce generated sources from verbatim frozen schemas, never the App bundle.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.resolve(root, '../docs/protocol/baselines/schema-0.79.3');
for (const [name, expected] of Object.entries({
  '@bufbuild/buf': '1.50.0', '@bufbuild/protoc-gen-es': '1.10.1',
  '@connectrpc/protoc-gen-connect-es': '1.6.1', '@bufbuild/protobuf': '1.10.1',
  '@connectrpc/connect': '1.6.1', '@connectrpc/connect-node': '1.6.1',
})) {
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (actual !== expected) throw new Error(`Version mismatch for ${name}: run npm ci`);
}

const names = ['agent.v1.proto', 'aiserver.v1.proto', 'aiserver.v1_2.proto', 'anyrun.v1.proto', 'internapi.v1.proto', 'svc_aiserver.v1.GrokBotService.proto'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-exec-daemon-codegen-'));
try {
  const hashes = {};
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(source, name));
    fs.writeFileSync(path.join(tmp, name), bytes);
    hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(tmp, 'buf.yaml'), 'version: v2\nmodules:\n  - path: .\n');
  const checked = process.argv.includes('--check');
  const committed = path.join(root, 'src/generated');
  const out = checked ? path.join(tmp, 'generated') : committed;
  fs.mkdirSync(out, {recursive: true});
  const template = {version: 'v2', plugins: [
    {local: path.join(root, 'node_modules/.bin/protoc-gen-es'), out, opt: ['target=ts']},
    {local: path.join(root, 'node_modules/.bin/protoc-gen-connect-es'), out, opt: ['target=ts']},
  ]};
  cp.execFileSync(path.join(root, 'node_modules/.bin/buf'), ['generate', tmp, '--template', JSON.stringify(template)], {cwd: root, stdio: 'inherit'});
  fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify({source: 'docs/protocol/baselines/schema-0.79.3', buf: '1.50.0', protobufEs: '1.10.1', connectEs: '1.6.1', sha256: hashes}, null, 2) + '\n');
  if (checked) {
    const actual = fs.readdirSync(committed).sort();
    const expected = fs.readdirSync(out).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || expected.some(name => !fs.readFileSync(path.join(out,name)).equals(fs.readFileSync(path.join(committed,name))))) {
      throw new Error('Generated sources differ: run npm run generate');
    }
    console.log(`Generation check: ${expected.length} files byte-identical`);
  }
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
