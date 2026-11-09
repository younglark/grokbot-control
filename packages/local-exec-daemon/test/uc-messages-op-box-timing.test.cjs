// t156: UC messages-op (consent / sendKey / draftCard / replay / cancel / frames) + Box connection constants with a fake clock.
// Synthetic fixtures and local fake peers only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const pb=require('../dist/generated/aiserver.v1_pb');
const {UcReplyLanes,closingBudgetMs}=require('../dist/uc/reply-lanes');
const {UserComputerProvider,parseQueued}=require('../dist/uc/provider');
const {BoxProvider,boxBackoffMs}=require('../dist/box/provider');
const M=require('../dist/box/messages-op');
const {ASK_MSG,NEVER_MSG}=require('../dist/exec/handlers');
const Z2=M.UNSUPPORTED_FRAME;
const V=pb.GrokBotUserComputerMessagesConsentVerdict;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(5)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t156-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}

function uc(t,{settings={version:1,localToolPermission:'always',messagesEnabled:true},sidecar}={}){
 const root=dir(t),prior=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;t.after(()=>{if(prior===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=prior});
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify(settings));
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic',root,permission:settings.localToolPermission,accountScope:'A',sidecar:sidecar??(()=>undefined),hello:{label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:settings.localToolPermission,supervised:true,variant:'synthetic',serverAuthoritative:false}});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic'};p.proven=true;
 const frames=[];p.client={submitGrokBotUserComputerResponses:async(req)=>{frames.push(...req.frames);return{acceptedCount:req.frames.length}},withdrawGrokBotUserComputerPresence:async()=>({})};
 p.replies=new UcReplyLanes({canFlush:()=>!p.closing&&p.proven,send:async(batch)=>p.client.submitGrokBotUserComputerResponses({frames:batch}),reject:()=>{},isCancelled:()=>false,log:()=>{}});
 t.after(()=>p.beginShutdown());
 const of=rid=>frames.filter(f=>f.requestId===rid).map(f=>[f.frame.case,f.frame.value.error??f.frame.value.verdict,f.frame.value.reason]);
 return{p,root,frames,of,wait:n=>until(()=>frames.length>=n),run:async(value,rid='m1')=>{await p.handleQueued(q(value,rid))}};
}
const q=(value,requestId='m1')=>parseQueued(new pb.GrokBotUserComputerQueuedRequest({id:'qid-'+requestId+Math.random(),frame:{requestId,frame:{case:'messagesOp',value}}}));
const op=o=>JSON.stringify(o);
const SEND={kind:'send',to:'+15550001111',text:'hi'};

test('UC v9r messagesOp: AJe schema, T9r sendKey, draftCard authorization; invalid → w9r messages-error z2',()=>{
 const a=q({opJson:op(SEND),approvalId:'ap',sendKey:'k',draftCard:true,authorizedByApproval:true});
 assert.deepEqual(a.messages,{requestId:'m1',op:SEND,approvalId:'ap',sendKey:'k',draftCard:true,authorization:{kind:'approval'}});
 assert.deepEqual(q({opJson:op(SEND),sendKey:'',authorizedByApproval:true}).messages,{requestId:'m1',op:SEND,approvalId:undefined});
 assert.deepEqual(q({opJson:'{bad'}).unsupported,{reply:{kind:'messages-error',requestId:'m1',error:Z2}});
 assert.deepEqual(q({opJson:op({kind:'items',x:1})}).unsupported,{reply:{kind:'messages-error',requestId:'m1',error:Z2}});
 assert.deepEqual(q({opJson:'{bad'},'').unsupported,{});
});

test('UC capability gate: non-consent → messages-error (draftCard → Lpt code); consent send → accepted + REFUSED',{timeout:10000},async t=>{
 const a=uc(t,{settings:{version:1,localToolPermission:'always'}});
 await a.run({opJson:op({kind:'items'})},'r1');await a.run({opJson:op({kind:'items'}),draftCard:true},'r2');
 await a.run({opJson:op(SEND)},'r3');await a.wait(4);
 assert.deepEqual(a.of('r1'),[['messagesError',M.MESSAGES_OFF,undefined]]);
 assert.deepEqual(a.of('r2'),[['messagesError','messages_disabled',undefined]]);
 assert.deepEqual(a.of('r3'),[['messagesAccepted',undefined,undefined],['messagesConsentResult',V.REFUSED,M.MESSAGES_OFF]]);
});

test('UC consent flow (decideLocalUse=Qce): ask → ASK verdict (remembered, replayed); never → REFUSED Xh; standing grant → runs → sidecar_missing',{timeout:10000},async t=>{
 const a=uc(t,{settings:{version:1,localToolPermission:'ask',messagesEnabled:true}});
 await a.run({opJson:op(SEND)},'c1');await a.wait(2);
 assert.deepEqual(a.of('c1'),[['messagesAccepted',undefined,undefined],['messagesConsentResult',V.ASK,undefined]]);
 await a.run({opJson:op(SEND)},'c1');await a.wait(3);
 assert.deepEqual(a.of('c1').slice(2),[['messagesConsentResult',V.ASK,undefined]]);
 fs.writeFileSync(path.join(a.root,'local-tool-standing-grants.v1.json'),JSON.stringify({version:1,grants:[{scope:'subject',action:'send-imessage',accountScope:'A',recipient:'+15550001111',grantedAtMs:0}]}));
 await a.run({opJson:op(SEND)},'c2');await until(()=>a.of('c2').length===2);
 assert.deepEqual(a.of('c2'),[['messagesAccepted',undefined,undefined],['messagesError','sidecar_missing',undefined]]);
 const b=uc(t,{settings:{version:1,localToolPermission:'never',messagesEnabled:true}});
 await b.run({opJson:op(SEND)},'c3');await b.wait(2);
 assert.deepEqual(b.of('c3')[1],['messagesConsentResult',V.REFUSED,NEVER_MSG]);
});

test('UC approvalId send skips consent: isLocalUseBlocked → ASK text / draftCard code; approved → worker validation',{timeout:10000},async t=>{
 const a=uc(t,{settings:{version:1,localToolPermission:'ask',messagesEnabled:true}});
 await a.run({opJson:op(SEND),approvalId:'none'},'p1');await a.run({opJson:op(SEND),approvalId:'none',draftCard:true},'p2');await a.wait(2);
 assert.deepEqual(a.of('p1'),[['messagesError',ASK_MSG,undefined]]);
 assert.deepEqual(a.of('p2'),[['messagesError','messages_local_tools_unapproved',undefined]]);
 fs.writeFileSync(path.join(a.root,'local-tool-approvals.json'),JSON.stringify({version:1,approvals:[{id:'ok',action:'send-imessage',target:'nobody\nhi',recordedAtMs:Date.now()}]}));
 await a.run({opJson:op({kind:'send',to:'nobody',text:'hi'}),approvalId:'ok'},'p3');await a.wait(3);
 assert.deepEqual(a.of('p3'),[['messagesError','send_recipient_invalid',undefined]]);
});

test('UC sendKey: D6r stores only keyable draft-card errors; same key + same op replays under the new requestId',{timeout:10000},async t=>{
 const orig=console.error;const errs=[];console.error=(...x)=>errs.push(x.join(' '));t.after(()=>{console.error=orig});
 const a=uc(t,{sidecar:()=>'/synthetic/Side.app'});
 fs.writeFileSync(path.join(a.root,'local-tool-standing-grants.v1.json'),JSON.stringify({version:1,grants:[{scope:'action',action:'send-imessage',accountScope:'A',grantedAtMs:0}]}));
 await a.run({opJson:op(SEND),sendKey:'K',draftCard:true},'k1');await until(()=>a.of('k1').length===2);
 assert.deepEqual(a.of('k1')[1],['messagesError','helper_send-message_failed',undefined]);
 await a.run({opJson:op(SEND),sendKey:'K',draftCard:true},'k2');await until(()=>a.of('k2').length===1);
 assert.deepEqual(a.of('k2'),[['messagesError','helper_send-message_failed',undefined]]);
 // sidecar_missing is in Wue (JI) → not stored under the key: a new requestId re-runs.
 const b=uc(t);
 fs.writeFileSync(path.join(b.root,'local-tool-standing-grants.v1.json'),JSON.stringify({version:1,grants:[{scope:'action',action:'send-imessage',accountScope:'A',grantedAtMs:0}]}));
 await b.run({opJson:op(SEND),sendKey:'K',draftCard:true},'k3');await b.run({opJson:op(SEND),sendKey:'K',draftCard:true},'k4');
 await until(()=>b.of('k4').length===2);assert.deepEqual(b.of('k4'),[['messagesAccepted',undefined,undefined],['messagesError','sidecar_missing',undefined]]);
 assert.ok(errs.includes('[messages-worker] helper send-message failed: sidecar_missing'));
});

test('UC cancelled before start → Gl / messages_send_cancelled; closing replies use Fpt codes for draft cards',{timeout:10000},async t=>{
 const a=uc(t);
 a.p.cancelledIds.add('x1');a.p.cancelledIds.add('x2');
 await a.run({opJson:op({kind:'items'})},'x1');await a.run({opJson:op({kind:'items'}),draftCard:true},'x2');await a.wait(2);
 assert.deepEqual(a.of('x1'),[['messagesError',M.CANCELLED_BEFORE_START,undefined]]);
 assert.deepEqual(a.of('x2'),[['messagesError','messages_send_cancelled',undefined]]);
 const d=q({opJson:op({kind:'items'}),draftCard:true},'x3');
 assert.deepEqual(a.p.closingFrame(d,M.UC_BUSY),{kind:'messages-error',requestId:'x3',error:'messages_local_exec_busy'});
 assert.deepEqual(a.p.closingFrame(d,'other'),{kind:'messages-error',requestId:'x3',error:'other'});
 assert.deepEqual(a.p.closingFrame(q({opJson:op({kind:'items'})},'x4'),M.UC_BUSY),{kind:'messages-error',requestId:'x4',error:M.UC_BUSY});
});

test('UC lanes: x9r budgets for messages frames; B8r sizes',()=>{
 const F=(c,v)=>new pb.GrokBotUserComputerResponseFrame({requestId:'r',frame:{case:c,value:v}});
 assert.equal(closingBudgetMs(F('messagesConsentResult',{verdict:1})),180000);
 assert.equal(closingBudgetMs(F('messagesResult',{resultJson:'{}'})),180000);
 assert.equal(closingBudgetMs(F('messagesAccepted',{})),undefined);
});

// ---------------- Box connection constants (fake clock) ----------------
function fakeClock(){const timers=[];return{timers,schedule(ms,fn){const t={ms,fn,done:false};timers.push(t);return{dispose(){t.done=true}}},
 pending(ms){return timers.filter(t=>!t.done&&t.ms===ms)},fire(ms){const t=timers.find(t=>!t.done&&t.ms===ms);if(!t)throw Error('no timer '+ms);t.done=true;t.fn()}}}
async function boxServer(t,onGet){
 const data=dir(t),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({version:1,localToolPermission:'always'}));
 const gets=[],streams=[];
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{if(req.method==='GET'){gets.push(req);streams.push(res);onGet(res,gets.length)}else{res.writeHead(200);res.end('{}')}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const s of streams)s.destroy();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 return{gets,streams,url:`http://127.0.0.1:${server.address().port}`};
}
function box(t,s,clock,extra={}){
 const p=new BoxProvider({connection:{baseUrl:s.url,token:'synthetic-token',headers:{}},root:dir(t),computerId:'synthetic',label:'lab',variant:'lab',permission:'always',sidecar:()=>undefined,clock,heartbeatMs:987654,...extra});
 const running=p.start();t.after(async()=>{await p.stop();await Promise.race([running,new Promise(r=>setTimeout(r,50))])});return p;
}

test('Box backoff: 1 s doubling to 10 s (B7t), all statuses retried incl. 401, onConnectionStale after 3 failures (Cwr)',{timeout:15000},async t=>{
 const s=await boxServer(t,(res,n)=>{res.writeHead(n===1?401:500);res.end()});
 const clock=fakeClock();let stale=0;box(t,s,clock,{onConnectionStale:async()=>{stale++}});
 const seen=[];
 for(let i=0;i<6;i++){
  await until(()=>clock.timers.some(x=>!x.done&&x.ms!==15000&&x.ms!==35000));
  const b=clock.timers.find(x=>!x.done&&x.ms!==15000&&x.ms!==35000);seen.push(b.ms);
  if(i===2)assert.equal(stale,1);
  clock.fire(b.ms);
 }
 assert.deepEqual(seen,[1000,2000,4000,8000,10000,10000]);
 assert.equal(stale,2);assert.ok(s.gets.length>=6);
 assert.deepEqual([1,2,3,4,5,6].map(boxBackoffMs),[1000,2000,4000,8000,10000,10000]);
});

test('Box backoff resets to 1 s after a successful connect; normal stream end is not a failure',{timeout:15000},async t=>{
 const s=await boxServer(t,(res,n)=>{if(n<=2){res.writeHead(500);res.end()}else{res.writeHead(200,{'content-type':'text/event-stream'});res.write(':\n\n');res.end()}});
 const clock=fakeClock();box(t,s,clock);
 const next=async()=>{await until(()=>clock.timers.some(x=>!x.done&&[1000,2000,4000].includes(x.ms)));const b=clock.timers.find(x=>!x.done&&[1000,2000,4000].includes(x.ms));clock.fire(b.ms);return b.ms};
 assert.deepEqual([await next(),await next(),await next()],[1000,2000,1000]);
});

test('Box connect deadline 15 s (Rwr) aborts a dial with no response headers; stall watchdog 35 s (Iwr) aborts an idle stream, kicked by data',{timeout:15000},async t=>{
 const s=await boxServer(t,(res,n)=>{if(n===1)return;res.writeHead(200,{'content-type':'text/event-stream'});res.write(':\n\n')});
 const clock=fakeClock();box(t,s,clock);
 await until(()=>s.gets.length===1&&clock.pending(15000).length===1);
 clock.fire(15000);
 await until(()=>clock.pending(1000).length===1);clock.fire(1000);
 await until(()=>s.gets.length===2&&clock.pending(35000).length===1);
 const before=clock.timers.filter(x=>x.ms===35000).length;
 s.streams[1].write(':\n\n');await until(()=>clock.timers.filter(x=>x.ms===35000).length>before);
 assert.equal(clock.pending(35000).length,1);
 clock.fire(35000);
 // stall abort counts as a failed stream → backoff restarts at 1 s (reset happened on connect)
 await until(()=>clock.pending(1000).length===1);clock.fire(1000);
 await until(()=>s.gets.length===3);
});
