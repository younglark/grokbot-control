// t159: O9r connection exchange, connection file (RLe/vLe), Box stale trigger, Obsidian device tools, cp writer.
// Synthetic fixtures and local fake servers only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const X=require('../dist/state/connection-exchange');
const C=require('../dist/state/connection');
const W=require('../dist/state/fs-write');
const O=require('../dist/uc/obsidian');
const L=require('../dist/uc/local-tools');
const {BoxProvider}=require('../dist/box/provider');
const {sealJson}=require('../dist/uc/sealed');
const KEY=Buffer.alloc(32,7).toString('base64');
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t159-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
async function server(t,handler){const seen=[];const s=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{seen.push({method:req.method,url:req.url,headers:req.headers,body:b});handler(req,res)})});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections?.();s.close(r)}));return{seen,url:`http://127.0.0.1:${s.address().port}`}}
const client=X.backendClientFromEnv({},'linux');

test('mb headers from eke(env,"desktop") (D:79034, jAt/VPe/ese/BAt/FAt)',()=>{
 assert.deepEqual(X.clientHeaders(client),{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.79.4-dev Safari/537.36',
  'x-cursor-client-type':'sand','x-cursor-client-version':'0.79.4-dev','x-sand-box-namespace':'dev','x-cursor-client-os':'linux','x-cursor-client-source':'sand-desktop'});
 const prod=X.backendClientFromEnv({SAND_PACKAGED:'1',SAND_CLIENT_APP_VERSION:'1.2.3-beta.4'},'darwin');
 assert.equal(prod.clientVersion,'1.2.3');assert.equal(prod.boxNamespace,'prod');assert.equal(X.variantForNamespace(prod.boxNamespace),'sand');
 const lab=X.backendClientFromEnv({SAND_PACKAGED:'1',SAND_LAB:'1',SAND_ISOLATED_DEPLOYMENT:'1',SAND_BACKEND_URL:'https://api.synthetic.invalid',SAND_CURSOR_WEBSITE_URL:'https://www.synthetic.invalid'},'linux');
 assert.equal(lab.clientVersion,'0.79.4-lab');assert.equal(lab.boxNamespace,'prod');
 assert.equal(X.backendClientFromEnv({SAND_BOX_OWNER_NAMESPACE:' lab '},'linux').boxNamespace,'lab');
});

test('O9r request: POST new URL(k9r, backendUrl), content-type + mb headers, body {credential}',async t=>{
 const s=await server(t,(req,res)=>{res.writeHead(200);res.end(JSON.stringify({baseUrl:'http://gw.synthetic',token:'',networkToken:'synthetic-net',gatewayPortToken:'synthetic-port'}))});
 const r=await X.exchangeConnection({backendUrl:`${s.url}/api/v1/`,credential:'synthetic-cred',client});
 assert.equal(s.seen[0].method,'POST');assert.equal(s.seen[0].url,'/sand-box/local-exec-connection'); // absolute path replaces /api/v1/
 assert.equal(s.seen[0].headers['content-type'],'application/json');assert.equal(s.seen[0].headers['x-cursor-client-source'],'sand-desktop');
 assert.deepEqual(JSON.parse(s.seen[0].body),{credential:'synthetic-cred'});
 // empty token → undefined; networkToken wins over gatewayPortToken (M9r)
 assert.deepEqual(JSON.parse(JSON.stringify(r)),{kind:'connected',connection:{baseUrl:'http://gw.synthetic',headers:{'x-anyrun-network-token':'synthetic-net'}}});
});

test('O9r result kinds: status / body / shape / transport (xt)',async t=>{
 const replies=[[500,''],[200,'not json'],[200,'[1]'],[200,'{"baseUrl":""}'],[200,'{"baseUrl":"http://g","token":5}']];let i=0;
 const s=await server(t,(req,res)=>{const [st,b]=replies[i++];res.writeHead(st);res.end(b)});
 const go=()=>X.exchangeConnection({backendUrl:s.url,credential:'c',client});
 assert.deepEqual(await go(),{kind:'unavailable',reason:'status',detail:'http_500'});
 assert.deepEqual(await go(),{kind:'unavailable',reason:'body',detail:'SyntaxError'});
 assert.deepEqual(await go(),{kind:'unavailable',reason:'shape',detail:'reply is not an object'});
 assert.deepEqual(await go(),{kind:'unavailable',reason:'shape',detail:'reply has no baseUrl'});
 assert.deepEqual(JSON.parse(JSON.stringify(await go())),{kind:'connected',connection:{baseUrl:'http://g'}});
 const dead=http.createServer();await new Promise(r=>dead.listen(0,'127.0.0.1',r));const port=dead.address().port;await new Promise(r=>dead.close(r));
 assert.deepEqual(await X.exchangeConnection({backendUrl:`http://127.0.0.1:${port}`,credential:'c',client}),{kind:'unavailable',reason:'transport',detail:'TypeError (ECONNREFUSED)'});
});

test('connection file: vLe sealed with key (0600) / plain without; RLe opens sealed only with the key',async t=>{
 const d=dir(t);const env={SAND_DATA_ROOT:d};const file=path.join(d,'local-exec-daemon-connection.json');
 await C.writeConnection({baseUrl:'http://gw',token:undefined,headers:{'x-anyrun-port-token':'p'}},KEY,env);
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(raw.sandSealedFile,1);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.deepEqual(await C.loadConnection(env,KEY),{baseUrl:'http://gw',headers:{'x-anyrun-port-token':'p'}});
 assert.equal(await C.loadConnection(env,null),null);
 assert.equal(await C.loadConnection(env,Buffer.alloc(32,9).toString('base64')),null);
 await C.writeConnection({baseUrl:'http://plain',token:'t'},null,env);
 assert.equal(fs.readFileSync(file,'utf8'),'{"baseUrl":"http://plain","token":"t"}');
 assert.deepEqual(await C.loadConnection(env,KEY),{baseUrl:'http://plain',token:'t'});
 fs.writeFileSync(file,'{"baseUrl":""}');assert.equal(await C.loadConnection(env,KEY),null);
});

function fakeClock(){const timers=[];return{timers,schedule(ms,fn){const t={ms,fn,done:false};timers.push(t);return{dispose(){t.done=true}}},
 live(){return timers.filter(t=>!t.done)}}}
async function settle(){for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r))}

test('Box runLoop: onConnectionStale after Cwr=3 consecutive failed dials, counter reset, failure logged with xt',async t=>{
 const clock=fakeClock();let dials=0,stale=0;const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));
 const p=new BoxProvider({root:dir(t),computerId:'synthetic',label:'lab',variant:'sand-dev',permission:'always',sidecar:()=>undefined,clock,
  resolveConnection:async()=>{dials++;throw Object.assign(new Error('nope'),{name:'SandLocalExecConnectionError'})},
  onConnectionStale:async()=>{stale++;if(stale===2)throw Object.assign(new Error('x'),{code:'EACCES'})}});
 t.after(async()=>{console.error=orig;await p.stop()});
 const running=p.start();
 const fireBackoff=async()=>{await settle();const b=clock.live().find(x=>x.ms!==15000);assert.ok(b,'backoff timer');b.done=true;b.fn();await settle()};
 for(let i=1;i<=6;i++){await settle();assert.equal(dials,i);assert.equal(stale,Math.floor(i/3));await fireBackoff()}
 assert.ok(errs.includes('[local-exec-provider] stale-connection re-resolve failed: Error (EACCES)'),errs.join('\n'));
 void running;
});

// ---------------- Obsidian ----------------
function vaultSetup(t,{gate=true,vault=true}={}){
 const root=dir(t),v=path.join(dir(t),'Vault');fs.mkdirSync(v);
 if(gate)fs.writeFileSync(path.join(root,'mac-device-tools-gate.json'),JSON.stringify({isOn:true}));
 if(vault)fs.writeFileSync(path.join(root,'obsidian-vault.json'),JSON.stringify({path:v}));
 return{root,v};
}
test('Ipt gate + vault discovery (QR / ypt): offered only with gate isOn===true and an existing vault directory',async t=>{
 const logs=[];const log=m=>logs.push(m);
 for(const [opts,expect] of [[{},true],[{gate:false},false],[{vault:false},false]]){
  const {root}=vaultSetup(t,opts);const o=O.obsidianTools({rootDir:()=>root,log});await o.refresh();
  assert.equal(o.offers('mac_read_obsidian'),expect);assert.deepEqual(o.announced().map(x=>x.toolId),expect?['mac_read_obsidian','mac_write_obsidian']:[]);
 }
 const {root}=vaultSetup(t);fs.writeFileSync(path.join(root,'mac-device-tools-gate.json'),'{"isOn":"yes"}');
 const o=O.obsidianTools({rootDir:()=>root,log});await o.refresh();assert.equal(o.offers('mac_read_obsidian'),false);
 fs.writeFileSync(path.join(root,'mac-device-tools-gate.json'),'{"isOn":true}');
 fs.writeFileSync(path.join(root,'obsidian-vault.json'),'{"path":"/x","extra":1}');await o.refresh();
 assert.equal(o.offers('mac_read_obsidian'),false);assert.ok(logs.includes('obsidian vault config read failed: invalid schema'));
 fs.writeFileSync(path.join(root,'obsidian-vault.json'),'{');await o.refresh();assert.ok(logs.includes('obsidian vault config read failed: SyntaxError'));
 assert.deepEqual(await o.run({toolId:'mac_read_obsidian',inputJson:'{}'}),{status:'failed',error:O.NO_VAULT});
});

test('Obsidian read/write (bpt/Apt): list, query, id read, create in new folder, title taken, append newline, refusals',async t=>{
 const {root,v}=vaultSetup(t);const o=O.obsidianTools({rootDir:()=>root});await o.refresh();
 fs.mkdirSync(path.join(v,'Projects'));fs.writeFileSync(path.join(v,'Projects','Plan.md'),'alpha body');fs.writeFileSync(path.join(v,'Inbox.md'),'Σ word');
 fs.writeFileSync(path.join(v,'.hidden.md'),'x');fs.writeFileSync(path.join(v,'notes.txt'),'x');
 fs.utimesSync(path.join(v,'Inbox.md'),new Date(2000),new Date(2000_000));fs.utimesSync(path.join(v,'Projects','Plan.md'),new Date(1000),new Date(1000_000));
 const run=async(tool,input)=>{const r=await o.run({toolId:tool,inputJson:typeof input==='string'?input:JSON.stringify(input)});return r.status==='done'?JSON.parse(r.outputJson):r};
 const list=await run('mac_read_obsidian',{});
 assert.deepEqual(list.notes.map(n=>[n.id,n.title,n.folder,n.snippet]),[['Inbox.md','Inbox','','Σ word'],['Projects/Plan.md','Plan','Projects','alpha body']]);
 assert.equal(list.truncated,false);
 assert.deepEqual((await run('mac_read_obsidian',{limit:1})).truncated,true);
 assert.deepEqual((await run('mac_read_obsidian',{query:' ALPHA '})).notes.map(n=>n.id),['Projects/Plan.md']);
 assert.deepEqual((await run('mac_read_obsidian',{query:'σ'})).notes.map(n=>n.id),['Inbox.md']);
 assert.deepEqual((await run('mac_read_obsidian',{folder:'Projects'})).notes.map(n=>n.id),['Projects/Plan.md']);
 const one=await run('mac_read_obsidian',{id:'Projects/Plan.md'});
 assert.deepEqual({...one.note,modifiedAt:undefined},{id:'Projects/Plan.md',title:'Plan',folder:'Projects',modifiedAt:undefined,body:'alpha body',bodyTruncated:false});
 assert.deepEqual(await run('mac_read_obsidian',{id:'x.md',limit:2}),{status:'failed',error:O.INPUT_INVALID});
 assert.deepEqual(await run('mac_read_obsidian','nope'),{status:'failed',error:O.INPUT_NOT_JSON});
 assert.deepEqual(await run('mac_read_obsidian',{id:'../x.md'}),{status:'failed',error:O.OUTSIDE_VAULT});
 assert.deepEqual(await run('mac_read_obsidian',{id:'Missing.md'}),{status:'failed',error:O.NOTE_MISSING});
 assert.deepEqual(await run('mac_read_obsidian',{id:'notes.txt'}),{status:'failed',error:O.NOTE_MISSING});
 const created=await run('mac_write_obsidian',{title:' Idea ',body:'first',folder:'New/Sub'});
 assert.deepEqual(created,{action:'created',note:{id:'New/Sub/Idea.md',title:'Idea',folder:'New/Sub'}});
 assert.equal(fs.readFileSync(path.join(v,'New','Sub','Idea.md'),'utf8'),'first');
 assert.deepEqual(await run('mac_write_obsidian',{title:'Idea.md',body:'again',folder:'New/Sub'}),{status:'failed',error:O.TITLE_TAKEN});
 assert.deepEqual(await run('mac_write_obsidian',{title:'.x',body:'b'}),{status:'failed',error:O.BAD_TITLE});
 assert.deepEqual(await run('mac_write_obsidian',{id:'New/Sub/Idea.md',currentTitle:'Wrong',body:'b'}),{status:'failed',error:O.TITLE_MISMATCH});
 assert.deepEqual(await run('mac_write_obsidian',{id:'New/Sub/Idea.md',currentTitle:'Idea',body:'second'}),{action:'appended',note:{id:'New/Sub/Idea.md',title:'Idea',folder:'New/Sub'}});
 assert.equal(fs.readFileSync(path.join(v,'New','Sub','Idea.md'),'utf8'),'first\nsecond');
 assert.deepEqual(await run('mac_write_obsidian',{id:'a.md',body:'b'}),{status:'failed',error:O.INPUT_INVALID});
 fs.symlinkSync(os.tmpdir(),path.join(v,'Link'));
 assert.deepEqual(await run('mac_write_obsidian',{title:'T',body:'b',folder:'Link'}),{status:'failed',error:O.OUTSIDE_VAULT});
 fs.rmSync(v,{recursive:true});
 assert.deepEqual(await run('mac_read_obsidian',{}),{status:'failed',error:O.VAULT_GONE});
});

test('UC hello local tools and device branch: Obsidian announced in mobileLocalTools; accepted → result; Never → Xh',async t=>{
 const {root}=vaultSetup(t);const dev=L.createDeviceTools({rootDir:()=>root});
 const snap=await L.localToolsSnapshot(new L.ComputerUse(),dev);
 assert.deepEqual(snap,{computerUse:[],device:[{toolId:'mac_read_obsidian',state:'ready'},{toolId:'mac_write_obsidian',state:'ready'}]});
 assert.deepEqual(L.helloLocalToolCapabilities(snap,dev),{mobileLocalTools:[{toolId:'mac_read_obsidian',state:'ready',features:[]},{toolId:'mac_write_obsidian',state:'ready',features:[]}],consent:false});
 const frames=[];const entry={cancelled:false,cancel(){}};
 await L.handleLocalTool('r1',{toolId:'mac_read_obsidian',inputJson:'{}',conversationId:''},entry,f=>frames.push(f),new L.ComputerUse(),{tools:dev,blocked:async()=>undefined});
 assert.deepEqual(frames.map(f=>f.kind),['local-tool-accepted','local-tool-result']);
 assert.deepEqual(JSON.parse(frames[1].outcome.outputJson),{notes:[],truncated:false});
 frames.length=0;
 await L.handleLocalTool('r2',{toolId:'mac_write_obsidian',inputJson:'{}',conversationId:''},entry,f=>frames.push(f),new L.ComputerUse(),{tools:dev,blocked:async()=>'NEVER'});
 assert.deepEqual(frames,[{kind:'local-tool-accepted',requestId:'r2'},{kind:'local-tool-result',requestId:'r2',outcome:{status:'failed',error:'NEVER'}}]);
 frames.length=0;
 await L.handleLocalTool('r3',{toolId:'mac_read_obsidian',inputJson:'{}',conversationId:''},{cancelled:true,cancel(){}},f=>frames.push(f),new L.ComputerUse(),{tools:dev,blocked:async()=>undefined});
 assert.equal(frames[1].outcome.error,require('../dist/box/messages-op').CANCELLED_BEFORE_START);
});

// ---------------- cp ----------------
test('cp (D:80591): FIFO lock per resolved path, fsync before rename, mode rules, temp cleanup',async t=>{
 const d=dir(t);const f=path.join(d,'sub','a.json');
 const order=[];const real={fsync:fs.fsync,rename:fs.rename,fchmod:fs.fchmod,open:fs.open};
 fs.fsync=(fd,cb)=>{order.push('fsync');real.fsync(fd,cb)};fs.rename=(a,b,cb)=>{order.push('rename:'+path.basename(a).replace(/\d+$/,'N'));real.rename(a,b,cb)};
 fs.fchmod=(fd,m,cb)=>{order.push('fchmod:'+m.toString(8));real.fchmod(fd,m,cb)};
 const flags=[];fs.open=(p,fl,m,cb)=>{flags.push(fl);real.open(p,fl,m,cb)};
 try{
  const a=W.cp(f,'one');const b=W.cp(path.join(d,'sub','..','sub','a.json'),'two');
  assert.equal(W.cpQueueLength(f),2);
  await Promise.all([a,b]);assert.equal(W.cpQueueLength(f),0);
  assert.equal(fs.readFileSync(f,'utf8'),'two');
  // new file: no mode → no fchmod; the second write re-applies the stat()ed mode (BFt) with fchmod before fsync
  assert.deepEqual(order,['fsync','rename:a.json.N','fchmod:'+(0o100000|(0o666&~process.umask())).toString(8),'fsync','rename:a.json.N']);
 }finally{Object.assign(fs,real)}
 assert.equal(flags[0],W.CP_OPEN_FLAGS);
 const um=process.umask();assert.equal(fs.statSync(f).mode&0o777,0o666&~um);
 fs.chmodSync(f,0o640);await W.cp(f,'three');assert.equal(fs.statSync(f).mode&0o777,0o640);
 await W.cp(f,'four',{mode:0o600});assert.equal(fs.statSync(f).mode&0o777,0o600);
 // symlink target: realpath → the link stays, its target is replaced
 const target=path.join(d,'target.json');fs.writeFileSync(target,'x');const link=path.join(d,'link.json');fs.symlinkSync(target,link);
 await W.cp(link,'via-link');assert.ok(fs.lstatSync(link).isSymbolicLink());assert.equal(fs.readFileSync(target,'utf8'),'via-link');
 // rename failure removes the temp file
 const dirTarget=path.join(d,'isdir');fs.mkdirSync(dirTarget);
 await assert.rejects(W.cp(dirTarget,'x'));assert.deepEqual(fs.readdirSync(d).filter(n=>n.startsWith('isdir.')),[]);
 assert.deepEqual(fs.readdirSync(path.join(d,'sub')),['a.json']);
});
