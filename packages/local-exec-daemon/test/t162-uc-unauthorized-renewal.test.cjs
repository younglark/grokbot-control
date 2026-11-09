// t162: UC unauthorized branch (D:178278–178283), rejectCredential (D:178423), backendReturn early wake (v1t D:176417,
// sleepUnlessBackendReturns D:178334), renew pollAbort (D:178314, pollOnce D:178458–178484), network-change
// (noteNetworkChange D:178295–178313, ut/D9r D:179161, 179448–179456), backend-return marker (He/OLe D:179436, 81014),
// heartbeat poll gate (D:178400), no UC transport size cap (L1t D:177268, k7e D:174740–174748). Synthetic data only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {Code,ConnectError}=require('@connectrpc/connect');
const U=require('../dist/uc/provider');const {UserComputerProvider}=U;
const S=require('../dist/state/standing-signals');
const X=require('../dist/state/connection-exchange');
const {sealJson}=require('../dist/uc/sealed');
const pb=require('../dist/generated/aiserver.v1_pb');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(5)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t162-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
const hello=root=>({label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:'ask',variant:'sand-dev',serverAuthoritative:false,supervised:false});
const H={label:'x',localRoot:'/x',terminalsFolder:'/x/t',standing:'ask',supervised:false,variant:'',serverAuthoritative:false};

/** Fake clock for the provider's fixed-length sleeps/cooldowns: captures setTimeout calls of the given lengths. */
function fakeTimers(t,lengths){
 const real=global.setTimeout,realClear=global.clearTimeout,timers=[];
 global.setTimeout=(fn,ms,...a)=>{if(lengths.includes(ms)){const h={ms,fn,cleared:false,fired:false,unrefd:false,unref(){this.unrefd=true;return this},ref(){return this},hasRef(){return!this.unrefd},fire(){if(!this.cleared&&!this.fired){this.fired=true;fn(...a)}},[Symbol.toPrimitive](){return 0}};timers.push(h);return h}return real(fn,ms,...a)};
 global.clearTimeout=h=>{if(h&&timers.includes(h)){h.cleared=true;return}realClear(h)};
 t.after(()=>{global.setTimeout=real;global.clearTimeout=realClear});
 return {timers,pending:ms=>timers.filter(h=>h.ms===ms&&!h.cleared&&!h.fired)};
}
const hang=signal=>new Promise((_,rej)=>{const f=()=>rej(new ConnectError('aborted',Code.Canceled));if(signal.aborted)f();else signal.addEventListener('abort',f,{once:true})});
/** Scripted client: each Watch call takes the next script; steps are event cases, 'hang', or an Error. */
function scripted(log,watches,extra={}){return{
 watchGrokBotUserComputerRequests:(req,{signal})=>{const steps=watches.shift()??['hang'];log.push({kind:'watch',credential:req.credential});return(async function*(){
  for(const st of steps){if(st==='hang')await hang(signal);else if(st instanceof Error)throw st;else if(typeof st==='object')yield {event:st};else yield {event:{case:st,value:{pendingRequestCount:0}}}}})()},
 submitGrokBotUserComputerResponses:extra.submit??(async req=>{log.push({kind:'submit',credential:req.credential,ids:req.frames.map(f=>f.requestId)});return{acceptedCount:req.frames.length}}),
 pollGrokBotUserComputerRequests:extra.poll??(async req=>{log.push({kind:'poll',ackIds:[...req.ackIds]});return{requests:[]}}),
 withdrawGrokBotUserComputerPresence:async()=>({}),
}}
function env(t){const root=dir(t);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;t.after(()=>{if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});return root}

test('unauthorized (D:178278–178283): channel cleared, proven false, 10 s channelRetry not cut by a backend return; then re-resolve + renewConnection + re-Watch with the rotated credential',{timeout:10000},async t=>{
 const ft=fakeTimers(t,[10000]);const root=env(t);const log=[],events=[],made=[];let cred='synthetic-c1',resolves=0;
 const watches=[[new ConnectError('nope',Code.Unauthenticated)],['connected','hang']];
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'synthetic-c1',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),random:()=>0,
  createClient:u=>{made.push(u);return scripted(log,watches)},resolveChannel:async()=>{resolves++;return{backendUrl:'http://127.0.0.1:1',machineId:'m',credential:cred}},onLoopEvent:e=>events.push(e)});
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));t.after(()=>{console.error=orig});
 const run=p.start();
 await until(()=>ft.pending(10000).length===1);
 assert.deepEqual(events.map(e=>e.kind+(e.reason?':'+e.reason:'')),['disconnected:unauthorized']);
 assert.equal(p.channel,null);assert.equal(p.proven,false);assert.equal(resolves,1);assert.equal(made.length,1,'constructor client only');
 assert.ok(ft.pending(10000)[0].unrefd,'channelRetry timer is unref (qr.schedule, D:78137)');
 p.noteBackendReturn();await delay(20);assert.equal(log.filter(x=>x.kind==='watch').length,1,'channelRetry is a plain sleep, not woken by a backend return');
 cred='synthetic-c2';ft.pending(10000)[0].fire();
 await until(()=>events.some(e=>e.kind==='connected'));
 assert.equal(resolves,2);assert.equal(made.length,2,'channel was undefined → renewConnection');
 assert.deepEqual(log.filter(x=>x.kind==='watch').map(x=>x.credential),['synthetic-c1','synthetic-c2']);
 assert.equal(p.proven,true);
 await p.stop();await Promise.race([run,delay(200)]);
});

test('Submit 401 (D:178734): batch requeued, rejectCredential ends the Watch "unauthorized"; no lane pause — the batch flushes after the next connected',{timeout:10000},async t=>{
 const ft=fakeTimers(t,[10000]);const root=env(t);const log=[],events=[];let n=0;
 const watches=[['connected','hang'],['connected','hang']];
 const submit=async req=>{n++;log.push({kind:'submit',credential:req.credential,ids:req.frames.map(f=>f.requestId)});if(n===1)throw new ConnectError('rejected',Code.Unauthenticated);return{acceptedCount:req.frames.length}};
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'synthetic-c1',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),
  createClient:()=>scripted(log,watches,{submit}),onLoopEvent:e=>events.push(e)});
 const run=p.start();await until(()=>p.proven);
 await p.emit({kind:'control',requestId:'q',message:{throw:{error:'synthetic'}}});
 await until(()=>ft.pending(10000).length===1);
 assert.ok(events.some(e=>e.reason==='unauthorized'));assert.equal(p.replies.failure,undefined,'no credential pause in the lane');
 assert.equal(p.replies.readyCount,1,'batch requeued');assert.equal(n,1,'no retry while proven is false');
 ft.pending(10000)[0].fire();
 await until(()=>n===2);assert.deepEqual(log.filter(x=>x.kind==='submit').map(x=>x.ids),[['q'],['q']]);
 await p.stop();await Promise.race([run,delay(200)]);
});

test('rejectCredential (D:178423): stale channel ignored; between Watches it only clears proven (the next Watch resets the flag); PermissionDenied is not a credential rejection (sgt)',async t=>{
 const root=dir(t);const log=[];
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),createClient:()=>scripted(log,[['connected']])});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c'};p.proven=true;p.pollOnce=async()=>{};
 p.rejectCredential({...p.channel});assert.equal(p.proven,true,'other object = stale channel');
 p.rejectCredential(p.channel);assert.equal(p.proven,false);assert.equal(p.credentialRejected,true);assert.equal(p.abortController,undefined);
 p.client=scripted(log,[['connected']]);assert.equal(await p.watchLoop(H),'lifetime','a rejection before the Watch does not end it');
 // keepalive PermissionDenied → no rejection
 p.proven=true;p.backlog.push({requestId:'bk'});p.noteAdmitted('bk',-1e6);
 p.client={submitGrokBotUserComputerResponses:async()=>{throw new ConnectError('x',Code.PermissionDenied)}};
 await p.sendKeepAlives(1000);assert.equal(p.proven,true);assert.equal(p.credentialRejected,false);
});

test('backendReturn v1t (D:176417–176450) and w8r (D:176402–176416)',async t=>{
 const L=U.backendLooksDown;
 const http503=new ConnectError('HTTP 503',Code.Unavailable);assert.equal(http503.rawMessage,'HTTP 503');assert.equal(L(http503),true);
 assert.equal(L(new ConnectError('HTTP 500',Code.Internal)),false,'500 is not in S8r');
 assert.equal(L(new ConnectError('x',Code.Unavailable,undefined,undefined,Object.assign(new Error('c'),{code:'ECONNREFUSED'}))),true);
 assert.equal(L(new ConnectError('x',Code.Internal,undefined,undefined,Object.assign(new Error('c'),{code:'ECONNREFUSED'}))),true,'errno along the cause chain');
 assert.equal(L(new ConnectError('x',Code.Unavailable,undefined,undefined,Object.assign(new Error('c'),{code:'EACCES'}))),false,'an errno outside _8r decides');
 assert.equal(L(new ConnectError('x',Code.Unavailable)),true);assert.equal(L(new ConnectError('x',Code.Unauthenticated)),false);
 assert.equal(L(new TypeError('fetch failed')),true);
 t.mock.timers.enable({apis:['setTimeout']});
 const b=U.createBackendReturn(()=>0.5);
 let a=b.arm();b.noteBackendReturn();t.mock.timers.tick(5000);assert.equal(a.signal.aborted,false,'not down → no wake');a.dispose();
 b.noteFailure(http503);a=b.arm();b.noteBackendReturn();t.mock.timers.tick(999);assert.equal(a.signal.aborted,false);t.mock.timers.tick(1);assert.equal(a.signal.aborted,true,'random()*g8r = 1000 ms');a.dispose();
 b.noteAnswered();a=b.arm();b.noteBackendReturn();t.mock.timers.tick(5000);assert.equal(a.signal.aborted,false);a.dispose();
 b.noteSilence();b.noteBackendReturn();a=b.arm();t.mock.timers.tick(5000);assert.equal(a.signal.aborted,false,'a return before arm() is not remembered');
 const z=U.createBackendReturn(()=>0);z.noteSilence();const az=z.arm();z.noteBackendReturn();assert.equal(az.signal.aborted,true,'random 0 → at once');
});

test('reconnectBackoff sleep is cut short by a backend return after a backend-down failure (D:178284–178286, 178334)',{timeout:10000},async t=>{
 const ft=fakeTimers(t,[1000,2000]);const root=env(t);const log=[],events=[];
 const watches=[[new ConnectError('HTTP 503',Code.Unavailable)],[new ConnectError('HTTP 503',Code.Unavailable)],['connected','hang']];
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),random:()=>0,
  createClient:()=>scripted(log,watches),onLoopEvent:e=>events.push(e)});
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));t.after(()=>{console.error=orig});
 const run=p.start();
 await until(()=>ft.pending(1000).length===1);assert.equal(log.filter(x=>x.kind==='watch').length,1);
 p.noteBackendReturn();await until(()=>log.filter(x=>x.kind==='watch').length===2);
 assert.equal(ft.pending(1000).length,0,'the 1 s timer was cleared, not fired');
 await until(()=>ft.pending(2000).length===1,2000);// e = 2 → 2000 ms
 ft.pending(2000)[0].fire();await until(()=>events.some(e=>e.kind==='connected'));
 await p.stop();await Promise.race([run,delay(200)]);
});

test('renew aborts the in-flight poll (D:178314 / 178478–178481): acks requeued and the poll is asked again on the new client',{timeout:5000},async t=>{
 const root=dir(t);const log=[];let first=true;
 const oldClient={pollGrokBotUserComputerRequests:(req,{signal})=>{log.push({kind:'old-poll',ackIds:[...req.ackIds]});return hang(signal)}};
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),
  createClient:()=>first?(first=false,oldClient):scripted(log,[])});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c'};p.proven=true;p.pendingAcks=['a1'];p.pollTimer=setInterval(()=>{},1e6);t.after(()=>clearInterval(p.pollTimer));
 const polled=p.pollOnce();await until(()=>p.pollAbort!==undefined);
 p.renew(p.channel,'silent');await polled;
 assert.equal(p.pollAbort,undefined);
 await until(()=>log.some(x=>x.kind==='poll'));assert.deepEqual(log.find(x=>x.kind==='poll').ackIds,['a1'],'acks carried to the new client');
});

test('network-change (D:178295–178313, 178273–178276): Watch ends "network-change" → renew + immediate re-Watch; 30 s cooldown defers a second change',{timeout:10000},async t=>{
 const ft=fakeTimers(t,[30000]);const root=env(t);const log=[],events=[],made=[];
 const watches=[['connected','hang'],['connected','hang']];
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),
  createClient:u=>{made.push(u);return scripted(log,watches)},onLoopEvent:e=>events.push(e)});
 const run=p.start();await until(()=>p.proven);
 p.noteNetworkChange();
 await until(()=>events.filter(e=>e.kind==='connected').length===2);
 assert.deepEqual(events.map(e=>e.kind+':'+(e.reason??e.cause??'')),['connected:','disconnected:network-change','renewed:network-change','connected:']);
 assert.equal(made.length,2,'renew → new client');
 // t171: [0] is the 30 s network-renewal cooldown; [1] is the second Watch's own safety poll (S9r, D:178393; the first Watch's was disposed, D:178418).
 assert.equal(ft.pending(30000).length,2);assert.ok(ft.pending(30000)[0].unrefd);
 p.noteNetworkChange();await delay(30);assert.equal(events.filter(e=>e.kind==='connected').length,2,'held: deferred, Watch not aborted');
 ft.pending(30000)[0].fire();
 await until(()=>events.filter(e=>e.kind==='disconnected').length===2);assert.equal(events.filter(e=>e.reason==='network-change').length,2,'deferred change replayed after the cooldown');
 await p.stop();await Promise.race([run,delay(200)]);
 // between Watches: renew at once + backend return
 const q=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root),createClient:()=>scripted([],[]),onLoopEvent:e=>events.push({q:1,...e})});
 q.channel={backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c'};let woke=0;q.backendReturn.noteBackendReturn=()=>woke++;
 q.noteNetworkChange();assert.ok(events.some(e=>e.q&&e.kind==='renewed'&&e.cause==='network-change'));assert.equal(woke,1);
});

test('standing signals: D9r fingerprint (link-local/internal ignored), first read is the baseline; OLe backend-return marker (plain JSON, sealed → null, at > last)',async t=>{
 const ifs=a=>({lo:[{address:'127.0.0.1',family:'IPv4',internal:true}],eth0:a});
 assert.equal(S.networkFingerprint(ifs([{address:'10.0.0.2',family:'IPv4',internal:false},{address:'169.254.1.1',family:'IPv4',internal:false},{address:'fe80::1',family:'IPv6',internal:false},{address:'2001:db8::1',family:'IPv6',internal:false}])),'eth0|IPv4|10.0.0.2 eth0|IPv6|2001:db8::1');
 let cur=ifs([{address:'10.0.0.2',family:'IPv4',internal:false}]);let changes=0;
 const sig=S.createStandingSignals({startedAt:1000,networkInterfaces:()=>cur,readBackendReturn:async()=>marker});
 sig.networkChange(()=>changes++);sig.networkChange(()=>changes++);assert.equal(changes,0);
 cur=ifs([{address:'10.0.0.3',family:'IPv4',internal:false}]);sig.networkChange(()=>changes++);assert.equal(changes,1);
 cur=ifs([{address:'10.0.0.3',family:'IPv4',internal:false},{address:'169.254.9.9',family:'IPv4',internal:false}]);sig.networkChange(()=>changes++);assert.equal(changes,1,'link-local only change ignored');
 const logs=[];const bad=S.createStandingSignals({startedAt:0,networkInterfaces:()=>{throw Object.assign(new Error('x'),{code:'EPERM'})},log:m=>logs.push(m)});bad.networkChange(()=>changes++);assert.deepEqual(logs,['network interface read failed: Error (EPERM)']);
 let marker=null,wakes=0;await sig.backendReturn(()=>wakes++);marker={at:1000};await sig.backendReturn(()=>wakes++);assert.equal(wakes,0,'at <= startedAt');
 marker={at:1500};await sig.backendReturn(()=>wakes++);await sig.backendReturn(()=>wakes++);assert.equal(wakes,1);
 const d=dir(t),f=path.join(d,S.BACKEND_RETURN_FILE);
 assert.equal(await S.readBackendReturn(f),null);
 fs.writeFileSync(f,JSON.stringify({at:42}));assert.deepEqual(await S.readBackendReturn(f),{at:42});
 fs.writeFileSync(f,sealJson(Buffer.alloc(32,7).toString('base64'),JSON.stringify({at:43})));assert.equal(await S.readBackendReturn(f),null,'no file key → sealed marker unreadable');
 fs.writeFileSync(f,'{nope');assert.equal(await S.readBackendReturn(f),null);
 fs.writeFileSync(f,JSON.stringify({at:'1'}));assert.equal(await S.readBackendReturn(f),null);
 assert.equal(S.backendReturnPath({SAND_DATA_ROOT:d}),f);
});

test('heartbeat polls only when pendingRequestCount > 0 (D:178400); connected/notify always poll',async t=>{
 const root=dir(t);const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root)});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'m',credential:'c'};let polls=0;p.pollOnce=async()=>{polls++};
 p.client=scripted([],[['connected',{case:'heartbeat',value:{pendingRequestCount:0}},{case:'heartbeat',value:{pendingRequestCount:2}},{case:'notify',value:{}}]]);
 // t171: connected → requestPoll + the safety poll's leading tick (D:178391–178395) = 2, heartbeat(2) = 1, notify = 1.
 assert.equal(await p.watchLoop(H),'lifetime');assert.equal(polls,4);
});

test('UC transport has no 8 MiB read cap (L1t sets none; connect default 0xFFFFFFFF, D:174740–174748): a 9 MiB Poll response decodes',{timeout:15000},async t=>{
 const big='x'.repeat(9*1024*1024);const body=Buffer.from(new pb.PollGrokBotUserComputerRequestsResponse({requests:[{id:big}]}).toBinary());
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/proto'});res.end(body)})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections?.();server.close(r)}));
 const root=dir(t);const url=`http://127.0.0.1:${server.address().port}`;
 const p=new UserComputerProvider({backendUrl:url,machineId:'m',credential:'c',root,permission:'ask',client:X.backendClientFromEnv({},'linux'),sidecar:()=>undefined,hello:hello(root)});
 const res=await p.client.pollGrokBotUserComputerRequests({machineId:'m',credential:'c',ackIds:[],limit:64});
 assert.equal(res.requests[0].id.length,big.length);
});
