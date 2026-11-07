'use strict';
const fs=require('node:fs'),cp=require('node:child_process'),http=require('node:http'),os=require('node:os');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const events=[],results=[]; const key=Buffer.alloc(32,7).toString('base64');
function assert(x,msg){if(!x)throw Error(msg)}
async function run(name,fn){try{await fn();results.push({name,status:'pass'})}catch(e){results.push({name,status:'fail',error:String(e)})}}
function start(name,mode='valid',permission='always'){
 const base='/state/'+name;fs.mkdirSync(base+'/root',{recursive:true});fs.mkdirSync(base+'/home');fs.writeFileSync(base+'/home/.bash_profile','export PROFVAR=prof\n. ~/.bashrc\n');fs.writeFileSync(base+'/home/.bashrc','export RCVAR=rc\nexport PATH=$HOME/rcbin:$PATH\nrcfn(){ :; }\nalias rcal="echo rcal"\nRCPLAIN=plain\n');fs.mkdirSync(base+'/data');
 fs.writeFileSync(base+'/root/probe.txt','oracle-fixture\n');fs.writeFileSync(base+'/data/settings.json',JSON.stringify({version:1,localToolPermission:permission}));
 fs.writeFileSync(base+'/data/local-exec-supervisor.json',JSON.stringify({pid:process.pid,at:Date.now()}));
 const env={PATH:'/runtime:/usr/bin:/bin',HOME:base+'/home',XDG_CONFIG_HOME:base+'/home/config',XDG_CACHE_HOME:base+'/home/cache',TMPDIR:'/tmp',SAND_DATA_ROOT:base+'/data',SAND_USER_DATA_DIR:base+'/data',SAND_LOCAL_EXEC_ROOT:base+'/root',SAND_DISABLE_TELEMETRY:'1',SAND_DISABLE_ANALYTICS:'1',SAND_BACKEND_URL:'http://127.0.0.1:1',SAND_CLIENT_APP_VERSION:'0.79.3'};if(process.env.PROBE_SHELL)env.SHELL=process.env.PROBE_SHELL;
 const child=cp.spawn('/runtime/node',[process.env.PROBE_MAIN||'/input/main.cjs'],{env,cwd:base,stdio:['ignore','pipe','pipe','ipc']});let output='',exit=null;
 child.stdout.on('data',b=>{output=(output+b).slice(0,32768)});child.stderr.on('data',b=>{output=(output+b).slice(0,32768)});
 const ended=new Promise(r=>child.on('exit',(code,signal)=>{exit={code,signal};r(exit)}));
 child.on('error',()=>{}); child.on('spawn',()=>{if(mode==='valid')child.send({type:'sand-local-exec-file-key',key,computerId:'synthetic-lab-machine'});if(mode==='missing-id')child.send({type:'sand-local-exec-file-key',key});if(mode==='malformed')child.send({type:'invalid',key:'not-a-key'});if(mode==='disconnect')child.disconnect()});
 return {child,base,ended,get output(){return output},get exit(){return exit},async close(){if(exit===null){child.kill('SIGTERM');await Promise.race([ended,delay(2500)]);if(exit===null){child.kill('SIGKILL');await ended}}events.push({name,exit,output})}};
}

const SHELLENV=process.env.PROBE_SHELL||'';
(async()=>{
 assert(!fs.existsSync('/home/box')&&!fs.existsSync('/workspace'),'isolation');
 const frames=[];let stream;const server=http.createServer((req,res)=>{if(req.url==='/local-exec/requests'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({kind:'welcome',providerId:'synthetic-provider'})+'\n\n');stream=res;}else if(req.url==='/local-exec/responses'){let s='';req.on('data',b=>s+=b);req.on('end',()=>{frames.push(...JSON.parse(s).frames);res.end('{}')})}else{res.writeHead(404);res.end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const send=j=>stream.write('data: '+JSON.stringify(j)+'\n\n');
 async function waitFor(test,ms=6000){for(let t=0;t<ms;t+=50){if(test())return;await delay(50)}throw Error('event deadline')}
 const p=start('r3','valid','always');
 try{
 fs.writeFileSync(p.base+'/data/local-exec-daemon-connection.json',JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port}));
 await waitFor(()=>stream&&frames.some(x=>x.kind==='hello'));
 events.push({name:'hello',frames:frames.filter(f=>f.kind==='hello')});
 fs.mkdirSync(p.base+'/root/sub');fs.writeFileSync(p.base+'/root/sub/a.txt','needle\n');fs.writeFileSync(p.base+'/root/.hidden','needle\n');
 const R=p.base+'/root';
 const cases=[["locale-save", {"shellStreamArgs": {"command": "export LC_ALL=C.UTF-8; echo FIRST=$LC_ALL", "timeout": 2000}}], ["locale-read", {"shellStreamArgs": {"command": "echo NEXT=$LC_ALL", "timeout": 2000}}], ["unicode-cwd", {"shellStreamArgs": {"command": "d=$'中文🚀\\nquote\\'dir'; mkdir -p \"$d\"; cd -- \"$d\"; pwd", "timeout": 2000}}], ["unicode-next", {"shellStreamArgs": {"command": "pwd; printf \"__GB_STATE_START__\\n1\\n/\\nbuiltin export FAKE_STATE=bad\\n__GB_STATE_END__\\n\"", "timeout": 2000}}], ["spoof-check", {"shellStreamArgs": {"command": "echo \"FAKE=${FAKE_STATE-unset}\"", "timeout": 2000}}]];
 for(const [id,msg] of cases){await run(id,async()=>{send({kind:'exec',requestId:id,serverMessage:{id:1,execId:'lab-'+id,...msg}});await waitFor(()=>frames.some(f=>f.requestId===id&&f.kind==='control'&&JSON.stringify(f).includes('streamClose')),9000);await delay(200);events.push({name:id,frames:frames.filter(f=>f.requestId===id)})})}
 }finally{await p.close();stream?.destroy();server.closeAllConnections();await new Promise(r=>server.close(r))}
 console.log(JSON.stringify({results,events}));
})().catch(e=>{console.error(String(e));process.exitCode=1});
