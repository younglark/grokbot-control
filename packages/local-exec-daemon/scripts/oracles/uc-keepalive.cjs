'use strict';
/**
 * Keepalive oracle (t103u), peer derived from uc-bad-frames.cjs. Round2 dynamic probes (auth t83u): Electron parentPort/utilityProcess + UserComputer ConnectRPC
 * + sealed credential R/W. Isolation-first; synthetic only; no real accounts.
 */
const fs=require('node:fs'),cp=require('node:child_process'),http=require('node:http'),os=require('node:os'),crypto=require('node:crypto'),path=require('node:path');
const pb=require('/scripts/pb.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const events=[],results=[],skips=[];
const key=Buffer.alloc(32,7).toString('base64'); // synthetic file key (not a secret)
const SYN_CRED='synthetic-uc-credential-lab-only';
const SYN_MACHINE='synthetic-lab-machine';
function assert(x,msg){if(!x)throw Error(msg)}
async function run(name,fn){try{await fn();results.push({name,status:'pass'})}catch(e){results.push({name,status:'fail',error:String(e&&e.stack||e)})} }
function seal(fileKeyB64, plaintext){
  const iv=crypto.randomBytes(12);
  const c=crypto.createCipheriv('aes-256-gcm', Buffer.from(fileKeyB64,'base64'), iv);
  const enc=Buffer.concat([c.update(plaintext,'utf8'), c.final()]);
  const data=Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  return JSON.stringify({sandSealedFile:1, data});
}
function unseal(fileKeyB64, raw){
  const j=JSON.parse(raw); assert(j.sandSealedFile===1,'not sealed');
  const buf=Buffer.from(j.data,'base64');
  const d=crypto.createDecipheriv('aes-256-gcm', Buffer.from(fileKeyB64,'base64'), buf.subarray(0,12));
  d.setAuthTag(buf.subarray(12,28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
function mkBase(name, permission='always'){
  const base='/state/'+name;
  fs.mkdirSync(base+'/root',{recursive:true});
  fs.mkdirSync(base+'/home');
  fs.mkdirSync(base+'/data');
  fs.writeFileSync(base+'/root/probe.txt','oracle-fixture-r2\n');
  fs.writeFileSync(base+'/data/settings.json',JSON.stringify({version:1,localToolPermission:permission}));
  fs.writeFileSync(base+'/data/local-exec-supervisor.json',JSON.stringify({pid:process.pid,at:Date.now()}));
  return base;
}
function envFor(base, extra={}){
  return {
    PATH:'/runtime:/usr/bin:/bin', HOME:base+'/home', XDG_CONFIG_HOME:base+'/home/config',
    XDG_CACHE_HOME:base+'/home/cache', TMPDIR:'/tmp', SAND_DATA_ROOT:base+'/data',
    SAND_USER_DATA_DIR:base+'/data', SAND_LOCAL_EXEC_ROOT:base+'/root',
    SAND_DISABLE_TELEMETRY:'1', SAND_DISABLE_ANALYTICS:'1',
    SAND_BACKEND_URL:'http://127.0.0.1:1', SAND_CLIENT_APP_VERSION:'0.79.3',
    ...extra
  };
}
function startNode(name, mode='valid', permission='always'){
  const base=mkBase(name, permission);
  const child=cp.spawn('/runtime/node',['/input/main.cjs'],{env:envFor(base),cwd:base,stdio:['ignore','pipe','pipe','ipc']});
  let output='',exit=null;
  child.stdout.on('data',b=>{output=(output+b).slice(0,65536)});
  child.stderr.on('data',b=>{output=(output+b).slice(0,65536)});
  const ended=new Promise(r=>child.on('exit',(code,signal)=>{exit={code,signal};r(exit)}));
  child.on('error',()=>{});
  child.on('spawn',()=>{
    if(mode==='valid')child.send({type:'sand-local-exec-file-key',key,computerId:SYN_MACHINE});
  });
  return {child,base,ended,get output(){return output},get exit(){return exit},
    async close(){if(exit===null){child.kill('SIGTERM');await Promise.race([ended,delay(2500)]);if(exit===null){child.kill('SIGKILL');await ended}}events.push({name,exit,output:output.slice(0,8192)})}};
}

// ---- ConnectRPC fake UserComputer peer ----
function buildConnected(pending=0){
  const inner=pb.encVarint(1, pending); // pending_request_count
  return pb.encMsg(1, inner); // connected event
}
function buildNotify(){return pb.encMsg(2, Buffer.alloc(0));}
function buildHeartbeat(pending=0){return pb.encMsg(3, pb.encVarint(1,pending));}
function buildExecFrame(requestId, serverMessage){
  const exec=pb.encStr(1, JSON.stringify(serverMessage)); // server_message_json
  const frame=Buffer.concat([pb.encStr(1, requestId), pb.encMsg(2, exec)]);
  return frame;
}
function buildQueued(id, frame, at=Date.now()){
  return Buffer.concat([pb.encStr(1,id), pb.encMsg(2, frame), pb.encInt64(3, at)]);
}
function buildPollResponse(queuedList){
  return Buffer.concat(queuedList.map(q=>pb.encMsg(1,q)));
}
function buildSubmitAccepted(n){return pb.encVarint(1,n);}
function buildWithdrawn(v=true){return pb.encBool(1,v);}

const T0=Date.now();const ctl={submitDelayMs:0,keepaliveError:false,rotation:false};
function startUcServer(){
  const log=[];
  let queue=[]; // {id, frameBuf}
  let watchRes=null;
  let forceUnauth=false;
  let acceptWithdraw=true;
  const server=http.createServer((req,res)=>{
    const url=req.url||'';
    log.push({method:req.method,url,ct:req.headers['content-type'],cl:req.headers['content-length']});
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      const raw=Buffer.concat(chunks);
      const body=pb.unwrapConnectBody(raw);
      try{
        if(url.endsWith('/WatchGrokBotUserComputerRequests')){
          // Connect server-streaming
          res.writeHead(200,{
            'content-type':'application/connect+proto',
            'connect-content-encoding':'identity',
            'connect-accept-encoding':'identity'
          });
          const fields=pb.decodeFields(body);
          const machineId=pb.firstStr(fields,1);
          const credential=pb.firstStr(fields,2);
          const presence=pb.firstStr(fields,4);
          let hello={};
          if(fields[3]?.[0]?.t==='b'){
            const hf=pb.decodeFields(fields[3][0].v);
            hello={
              label:pb.firstStr(hf,1), localRoot:pb.firstStr(hf,2), terminalsFolder:pb.firstStr(hf,3),
              standing:pb.firstStr(hf,4), supervised:!!(hf[5]?.[0]?.v), variant:pb.firstStr(hf,6),
              serverAuthoritative:!!(hf[7]?.[0]?.v), kind:pb.firstStr(hf,9)
            };
            if(hf[8]?.[0]?.t==='b'){
              const cf=pb.decodeFields(hf[8][0].v);
              hello.capabilities={
                messagesOp:!!(cf[1]?.[0]?.v),
                messagesOpGeneration:cf[2]?.[0]?.v,
                localStandingGrants:!!(cf[3]?.[0]?.v),
                aiToolSetup:!!(cf[4]?.[0]?.v),
                shell:!!(cf[6]?.[0]?.v),
                urlFileTransfer:!!(cf[11]?.[0]?.v),
              };
            }
          }
          log.push({kind:'watch',t:Date.now()-T0,label:credential===SYN_CRED?'old':'new',machineId,credentialLen:credential.length,presenceLen:presence.length,hello});
          if(forceUnauth || (credential!==SYN_CRED&&credential!==SYN_CRED+'-new') || machineId!==SYN_MACHINE){
            res.write(pb.endEnvelope({error:{code:'unauthenticated',message:'synthetic reject'}}));
            res.end();
            return;
          }
          watchRes=res;
          res.write(pb.envelope(buildConnected(queue.length)));
          // keep open; heartbeats optional
          return;
        }
        if(url.endsWith('/PollGrokBotUserComputerRequests')){
          const fields=pb.decodeFields(pb.unwrapConnectBody(raw));
          const acks=(fields[3]||[]).filter(x=>x.t==='b').map(x=>x.v.toString('utf8'));
          log.push({kind:'poll',acks,qlen:queue.length,machineId:pb.firstStr(fields,1)});
          if(forceUnauth || ![SYN_CRED,SYN_CRED+'-new'].includes(pb.firstStr(fields,2))){
            res.writeHead(401,{'content-type':'application/proto'});
            res.end();
            return;
          }
          // ack removal
          if(acks.length) queue=queue.filter(x=>!acks.includes(x.id));
          const take=queue.slice(0,8);log.push({kind:'poll-items',t:Date.now()-T0,ids:take.map(x=>x.id)});
          const resp=buildPollResponse(take.map(x=>buildQueued(x.id,x.frameBuf)));
          res.writeHead(200,{'content-type':'application/proto'});
          res.end(resp);
          return;
        }
        if(url.endsWith('/SubmitGrokBotUserComputerResponses')){
          const fields=pb.decodeFields(pb.unwrapConnectBody(raw));
          const frames=(fields[3]||[]).filter(x=>x.t==='b').map(x=>{
            const ff=pb.decodeFields(x.v);
            const rec={requestId:pb.firstStr(ff,1), rawLen:x.v.length, fieldKeys:Object.keys(ff), textHints:[]};
            // Best-effort: any nested length-delimited utf8 containing oracle markers
            const walk=(buf,depth)=>{
              if(depth>4||!buf||buf.length>1e6)return;
              try{
                const f=pb.decodeFields(buf);
                for(const arr of Object.values(f)){
                  for(const it of arr){
                    if(it.t==='b'){
                      const s=it.v.toString('utf8');
                      if(/oracle-fixture|streamClose|readResult|error|Ripgrep/.test(s)) rec.textHints.push(s.slice(0,200));
                      walk(it.v,depth+1);
                    }
                  }
                }
              }catch{}
            };
            walk(x.v,0);
            // also raw utf8 search
            const rawS=x.v.toString('utf8');
            if(/oracle-fixture-r2/.test(rawS) && !rec.textHints.some(h=>h.includes('oracle-fixture-r2'))) rec.textHints.push('oracle-fixture-r2');
            return rec;
          });
          const rawFrames=(fields[3]||[]).map(it=>{
            const ff=pb.decodeFields(it.v);const type=ff[3]?3:ff[2]?2:0;
            const payload=type?pb.decodeFields(ff[type][0].v):{};
            return {requestId:pb.firstStr(ff,1),type,message:type?JSON.parse(pb.firstStr(payload,1)):null};
          });
          const types=(fields[3]||[]).map(it=>{const ff=pb.decodeFields(it.v);return {requestId:pb.firstStr(ff,1),type:Number(Object.keys(ff).find(k=>k!=='1'))}});
          const keepalive=types.length>0&&types.every(f=>f.type===9);
          const t=Date.now()-T0;
          const entry={kind:'submit',t,keepalive,types,count:frames.length,frames,rawFrames};log.push(entry);
          res.on('close',()=>log.push({kind:'response-close',t:Date.now()-T0,ids:types.map(f=>f.requestId),ended:res.writableEnded}));
          if(keepalive&&ctl.rotation&&pb.firstStr(fields,2)===SYN_CRED){setTimeout(()=>{log.push({kind:'old-ka-401',t:Date.now()-T0});try{res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({code:'unauthenticated',message:'synthetic old credential'}))}catch{}},2000);return;}
          if(keepalive&&ctl.keepaliveError){
            res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({code:'resource_exhausted',message:'synthetic'}));return;
          }
          // retry-probe (t108 review): attempts 2–4 → 503 then recover; retry-expiry: every attempt ≥2 → 503.
          if(ctl.retryProbe&&!keepalive){ctl.attempt=(ctl.attempt||0)+1;entry.attempt=ctl.attempt;if(ctl.attempt>=2&&(ctl.retryForever||ctl.attempt<=4)){entry.status=503;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({code:'unavailable',message:'synthetic retry probe'}));return;}entry.status=200;}
          const respond=()=>{try{res.writeHead(200,{'content-type':'application/proto'});res.end(buildSubmitAccepted(frames.length))}catch{}};
          if(ctl.retryProbe&&!keepalive&&ctl.attempt===1){setTimeout(respond,500);return;}
          if(!keepalive&&ctl.submitDelayMs){setTimeout(respond,ctl.submitDelayMs);return;}
          respond();
          return;
        }
        if(url.endsWith('/WithdrawGrokBotUserComputerPresence')){
          const fields=pb.decodeFields(pb.unwrapConnectBody(raw));
          log.push({kind:'withdraw',machineId:pb.firstStr(fields,1),presence:pb.firstStr(fields,4)||pb.firstStr(fields,3)});
          res.writeHead(200,{'content-type':'application/proto'});
          res.end(buildWithdrawn(acceptWithdraw));
          try{watchRes?.end()}catch{}
          watchRes=null;
          return;
        }
        res.writeHead(404); res.end('no');
      }catch(e){
        log.push({kind:'handler-error',error:String(e&&e.stack||e)});
        try{res.writeHead(500);res.end()}catch{}
      }
    });
  });
  return {
    server, log,
    listen:()=>new Promise(r=>server.listen(0,'127.0.0.1',r)),
    port:()=>server.address().port,
    enqueueRaw(id, frameBuf){ queue.push({id,frameBuf}); try{watchRes?.write(pb.envelope(buildNotify()))}catch{} },
    enqueueExec(id, serverMessage){
      const frameBuf=buildExecFrame(id, serverMessage);
      queue.push({id, frameBuf});
      try{watchRes?.write(pb.envelope(buildNotify()))}catch{}
    },
    enqueueCancel(id){const frameBuf=Buffer.concat([pb.encStr(1,id),pb.encMsg(6,Buffer.alloc(0))]);queue.push({id:'cancel-'+id,frameBuf});try{watchRes?.write(pb.envelope(buildNotify()))}catch{}},
    removeQueue(id){queue=queue.filter(x=>x.id!==id)},
    notify(){try{watchRes?.write(pb.envelope(buildNotify()))}catch{}},
    setUnauth(v){forceUnauth=!!v},
    closeWatch(){try{watchRes?.end()}catch{};watchRes=null},
    async close(){try{watchRes?.end()}catch{}; await new Promise(r=>server.close(r));}
  };
}



// Scenario: argv[2] in backlog | stall | exhausted | cancel
(async()=>{
 assert(!fs.existsSync('/home/box')&&!fs.existsSync('/workspace'),'isolation');
 const scenario=process.argv[2]||'backlog';
 if(scenario.startsWith('cancel-overflow')||scenario==='overflow'||scenario==='pressure')ctl.submitDelayMs=10000;else if(scenario==='stall'||scenario==='exhausted'||scenario==='stall-cancel') ctl.submitDelayMs=7000;
 if(scenario==='rotation') ctl.rotation=true;if(scenario==='fairness-native')ctl.submitDelayMs=2000;
 if(scenario==='exhausted') ctl.keepaliveError=true;
 const uc=startUcServer();await uc.listen();const base=mkBase('ka-'+scenario);
 const cred={backendUrl:'http://127.0.0.1:'+uc.port(),userComputer:{credential:SYN_CRED,machineId:SYN_MACHINE,accountScope:'lab:scope',serverAuthoritative:false}};
 fs.writeFileSync(base+'/data/local-exec-daemon-credential.json',seal(key,JSON.stringify(cred)));
 const PROBE_MAIN=process.env.PROBE_MAIN||'/input/main.cjs';
 const child=cp.spawn('/runtime/node',[PROBE_MAIN],{env:envFor(base,process.env.PROBE_MAIN?{NODE_PATH:'/repo/node_modules'}:{}),cwd:base,stdio:['ignore','pipe','pipe','ipc']});
 let out='';child.stdout.on('data',b=>out=(out+b).slice(-8192));child.stderr.on('data',b=>out=(out+b).slice(-8192));const ended=new Promise(r=>child.on('exit',r));
 async function until(fn,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(20)}throw Error('deadline')}
 let marks={};let killedByProbe=false;let diedEarly=null;child.on('exit',(c,sig)=>{if(!killedByProbe)diedEarly={code:c,signal:sig,t:Date.now()-T0}});
 const killAt=(process.argv.find(a=>a.startsWith('--kill-at='))||'').slice(10);if(killAt)setTimeout(()=>child.kill('SIGKILL'),Number(killAt));
 try{
  child.send({type:'sand-local-exec-file-key',key,computerId:SYN_MACHINE});await until(()=>uc.log.some(x=>x.kind==='watch'));
  // cancel-overflow: 200 busy (t106 review); -long: 520 busy with 1024-char ids, active cancel (t107 over-budget);
  // -backlog: 488 long busy, cancel of a 2000-char-id backlog entry, its terminal must survive (t107 terminal loss).
  const CO=scenario==='cancel-overflow-long'?{n:520,id:i=>'busy'+String(i).padStart(4,'0')+'x'.repeat(1016),target:'target',obs:3000}:scenario==='cancel-overflow-backlog'?{n:488,id:i=>'busy'+String(i).padStart(4,'0')+'x'.repeat(1016),target:'backlogTarget'.padEnd(2000,'z'),obs:9000}:{n:200,id:i=>'busy'+i,target:'target',obs:3000};
  if(scenario==='retry-probe'||scenario==='retry-expiry'){ctl.retryProbe=true;ctl.retryForever=scenario==='retry-expiry';uc.enqueueExec('retry-target',{id:1,shellStreamArgs:{command:'printf PAYLOAD; sleep .05',timeout:10000}});marks.enqueued=Date.now()-T0;await delay(scenario==='retry-expiry'?37000:5000);
  }else if(scenario==='fairness-native'){
    // t108 review: 257 lanes × 3 frames behind a slow submit; lane order must persist across batches.
    const m={id:1,shellStreamArgs:{command:'sleep 15',timeout:20000}};uc.enqueueExec('target',m);marks.enqueued=Date.now()-T0;await until(()=>uc.log.some(x=>x.kind==='submit'&&!x.keepalive));
    for(let i=1;i<8;i++)uc.enqueueExec('active'+i,m);await delay(100);
    for(let i=0;i<64;i++)uc.enqueueExec('bk'+i,{id:1,shellStreamArgs:{command:'echo BACKLOG',timeout:5000}});await delay(100);
    for(let i=0;i<257;i++)for(let j=0;j<3;j++)uc.enqueueRaw('q'+i+'-'+j,buildExecFrame('busyLane'+i,{id:1,shellStreamArgs:{command:'echo SHOULD_NOT_START',timeout:5000}}));marks.flood=Date.now()-T0;
    await delay(1000);ctl.submitDelayMs=0;await delay(1400);
  }else if(scenario.startsWith('cancel-overflow')){
    const command=`/usr/bin/python3 -c 'import os,time
for _ in range(1000): os.write(1,b"x"*4096); time.sleep(.003)
time.sleep(20)'`;
    uc.enqueueExec('target',{id:1,shellStreamArgs:{command,timeout:25000}});marks.enqueued=Date.now()-T0;
    await until(()=>uc.log.some(x=>x.kind==='submit'&&!x.keepalive));
    for(let i=1;i<8;i++)uc.enqueueExec('active'+i,{id:1,shellStreamArgs:{command,timeout:25000}});await delay(1000);
    for(let i=0;i<64;i++)uc.enqueueExec(i===0&&CO.target!=='target'?CO.target:'bk'+i,{id:1,shellStreamArgs:{command:'echo BACKLOG',timeout:5000}});await delay(1500);
    for(let i=0;i<CO.n;i++)uc.enqueueExec(CO.id(i),{id:1,shellStreamArgs:{command:'echo SHOULD_NOT_START',timeout:5000}});await delay(1000);
    ctl.submitDelayMs=0;marks.cancel=Date.now()-T0;uc.enqueueCancel(CO.target);await delay(CO.obs);
  }else if(scenario==='overflow'){
    // Independent review t104 probe: 8 active + 64 backlog + 200 busy while the first submit stalls 10s.
    for(let i=0;i<8;i++)uc.enqueueExec('sh'+i,{id:1,shellStreamArgs:{command:`/usr/bin/python3 -c 'import os,time
for _ in range(1000): os.write(1,b"x"*4096); time.sleep(.003)
time.sleep(20)'`,timeout:25000}});marks.enqueued=Date.now()-T0;await delay(1000);
    for(let i=8;i<72;i++)uc.enqueueExec('sh'+i,{id:1,shellStreamArgs:{command:'echo BACKLOG',timeout:5000}});await delay(1500);
    for(let i=0;i<200;i++)uc.enqueueExec('busy'+i,{id:1,shellStreamArgs:{command:'echo SHOULD_NOT_START',timeout:5000}});marks.busy=Date.now()-T0;await delay(2000);ctl.submitDelayMs=0;await delay(7500);
  }else if(scenario==='pressure'){
    for(let i=0;i<8;i++)uc.enqueueExec('sh'+i,{id:1,shellStreamArgs:{command:`/usr/bin/python3 -c 'import os,time
for _ in range(1000): os.write(1,b"x"*4096); time.sleep(.003)
time.sleep(10)'`,timeout:20000}});marks.enqueued=Date.now()-T0;await delay(1000);
    for(let i=8;i<72;i++)uc.enqueueExec('sh'+i,{id:1,shellStreamArgs:{command:'echo CANCEL_ME',timeout:5000}});await delay(3000);
    marks.cancel=Date.now()-T0;for(let i=8;i<72;i++)uc.enqueueCancel('sh'+i);await Promise.race([ended,delay(3000)]);marks.after=Date.now()-T0;
  } else if(scenario==='rotation'){
    for(let i=0;i<9;i++)uc.enqueueExec('sh'+i,{id:1,shellStreamArgs:{command:'sleep 8; echo done',timeout:15000}});marks.enqueued=Date.now()-T0;
    await until(()=>uc.log.some(x=>x.kind==='submit'&&x.keepalive));cred.userComputer.credential=SYN_CRED+'-new';fs.writeFileSync(base+'/data/local-exec-daemon-credential.json',seal(key,JSON.stringify(cred)));marks.rotate=Date.now()-T0;
    await until(()=>uc.log.some(x=>x.kind==='watch'&&x.label==='new'));marks.newWatch=Date.now()-T0;await until(()=>uc.log.some(x=>x.kind==='old-ka-401'));marks.old401=Date.now()-T0;await delay(200);uc.enqueueExec('post',{id:1,shellStreamArgs:{command:'echo ROTATED',timeout:2000}});marks.post=Date.now()-T0;
    await delay(4000);
  } else if(scenario==='stall-cancel'){
    // Stable semantic boundary: 'one' emits nothing between its start frame and the cancel. With
    // 'echo hi; sleep 30' whether "hi" was read before or after the cancel's replies.drop raced in both
    // daemons (official kept it in some runs, ours in others), so the probe no longer depends on it.
    uc.enqueueExec('one',{id:1,shellStreamArgs:{command:'sleep 30',timeout:20000}});marks.enqueued=Date.now()-T0;
    await until(()=>uc.log.some(s=>s.kind==='submit'&&!s.keepalive));
    ctl.submitDelayMs=0;marks.cancel=Date.now()-T0;uc.enqueueCancel('one');uc.enqueueExec('two',{id:1,shellStreamArgs:{command:'echo AFTER_CANCEL',timeout:5000}});
    await delay(6000);
  } else if(scenario==='backlog'||scenario==='cancel'){
    for(let i=0;i<9;i++) uc.enqueueExec('sh'+i,{id:1,shellStreamArgs:{command:'sleep 6; echo done'+i,timeout:20000}});
    marks.enqueued=Date.now()-T0;
    if(scenario==='cancel'){await delay(3000);marks.cancel=Date.now()-T0;uc.enqueueCancel('sh8');}
    await delay(8500);
  } else {
    uc.enqueueExec('one',{id:1,shellStreamArgs:{command:'echo hi',timeout:5000}});
    marks.enqueued=Date.now()-T0;
    await delay(9000);
  }
  const subs=uc.log.filter(x=>x.kind==='submit');
  const keepalives=subs.filter(x=>x.keepalive).map(x=>({t:x.t,ids:x.types.map(f=>f.requestId)}));
  const firstNonKeepalive={};for(const s of subs) if(!s.keepalive) for(const f of s.types) firstNonKeepalive[f.requestId]??=s.t;
  const dataSeq=subs.filter(s=>!s.keepalive).map(s=>[s.t,s.types.length]);const dataSubmits={};for(const s of subs) if(!s.keepalive) for(const f of s.types) dataSubmits[f.requestId]=(dataSubmits[f.requestId]||0)+1;
  const sh8=subs.flatMap(s=>s.rawFrames).filter(f=>f.requestId==='sh8'&&f.message).map(f=>f.message);
  const polls=uc.log.filter(x=>x.kind==='poll').length;
  // Semantic data evidence (P3): per request, the ordered list of decoded data messages (chunk/batch independent).
  const data={};for(const s of subs) if(!s.keepalive) for(const f of s.rawFrames){if(!f.requestId)continue;(data[f.requestId]??=[]).push(f.message)}
  const watches=uc.log.filter(x=>x.kind==='watch').map(x=>({t:x.t,label:x.label}));
  const closes=uc.log.filter(x=>x.kind==='response-close').map(x=>({t:x.t,ids:x.ids,ended:x.ended}));
  // Death gate (P2-4): the daemon must still be alive when the scenario ends (before probe cleanup).
  const alive=child.exitCode===null&&child.signalCode===null&&!diedEarly;
  const results=[{name:scenario,status:alive?'pass':'fail',error:alive?undefined:'daemon died before cleanup: '+JSON.stringify(diedEarly||{code:child.exitCode,signal:child.signalCode})}];
  if(scenario==='retry-probe'||scenario==='retry-expiry'){console.log(JSON.stringify({scenario,marks,attempts:subs.filter(s=>!s.keepalive).map(s=>({t:s.t,status:s.status,frames:s.rawFrames})),accepted:subs.filter(s=>!s.keepalive&&s.status===200).flatMap(s=>s.rawFrames),daemonAlive:alive,results}));}
  else if(scenario==='fairness-native'){console.log(JSON.stringify({scenario,marks,busyBatches:subs.filter(s=>!s.keepalive&&s.types.some(f=>f.requestId.startsWith('busyLane'))).map(s=>({t:s.t,ids:s.types.map(f=>f.requestId)})),daemonAlive:alive,results}));}
  else if(scenario==='overflow'){
    const terminal=subs.flatMap(x=>x.rawFrames).filter(x=>x.requestId.startsWith('busy')&&x.message?.throw).map(x=>({requestId:x.requestId,error:x.message.throw.error}));
    const acked=[...new Set(uc.log.filter(x=>x.kind==='poll').flatMap(x=>x.acks||[]).filter(x=>x.startsWith('busy')))];
    const started=Object.keys(data).filter(k=>k.startsWith('busy')&&(data[k]||[]).some(m=>m&&m.shellStream&&m.shellStream.start));
    console.log(JSON.stringify({scenario,marks,acked,terminal,busyStarted:started,keepalives,daemonAlive:alive,results}));
  } else if(scenario.startsWith('cancel-overflow')){const acked=[...new Set(uc.log.filter(x=>x.kind==='poll').flatMap(x=>x.acks||[]))];const targetData=subs.flatMap(s=>s.rawFrames).filter(f=>f.requestId===CO.target);console.log(JSON.stringify({scenario,marks,firstSubmit:subs.find(s=>!s.keepalive),busyCount:CO.n,queuedTargetTerminal:targetData.map(f=>f.message),targetStarted:targetData.some(f=>f.message?.shellStream?.start),pollItemsAfterCancel:uc.log.filter(x=>x.kind==='poll-items'&&x.t>=marks.cancel),busyAcked:acked.filter(x=>x.startsWith('busy')).length,cancelAcked:acked.includes('cancel-'+CO.target),targetExit:targetData.filter(f=>f.message?.shellStream?.exit).map(f=>f.message),closes,polls,daemonAlive:alive,results}));}else console.log(JSON.stringify({scenario,marks,keepalives,firstNonKeepalive,dataSubmits,dataSeq,sh8,data,watches,closes,polls,daemonAlive:alive,results}));
  if(!alive)process.exitCode=3;
 }finally{killedByProbe=true;child.kill('SIGTERM');await Promise.race([ended,delay(2500)]);if(child.exitCode===null)child.kill('SIGKILL');uc.closeWatch();await uc.close();if(process.env.DEBUG_OUT||scenario.startsWith('retry-'))console.error(out)}
})().catch(e=>{console.error(e);process.exitCode=1});
