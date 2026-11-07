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
 const cases=[
  ['ls',{lsArgs:{path:R,toolCallId:'t'}}],
  ['grep',{grepArgs:{pattern:'needle',path:R,toolCallId:'t'}}],
  ['glob',{globToolArgs:{targetDirectory:R,globPattern:'**/*.txt'}}],
  ['delete',{deleteArgs:{path:R+'/sub/a.txt',toolCallId:'t'}}],
  ['write',{writeArgs:{path:R+'/w.txt',fileText:'x',toolCallId:'t'}}],
  ['sh-ident',{shellStreamArgs:{command:'echo "ARG0=$0"; shopt -q login_shell && echo LOGIN=1 || echo LOGIN=0; echo "BASH=$BASH"; echo "SHELLV=$SHELL"; shopt -q extglob && echo EXTGLOB=1 || echo EXTGLOB=0; echo "PATH=$PATH"; echo "PWD=$PWD"; cat; echo "CATRC=$?"; [ -t 0 ] && echo TTY0=1 || echo TTY0=0; [ -t 1 ] && echo TTY1=1 || echo TTY1=0; env | cut -d= -f1 | sort | tr "\\n" " "; echo; for v in AGENT_TRANSCRIPTS CURSOR_AGENT FORCE_COLOR GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 NODE_PATH NO_COLOR TERM _ZO_DOCTOR SAND_AGENT SHLVL; do echo "$v=${!v-<unset>}"; done',workingDirectory:R,toolCallId:'t1',timeout:5000}}],
  ['sh-state1',{shellStreamArgs:{command:'cd sub; export R3VAR=persisted; r3fn(){ echo fn; }; alias r3al="echo al"; echo set',workingDirectory:R,toolCallId:'t2',timeout:5000}}],
  ['sh-state2',{shellStreamArgs:{command:'echo "PWD2=$PWD"; echo "VAR2=${R3VAR:-unset}"; type r3fn >/dev/null 2>&1 && echo FN2=1 || echo FN2=0',workingDirectory:R,toolCallId:'t3',timeout:5000}}],
  ['sh-state3-nocwd',{shellStreamArgs:{command:'echo "PWD3=$PWD"; echo "VAR3=${R3VAR:-unset}"',toolCallId:'t4',timeout:5000}}],
  ['sh-exitcode',{shellStreamArgs:{command:'echo out; echo err >&2; exit 7',workingDirectory:R,toolCallId:'t5',timeout:5000}}],
  ['sh-timeout',{shellStreamArgs:{command:'echo before; sleep 5; echo after',workingDirectory:R,toolCallId:'t6',timeout:800}}],
  ['sh-init',{shellStreamArgs:{command:'echo "RC=${RCVAR:-unset} PROF=${PROFVAR:-unset} RCPLAIN=${RCPLAIN:-unset}"; echo "PATH=$PATH"; type rcfn >/dev/null 2>&1 && echo RCFN=1 || echo RCFN=0; alias rcal >/dev/null 2>&1 && echo RCAL=1 || echo RCAL=0',workingDirectory:R,toolCallId:'i1',timeout:5000}}],
  ['sh-plain1',{shellStreamArgs:{command:'PLAINV=1; alias myal="echo x"; shopt -s nullglob; set -o noglob',workingDirectory:R,toolCallId:'p1',timeout:5000}}],
  ['sh-plain2',{shellStreamArgs:{command:'echo "PLAINV=${PLAINV:-unset}"; alias myal >/dev/null 2>&1 && echo MYAL=1 || echo MYAL=0; shopt -q nullglob && echo NULLGLOB=1 || echo NULLGLOB=0; [[ $- == *f* ]] && echo NOGLOB=1 || echo NOGLOB=0',workingDirectory:R,toolCallId:'p2',timeout:5000}}],
  ['sh-exit1',{shellStreamArgs:{command:'export EXV=1; exit 3',workingDirectory:R,toolCallId:'e1',timeout:5000}}],
  ['sh-exit2',{shellStreamArgs:{command:'echo "EXV=${EXV:-unset}"; unset R3VAR',workingDirectory:R,toolCallId:'e2',timeout:5000}}],
  ['sh-unset2',{shellStreamArgs:{command:'echo "R3=${R3VAR:-unset}"',workingDirectory:R,toolCallId:'e3',timeout:5000}}],
  ['sh-badcwd',{shellStreamArgs:{command:'pwd',workingDirectory:R+'/nope',toolCallId:'b1',timeout:5000}}],
 ];
 for(const [id,msg] of cases){await run(id,async()=>{send({kind:'exec',requestId:id,serverMessage:{id:1,execId:'lab-'+id,...msg}});await waitFor(()=>frames.some(f=>f.requestId===id&&f.kind==='control'&&JSON.stringify(f).includes('streamClose')),9000);await delay(200);events.push({name:id,frames:frames.filter(f=>f.requestId===id)})})}
 }finally{await p.close();stream?.destroy();server.closeAllConnections();await new Promise(r=>server.close(r))}
 console.log(JSON.stringify({results,events}));
})().catch(e=>{console.error(String(e));process.exitCode=1});
