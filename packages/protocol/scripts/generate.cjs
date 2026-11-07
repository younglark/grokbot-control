'use strict';
// Canonical frozen input, deterministic per-consumer artifacts. No runtime workspace dependency.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '../../..');
const source = path.join(repo, 'packages/protocol/baselines/schema-0.79.3');
const frozen = JSON.parse(fs.readFileSync(path.join(source,'../schema-0.79.3.sha256.json'),'utf8'));
for (const [name,hash] of Object.entries(frozen)) {
  if (crypto.createHash('sha256').update(fs.readFileSync(path.join(source,name))).digest('hex') !== hash) throw new Error(`Frozen baseline changed: ${name}; create a NEW version directory instead`);
}
const checked = process.argv.includes('--check');
const selected = process.argv.find(a => a.startsWith('--target='))?.split('=')[1];
if (selected && !['control','daemon'].includes(selected)) throw new Error('Unknown codegen target');
function installed(name, version) {
  for (const modules of require.resolve.paths(name) || []) {
    const dir = path.join(modules,name);
    const p = path.join(dir,'package.json');
    if (!fs.existsSync(p)) continue;
    const info = JSON.parse(fs.readFileSync(p,'utf8'));
    if (info.name !== name) continue;
    if (info.version !== version) throw new Error(`Version mismatch for ${name}; run npm ci at repository root`);
    return {dir,info};
  }
  throw new Error(`Package metadata missing for ${name}`);
}
function binary(name, version, command) {
  const {dir,info} = installed(name,version);
  return path.join(dir, typeof info.bin === 'string' ? info.bin : info.bin[command]);
}
const buf = binary('@bufbuild/buf','1.50.0','buf');
const es = binary('@bufbuild/protoc-gen-es','1.10.1','protoc-gen-es');
const connect = binary('@connectrpc/protoc-gen-connect-es','1.6.1','protoc-gen-connect-es');
installed('@bufbuild/protobuf','1.10.1');
installed('@connectrpc/connect','1.6.1');
installed('@connectrpc/connect-node','1.6.1');
const names = ['agent.v1.proto','aiserver.v1.proto','aiserver.v1_2.proto','anyrun.v1.proto','internapi.v1.proto','svc_aiserver.v1.GrokBotService.proto'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'gbc-protocol-codegen-'));
try {
  const input = path.join(tmp,'input'); fs.mkdirSync(input);
  const hashes = {};
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(source,name));
    fs.writeFileSync(path.join(input,name),bytes);
    hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(input,'buf.yaml'),'version: v2\nmodules:\n  - path: .\n');
  const manifest = JSON.stringify({source:'packages/protocol/baselines/schema-0.79.3',buf:'1.50.0',protobufEs:'1.10.1',connectEs:'1.6.1',sha256:hashes},null,2)+'\n';
  const targets = [
    {name:'control',target:'js',dest:path.join(repo,'packages/grokbot-control/vendor/proto-gen')},
    {name:'daemon',target:'ts',dest:path.join(repo,'packages/local-exec-daemon/src/generated')},
  ].filter(t=>!selected || t.name===selected);
  for (const t of targets) {
    const out = path.join(tmp,t.name);fs.mkdirSync(out);
    const template = {version:'v2',plugins:[
      {local:[process.execPath,es],out,opt:[`target=${t.target}`]},
      {local:[process.execPath,connect],out,opt:[`target=${t.target}`]},
    ]};
    cp.execFileSync(process.execPath,[buf,'generate',input,'--template',JSON.stringify(template)],{cwd:repo,stdio:'inherit'});
    fs.writeFileSync(path.join(out,'SOURCE.json'),manifest);
    const expected = fs.readdirSync(out).sort();
    if (checked) {
      const actual = fs.readdirSync(t.dest).filter(f=>f.endsWith(t.target==='js'?'.js':'.ts') || f==='SOURCE.json').sort();
      if (JSON.stringify(actual)!==JSON.stringify(expected) || expected.some(f=>!fs.readFileSync(path.join(out,f)).equals(fs.readFileSync(path.join(t.dest,f))))) throw new Error(`Generated ${t.name} artifacts differ; run npm run generate`);
      console.log(`${t.name}: ${expected.length} generated files byte-identical`);
    } else {
      fs.mkdirSync(t.dest,{recursive:true});
      for(const name of expected) fs.copyFileSync(path.join(out,name),path.join(t.dest,name));
      console.log(`${t.name}: generated ${expected.length} files from the canonical frozen input`);
    }
  }
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
