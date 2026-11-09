// t158: Box data reply lane (D:flush/postBatch), unref'd timers, close semantics; UC local-tool (D:handleLocalTool).
// Synthetic fixtures and local fake peers only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const pb=require('../dist/generated/aiserver.v1_pb');
const {UcReplyLanes}=require('../dist/uc/reply-lanes');
const {UserComputerProvider,parseQueued}=require('../dist/uc/provider');
const {BoxProvider,boxRealClock,describeError}=require('../dist/box/provider');
const L=require('../dist/uc/local-tools');
const M=require('../dist/box/messages-op');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(5)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t158-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
function fakeClock(){const timers=[];return{timers,schedule(ms,fn){const t={ms,fn,done:false};timers.push(t);return{dispose(){t.done=true}}},
 pending(ms){return timers.filter(t=>!t.done&&t.ms===ms)},fire(ms){const t=timers.find(t=>!t.done&&t.ms===ms);if(!t)throw Error('no timer '+ms);t.done=true;t.fn()}}}

async function lane(t,postHandler){
 const data=dir(t),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({version:1,localToolPermission:'always'}));
 const posts=[];
 const server=http.createServer((req,res)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{if(req.method==='GET'){res.writeHead(503);res.end();return}
  const body=JSON.parse(b);posts.push({body,headers:req.headers});postHandler(res,posts.length,body)})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const clock=fakeClock();
 const p=new BoxProvider({connection:{baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-token',headers:{'x-lab':'1'}},root:dir(t),computerId:'synthetic',label:'lab',variant:'lab',permission:'always',sidecar:()=>undefined,clock,heartbeatMs:987654});
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));
 t.after(async()=>{console.error=orig;await p.stop();server.closeAllConnections?.();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 return{p,clock,posts,errs};
}

test('Box data lane: whole outbox is one POST {providerId, frames}; headers per cmt',{timeout:10000},async t=>{
 let release;const gate=new Promise(r=>release=r);
 const b=await lane(t,async(res,n)=>{if(n===1)await gate;res.writeHead(200);res.end('{}')});
 b.p.enqueue({kind:'f',n:1});b.p.enqueue({kind:'f',n:2});b.p.enqueue({kind:'f',n:3});
 await until(()=>b.posts.length===1);release();
 await until(()=>b.posts.length===2);
 assert.deepEqual(b.posts.map(x=>x.body.frames.map(f=>f.n)),[[1],[2,3]]);
 assert.equal(b.posts[0].headers.authorization,'Bearer synthetic-token');assert.equal(b.posts[0].headers['x-lab'],'1');
 assert.equal(b.posts[0].headers['content-type'],'application/json');
});

test('Box data lane: 3 attempts 200 ms apart, then drop with the original log text (xt of H5e)',{timeout:10000},async t=>{
 const b=await lane(t,(res)=>{res.writeHead(500);res.end()});
 b.p.enqueue({kind:'f',n:1});
 await until(()=>b.posts.length===1&&b.clock.pending(200).length===1);b.clock.fire(200);
 await until(()=>b.posts.length===2&&b.clock.pending(200).length===1);b.clock.fire(200);
 await until(()=>b.errs.length===1);
 assert.equal(b.errs[0],'[local-exec-provider] dropping 1-frame response batch after 3 failed POSTs: SandLocalExecResponsePostError (http_500)');
 assert.equal(b.posts.length,3);
 // dropped batch is gone; a later enqueue posts only the new frame (401 does not pause the lane)
 b.p.enqueue({kind:'f',n:2});await until(()=>b.posts.length===4);assert.deepEqual(b.posts[3].body.frames.map(f=>f.n),[2]);
});

test('Box data lane: 120 s deadline per attempt (Gi E0) → DeadlineExceededError after 3 attempts',{timeout:10000},async t=>{
 const b=await lane(t,()=>{/* never answers */});
 b.p.enqueue({kind:'f',n:1});
 for(let i=0;i<3;i++){
  await until(()=>b.posts.length===i+1&&b.clock.pending(120000).length===1);b.clock.fire(120000);
  if(i<2){await until(()=>b.clock.pending(200).length===1);b.clock.fire(200)}
 }
 await until(()=>b.errs.length===1);
 assert.equal(b.errs[0],'[local-exec-provider] dropping 1-frame response batch after 3 failed POSTs: DeadlineExceededError (deadline_exceeded)');
});

test('Box close: flush stops between batches; no drain; default clock timers are unref\'d (qr.schedule)',{timeout:10000},async t=>{
 const b=await lane(t,(res)=>{res.writeHead(200);res.end('{}')});
 await b.p.stop();b.p.enqueue({kind:'f',n:9});await delay(100);assert.equal(b.posts.length,0);
 const realSet=global.setTimeout;let unrefd=0;
 global.setTimeout=(fn,ms)=>{const h=realSet(fn,ms);const u=h.unref.bind(h);h.unref=()=>{unrefd++;return u()};return h};
 try{const d=boxRealClock.schedule(10,()=>{});d.dispose()}finally{global.setTimeout=realSet}
 assert.equal(unrefd,1);
 assert.equal(describeError(Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}})),'TypeError (ECONNREFUSED)');
 assert.equal(describeError('x'),'string');
});

// ---------------- UC local-tool ----------------
function uc(t){
 const root=dir(t),prior=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;t.after(()=>{if(prior===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=prior});
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:'always'}));
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic',root,permission:'always',accountScope:'A',sidecar:()=>undefined,hello:{label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:'always',supervised:true,variant:'synthetic',serverAuthoritative:false}});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic'};p.proven=true;
 const frames=[];p.client={submitGrokBotUserComputerResponses:async(req)=>{frames.push(...req.frames);return{acceptedCount:req.frames.length}},withdrawGrokBotUserComputerPresence:async()=>({})};
 p.replies=new UcReplyLanes({canFlush:()=>!p.closing&&p.proven,send:async(batch)=>p.client.submitGrokBotUserComputerResponses({frames:batch}),reject:()=>{},isCancelled:()=>false,log:()=>{}});
 t.after(()=>p.beginShutdown());
 const of=rid=>frames.filter(f=>f.requestId===rid).map(f=>f.frame.case==='localToolResult'?[f.frame.case,f.frame.value.status,f.frame.value.error]:[f.frame.case,f.frame.value.permissionGranted]);
 return{p,frames,of};
}
const q=(value,requestId='t1')=>parseQueued(new pb.GrokBotUserComputerQueuedRequest({id:'qid-'+requestId,frame:{requestId,frame:{case:'localTool',value}}}));

test('UC v9r localTool intake (toolId/inputJson/conversationId/approvalId)',()=>{
 assert.deepEqual(q({toolId:'computer_click',inputJson:'{}',conversationId:'c',approvalId:'a'}).localTool,{toolId:'computer_click',inputJson:'{}',conversationId:'c',approvalId:'a'});
});

test('UC local-tool on Linux: mail → hke/cse (no accept); unknown/Obsidian → B5e; computer_* → accepted + BL or ewr errors; cancelled → Gl',{timeout:10000},async t=>{
 const a=uc(t);
 const run=async(v,rid)=>{await a.p.handleQueued(q(v,rid));await until(()=>a.of(rid).some(x=>x[0]==='localToolResult'))};
 await run({toolId:'mac_mail_accounts',inputJson:'{}',conversationId:'c'},'m1');
 await run({toolId:'mac_send_mail',inputJson:'{}',conversationId:'c',approvalId:'x'},'m2');
 await run({toolId:'mac_read_obsidian',inputJson:'{}',conversationId:'c'},'o1');
 await run({toolId:'computer_screenshot',inputJson:'{}',conversationId:'c'},'c1');
 await run({toolId:'computer_screenshot',inputJson:'null',conversationId:'c'},'c2');
 await run({toolId:'computer_click',inputJson:'[1]',conversationId:'c'},'c3');
 await run({toolId:'computer_click',inputJson:'{}',conversationId:''},'c4');
 a.p.cancelledIds.add('c5');await run({toolId:'computer_click',inputJson:'{}',conversationId:'c'},'c5');
 assert.deepEqual(a.of('m1'),[['localToolResult','failed','mail_accounts_unavailable']]);
 assert.deepEqual(a.of('m2'),[['localToolResult','failed','mail_send_unavailable']]);
 assert.deepEqual(a.of('o1'),[['localToolResult','failed','This computer has no "mac_read_obsidian" tool.']]);
 const acc=['localToolAccepted',false];
 assert.deepEqual(a.of('c1'),[acc,['localToolResult','failed',L.COMPUTER_USE_UNAVAILABLE]]);
 assert.deepEqual(a.of('c2'),[acc,['localToolResult','failed',L.COMPUTER_USE_UNAVAILABLE]]);
 assert.deepEqual(a.of('c3'),[acc,['localToolResult','failed','The computer_click arguments are not a JSON object.']]);
 assert.deepEqual(a.of('c4'),[acc,['localToolResult','failed','The call names no conversation to run it for.']]);
 assert.deepEqual(a.of('c5'),[acc,['localToolResult','failed',M.CANCELLED_BEFORE_START]]);
 assert.deepEqual(a.p.closingFrame(q({toolId:'x',inputJson:'',conversationId:''},'z'),M.UC_BUSY),{kind:'local-tool-result',requestId:'z',outcome:{status:'failed',error:M.UC_BUSY}});
});

test('UL oneCallAtATime: second call per conversation waits; onStillQueued every 60 s (q6r, leading false); abort → Gl',{timeout:10000},async()=>{
 const clock=fakeClock();let release;const blocked=new Promise(r=>release=r);let calls=0;
 const cu=new L.ComputerUse(clock,async()=>{calls++;if(calls===1)await blocked;return undefined});
 const call={toolId:'computer_wait',inputJson:'{}',conversationId:'c'};
 const first=cu.call(call,{signal:new AbortController().signal,onStillQueued:()=>{}});
 let queued=0;const ac=new AbortController();
 const second=cu.call(call,{signal:ac.signal,onStillQueued:()=>queued++});
 const third=cu.call({...call},{signal:new AbortController().signal,onStillQueued:()=>{}});
 await until(()=>clock.pending(60000).length===2);clock.fire(60000);assert.equal(queued,1);
 await until(()=>clock.pending(60000).length===2);
 ac.abort();
 assert.deepEqual(await second,{status:'failed',error:M.CANCELLED_BEFORE_START});
 release();
 assert.deepEqual(await first,{status:'failed',error:L.COMPUTER_USE_UNAVAILABLE});
 assert.deepEqual(await third,{status:'failed',error:L.COMPUTER_USE_UNAVAILABLE});
 assert.deepEqual(await cu.announcedTools(),[]);
});
