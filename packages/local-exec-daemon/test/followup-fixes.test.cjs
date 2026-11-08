'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {loadSettings}=require('../dist/settings');const {UserComputerProvider}=require('../dist/uc/provider');const {ReplyQueue,HttpStatusError}=require('../dist/transport/replies');
const {handleShellStream,shutdownShells}=require('../dist/exec/handlers'); const {resetExecIdCounter}=require('../dist/exec/handlers');
const {startUcFakePeer,SYN_CRED,SYN_MACHINE}=require('./helpers/uc-fake-peer.cjs');const wire=require('./helpers/wire-oracle.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function until(f,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(20)}throw Error('deadline')}
function temp(){return fs.mkdtempSync(path.join(os.tmpdir(),'local-exec-daemon-followup-'))}
function setup(root){fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:'always'}));fs.writeFileSync(path.join(root,'probe.txt'),'oracle-fixture\n')}
function provider(peer,root){return new UserComputerProvider({backendUrl:`http://127.0.0.1:${peer.port()}`,machineId:SYN_MACHINE,credential:SYN_CRED,root,permission:'always',hello:{label:'independent',localRoot:root,terminalsFolder:root,standing:'always',variant:'lab',serverAuthoritative:false}})}
async function cleanup(p,peer,run,root,old){await p.stop({ withdrawPresence: true });await run;await shutdownShells();await peer.close();fs.rmSync(root,{recursive:true,force:true});if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old}
test('ceiling cross-product and unknown fail closed (independent nI truth table)',{timeout:5000},async()=>{
 const root=temp();try{for(const permission of [undefined,'never','ask','always'])for(const ceiling of [undefined,'never','ask','always']){
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:permission,localToolPermissionCeiling:ceiling}));
 const expected=['never','ask','always'][Math.min(['never','ask','always'].indexOf(permission??'ask'),ceiling===undefined?2:['never','ask','always'].indexOf(ceiling))];
 assert.equal((await loadSettings({SAND_DATA_ROOT:root})).permission,expected,`${permission}/${ceiling}`)}
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:'always',localToolPermissionCeiling:'unknown'}));assert.notEqual((await loadSettings({SAND_DATA_ROOT:root})).permission,'always');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('Watch disconnect does not stop provider or shell; reconnect yields exit/done', {timeout:10000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;
 const peer=startUcFakePeer();await peer.listen();const p=provider(peer,root);let returned=false;const run=p.start().then(()=>returned=true);
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.enqueueExec('long',{id:1,shellStreamArgs:{command:'echo RUN; sleep 1; echo done'}});await until(()=>JSON.stringify(peer.log).includes('RUN'));peer.closeWatch();await delay(200);assert.equal(returned,false,'Watch end returned from provider.start');await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.message?.shellStream?.exit)));assert.match(JSON.stringify(peer.log),/done/);await until(()=>peer.log.filter(x=>x.kind==='watch').length>=2);
 }finally{await cleanup(p,peer,run,root,old)}
});
test('bad queued JSON ack/error does not poison same Poll batch good request', {timeout:10000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();peer.enqueueBad('bad');peer.enqueueRaw('null',Buffer.concat([wire.encStr(1,'null'),wire.encMsg(2,wire.encStr(1,'null'))]));peer.enqueueRaw('oneof',wire.encStr(1,'oneof'));peer.enqueueExec('good',{id:1,readArgs:{path:'probe.txt'}});const p=provider(peer,root);const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='good'&&f.message?.readResult)),2000);await until(()=>peer.log.some(x=>x.kind==='poll'&&x.acks.includes('bad')));assert.ok(peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='bad'&&f.message?.throw)));for(const id of ['null','oneof'])await until(()=>peer.log.some(x=>x.kind==='poll'&&x.acks.includes(id)))}finally{await cleanup(p,peer,run,root,old)}
});
test('temporary 503 beyond five attempts recovers without permanent lane failure', {timeout:12000},async()=>{
 let attempts=0,rejects=0;const q=new ReplyQueue(async()=>{if(++attempts<=5)throw new HttpStatusError(503)},()=>rejects++);
 try{q.enqueue(Buffer.from('result'));await until(()=>attempts>=6,8500);assert.equal(rejects,0);assert.equal(q.failure,undefined)}finally{q.stop()}
});
test('normal sleep4 background drain matches isolated original oracle (~4s)', {timeout:7000},async()=>{
 const root=temp(),got=[];let pid;const start=Date.now();
 try{await handleShellStream({root,requestId:'background',msgId:1,command:'sleep 4 & echo $! > bgpid; echo hi',emit:f=>got.push(f)});pid=Number(fs.readFileSync(path.join(root,'bgpid'),'utf8'));assert.ok(Date.now()-start>=3500 && Date.now()-start<6500,'must match measured original ~4s drain');assert.ok(got.some(f=>f.message?.shellStream?.exit))}finally{if(!pid&&fs.existsSync(path.join(root,'bgpid')))pid=Number(fs.readFileSync(path.join(root,'bgpid'),'utf8'));if(pid)try{process.kill(pid,'SIGKILL')}catch{}await shutdownShells();fs.rmSync(root,{recursive:true,force:true})}
});
test('independent codec goldens for accepted_count and streaming envelope',()=>{
 assert.equal(wire.encVarint(1,1).toString('hex'),'0801');assert.equal(wire.firstStr(wire.decodeFields(Buffer.from('0a036c6162','hex')),1),'lab');assert.equal(wire.takeEnvelopes(Buffer.from('00000000020801','hex')).messages[0].toString('hex'),'0801');
});
test('shutdown waits for abort exit and streamClose before disabling reply lane', {timeout:6000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();const p=provider(peer,root);const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.enqueueExec('stop',{id:1,shellStreamArgs:{command:'echo READY; sleep 30'}});await until(()=>JSON.stringify(peer.log).includes('READY'));await p.stop({ withdrawPresence: true });await run;assert.ok(peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.message?.shellStream?.exit?.aborted)));assert.ok(peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.message?.streamClose)));const watch=peer.log.find(x=>x.kind==='watch');const withdraw=peer.log.find(x=>x.kind==='withdraw');assert.equal(withdraw.presence,watch.presence);assert.equal(watch.hello.label,'independent');assert.equal(watch.hello.localRoot,root);assert.equal(watch.hello.kind,'')}
 finally{await cleanup(p,peer,run,root,old)}
});
test('same-scope synthetic credential rotation resumes retained replies after 401', {timeout:8000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();const p=provider(peer,root);const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.rejectSubmits(true);peer.enqueueExec('rotate',{id:1,readArgs:{path:'probe.txt'}});await until(()=>p.blocked);assert.ok(p.replies.readyCount>0,'must retain response frames (UC lanes)');peer.rejectSubmits(false);peer.rotateCredential('synthetic-rotated');assert.equal(p.updateChannel({backendUrl:`http://127.0.0.1:${peer.port()}`,machineId:SYN_MACHINE,credential:'synthetic-rotated'}),true);await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='rotate'&&f.message?.readResult)));assert.equal(p.blocked,false)}
 finally{await cleanup(p,peer,run,root,old)}
});
test('HTTP-success accepted0 is final refusal; independent r2 and shutdown drain are not blocked', {timeout:7000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();peer.setAcceptedFor('r1',0);const p=provider(peer,root);const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.enqueueExec('r1',{id:1,readArgs:{path:'probe.txt'}});await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='r1')));peer.enqueueExec('r2',{id:2,readArgs:{path:'probe.txt'}});await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='r2'&&f.message?.streamClose)),1500);
 const refused=peer.log.filter(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='r1'));assert.equal(refused.length,2,'read result + streamClose are final-refused once each');assert.equal(new Set(refused.map(x=>x.rawHex)).size,2);const start=Date.now();await p.stop({ withdrawPresence: true });await run;assert.ok(Date.now()-start<2500,'final refusal must not obstruct shutdown drain');assert.ok(peer.log.some(x=>x.kind==='withdraw'));assert.equal(p.blocked,false)}
 finally{await cleanup(p,peer,run,root,old)}
});
test('ceiling hot tightening prevents next UC execution', {timeout:6000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();const p=provider(peer,root);const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.enqueueExec('first',{id:1,shellStreamArgs:{command:'echo first > first'}});await until(()=>fs.existsSync(path.join(root,'first')));fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:'always',localToolPermissionCeiling:'never'}));peer.enqueueExec('denied',{id:2,shellStreamArgs:{command:'touch forbidden'}});await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='denied')));assert.equal(fs.existsSync(path.join(root,'forbidden')),false);await until(()=>peer.log.some(x=>x.kind==='watch'&&x.hello.standing==='never'))}
 finally{await cleanup(p,peer,run,root,old)}
});
test('opened fd outside root is refused during parent-directory swap race (Linux)',{timeout:5000},async(t)=>{
 if(process.platform!=='linux'){t.skip('Linux /proc fd validation');return;}
 const root=temp(),outside=temp(),got=[];fs.mkdirSync(path.join(root,'parent'));fs.writeFileSync(path.join(root,'parent','file'),'inside');fs.writeFileSync(path.join(outside,'file'),'synthetic-outside');const original=fs.promises.open;let swapped=false;
 fs.promises.open=async function(p,...args){if(!swapped&&p===path.join(root,'parent','file')){swapped=true;fs.renameSync(path.join(root,'parent'),path.join(root,'saved'));fs.symlinkSync(outside,path.join(root,'parent'));}return original.call(this,p,...args)};
 try{const {handleRead}=require('../dist/exec/handlers');await handleRead({root,requestId:'race',msgId:1,path:'parent/file',emit:f=>got.push(f)});assert.equal(swapped,true);assert.ok(got.some(f=>f.message?.throw));assert.doesNotMatch(JSON.stringify(got),/synthetic-outside/)}finally{fs.promises.open=original;fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true})}
});
test('six-second normal background matches original five-second drain without late stdout', {timeout:10000},async()=>{
 const root=temp(),got=[];const start=Date.now();
 try{await handleShellStream({root,requestId:'delayed-background',msgId:1,command:'echo $$ > pgid; (sleep 6; echo later) & echo $! > bgpid; echo hi',emit:f=>got.push(f)});const elapsed=Date.now()-start;assert.ok(elapsed>=4500&&elapsed<6200,'matches measured original ~5.04s');assert.doesNotThrow(()=>process.kill(Number(fs.readFileSync(path.join(root,'bgpid'),'utf8')),0));assert.ok(got.some(f=>f.message?.shellStream?.exit));assert.ok(got.some(f=>f.message?.streamClose));await delay(2500);assert.doesNotMatch(JSON.stringify(got),/later/)}finally{if(fs.existsSync(path.join(root,'pgid'))){const pid=Number(fs.readFileSync(path.join(root,'pgid'),'utf8'));try{process.kill(-pid,'SIGKILL')}catch{}}await shutdownShells();fs.rmSync(root,{recursive:true,force:true})}
});
test('loopback Submit 503 six times retains acknowledged output and resumes with no execution replay', {timeout:13000},async()=>{
 const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();peer.failSubmits(6);const p=provider(peer,root);const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.enqueueExec('retry',{id:1,shellStreamArgs:{command:'echo ran >> count; echo done'}});await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.message?.streamClose)),11000);assert.equal(p.blocked,false);assert.equal(fs.readFileSync(path.join(root,'count'),'utf8'),'ran\n')}
 finally{await cleanup(p,peer,run,root,old)}
});
test('saturated reply lane backpressures producers then resumes without permanent failure', {timeout:5000},async()=>{
 let release;const sent=[];const barrier=new Promise(r=>release=r);const q=new ReplyQueue(async b=>{await barrier;sent.push(b.toString())},()=>assert.fail('capacity is not authentication failure'),64,2);
 try{await q.enqueue(Buffer.from('one'));await q.enqueue(Buffer.from('two'));let admitted=false;const third=q.enqueue(Buffer.from('three')).then(()=>admitted=true);await delay(20);assert.equal(admitted,false);assert.equal(q.available,false);assert.equal(q.failure,undefined);release();await third;assert.equal(await q.drain(),true);assert.deepEqual(sent,['one','two','three'])}finally{release();q.stop()}
});
test('Hello semantic defaults and Submit bytes match independent frozen-proto goldens', {timeout:5000},async()=>{
 const golden=require('./fixtures/uc-outbound-goldens.json');const peer=startUcFakePeer();await peer.listen();
 const p=new UserComputerProvider({backendUrl:`http://127.0.0.1:${peer.port()}`,machineId:SYN_MACHINE,credential:SYN_CRED,root:'/synthetic-root',permission:'ask',hello:{label:'independent',localRoot:'/synthetic-root',terminalsFolder:'/synthetic-root/terminals',standing:'ask',supervised:true,variant:'lab',serverAuthoritative:false}});const run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));const normalize=hex=>Object.fromEntries(Object.entries(wire.decodeFields(Buffer.from(hex,'hex'))).filter(([key,values])=>!(key==='7'&&values[0].v===0)&&!(key==='9'&&values[0].v.length===0)));assert.deepEqual(normalize(peer.log.find(x=>x.kind==='watch').helloHex),normalize(golden.helloHex));await p.emit({kind:'client',requestId:'golden',message:{id:7}});await until(()=>peer.log.some(x=>x.kind==='submit'));assert.equal(peer.log.find(x=>x.kind==='submit').rawHex,golden.submitClientHex);assert.equal(wire.decodeFields(Buffer.from(golden.accepted1Hex,'hex'))[1][0].v,1)}finally{await p.stop({ withdrawPresence: true });await run;const w=peer.log.find(x=>x.kind==='watch'),d=peer.log.find(x=>x.kind==='withdraw');assert.equal(d.presence,w.presence);await peer.close()}
});
test('Poll limit is official tgt=64 regardless of capacity; queue IDs acknowledged separately from inflight request ID', {timeout:5000},async()=>{
 const http=require('node:http');let limit;let round=0;const got=[];
 const frame=Buffer.concat([wire.encStr(1,'already-running'),wire.encMsg(2,wire.encStr(1,'{"id":1,"readArgs":{"path":"probe.txt"}}'))]);
 const q=id=>wire.encMsg(1,Buffer.concat([wire.encStr(1,id),wire.encMsg(2,frame)]));
 const server=http.createServer((req,res)=>{let body=[];req.on('data',c=>body.push(c));req.on('end',()=>{const f=wire.decodeFields(Buffer.concat(body));limit=f[4][0].v;res.writeHead(200,{'content-type':'application/proto'});res.end(round++===0?Buffer.concat([q('queue-a'),q('queue-b')]):Buffer.alloc(0))})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const p=new UserComputerProvider({backendUrl:`http://127.0.0.1:${server.address().port}`,machineId:SYN_MACHINE,credential:SYN_CRED,root:'/tmp',permission:'ask',hello:{label:'lab',localRoot:'/tmp',terminalsFolder:'/tmp',standing:'ask',variant:'lab',serverAuthoritative:false}});
 p.channel={backendUrl:`http://127.0.0.1:${server.address().port}`,machineId:SYN_MACHINE,credential:SYN_CRED};p.replies={available:true};p.emit=f=>got.push(f);p.active=new Set(['already-running',...Array.from({length:7},(_,i)=>String(i))]);p.backlog=Array.from({length:62},(_,i)=>({requestId:'backlog-'+i}));
 try{await p.pollOnce();assert.equal(limit,64);assert.deepEqual(p.pendingAcks,['queue-a','queue-b']);assert.equal(p.backlog.length,62);assert.equal(got.length,0,'official startRequest suppresses in-flight duplicate without extra response')}finally{await new Promise(r=>server.close(r))}
});
test('outer malformed throw-only versus inner unsupported throw+close matches isolated original oracle', {timeout:5000},async()=>{
 resetExecIdCounter(1); // server sends id=1; official nextExecId starts at 1 so reply id stays 1
 const expected=require('../scripts/oracles/uc-bad-frames-result.json').frames;const root=temp();setup(root);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;const peer=startUcFakePeer();await peer.listen();const p=provider(peer,root),run=p.start();
 try{await until(()=>peer.log.some(x=>x.kind==='watch'));peer.enqueueRaw('outer-unknown',wire.encStr(1,'outer-unknown'));peer.enqueueBad('bad-json');peer.enqueueExec('inner-unsupported',{id:1,writeShellStdinArgs:{shellId:'1',chars:'x'}});await until(()=>peer.log.some(x=>x.kind==='submit'&&x.frames.some(f=>f.requestId==='inner-unsupported'&&f.message?.streamClose)));await delay(200);
 const observed=peer.log.filter(x=>x.kind==='submit').flatMap(x=>x.frames);
 for(const id of ['outer-unknown','bad-json','inner-unsupported']){assert.deepEqual(observed.filter(f=>f.requestId===id).map(f=>({kind:f.kind,message:f.message})),expected.filter(f=>f.requestId===id).map(f=>({kind:f.type,message:f.message})),id)}
 }finally{await cleanup(p,peer,run,root,old)}
});
