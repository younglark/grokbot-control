import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=p=>JSON.parse(readFileSync(join(root,p),'utf8'));

test('root orchestrates private workspaces; public package/bin/export contracts survive',()=>{
 assert.equal(json('package.json').private,true);
 assert.equal(json('packages/protocol/package.json').private,true);
 const control=json('packages/grokbot-control/package.json'),daemon=json('packages/local-exec-daemon/package.json');
 assert.equal(control.name,'grokbot-control');assert.equal(control.bin.gbc,'./dist/cli/main.js');assert.equal(control.bin['gbc-mcp'],'./dist/mcp/main.js');assert.equal(control.exports['.'].import,'./dist/index.js');
 assert.equal(daemon.name,'local-exec-daemon');assert.equal(daemon.bin['local-exec-daemon'],'dist/index.js');assert.equal(daemon.private,true);
});
test('one root lock; consumers have no unpublished runtime workspace dependency',()=>{
 assert.ok(existsSync(join(root,'package-lock.json')));
 for(const name of ['grokbot-control','local-exec-daemon','protocol']){
  assert.equal(existsSync(join(root,'packages',name,'package-lock.json')),false);
  const pkg=json(`packages/${name}/package.json`);
  for(const [dep,version] of Object.entries(pkg.dependencies||{})){
   assert.notEqual(dep,'@grokbot-control/protocol');assert.ok(!/^(workspace:|file:)/.test(version));
  }
 }
});
test('frozen archive is unchanged and both consumers record exactly the same input hash',()=>{
 // Parent App archives (immutable) and daemon-exec generator inputs are all frozen; verify each vs its own manifest.
 // 0.79.3 dirs stay as history; 0.79.4-daemon-exec is the current generator input.
 for(const prefix of ['packages/protocol/baselines/schema-0.79.3','packages/protocol/baselines/schema-0.79.3-daemon-exec','packages/protocol/baselines/schema-0.79.4','packages/protocol/baselines/schema-0.79.4-daemon-exec']){
  const hashes=json(`${prefix}.sha256.json`);
  assert.deepEqual(readdirSync(join(root,prefix)).sort(),Object.keys(hashes).sort(),prefix);
  for(const [name,hash] of Object.entries(hashes)){
   const p=join(root,prefix,name);assert.equal(lstatSync(p).isSymbolicLink(),false);
   assert.equal(createHash('sha256').update(readFileSync(p)).digest('hex'),hash,`${prefix}/${name}`);
  }
 }
 const a=json('packages/grokbot-control/vendor/proto-gen/SOURCE.json'),b=json('packages/local-exec-daemon/src/generated/SOURCE.json');assert.deepEqual(a,b);
 // Consumers record hashes of the generator input they declare (daemon-exec since t98u), not the parent App archive.
 assert.equal(a.source,'packages/protocol/baselines/schema-0.79.4-daemon-exec');
 const inputHashes=json(`${a.source}.sha256.json`);
 for(const [name,hash] of Object.entries(a.sha256))assert.equal(hash,inputHashes[name],name);
});
test('public lifecycle ships only runtime artifacts and no workflow publishes to npmjs',()=>{
 const p=json('packages/grokbot-control/package.json');assert.deepEqual(p.files,['dist','vendor/proto-gen','README.md']);
 assert.equal(p.scripts.prepare,undefined);assert.equal(p.scripts.install,undefined);assert.equal(p.scripts.prepack,'npm run build');
 assert.equal(existsSync(join(root,'.github/workflows/publish.yml')),false);
 const workflows=join(root,'.github/workflows');
 for(const name of readdirSync(workflows)){
  const text=readFileSync(join(workflows,name),'utf8');
  assert.doesNotMatch(text,/npm\s+publish/,'workflow must not publish to npmjs: '+name);
  assert.doesNotMatch(text,/registry\.npmjs\.org/,'workflow must not target registry.npmjs.org: '+name);
 }
 const rootPkg=json('package.json');
 assert.equal(rootPkg.scripts['release:github'],'node scripts/release-github.mjs');
 assert.ok(existsSync(join(root,'scripts/release-github.mjs')));
 const release=readFileSync(join(root,'.github/workflows/release-github.yml'),'utf8');
 assert.match(release,/tags:\s*\n\s*-\s*'v\[0-9\]\*'/);
 assert.doesNotMatch(release,/-\s*['"]npm-v/);
 assert.match(release,/contents:\s*write/);
 assert.match(release,/UC_SKIP_OFFICIAL/);
 assert.match(release,/release-github\.mjs --ci --skip-tests/);
 assert.doesNotMatch(release,/--force/);
});
test('headless and Docker boundaries are documentation, not fake implemented products',()=>{
 for(const p of ['packages/headless-node/package.json','packages/headless-node/src/cli.ts','deploy/headless/Dockerfile','deploy/headless/docker-compose.yml'])assert.equal(existsSync(join(root,p)),false,p);
 assert.ok(existsSync(join(root,'docs/headless/README.md')));
});

test('current Markdown relative links resolve, including the frozen schema README',()=>{
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(item=>{
  if(['node_modules','dist','.git'].includes(item.name))return [];
  const p=join(dir,item.name);return item.isDirectory()?walk(p):p.endsWith('.md')?[p]:[];
 });
 for(const file of walk(root)){
  // Original pre-workspace restore recipe is explicitly labeled historical.
  if(file===join(root,'packages/protocol/RESTORE.md'))continue;
  for(const match of readFileSync(file,'utf8').matchAll(/\]\(([^)\s]+)\)/g)){
   const href=match[1];if(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)||/^[#/<]/.test(href))continue;
   assert.ok(existsSync(resolve(dirname(file),href.split('#')[0])),`${file}: ${href}`);
  }
 }
});
