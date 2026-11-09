// t165: drop-in fixes found by the acceptance harness. Synthetic fixtures and a local fake Box peer only.
// (1) Box exec authorises through the shared isLocalUseBlocked path with the frame's approvalId (D:136309–136332)
//     and refuses with x9 (D:136410): oa({throw: xp({id:0,error})}).toJson() → id 0 omitted on the wire, not a file-error.
// (2) localRoot = wft (D:132542–132545): trimmed SAND_LOCAL_EXEC_ROOT → trimmed SAND_AGENT_PROJECT_DIR → homedir().
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {BoxProvider}=require('../dist/box/provider');
const {ASK_MSG,NEVER_MSG}=require('../dist/exec/handlers');
const {localRootFromEnv}=require('../dist/util');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(10)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t165-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}

async function boxPeer(t,settings){
 const root=dir(t),data=dir(t),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify(settings));
 const posted=[];let stream;
 const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream'});stream=res;res.write(':\n\n');res.write('data: {"kind":"welcome","providerId":"p1"}\n\n')}
  else{for(const f of JSON.parse(body).frames)posted.push(f);res.writeHead(200);res.end('{}')}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const provider=new BoxProvider({connection:{baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-token',headers:{}},root,computerId:'synthetic',label:'lab',variant:'lab',permission:'always',sidecar:()=>undefined,heartbeatMs:60000});
 const running=provider.start();
 t.after(async()=>{await provider.stop();stream?.destroy();await Promise.race([running,delay(50)]);await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 await until(()=>stream&&posted.some(f=>f.kind==='hello'));
 return{root,data,send:o=>stream.write('data: '+JSON.stringify(o)+'\n\n'),reply:id=>posted.filter(f=>f.requestId===id)};
}
const sm=(cmd)=>({id:9,shellStreamArgs:{command:cmd,workingDirectory:'',timeout:5000}});
const closed=frames=>frames.some(f=>f.kind==='control'&&(f.message.streamClose||f.message.throw));

test('Box exec under ask: no approval → control throw{id:0,ASK}; matching approvalId → runs; mismatched → throw',{timeout:15000},async t=>{
 const b=await boxPeer(t,{version:1,localToolPermission:'ask'});
 fs.writeFileSync(path.join(b.data,'local-tool-approvals.json'),JSON.stringify({version:1,approvals:[{id:'ap1',action:'run-command',target:'echo T165_OK',resourcePath:b.root+'/terminals',recordedAtMs:Date.now()}]}));
 b.send({kind:'exec',requestId:'e1',serverMessage:sm('echo T165_OK')});
 await until(()=>b.reply('e1').length);
 assert.deepEqual(b.reply('e1'),[{kind:'control',requestId:'e1',message:{throw:{error:ASK_MSG}}}]);
 b.send({kind:'exec',requestId:'e2',approvalId:'ap1',serverMessage:sm('echo T165_OK')});
 await until(()=>closed(b.reply('e2')));
 assert.ok(JSON.stringify(b.reply('e2')).includes('T165_OK\\n'));
 assert.equal(b.reply('e2').at(-1).message.streamClose!==undefined,true);
 b.send({kind:'exec',requestId:'e3',approvalId:'ap1',serverMessage:sm('echo OTHER')});
 await until(()=>b.reply('e3').length);
 assert.deepEqual(b.reply('e3'),[{kind:'control',requestId:'e3',message:{throw:{error:ASK_MSG}}}]);
});

test('Box exec under never: control throw{id:0,NEVER} even with an approvalId; always: runs without one',{timeout:15000},async t=>{
 const n=await boxPeer(t,{version:1,localToolPermission:'never'});
 n.send({kind:'exec',requestId:'n1',approvalId:'whatever',serverMessage:sm('echo NOPE')});
 await until(()=>n.reply('n1').length);
 assert.deepEqual(n.reply('n1'),[{kind:'control',requestId:'n1',message:{throw:{error:NEVER_MSG}}}]);
});

test('Box exec under always runs without an approval',{timeout:15000},async t=>{
 const a=await boxPeer(t,{version:1,localToolPermission:'always'});
 a.send({kind:'exec',requestId:'a1',serverMessage:sm('echo ALWAYS_OK')});
 await until(()=>closed(a.reply('a1')));
 assert.ok(JSON.stringify(a.reply('a1')).includes('ALWAYS_OK'));
});

test('localRootFromEnv follows wft: trimmed ROOT → trimmed AGENT_PROJECT_DIR → homedir (raw, no resolve)',()=>{
 assert.equal(localRootFromEnv({SAND_LOCAL_EXEC_ROOT:' /tmp/r ',SAND_AGENT_PROJECT_DIR:'/tmp/p'}),'/tmp/r');
 assert.equal(localRootFromEnv({SAND_LOCAL_EXEC_ROOT:'   ',SAND_AGENT_PROJECT_DIR:' /tmp/p '}),'/tmp/p');
 assert.equal(localRootFromEnv({SAND_AGENT_PROJECT_DIR:''}),os.homedir());
 assert.equal(localRootFromEnv({}),os.homedir());
 assert.equal(localRootFromEnv({SAND_LOCAL_EXEC_ROOT:'rel/dir'}),'rel/dir');
});
