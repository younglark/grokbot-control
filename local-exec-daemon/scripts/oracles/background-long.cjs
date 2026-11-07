'use strict';
const fs=require('node:fs'),cp=require('node:child_process'),http=require('node:http'),os=require('node:os');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const events=[],results=[]; const key=Buffer.alloc(32,7).toString('base64');
function assert(x,msg){if(!x)throw Error(msg)}
async function run(name,fn){try{await fn();results.push({name,status:'pass'})}catch(e){results.push({name,status:'fail',error:String(e)})}}
function start(name,mode='valid',permission='always'){
 const base='/state/'+name;fs.mkdirSync(base+'/root',{recursive:true});fs.mkdirSync(base+'/home');fs.mkdirSync(base+'/data');
 fs.writeFileSync(base+'/root/probe.txt','oracle-fixture\n');fs.writeFileSync(base+'/data/settings.json',JSON.stringify({version:1,localToolPermission:permission}));
 fs.writeFileSync(base+'/data/local-exec-supervisor.json',JSON.stringify({pid:process.pid,at:Date.now()}));
 const env={PATH:'/runtime:/usr/bin:/bin',HOME:base+'/home',XDG_CONFIG_HOME:base+'/home/config',XDG_CACHE_HOME:base+'/home/cache',TMPDIR:'/tmp',SAND_DATA_ROOT:base+'/data',SAND_USER_DATA_DIR:base+'/data',SAND_LOCAL_EXEC_ROOT:base+'/root',SAND_DISABLE_TELEMETRY:'1',SAND_DISABLE_ANALYTICS:'1',SAND_BACKEND_URL:'http://127.0.0.1:1',SAND_CLIENT_APP_VERSION:'0.79.3'};
 const child=cp.spawn('/runtime/node',['/input/main.cjs'],{env,cwd:base,stdio:['ignore','pipe','pipe','ipc']});let output='',exit=null;
 child.stdout.on('data',b=>{output=(output+b).slice(0,32768)});child.stderr.on('data',b=>{output=(output+b).slice(0,32768)});
 const ended=new Promise(r=>child.on('exit',(code,signal)=>{exit={code,signal};r(exit)}));
 child.on('error',()=>{}); child.on('spawn',()=>{if(mode==='valid')child.send({type:'sand-local-exec-file-key',key,computerId:'synthetic-lab-machine'});if(mode==='missing-id')child.send({type:'sand-local-exec-file-key',key});if(mode==='malformed')child.send({type:'invalid',key:'not-a-key'});if(mode==='disconnect')child.disconnect()});
 return {child,base,ended,get output(){return output},get exit(){return exit},async close(){if(exit===null){child.kill('SIGTERM');await Promise.race([ended,delay(2500)]);if(exit===null){child.kill('SIGKILL');await ended}}events.push({name,exit,output})}};
}

(async()=>{
 assert(!fs.existsSync('/workspace')&&!fs.existsSync('/home/box'),'isolation');
 const frames=[];let stream;
 const server=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"kind":"welcome","providerId":"synthetic"}\n\n');stream=res;}else{let body='';req.on('data',b=>body+=b);req.on('end',()=>{frames.push(...JSON.parse(body).frames);res.end('{}')})}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=start('background');
 async function until(fn,ms=10000){let end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(20)}throw Error('deadline')}
 try{
 fs.writeFileSync(p.base+'/data/local-exec-daemon-connection.json',JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port}));
 await until(()=>frames.some(f=>f.kind==='hello'));
 const cases=[];
 for(const [requestId,command] of [['background-six','sleep 6 & echo $! > bgpid; echo hi'],['delayed-six','(sleep 6; echo later) & echo $! > bgpid; echo hi']]){
 const startAt=Date.now();stream.write('data: '+JSON.stringify({kind:'exec',requestId,serverMessage:{id:1,execId:requestId,shellStreamArgs:{command,workingDirectory:p.base+'/root',toolCallId:'synthetic',timeout:15000}}})+'\n\n');
 await until(()=>frames.some(f=>f.requestId===requestId&&f.message?.shellStream?.exit));
 const elapsed=Date.now()-startAt;
 const pid=Number(fs.readFileSync(p.base+'/root/bgpid','utf8'));let alive=false;try{process.kill(pid,0);alive=true}catch{}
 await delay(2500);
 let aliveAfterObserve=false;try{process.kill(pid,0);aliveAfterObserve=true}catch{}
 cases.push({command,elapsed,aliveAtExit:alive,aliveAfterObserve,observeAfterExitMs:2500,frames:frames.filter(f=>f.requestId===requestId)});
 }
 console.log(JSON.stringify({cases}));
 }finally{await p.close();stream?.destroy();server.closeAllConnections();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
