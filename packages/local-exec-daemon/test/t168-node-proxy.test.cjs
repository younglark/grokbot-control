// t168: SAND_NODE_PROXY_ENV handling per nke (D:79197–79232) as run by sqr at module load (D:187195–187207);
// discovery carries proxyFingerprint (D:179216). Synthetic values only.
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {applyNodeProxyEnv,proxyFingerprint,NODE_PROXY_ENV}=require('../dist/state/node-proxy');
const {publishDiscovery}=require('../dist/state/discovery');
const P={HTTPS_PROXY:'http://127.0.0.1:3128',HTTP_PROXY:'http://127.0.0.1:3128',NO_PROXY:'localhost'};
const fp=p=>crypto.createHash('sha256').update(JSON.stringify([p.HTTPS_PROXY,p.HTTP_PROXY,p.NO_PROXY])).digest('hex').slice(0,16);

test('valid value: removed from env, applied with a copy of the three keys, fingerprint = sha256([https,http,no]).slice(0,16)',()=>{
 const env={[NODE_PROXY_ENV]:JSON.stringify({...P,EXTRA:'x'}),KEEP:'1'};const got=[];
 const r=applyNodeProxyEnv(env,m=>got.push(m),p=>got.push(p));
 assert.equal(env[NODE_PROXY_ENV],undefined);assert.equal(env.KEEP,'1');
 assert.deepEqual(got,[P]);assert.deepEqual(r,{raw:JSON.stringify({...P,EXTRA:'x'}),fingerprint:fp(P)});
 assert.equal(proxyFingerprint(P),fp(P));
});
test('absent → untouched, no log; malformed / wrong types → "malformed; staying direct"; apply throws → "refused (…)"',()=>{
 const logs=[];const ap=()=>{throw new Error('nope')};
 assert.equal(applyNodeProxyEnv({},m=>logs.push(m),()=>logs.push('applied')),undefined);assert.deepEqual(logs,[]);
 for(const raw of ['not json','[]','null',JSON.stringify({HTTPS_PROXY:'a',HTTP_PROXY:'b'}),JSON.stringify({HTTPS_PROXY:1,HTTP_PROXY:'b',NO_PROXY:''})]){
  const env={[NODE_PROXY_ENV]:raw};assert.equal(applyNodeProxyEnv(env,m=>logs.push(m),()=>logs.push('applied')),undefined);assert.equal(env[NODE_PROXY_ENV],undefined);
 }
 assert.deepEqual(logs,Array(5).fill('SAND_NODE_PROXY_ENV is malformed; staying direct'));
 const l2=[];assert.equal(applyNodeProxyEnv({[NODE_PROXY_ENV]:JSON.stringify(P)},m=>l2.push(m),ap),undefined);
 assert.deepEqual(l2,['SAND_NODE_PROXY_ENV was refused (nope); staying direct']);
});
test('discovery: proxyFingerprint after generation, before rejectedAccountScopes (D:179211–179219)',async t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'t168-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 await publishDiscovery({pid:1,startedAt:2,servingAt:3,inflightCount:0,generation:7,proxyFingerprint:'abcd',rejectedAccountScopes:['s']},undefined,{SAND_DATA_ROOT:d});
 assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(d,'local-exec-daemon.json'),'utf8'))),['pid','startedAt','servingAt','inflightCount','generation','proxyFingerprint','rejectedAccountScopes']);
});

// t168 F5: sqr's env scrub (D:187195–187210): inherited fds (n$t D:79641, s$t/wDe D:79644–79658), file key, system CA.
const {scrubBootEnv,parseInheritedFds,closeInheritedFds}=require('../dist/bootstrap/boot-env');
test('boot env scrub: deletes INHERITED_FDS / FILE_KEY / NODE_USE_SYSTEM_CA; n$t parse is all-or-nothing',()=>{
 const env={SAND_LOCAL_EXEC_INHERITED_FDS:'[{"fd":7,"target":"/dev/null","x":1}]',SAND_LOCAL_EXEC_FILE_KEY:'k',NODE_USE_SYSTEM_CA:'1',KEEP:'y'};
 const r=scrubBootEnv(env,()=>[]);
 assert.deepEqual(env,{KEEP:'y'});assert.deepEqual(r.inheritedFds,[{fd:7,target:'/dev/null'}]);
 for(const bad of [undefined,'nope','{}','[{"fd":-1,"target":"x"}]','[{"fd":1.5,"target":"x"}]','[{"fd":3,"target":""}]','[{"fd":3,"target":"x"},5]'])assert.deepEqual(parseInheritedFds(bad),[],String(bad));
});
test('boot env scrub: closes only fds whose /proc link still matches the target (wDe)',()=>{
 const fd=fs.openSync('/dev/null','r');const other=fs.openSync(__filename,'r');
 try{
  const closed=closeInheritedFds([{fd,target:'/dev/null'},{fd:other,target:'/dev/null'},{fd:99999,target:'/dev/null'}]);
  assert.deepEqual(closed,[fd]);assert.throws(()=>fs.fstatSync(fd));assert.ok(fs.fstatSync(other));
 }finally{try{fs.closeSync(other)}catch{}}
});
