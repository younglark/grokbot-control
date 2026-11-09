// t131u: offline synthetic tests; original 0.79.3 uee.close D:L178009–178134,
// poll closing admission D:L178543, resolve/rehello D:L178189–178244. No official bundle is executed.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {UserComputerProvider,UC_BACKLOG_CLOSED_BEFORE_START}=require('../dist/uc/provider');
const {UcReplyLanes}=require('../dist/uc/reply-lanes');
const pb=require('../dist/generated/aiserver.v1_pb');
const H=require('../dist/exec/handlers');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve()};
const channel=credential=>({backendUrl:'http://synthetic.invalid',machineId:'synthetic',credential});
function env(t,opts={}){
 const root=fs.mkdtempSync('/tmp/uc-close-channel-'),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:'always'}));
 const p=new UserComputerProvider({backendUrl:'http://synthetic.invalid',machineId:'synthetic',credential:'old',accountScope:'scope-A',root,permission:'always',hello:{label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:'always',supervised:true,variant:'synthetic',serverAuthoritative:false},...opts});
 p.channel=channel('old');p.proven=true;
 const submissions=[],withdraws=[];
 p.client={submitGrokBotUserComputerResponses:async(req,options)=>{submissions.push({req,options});return{acceptedCount:req.frames.length}},withdrawGrokBotUserComputerPresence:async(req,options)=>{withdraws.push({req,options});return{}}};
 const normal=[];p.replies=new UcReplyLanes({canFlush:()=>!p.closing&&!p.closed&&p.proven,send:async(frames)=>{normal.push(frames)},reject:()=>{},isCancelled:id=>p.cancelledIds.has(id)});
 t.after(()=>{p.beginShutdown();if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old;fs.rmSync(root,{recursive:true,force:true})});
 return{p,root,submissions,withdraws,normal};
}
const q=id=>({id:'q-'+id,requestId:id,kind:2,serverMessage:{lsArgs:{path:'/synthetic'}},authorization:{kind:'none'}});
const closeFrame=id=>new pb.GrokBotUserComputerResponseFrame({requestId:id,frame:{case:'control',value:{messageJson:JSON.stringify({streamClose:{id:1}})}}});

test('close has closing then closed; abandons backlog with A9; cancels active and drains its terminal after inflight settles',async t=>{
 const {p,submissions,withdraws}=env(t),work=defer(),cancelled=[];const oldCancel=H.cancelRequest;H.cancelRequest=id=>{cancelled.push(id);return true};t.after(()=>H.cancelRequest=oldCancel);
 p.handleQueued=async task=>{await work.promise;await p.emit({kind:'control',requestId:task.requestId,message:{streamClose:{id:1}}})};
 p.backlog=[q('running')];p.runBacklog();p.backlog=[q('waiting')];
 const stopping=p.stop();await tick();assert.equal(p.closing,true);assert.equal(p.closed,false);assert.deepEqual(cancelled,['running']);assert.equal(p.backlog.length,0);assert.equal(submissions.length,0);
 work.resolve();await stopping;assert.equal(p.closed,true);assert.equal(p.closeDrained,true);assert.equal(withdraws.length,0);
 const frames=submissions.flatMap(s=>s.req.frames);assert.equal(frames.length,2);
 assert.equal(JSON.parse(frames.find(f=>f.requestId==='waiting').frame.value.messageJson).throw.error,UC_BACKLOG_CLOSED_BEFORE_START);
 assert.deepEqual(JSON.parse(frames.find(f=>f.requestId==='running').frame.value.messageJson),{streamClose:{id:1}});
 assert.equal(submissions[0].options.timeoutMs,10000);
});

test('in-flight Poll is awaited: returned exec is ACKed + A9, never dispatched; close drains it before closed',async t=>{
 const {p,submissions}=env(t),poll=defer(),entered=defer();let runs=0;
 p.handleQueued=async()=>{runs++};p.client.pollGrokBotUserComputerRequests=async(req,opts)=>{assert.equal(opts.timeoutMs,10000);entered.resolve();return poll.promise};
 const polling=p.pollOnce();await entered.promise;
 const stopping=p.stop();await tick();assert.equal(p.closed,false);assert.equal(p.pollBusy,true);
 poll.resolve({requests:[new pb.GrokBotUserComputerQueuedRequest({id:'q-late',frame:{requestId:'late',frame:{case:'exec',value:{serverMessageJson:JSON.stringify({lsArgs:{path:'/synthetic'}})}}}})]});
 await polling;await stopping;assert.equal(runs,0);assert.deepEqual(p.pendingAcks,['q-late']);
 assert.equal(JSON.parse(submissions[0].req.frames[0].frame.value.messageJson).throw.error,UC_BACKLOG_CLOSED_BEFORE_START);
});

test('withdraw begins before drain; close reentry resolves immediately, does not repeat or upgrade; first close awaits withdraw last',async t=>{
 const {p}=env(t),poll=defer(),withdraw=defer(),events=[];p.pollBusy=true;
 p.client.withdrawGrokBotUserComputerPresence=async(req,opts)=>{events.push('withdraw');assert.ok(opts.signal instanceof AbortSignal,'withdrawDeadline (g9r 750 ms) signal, D:178031–178049');await withdraw.promise};
 const stop=p.stop({withdrawPresence:true});assert.deepEqual(events,['withdraw']);assert.equal(p.watchStopped,true);assert.equal(p.closed,false);
 let firstDone=false;stop.then(()=>firstDone=true);await p.stop({withdrawPresence:true});assert.equal(firstDone,false);
 p.pollBusy=false;p.onPollIdle();await tick();assert.equal(p.closed,true);assert.equal(firstDone,false,'withdraw still pending');withdraw.resolve();await stop;
 assert.deepEqual(events,['withdraw']);
});

test('default close leaves Watch until final closed/abort; reentrant explicit withdraw does not upgrade default',async t=>{
 const {p,withdraws}=env(t);p.pollBusy=true;p.abortController=new AbortController();const originalAbort=p.abortController;
 const stop=p.stop();await tick();assert.equal(p.watchStopped,false);assert.equal(originalAbort.signal.aborted,false);await p.stop({withdrawPresence:true});assert.equal(withdraws.length,0);
 p.pollBusy=false;p.onPollIdle();await stop;assert.equal(originalAbort.signal.aborted,true);assert.equal(withdraws.length,0);
});

test('normal Submit in flight is not aborted by close; late terminal is sent once on control path',async t=>{
 const {p,submissions}=env(t),send=defer();let signal,attempts=0;
 p.replies=new UcReplyLanes({send:async(frames,s)=>{attempts++;signal=s;await send.promise},reject:()=>{},isCancelled:()=>false});
 p.replies.push([closeFrame('already-submitting')]);const flushing=p.replies.flush();await tick();
 const stop=p.stop();await tick();assert.equal(signal.aborted,false);assert.equal(p.closed,false);
 await p.emit({kind:'control',requestId:'late-terminal',message:{streamClose:{id:2}}});assert.equal(attempts,1);
 send.resolve();await flushing;await stop;assert.equal(attempts,1);assert.equal(submissions.length,1);assert.equal(submissions[0].req.frames[0].requestId,'late-terminal');
});

test('close single control attempt drops failed batch without applying normal retry budgets; unproven close sends nothing',async t=>{
 const {p}=env(t);let attempts=0;p.replies.push([closeFrame('failed')]);p.client.submitGrokBotUserComputerResponses=async()=>{attempts++;throw Error('synthetic EIO')};
 await p.stop();assert.equal(attempts,1);assert.equal(p.replies.readyCount,0);
 // Normal retry budgets and cancel terminal policy remain covered by the existing reply-lane suite.
});

test('unproven close keeps queued frames and does not claim a Submit',async t=>{
 const {p,submissions}=env(t);p.proven=false;p.replies.push([closeFrame('held')]);await p.stop();assert.equal(submissions.length,0);assert.equal(p.replies.readyCount,1);
});

test('rehello resolves fresh channel, rotates while retaining ACK state, missing channel abandons work, fixed SA is unchanged',async t=>{
 let live=channel('new');const {p}=env(t,{resolveChannel:async()=>live});p.pendingAcks=['ack'];p.backlog=[q('queued')];
 await p.rehelloIfChanged();assert.equal(p.channel.credential,'new');assert.deepEqual(p.pendingAcks,['ack']);assert.equal(p.backlog.length,1);assert.equal(p.serverAuthoritative,false);assert.equal(p.proven,false);
 live=null;await p.rehelloIfChanged();assert.equal(p.channel,null);assert.equal(p.backlog.length,0);assert.equal(p.serverAuthoritative,false);assert.equal(p.replies.readyCount,1);
});

test('runLoop resolves at each entry rather than constructor snapshot',async t=>{
 let calls=0;const {p}=env(t,{resolveChannel:async()=>{calls++;return channel('fresh-'+calls)}});const observed=[];
 p.watchLoop=async()=>{observed.push(p.channel.credential);p.closed=true};await p.start();assert.deepEqual(observed,['fresh-1']);assert.equal(calls,1);
});


test('close poll and inflight wait each use the fixed 10s control deadline, not old 1s/1500ms drain budget',async t=>{
 const {p}=env(t);t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());
 p.pollBusy=true;p.active.add('stuck-synthetic');
 const stop=p.stop();await tick();t.mock.timers.tick(9999);await tick();assert.equal(p.closed,false);
 t.mock.timers.tick(1);await tick();assert.equal(p.closed,false,'inflight drain has its own deadline');
 t.mock.timers.tick(9999);await tick();assert.equal(p.closed,false);t.mock.timers.tick(1);await stop;assert.equal(p.closed,true);
});

test('a stale in-flight Poll cannot ACK or admit results after channel rotation',async t=>{
 const {p}=env(t),poll=defer(),entered=defer();p.pendingAcks=['prior-ack'];
 p.client.pollGrokBotUserComputerRequests=async()=>{entered.resolve();return poll.promise};
 const running=p.pollOnce();await entered.promise;p.channel=channel('rotated');
 poll.resolve({requests:[new pb.GrokBotUserComputerQueuedRequest({id:'must-not-ack',frame:{requestId:'late',frame:{case:'exec',value:{serverMessageJson:'{}'}}}})]});await running;
 assert.deepEqual(p.pendingAcks,['prior-ack']);assert.equal(p.seen.size,0);assert.equal(p.active.size,0);
});


test('current credential rejection clears proven so close cannot submit; stale rejection does not close rotated channel',async t=>{
 const {p,submissions}=env(t);const old=p.channel;p.channel=channel('new');p.rejectCredential(old);assert.equal(p.proven,true);assert.equal(p.credentialRejected,false);
 p.rejectCredential(p.channel);assert.equal(p.proven,false);assert.equal(p.credentialRejected,true);p.replies.push([closeFrame('unsent')]);await p.stop();assert.equal(submissions.length,0);
});


test('cancel drops old lane before executor cancellation: a synchronous cancel terminal must survive',async t=>{
 const {p}=env(t);p.proven=true;p.replies.flush=async()=>{};/* poll needs proven (D:178448); keep the lane unflushed */const previous=H.cancelRequest;const order=[];
 H.cancelRequest=id=>{order.push('cancel');void p.emit({kind:'control',requestId:id,message:{streamClose:{id:7}}});return true};t.after(()=>H.cancelRequest=previous);
 const drop=p.replies.drop.bind(p.replies);p.replies.drop=(...args)=>{order.push('drop');return drop(...args)};
 p.replies.push([closeFrame('running')]);
 p.client.pollGrokBotUserComputerRequests=async()=>({requests:[new pb.GrokBotUserComputerQueuedRequest({id:'q-cancel',frame:{requestId:'running',frame:{case:'cancel',value:{}}}})]});
 await p.pollOnce();assert.deepEqual(order,['drop','cancel']);assert.deepEqual(p.pendingAcks,['q-cancel']);
 const frames=p.replies.take();assert.equal(frames.length,1,'new cancel terminal is not the stale lane being dropped');
 assert.deepEqual(JSON.parse(frames[0].frame.value.messageJson),{streamClose:{id:7}});
});

test('cancel ordering: in-flight cancelled submit is aborted before terminal enqueue; late terminal drains on close exactly once',async t=>{
 const {p,submissions}=env(t),entered=defer();let inSignal;let aborted=false;const previous=H.cancelRequest;
 p.replies=new UcReplyLanes({canFlush:()=>!p.closing,send:async(frames,signal)=>{inSignal=signal;entered.resolve();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled synthetic submit'))},{once:true}))},reject:()=>{},isCancelled:id=>p.cancelledIds.has(id)});
 p.replies.push([closeFrame('running')]);const flushing=p.replies.flush();await entered.promise;
 H.cancelRequest=id=>{assert.equal(inSignal.aborted,true);p.replies.pauseForClose();void p.emit({kind:'control',requestId:id,message:{streamClose:{id:9}}});return true};t.after(()=>H.cancelRequest=previous);
 p.client.pollGrokBotUserComputerRequests=async()=>({requests:[new pb.GrokBotUserComputerQueuedRequest({id:'q-cancel',frame:{requestId:'running',frame:{case:'cancel',value:{}}}})]});
 await p.pollOnce();await flushing;assert.equal(aborted,true);await p.stop();
 const frames=submissions.flatMap(s=>s.req.frames);assert.equal(frames.length,1);assert.deepEqual(JSON.parse(frames[0].frame.value.messageJson),{streamClose:{id:9}});
});


test('cancel B does not erase the retained terminal from previously cancelled A',async t=>{
 const {p}=env(t);p.proven=true;p.replies.flush=async()=>{};/* poll needs proven (D:178448); keep the lane unflushed */const previous=H.cancelRequest;H.cancelRequest=id=>{void p.emit({kind:'control',requestId:id,message:{streamClose:{id:id==='A'?1:2}}});return true};t.after(()=>H.cancelRequest=previous);
 p.client.pollGrokBotUserComputerRequests=async()=>({requests:['A','B'].map(id=>new pb.GrokBotUserComputerQueuedRequest({id:'cancel-'+id,frame:{requestId:id,frame:{case:'cancel',value:{}}}}))});
 p.replies.push([closeFrame('A'),closeFrame('B')]);await p.pollOnce();
 const frames=p.replies.take();assert.deepEqual(frames.map(f=>f.requestId),['A','B']);assert.deepEqual(frames.map(f=>JSON.parse(f.frame.value.messageJson)),[{streamClose:{id:1}},{streamClose:{id:2}}]);
});

test('mixed Submit only aborts once every submitted id is cancelled, without dropping earlier cancel terminals',async t=>{
 const {p,submissions}=env(t),entered=defer();let signal;const previous=H.cancelRequest;const aborts=[];
 p.replies=new UcReplyLanes({send:async(frames,s)=>{signal=s;entered.resolve();await new Promise((resolve,reject)=>s.addEventListener('abort',()=>reject(Error('synthetic cancel')),{once:true}))},reject:()=>{},isCancelled:id=>p.cancelledIds.has(id)});
 p.replies.push([closeFrame('A'),closeFrame('B')]);const flushing=p.replies.flush();await entered.promise;
 H.cancelRequest=id=>{aborts.push(signal.aborted);p.replies.pauseForClose();void p.emit({kind:'control',requestId:id,message:{streamClose:{id:5}}});return true};t.after(()=>H.cancelRequest=previous);
 p.client.pollGrokBotUserComputerRequests=async()=>({requests:['A','B'].map(id=>new pb.GrokBotUserComputerQueuedRequest({id:'cancel-'+id,frame:{requestId:id,frame:{case:'cancel',value:{}}}}))});
 await p.pollOnce();await flushing;assert.deepEqual(aborts,[false,true]);await p.stop();
 assert.deepEqual(submissions.flatMap(s=>s.req.frames).map(f=>f.requestId),['A','B']);
});


test('UC pull consumer completes before pending Submit; stop/reentry preserves retry and drains new terminal once',async t=>{
 const {p,root,submissions,withdraws}=env(t),entered=defer(),gate=defer();let attempts=0,signal;
 p.replies=new UcReplyLanes({canFlush:()=>!p.closing&&!p.closed&&p.proven,send:async(frames,s)=>{attempts++;signal=s;if(attempts===1){entered.resolve();await gate.promise;throw Error('synthetic 503')}},sleep:async()=>{},reject:()=>{},isCancelled:id=>p.cancelledIds.has(id)});
 const task=q('channel-running');task.serverMessage={lsArgs:{path:root}};p.backlog=[task];p.runBacklog();const work=[...p.activeJobs][0];await entered.promise;await work;
 assert.equal(p.active.size,0,'consumer acknowledgement is not network receipt');assert.equal(attempts,1);assert.ok(p.replies.readyCount>=1);
 const stop=p.stop({withdrawPresence:true});await tick();assert.equal(signal.aborted,false);assert.equal(p.closed,false);await p.stop();gate.resolve();await stop;
 assert.equal(attempts,2,'normal in-flight submit retains its retry');assert.equal(withdraws.length,1);
 const terminal=submissions.flatMap(s=>s.req.frames).filter(f=>f.frame.case==='control'&&JSON.parse(f.frame.value.messageJson).streamClose);assert.equal(terminal.length,1);
});
