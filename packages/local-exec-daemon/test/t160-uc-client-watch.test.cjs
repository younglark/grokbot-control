// t160: UC Connect mb headers (E9r), provider-built hello capabilities, watch reason classification, plaintext
// credential (RDe), QPe validation + fatal text. Synthetic data and local fake peers only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),cp=require('node:child_process');
const {Code,ConnectError}=require('@connectrpc/connect');
const {UserComputerProvider}=require('../dist/uc/provider');
const X=require('../dist/state/connection-exchange');
const {loadSealedCredential}=require('../dist/uc/credential');
const {sealJson}=require('../dist/uc/sealed');
const KEY=Buffer.alloc(32,5).toString('base64');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(10)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t160-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
const hello=root=>({label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:'ask',variant:'sand-dev',serverAuthoritative:false});

test('E9r: every UC Connect request carries the mb(client) headers; client from env (D:179040, D:79034)',{timeout:10000},async t=>{
 const seen=[];const server=http.createServer((req,res)=>{seen.push({url:req.url,headers:req.headers});req.resume();req.on('end',()=>{res.writeHead(503);res.end()})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r)}));
 const root=dir(t);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;t.after(()=>{if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 const client=X.backendClientFromEnv({SAND_CLIENT_APP_VERSION:'9.8.7'},'linux');
 const p=new UserComputerProvider({backendUrl:`http://127.0.0.1:${server.address().port}`,machineId:'synthetic-machine',credential:'synthetic-cred',root,permission:'ask',client,sidecar:()=>undefined,hello:{...hello(root),supervised:false}});
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));
 const run=p.start();
 try{await until(()=>seen.some(s=>s.url.includes('WatchGrokBotUserComputerRequests')));
  const h=seen.find(s=>s.url.includes('WatchGrokBotUserComputerRequests')).headers;
  for(const [k,v] of Object.entries(X.clientHeaders(client)))assert.equal(h[k],v,k);
  assert.equal(h['x-cursor-client-version'],'9.8.7-dev');assert.equal(h['x-cursor-client-source'],'sand-desktop');
  // the 503 Watch failure is logged with xt and classified as a plain error (not unauthorized)
  await until(()=>errs.some(e=>e.startsWith('[user-computer-provider] watch stream failed: ConnectError')));
 }finally{console.error=orig;await p.stop();await Promise.race([run,delay(200)])}
});

function bare(t,opts={}){
 const root=dir(t);const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),...opts});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c'};
 const events=[];
 return{p,events};
}
// A scripted Watch stream that honours the abort signal like Connect does (ConnectError Canceled).
function script(steps){return{watchGrokBotUserComputerRequests:(req,{signal})=>(async function*(){
 for(const st of steps){
  if(st==='hang'){await new Promise((_,rej)=>{if(signal.aborted)rej(new ConnectError('aborted',Code.Canceled));signal.addEventListener('abort',()=>rej(new ConnectError('aborted',Code.Canceled)),{once:true})})}
  else if(st instanceof Error)throw st;
  else yield {event:{case:st,value:{pendingRequestCount:0}}};
 }})(),submitGrokBotUserComputerResponses:async()=>({acceptedCount:0}),pollGrokBotUserComputerRequests:async()=>({requests:[]})}}

test('watch reasons (D:178342–178420 / 178247–178256): lifetime, unauthorized, error, closed, rehello',{timeout:10000},async t=>{
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));t.after(()=>{console.error=orig});
 const H={label:'x',localRoot:'/x',terminalsFolder:'/x/t',standing:'ask',supervised:false,variant:'',serverAuthoritative:false};
 let {p}=bare(t);p.pollOnce=async()=>{};
 p.client=script(['connected']);assert.equal(await p.watchLoop(H),'lifetime');
 p.client=script([new ConnectError('nope',Code.Unauthenticated)]);assert.equal(await p.watchLoop(H),'unauthorized');
 assert.ok(errs.includes('[user-computer-provider] watch stream failed: ConnectError (unauthenticated)')||errs.some(e=>e.startsWith('[user-computer-provider] watch stream failed: ConnectError')),errs.join('\n'));
 ({p}=bare(t));p.pollOnce=async()=>{};p.client=script([new ConnectError('boom',Code.Unavailable)]);assert.equal(await p.watchLoop(H),'error');
 ({p}=bare(t));p.pollOnce=async()=>{};p.client=script(['connected','hang']);
 let r=p.watchLoop(H);await delay(20);p.rehello();assert.equal(await r,'lifetime');
 ({p}=bare(t));p.pollOnce=async()=>{};p.client=script(['connected','hang']);
 r=p.watchLoop(H);await delay(20);p.rejectCredential(p.channel);assert.equal(await r,'unauthorized');
 ({p}=bare(t));p.pollOnce=async()=>{};p.client=script(['hang']);
 r=p.watchLoop(H);await delay(20);p.closed=true;p.abort.abort();assert.equal(await r,'closed');
});

test('watch watchdogs (xh, unref): connect 35 s → "stall"; silence 15 s after connected → "silent"',{timeout:10000},async t=>{
 const H={label:'x',localRoot:'/x',terminalsFolder:'/x/t',standing:'ask',supervised:false,variant:'',serverAuthoritative:false};
 const real=global.setTimeout;const timers=[];
 global.setTimeout=(fn,ms)=>{if(ms===35000||ms===15000){const h={ms,fn,unrefd:false,unref(){this.unrefd=true;return this},ref(){return this},hasRef(){return!this.unrefd},[Symbol.toPrimitive](){return 0}};timers.push(h);return h}return real(fn,ms)};
 const realClear=global.clearTimeout;global.clearTimeout=h=>{if(h&&timers.includes(h)){h.cleared=true;return}realClear(h)};
 t.after(()=>{global.setTimeout=real;global.clearTimeout=realClear});
 let {p}=bare(t);p.pollOnce=async()=>{};p.client=script(['hang']);
 let r=p.watchLoop(H);await delay(20);
 let w=timers.filter(x=>x.ms===35000&&!x.cleared).at(-1);assert.ok(w&&w.unrefd);w.fn();assert.equal(await r,'stall');
 ({p}=bare(t));p.pollOnce=async()=>{};p.client=script(['connected','hang']);
 r=p.watchLoop(H);await delay(20);
 w=timers.filter(x=>x.ms===15000&&!x.cleared).at(-1);assert.ok(w&&w.unrefd);w.fn();assert.equal(await r,'silent');
});

test('hello capabilities are built by the provider: sidecar → messagesOp + localStandingGrants (D:178151–178172)',async t=>{
 for(const [sidecar,expect] of [[()=>undefined,{messagesOpGeneration:4,aiToolSetup:true,mobileLocalTools:[]}],[()=>'/synthetic/sidecar',{messagesOp:true,localStandingGrants:true,messagesOpGeneration:4,aiToolSetup:true,mobileLocalTools:[]}]]){
  const {p}=bare(t,{sidecar,deviceTools:{announced:()=>[],consentApp:()=>undefined,refresh:async()=>{},helperName:()=>undefined,offers:()=>false}});
  assert.deepEqual(p.withLocalToolCapabilities({ignored:true},{computerUse:[],device:[]}),expect);
 }
});

test('loadSealedCredential (ILe/RDe): plain JSON accepted, sealed needs the key, bad JSON/schema → null',async t=>{
 const d=dir(t);const env={SAND_DATA_ROOT:d};const f=path.join(d,'local-exec-daemon-credential.json');
 const payload={backendUrl:'http://synthetic.invalid',credential:'synthetic-box'};
 fs.writeFileSync(f,JSON.stringify(payload));
 assert.deepEqual(await loadSealedCredential(KEY,env),payload);assert.deepEqual(await loadSealedCredential(null,env),payload);
 fs.writeFileSync(f,sealJson(KEY,JSON.stringify(payload)));
 assert.deepEqual(await loadSealedCredential(KEY,env),payload);assert.equal(await loadSealedCredential(null,env),null);
 assert.equal(await loadSealedCredential(Buffer.alloc(32,1).toString('base64'),env),null);
 fs.writeFileSync(f,'{');assert.equal(await loadSealedCredential(KEY,env),null);
 fs.writeFileSync(f,JSON.stringify({backendUrl:'x'}));assert.equal(await loadSealedCredential(KEY,env),null); // GFt refine
 fs.rmSync(f);assert.equal(await loadSealedCredential(KEY,env),null);
});

test('QPe (D:79103): isolated deployment needs http(s) backend and website URLs; fatal text is xt (D:187341)',async()=>{
 assert.equal(X.validateIsolatedDeployment({}),false);
 assert.throws(()=>X.backendClientFromEnv({SAND_ISOLATED_DEPLOYMENT:'1'}),e=>e.name==='IsolatedDeploymentConfigError'&&/needs SAND_BACKEND_URL or CURSOR_API_BASE_URL/.test(e.message));
 assert.throws(()=>X.backendClientFromEnv({SAND_ISOLATED_DEPLOYMENT:'1',CURSOR_API_BASE_URL:'ftp://x'}),/http\(s\) backend/);
 assert.throws(()=>X.backendClientFromEnv({SAND_ISOLATED_DEPLOYMENT:'1',SAND_BACKEND_URL:'https://api.synthetic.invalid',CURSOR_WEBSITE_URL:''}),/needs SAND_CURSOR_WEBSITE_URL or CURSOR_WEBSITE_URL/);
 assert.equal(X.backendClientFromEnv({SAND_ISOLATED_DEPLOYMENT:'1',SAND_BACKEND_URL:'https://api.synthetic.invalid',CURSOR_WEBSITE_URL:'http://w.synthetic.invalid'},'linux').boxNamespace,'prod');
 const script=`const {exitFatal}=require(${JSON.stringify(path.resolve(__dirname,'../dist/bootstrap/handoff'))});const X=require(${JSON.stringify(path.resolve(__dirname,'../dist/state/connection-exchange'))});try{X.backendClientFromEnv({SAND_ISOLATED_DEPLOYMENT:'1'})}catch(e){exitFatal(e)}`;
 const r=cp.spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
 assert.equal(r.status,1);assert.equal(r.stderr,'[sand-local-exec-daemon] fatal: IsolatedDeploymentConfigError\n');
});
