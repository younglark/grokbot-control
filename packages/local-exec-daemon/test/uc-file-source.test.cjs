// Static evidence only: D:97843–97893 / 136384–136405 / 177287–177389 / 178742–178768.
// All filesystem data and authority records are synthetic. No official package or network.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const pb=require('../dist/generated/aiserver.v1_pb');
const {LocalFileSource,prepareDownload,resolveDownloadPath,UC_FILE_CHUNK_BYTES:M}=require('../dist/uc/file-source');
const {UcReplyLanes,UC_FILE_COPY_STOPPED,closingBudgetMs}=require('../dist/uc/reply-lanes');
const {UserComputerProvider,parseQueued}=require('../dist/uc/provider');
const {downloadRefusal,describeDownload}=require('../dist/uc/approvals');
const {ASK_MSG,NEVER_MSG}=require('../dist/exec/handlers');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const tick=async()=>{for(let i=0;i<50;i++)await Promise.resolve()};
function dir(t){const root=fs.mkdtempSync('/tmp/uc-file-source-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
const data=(s,last=false)=>({kind:'data',data:Buffer.from(s),last});
const control=id=>new pb.GrokBotUserComputerResponseFrame({requestId:id,frame:{case:'control',value:{messageJson:JSON.stringify({streamClose:{id:1}})}}});
const file=(id,seq,last,bytes=Buffer.from('x'))=>new pb.GrokBotUserComputerResponseFrame({requestId:id,frame:{case:'file',value:{seq,last,data:bytes}}});
const lane=(extra={})=>new UcReplyLanes({canFlush:()=>false,send:async()=>{},reject:()=>{},isCancelled:()=>false,log:()=>{},...extra});
function source(results){let reads=0,closes=0;return{read:async()=>{const next=results[reads++];assert.ok(next,'unexpected read');return await next},close:()=>{closes++},get reads(){return reads},get closes(){return closes}}}
async function collect(source){const out=[];try{for(;;){const r=await source.read();out.push(r);if(r.kind==='error'||r.last)return out}}finally{source.close()}}

test('Ype reads normal/empty/exact/multi-MiB files with 1MiB reads, last and exact bytes',async t=>{
 const root=dir(t);
 for(const size of [0,17,M,M*2+31]){const content=Buffer.alloc(size,0x67),name='s'+size;fs.writeFileSync(path.join(root,name),content);const out=await collect(await prepareDownload(root,name));assert.ok(out.every(r=>r.kind==='data'));assert.ok(out.every(r=>r.data.length<=M));assert.equal(out.at(-1).last,true);assert.equal(out.filter(r=>r.last).length,1);assert.deepEqual(Buffer.concat(out.map(r=>r.data)),content);assert.equal(out.length,Math.max(1,Math.ceil(size/M)))}
});
test('preflight file size refuses; lazy source enforces maxBytes independently; missing/read-error are structured',async t=>{
 const root=dir(t);fs.writeFileSync(path.join(root,'large'),Buffer.alloc(8));await assert.rejects(prepareDownload(root,'large',4),/exceeds Grok Bot/);
 const src=new LocalFileSource(path.join(root,'large'),4);const r=await src.read();assert.equal(r.kind,'error');assert.match(r.error,/exceeds Grok Bot/);src.close();
 const missing=await prepareDownload(root,'missing');const error=await missing.read();assert.equal(error.kind,'error');assert.match(error.error,/ENOENT/);missing.close();
 const directory=await prepareDownload(root,'.');const read=await directory.read();assert.equal(read.kind,'error');assert.match(read.error,/EISDIR/);directory.close();
});
test('n9 refuses lexical/symlink escapes, checks nearest existing ancestor and permits symlinked root',async t=>{
 const root=dir(t),outside=dir(t);fs.writeFileSync(path.join(outside,'x'),'secret synthetic');fs.symlinkSync(outside,path.join(root,'out'));
 await assert.rejects(resolveDownloadPath(root,'../escape'),/outside the allowed/);await assert.rejects(resolveDownloadPath(root,'out/x'),/symlink/);await assert.rejects(resolveDownloadPath(root,'out/missing/leaf'),/symlink/);
 fs.writeFileSync(path.join(root,'in'),'ok');const link=path.join(outside,'root-link');fs.symlinkSync(root,link);assert.equal(await resolveDownloadPath(link,'in'),path.join(link,'in'));
 // Original _ft uses startsWith('..'), including an ordinary '..name' child; do not strengthen/relax here.
 await assert.rejects(resolveDownloadPath(root,'..name'),/outside the allowed/);
});
test('lazy open is shared; close during pending open closes eventual handle, errors structured; close reentry inert',async t=>{
 const gate=defer(),entered=defer();let opens=0,closes=0,closed=false;
 t.mock.method(fsp,'open',async()=>{opens++;entered.resolve();await gate.promise;return{close:async()=>{closes++;closed=true},stat:async()=>{if(closed)throw Error('synthetic closed');return{isFile:()=>true,size:1}},read:async()=>{throw Error('must not read')}}});
 const src=new LocalFileSource('/synthetic/never-open-real');const pending=src.read();await entered.promise;src.close();src.close();gate.resolve();assert.equal((await pending).kind,'error');assert.equal((await src.read()).kind,'error');assert.equal(opens,1);assert.equal(closes,1);
});
test('Ype fills short reads and handles shrinking/growing files using its open-time size, matching original',async t=>{
 let reads=0,closed=0;t.mock.method(fsp,'open',async()=>({stat:async()=>({isFile:()=>true,size:3}),close:async()=>{closed++},read:async(buffer,offset,length)=>{reads++;if(reads<=2){buffer[offset]=reads;return{bytesRead:1}}return{bytesRead:0}}}));
 const src=new LocalFileSource('/synthetic/short');const a=await src.read();assert.deepEqual([...a.data],[1,2]);assert.equal(a.last,false);const b=await src.read();assert.equal(b.data.length,0);assert.equal(b.last,true);src.close();await tick();assert.equal(closed,1);
});
test('oee streams retain stream-only lane, one buffered file, seq order; last frame survives dropStreams',async()=>{
 const next=defer(),src=source([data('a'),next.promise]),l=lane();l.stream('file',src);await tick();assert.equal(src.reads,1);assert.deepEqual([...l.requestIds()],['file']);assert.equal(l.readyCount,1);
 const a=l.take();assert.equal(a[0].frame.value.seq,0);assert.equal(src.reads,2);assert.deepEqual(l.laneOrder(),['file']);assert.equal(l.take().length,0);assert.equal(src.reads,2);
 next.resolve(data('b',true));await tick();assert.equal(src.closes,1);l.dropStreams();const b=l.take();assert.equal(b[0].frame.value.seq,1);assert.equal(b[0].frame.value.last,true);
});
test('dropStreams drops only live attachments, closes once and suppresses late read; completed terminal/control retained',async()=>{
 const late=defer(),running=source([late.promise]),done=source([data('done',true)]),l=lane();l.stream('running',running);l.stream('done',done);l.push([control('exec')]);await tick();l.dropStreams();l.dropStreams();late.resolve(data('late',true));await tick();assert.equal(running.closes,1);assert.equal(done.closes,1);assert.deepEqual(l.take().map(f=>f.requestId),['exec','done']);assert.equal(l.readyCount,0);
});
test('replacement and cancel close old source; identity prevents pending old result/error from entering new lane',async()=>{
 const gate=defer(),old=source([gate.promise]),fresh=source([data('new',true)]),l=lane();l.stream('r',old);l.stream('r',fresh);await tick();gate.resolve({kind:'error',error:'stale'});await tick();assert.equal(old.closes,1);assert.equal(fresh.closes,1);const frames=l.take();assert.equal(frames.length,1);assert.equal(Buffer.from(frames[0].frame.value.data).toString(),'new');assert.equal(frames[0].frame.value.seq,0);
 const late=defer(),cancel=source([late.promise]);l.stream('cancel',cancel);l.drop(id=>id==='cancel');late.resolve(data('late',true));await tick();assert.equal(cancel.closes,1);assert.equal(l.take().length,0);assert.deepEqual([...l.requestIds()],[]);
});
test('structured source error closes attachment and retains retryable fileError through dropStreams',async()=>{
 const src=source([{kind:'error',error:'synthetic EIO'}]),l=lane();l.stream('e',src);await tick();l.dropStreams();const f=l.take()[0];assert.equal(src.closes,1);assert.equal(f.frame.case,'fileError');assert.equal(f.frame.value.error,'synthetic EIO');assert.equal(closingBudgetMs(f),120000);
});
test('batch limits and file fairness still apply to attached reads: 1MiB file bytes, non-file first',async()=>{
 const l=lane(),a=source([{kind:'data',data:Buffer.alloc(M),last:true}]),b=source([{kind:'data',data:Buffer.alloc(M),last:true}]);l.stream('a',a);l.stream('b',b);await tick();l.push([control('exec')]);let batch=l.take();assert.equal(batch[0].requestId,'exec');assert.equal(batch.filter(f=>f.frame.case==='file').length,1);assert.ok(batch.length<=256);l.push([control('exec2')]);batch=l.take();assert.deepEqual(batch.map(f=>f.requestId),['exec2']);assert.equal(l.take()[0].frame.case,'file');
 const many=lane();many.push(Array.from({length:300},(_,i)=>control('c'+i)));assert.equal(many.take().length,256);assert.equal(many.take().length,44);
 const big=lane();big.push(Array.from({length:3},(_,i)=>new pb.GrokBotUserComputerResponseFrame({requestId:'big'+i,frame:{case:'fileError',value:{error:'x'.repeat(3*M)}}})));assert.equal(big.take().length,2);assert.equal(big.take().length,1);
});
test('in-flight Submit retries same generated bytes while at most one file read is ahead; complete in order',async()=>{
 const gate=defer(),entered=defer(),src=source([data('first'),data('last',true)]);let calls=0;const sent=[];
 const l=lane({canFlush:()=>true,sleep:async()=>{},send:async(frames)=>{calls++;sent.push(new pb.SubmitGrokBotUserComputerResponsesRequest({frames}).toBinary());if(calls===1){entered.resolve();await gate.promise;throw Error('synthetic 503')}}});
 l.stream('r',src);await entered.promise;await tick();assert.equal(src.reads,2);assert.equal(src.closes,1);assert.equal(l.readyCount,1);gate.resolve();await l.waitForIdle();assert.equal(calls,3);assert.deepEqual(sent[0],sent[1]);const decoded=sent.map(b=>pb.SubmitGrokBotUserComputerResponsesRequest.fromBinary(b).frames[0]);assert.deepEqual(decoded.map(f=>f.frame.value.seq),[0,0,1]);assert.equal(decoded[2].frame.value.last,true);
});
test('exhausted nonreplayable chunk stops source, discards prefetched chunk, substitutes exact fileError',async()=>{
 const gate=defer(),src=source([data('first'),gate.promise]);let attempts=0;const batches=[];
 const l=lane({canFlush:()=>true,sleep:async()=>{},send:async(frames)=>{batches.push(frames);if(++attempts<=3)throw Error('synthetic exhausted')}});l.stream('r',src);await tick();await l.waitForIdle();assert.equal(attempts,4);assert.equal(src.closes,1);assert.equal(batches[3][0].frame.case,'fileError');assert.equal(batches[3][0].frame.value.error,UC_FILE_COPY_STOPPED);gate.resolve(data('stale',true));await tick();assert.equal(l.readyCount,0);
});
test('single-frame file closing retries preserve identity until 120s budget; expired closing drops, no file-copy replacement',async()=>{
 let now=0,calls=0;const l=lane({now:()=>now,sleep:async()=>{},send:async()=>{calls++;throw Error('synthetic exhausted')}});const f=file('one',0,true);l.submittingSince=0;assert.equal(await l.submit([f],new AbortController().signal),1);assert.equal(calls,3);assert.equal(l.take()[0],f);
 now=120000;assert.equal(await l.submit([f],new AbortController().signal),0);assert.equal(calls,6);assert.equal(l.readyCount,0);
});
test('cancel in-flight file Submit aborts all-cancelled batch, drops source/late read without replacement',async()=>{
 const gate=defer(),entered=defer(),src=source([data('first'),gate.promise]);let cancelled=false,signal;
 const l=lane({canFlush:()=>true,isCancelled:()=>cancelled,send:async(frames,s)=>{signal=s;entered.resolve();await new Promise((resolve,reject)=>s.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))}});l.stream('r',src);await entered.promise;cancelled=true;l.drop(id=>id==='r');await l.waitForIdle();assert.equal(signal.aborted,true);assert.equal(src.closes,1);gate.resolve(data('late',true));await tick();assert.equal(l.readyCount,0);
});

const envOwners=new WeakSet();
function provider(t,{permission='always',ceiling,sa=false}={}){
 const root=dir(t);if(!envOwners.has(t)){envOwners.add(t);const prior=process.env.SAND_DATA_ROOT;t.after(()=>{if(prior===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=prior})}process.env.SAND_DATA_ROOT=root;
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:permission,...(ceiling?{localToolPermissionCeiling:ceiling}:{})}));
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic',root,permission,accountScope:'A',hello:{label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:permission,supervised:true,variant:'synthetic',serverAuthoritative:sa}});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic'};p.proven=true;
 const frames=[],waiters=[];let withdraws=0;p.client={submitGrokBotUserComputerResponses:async(req)=>{frames.push(...pb.SubmitGrokBotUserComputerResponsesRequest.fromBinary(new pb.SubmitGrokBotUserComputerResponsesRequest(req).toBinary()).frames);for(const w of waiters)if(frames.length>=w.n)w.resolve();return{acceptedCount:req.frames.length}},withdrawGrokBotUserComputerPresence:async()=>{withdraws++}};
 p.replies=lane({canFlush:()=>!p.closing&&p.proven,send:async(batch)=>p.client.submitGrokBotUserComputerResponses({frames:batch})});
 t.after(()=>p.beginShutdown());
 return{p,root,frames,get withdraws(){return withdraws},wait:async n=>{if(frames.length>=n)return;await new Promise(resolve=>waiters.push({n,resolve}))}};
}
function queued(file,extra={}){return parseQueued(new pb.GrokBotUserComputerQueuedRequest({id:'qid',frame:{requestId:'r',frame:{case:'download',value:{path:file,...extra}}}}))}
test('frozen outer download mapping keeps approval precedence; UC end-to-end small/empty/multi chunks, no exec id/control', {timeout:10000},async t=>{
 for(const size of [0,9,2*M+19]){const e=provider(t);fs.writeFileSync(path.join(e.root,'f'),Buffer.alloc(size,0x73));const q=queued('f',{authorizedByApproval:true,authorizedByStanding:true,approvalId:'synthetic'});assert.equal(q.path,'f');assert.deepEqual(q.authorization,{kind:'approval'});await e.p.handleQueued(q);await e.wait(Math.max(1,Math.ceil(size/M)));await e.p.replies.waitForIdle();assert.ok(e.frames.every(f=>f.frame.case==='file'));assert.deepEqual(Buffer.concat(e.frames.map(f=>f.frame.value.data)),Buffer.alloc(size,0x73));assert.deepEqual(e.frames.map(f=>f.frame.value.seq),e.frames.map((_,i)=>i));assert.equal(e.frames.at(-1).frame.value.last,true)}
});
test('download authorization matrix: no default allow, non-SA ignores flags; ceiling, matching/retired/scope/SA behavior',async t=>{
 const root=dir(t),ap=path.join(root,'approvals.json'),rp=path.join(root,'retired.json'),none=path.join(root,'missing');fs.writeFileSync(ap,JSON.stringify({approvals:[{id:'a',action:'read-file',target:'f',accountScope:'A'}]}));
 const base={permission:'ask',serverAuthoritative:false,authorization:{kind:'none'},file:'f',terminalsFolder:root,approvalsPath:ap,retirementsPath:rp};assert.deepEqual(describeDownload('f'),{action:'read-file',target:'f',attachToResourcePath:'f'});
 for(const permission of ['never','ask','always'])for(const ceiling of [undefined,'never','ask','always'])for(const approved of [false,true]){const rank={never:0,ask:1,always:2},effective=ceiling&&rank[ceiling]<rank[permission]?ceiling:permission;const r=await downloadRefusal({...base,permission:effective,ceiling,approvalId:approved?'a':undefined,authorization:{kind:'approval'}});assert.equal(r,ceiling==='never'?NEVER_MSG:approved||effective==='always'?undefined:effective==='never'?NEVER_MSG:ASK_MSG)}
 const sa={...base,serverAuthoritative:true,permission:'never',ceiling:'never',accountScope:'A'};
 assert.equal(await downloadRefusal({...sa,authorization:{kind:'approval'}}),undefined);assert.equal(await downloadRefusal({...sa,authorization:{kind:'standing'}}),undefined);assert.equal(await downloadRefusal(sa),ASK_MSG);assert.equal(await downloadRefusal({...sa,approvalId:'a'}),undefined);assert.equal(await downloadRefusal({...sa,approvalId:'a',accountScope:'B'}),ASK_MSG);assert.equal(await downloadRefusal({...base,approvalId:'a',file:'other'}),ASK_MSG);fs.writeFileSync(rp,JSON.stringify({retiredIds:['a']}));assert.equal(await downloadRefusal({...base,approvalId:'a'}),ASK_MSG);assert.equal(await downloadRefusal({...base,approvalId:'a',approvalsPath:none}),ASK_MSG);
});
test('UC refusal occurs before path/open/attachment; SA allowed download still refuses root escape and missing file errors', {timeout:10000},async t=>{
 const deny=provider(t,{permission:'ask'});await deny.p.handleQueued(queued('../outside',{authorizedByApproval:true}));await deny.wait(1);assert.equal(deny.frames[0].frame.case,'fileError');assert.equal(deny.frames[0].frame.value.error,ASK_MSG);
 const allow=provider(t,{permission:'never',ceiling:'never',sa:true});await allow.p.handleQueued(queued('../outside',{authorizedByApproval:true}));await allow.wait(1);assert.match(allow.frames[0].frame.value.error,/outside the allowed/);
 await allow.p.handleQueued(queued('missing',{authorizedByApproval:true}));await allow.wait(2);assert.equal(allow.frames[1].frame.case,'fileError');assert.match(allow.frames[1].frame.value.error,/ENOENT/);
});
test('provider close drops pending attached source, retains completed file and exec terminal; withdraw explicit only',async t=>{
 for(const withdrawPresence of [false,true]){const e=provider(t);e.p.replies=lane({canFlush:()=>false});const gate=defer(),pending=source([gate.promise]),done=source([data('end',true)]);e.p.replies.stream('pending',pending);e.p.replies.stream('done',done);e.p.replies.push([control('exec')]);await tick();await e.p.stop({withdrawPresence});await e.p.stop({withdrawPresence:true});assert.equal(e.withdraws,withdrawPresence?1:0);assert.equal(pending.closes,1);assert.equal(done.closes,1);assert.deepEqual(e.frames.map(f=>f.requestId),['exec','done']);gate.resolve(data('late',true));await tick();assert.equal(e.p.replies.readyCount,0)}
});
