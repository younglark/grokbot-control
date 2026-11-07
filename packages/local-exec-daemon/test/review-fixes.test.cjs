'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {dispatchExec,handleShellStream,cancelRequest,shutdownShells} = require('../dist/exec/handlers');
const {GrokBotUserComputerQueuedRequest} = require('../dist/generated/aiserver.v1_pb');
const {parseQueued,UserComputerProvider} = require('../dist/uc/provider');
const {ReplyQueue,HttpStatusError} = require('../dist/transport/replies');
const fixtures = require('./fixtures/uc-wire.json');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=4000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(15)}throw Error('deadline')}
function workspace(){return fs.mkdtempSync(path.join(os.tmpdir(),'local-exec-daemon-review-'))}
const frames=[];
test('independent proto fixtures cover every outer oneof incl field6 cancel and int64 timestamp',()=>{
 for(const f of fixtures.frames){const item=GrokBotUserComputerQueuedRequest.fromBinary(Buffer.from(f.queuedHex,'hex'));assert.equal(item.enqueuedAtMs,1794055511678n);const q=parseQueued(item);assert.equal(q.kind,f.kind);assert.equal(q.requestId,'fixture-request')}
 assert.throws(()=>GrokBotUserComputerQueuedRequest.fromBinary(Buffer.from('08ff','hex')));

});
test('shell TERM/KILL kills group containing sleep grandchild with bounded close',async()=>{
 const root=workspace(); const got=[];const id='group';
 try{
 const job=handleShellStream({root,requestId:id,msgId:1,command:'sleep 300 & echo $! > grandchild; wait',emit:f=>got.push(f)});
 await until(()=>fs.existsSync(path.join(root,'grandchild')));
 const pid=Number(fs.readFileSync(path.join(root,'grandchild'),'utf8'));
 cancelRequest(id);await Promise.race([job,delay(2000).then(()=>{throw Error('cancel hung')})]);
 assert.ok(got.some(f=>f.message?.shellStream?.exit?.aborted));
 // Zombie may briefly remain until adopted/reaped; it must not be running.
 let state;try{state=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0]}catch{state='gone'}
 assert.ok(['Z','gone'].includes(state),state);
 }finally{await shutdownShells();fs.rmSync(root,{recursive:true,force:true})}
});
test('invalid cwd responds with throw+close and next request works; timeout distinct',async()=>{
 const root=workspace(); const got=[];const emit=f=>got.push(f);
 try{
 await dispatchExec({root,requestId:'bad',serverMessage:{id:1,shellStreamArgs:{command:'true',workingDirectory:path.join(root,'missing')}},permission:'always',emit});
 assert.ok(got.some(f=>f.requestId==='bad'&&f.message?.throw));assert.ok(got.some(f=>f.requestId==='bad'&&f.message?.streamClose));
 await handleShellStream({root,requestId:'ok',msgId:2,command:'printf ok',emit});
 assert.ok(got.some(f=>f.requestId==='ok'&&f.message?.shellStream?.exit?.code===0));
 await handleShellStream({root,requestId:'timeout',msgId:3,command:'sleep 30',timeout:50,emit});
 assert.equal(got.find(f=>f.requestId==='timeout'&&f.message?.shellStream?.exit)?.message.shellStream.exit.abortReason,'SHELL_ABORT_REASON_TIMEOUT');
 }finally{await shutdownShells();fs.rmSync(root,{recursive:true,force:true})}
});
test('read/ls/cwd symlink sibling root2 refused; binary and large read fail explicitly',async()=>{
 const base=workspace();const root=path.join(base,'root'),other=path.join(base,'root2');fs.mkdirSync(root);fs.mkdirSync(other);fs.writeFileSync(path.join(other,'secret'),'outside');fs.symlinkSync(other,path.join(root,'link'));
 const got=[];const emit=f=>got.push(f);
 try{
 for(const [requestId,args] of [['read',{readArgs:{path:path.join(root,'link','secret')}}],['ls',{lsArgs:{path:path.join(root,'link')}}],['cwd',{shellStreamArgs:{command:'pwd',workingDirectory:path.join(root,'link')}}]]){
 await dispatchExec({root,requestId,serverMessage:{id:1,...args},permission:'always',emit});
 assert.ok(got.some(f=>f.requestId===requestId&&f.message?.throw));assert.ok(got.some(f=>f.requestId===requestId&&f.message?.streamClose));}
 fs.writeFileSync(path.join(root,'binary'),Buffer.from([0,255,1]));
 fs.writeFileSync(path.join(root,'big'),Buffer.alloc(8*1024*1024+1,65));
 for(const file of ['binary','big']) {await dispatchExec({root,requestId:file,serverMessage:{id:1,readArgs:{path:file}},permission:'always',emit});assert.ok(got.some(f=>f.requestId===file&&f.message?.throw))}
 }finally{fs.rmSync(base,{recursive:true,force:true})}
});
test('reply lane retries same encoded bytes on transient failure and rejects unauth/capacity',async()=>{
 let attempts=0;const bodies=[];const q=new ReplyQueue(async b=>{bodies.push(b.toString());if(++attempts<3)throw new HttpStatusError(503)},()=>{});
 q.enqueue(Buffer.from('reply'));await q.drain(2000);assert.equal(attempts,3);assert.deepEqual(bodies,['reply','reply','reply']);q.stop();
 let rejected=0;const bad=new ReplyQueue(async()=>{throw new HttpStatusError(401)},()=>rejected++);bad.enqueue(Buffer.from('a'));await until(()=>rejected===1);assert.ok(bad.failure);bad.stop();
 const cap=new ReplyQueue(async()=>{},()=>rejected++,2,1);await assert.rejects(cap.enqueue(Buffer.from('oversized')),/capacity/);assert.equal(cap.failure,undefined);cap.stop();
});
test('UC scheduler admits 8 active +64 backlog; live Never hot read',async()=>{
 const root=workspace(),data=path.join(root,'data');fs.mkdirSync(data);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 const provider=new UserComputerProvider({backendUrl:'http://127.0.0.1:9',machineId:'synthetic',credential:'synthetic',root,permission:'always',hello:{label:'test',localRoot:root,terminalsFolder:root,standing:'always',variant:'test',serverAuthoritative:false}});
 const got=[]; provider.emit=f=>got.push(f);
 try{
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({version:1,localToolPermission:'never'}));
 await provider.handleQueued({id:'hot',requestId:'hot',kind:2,serverMessage:{id:1,shellStreamArgs:{command:'touch forbidden'}}});
 assert.equal(fs.existsSync(path.join(root,'forbidden')),false);assert.match(JSON.stringify(got),/turned off/);
 // Exercise real runBacklog admission, no subprocess fixtures required.
 const pending=[];provider.replies={available:true};provider.handleQueued=()=>new Promise(r=>pending.push(r));
 provider.backlog=Array.from({length:72},(_,i)=>({id:String(i),requestId:String(i),kind:2,serverMessage:{}}));provider.runBacklog();assert.equal(provider.active.size,8);assert.equal(provider.backlog.length,64);
 provider.closed=true;pending.forEach(r=>r());
 }finally{process.env.SAND_DATA_ROOT=old;fs.rmSync(root,{recursive:true,force:true})}
});
test('UC wire cancel field6 removes queued work; Poll confirms ack/clears seen (independent fixture)',async()=>{
 const cancel=fixtures.frames.find(f=>f.kind===6);
 let body=Buffer.from('0a','hex');const q=Buffer.from(cancel.queuedHex,'hex');body=Buffer.concat([body,Buffer.from([q.length]),q]);
 const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/proto'});res.end(body);body=Buffer.alloc(0)})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const provider=new UserComputerProvider({backendUrl:`http://127.0.0.1:${server.address().port}`,machineId:'synthetic',credential:'synthetic',root:'/tmp',permission:'ask',hello:{label:'test',localRoot:'/tmp',terminalsFolder:'/tmp',standing:'ask',variant:'test',serverAuthoritative:false}});
 provider.channel={backendUrl:`http://127.0.0.1:${server.address().port}`,machineId:'synthetic',credential:'synthetic'};
 provider.replies={available:true};provider.backlog=[{id:'pending',requestId:'fixture-request',kind:2,serverMessage:{}}];
 const root=workspace();const got=[];
 const job=handleShellStream({root,requestId:'fixture-request',msgId:1,command:'sleep 300 & echo ready > started; wait',emit:f=>got.push(f)});
 await until(()=>fs.existsSync(path.join(root,'started')));
 try{await provider.pollOnce();await job;assert.ok(got.some(f=>f.message?.shellStream?.exit?.aborted));assert.equal(provider.backlog.length,0);assert.equal(provider.seen.size,1);assert.deepEqual(provider.pendingAcks,['queue-fixture']);await provider.pollOnce();assert.equal(provider.seen.size,0);assert.equal(provider.pendingAcks.length,0)}finally{await shutdownShells();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
});
test('Box validates token/custom headers on GET and POST, retries 503, reconnects SSE',async()=>{
 const {BoxProvider}=require('../dist/box/provider');const root=workspace(),data=path.join(root,'data');fs.mkdirSync(data);const old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({version:1,localToolPermission:'never'}));
 let gets=0,posts=0,valid=true;let stream;
 const server=http.createServer((req,res)=>{
 valid=valid&&req.headers.authorization==='Bearer synthetic-token'&&req.headers['x-lab']==='synthetic-header';
 req.resume();req.on('end',()=>{
 if(req.method==='GET'){gets++;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"kind":"welcome","providerId":"fixture"}\n\n');if(gets===1)res.end();else stream=res;}
 else {posts++;res.writeHead(posts===1?503:200);res.end('{}')}
 });});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const provider=new BoxProvider({connection:{baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-token',headers:{'x-lab':'synthetic-header'}},root,computerId:'synthetic',label:'lab',variant:'lab',permission:'never'});
 const running=provider.start();
 try{await until(()=>gets>=2&&posts>=3);assert.equal(valid,true)}finally{await provider.stop();stream?.destroy();await running;await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old;fs.rmSync(root,{recursive:true,force:true})}
});
test('spawn error event produces error+close without uncaught exception',async()=>{
 const cp=require('node:child_process'),{EventEmitter}=require('node:events');const original=cp.spawn;const root=workspace();const got=[];
 cp.spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.destroy=()=>{};child.stderr=new EventEmitter();child.stderr.destroy=()=>{};process.nextTick(()=>child.emit('error',Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'})));return child};
 try{await handleShellStream({root,requestId:'spawn-error',msgId:1,command:'true',emit:f=>got.push(f)});assert.ok(got.some(f=>f.message?.throw));assert.ok(got.some(f=>f.message?.streamClose))}finally{cp.spawn=original;fs.rmSync(root,{recursive:true,force:true})}
});
test('stale supervisor exits with connected Box by default; active lease keeps it alive',async()=>{
 const cp=require('node:child_process');const streams=[];const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{if(req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"kind":"welcome"}\n\n');streams.push(res)}else res.end('{}')})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const root=workspace();const children=[];
 try{
 for(const leased of [false,true]){
 const dir=path.join(root,String(leased));fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({version:1,localToolPermission:'never'}));fs.writeFileSync(path.join(dir,'local-exec-supervisor.json'),JSON.stringify({pid:process.pid,at:Date.now()-1000000}));fs.writeFileSync(path.join(dir,'local-exec-daemon-connection.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${server.address().port}`}));if(leased)fs.writeFileSync(path.join(dir,'local-exec-update-lease.json'),JSON.stringify({until:Date.now()+60000}));
 const child=cp.fork(path.resolve(__dirname,'../dist/index.js'),[],{env:{...process.env,SAND_DATA_ROOT:dir,SAND_LOCAL_EXEC_ROOT:dir},stdio:['ignore','pipe','pipe','ipc']});children.push(child);child.send({type:'sand-local-exec-file-key',key:Buffer.alloc(32,7).toString('base64'),computerId:'synthetic'});await delay(2400);
 if(leased)assert.equal(child.exitCode,null);else assert.equal(child.exitCode,0);
 }
 }finally{for(const child of children){if(child.exitCode===null){const end=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await end}}streams.forEach(s=>s.destroy());await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
});
