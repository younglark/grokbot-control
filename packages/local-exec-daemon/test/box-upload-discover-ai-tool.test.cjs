// t154: Box upload / discover-ai-tool (UC + Box) / URL-transfer unsupported reply. Synthetic fixtures + local fake peer only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const pb=require('../dist/generated/aiserver.v1_pb');
const {discoverAiTool,discoverAiToolBytes,sanitize,codexMcpItems,describeAiToolDiscovery,aiToolConfigDirsFromEnv}=require('../dist/uc/ai-tool-discovery');
const {UcReplyLanes}=require('../dist/uc/reply-lanes');
const {UserComputerProvider,parseQueued}=require('../dist/uc/provider');
const {BoxProvider,maxUploadFrameBytes,uploadFrameTooLarge}=require('../dist/box/provider');
const {fileTooLarge}=require('../dist/uc/file-source');
const {ASK_MSG}=require('../dist/exec/handlers');
const Z2="This computer's local-exec daemon does not understand that request frame; update the desktop app.";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(10)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t154-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
function put(root,rel,body=''){const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,body);return f}
const touch=(f,sec)=>fs.utimesSync(f,sec,sec);

function claudeFixture(t){
 const home=dir(t),c=path.join(home,'.claude');
 put(home,'.claude.json',JSON.stringify({mcpServers:{zeta:{command:'/opt/tools/bin/server-x',args:[]},web:{url:'https://mcp.example/x'},sse:{type:'sse',url:'https://x'},bad:5},projects:{'/p':{mcpServers:{proj:{type:'stdio'}}},'/q':7}}));
 put(c,'plugins/installed_plugins.json',JSON.stringify({plugins:{'tool@market':{}}}));
 put(c,'skills/alpha/SKILL.md','x');fs.mkdirSync(path.join(c,'skills/beta'),{recursive:true});put(c,'skills/gamma.md','x');
 put(c,'commands/a.md');put(c,'commands/ns/b.md');put(c,'commands/ns/deep/c.md');put(c,'commands/ns/deep/deeper/d.md');put(c,'commands/z.txt');
 touch(put(c,'projects/-p/s1.jsonl'),1700000000);touch(put(c,'projects/-p/s2.jsonl'),1700000100);put(c,'projects/-p/notes.txt');touch(put(c,'projects/-p/sub/s3.jsonl'),1700000050);/* QJe a<e: depth-2 files count, depth-3 not */touch(put(c,'projects/-p/sub/deeper/s4.jsonl'),1800000000);
 put(c,'history.jsonl',[
  {display:'/help',timestamp:1700000200000},{display:'fix bug in /home/u/proj/src/a.ts please',timestamp:1700000300000},
  {display:'[Pasted text #1 +20 lines]   ',timestamp:1},{display:'key sk-abcdefghijklmnopqrstuv and mail a@b.co',timestamp:1700000250000},
  {display:'no ts'},{display:5}].map(x=>JSON.stringify(x)).join('\n')+'\nnot json\n'+JSON.stringify({display:'fix bug in /home/u/proj/src/a.ts please',timestamp:1700000400000})+'\n');
 return home;
}
const CLAUDE_EXPECTED={source:'claude_code',found:true,sessionCount:3,lastActiveAtMs:1700000300000,items:[
 {kind:'mcp_server',title:'zeta',excerpt:'stdio \u00b7 server-x'},{kind:'mcp_server',title:'web',excerpt:'http'},
 {kind:'mcp_server',title:'sse',excerpt:'sse'},{kind:'mcp_server',title:'bad',excerpt:'unknown'},
 {kind:'mcp_server',title:'proj',excerpt:'stdio'},{kind:'plugin',title:'tool@market'},{kind:'skill',title:'alpha'},
 {kind:'skill',title:'a'},{kind:'skill',title:'ns:b'},{kind:'skill',title:'ns:deep:c'},
 {kind:'session',title:'fix bug in [path] please',occurredAtMs:1700000300000},
 {kind:'session',title:'key [redacted] and mail [email]',occurredAtMs:1700000250000},
 {kind:'session',title:'no ts'}]};
function codexFixture(t){
 const home=dir(t),c=path.join(home,'.codex');
 put(c,'config.toml',['[mcp_servers.foo]','command = "/usr/local/bin/foo-mcp"','[mcp_servers.foo.env]','command = "ignored"','[mcp_servers."bar baz"]','url = "https://x"','[mcp_servers.qux]','[profile]','command = "nope"'].join('\n'));
 put(c,'prompts/p.md');put(c,'prompts/sub/q.md');
 touch(put(c,'sessions/2026/01/01/r1.jsonl'),1700000500);
 put(c,'history.jsonl',JSON.stringify({text:'hello codex',ts:1700000600})+'\n'+JSON.stringify({text:'ms ts',ts:1700000700000})+'\n');
 return home;
}
const CODEX_EXPECTED={source:'codex',found:true,sessionCount:2,lastActiveAtMs:1700000700000,items:[
 {kind:'mcp_server',title:'foo',excerpt:'stdio \u00b7 foo-mcp'},{kind:'mcp_server',title:'bar baz',excerpt:'http'},{kind:'mcp_server',title:'qux',excerpt:'unknown'},
 {kind:'skill',title:'p'},{kind:'session',title:'ms ts',occurredAtMs:1700000700000},{kind:'session',title:'hello codex',occurredAtMs:1700000600000}]};

test('discoverAiTool: absent roots → Fpe; claude/codex fixtures match VJe semantics exactly',async t=>{
 const empty=dir(t);
 assert.deepEqual(await discoverAiTool('claude_code',{homeDir:empty}),{source:'claude_code',found:false,sessionCount:0,items:[]});
 assert.deepEqual(await discoverAiTool('codex',{homeDir:empty}),{source:'codex',found:false,sessionCount:0,items:[]});
 assert.deepEqual(await discoverAiTool('claude_code',{homeDir:claudeFixture(t)}),CLAUDE_EXPECTED);
 assert.deepEqual(await discoverAiTool('codex',{homeDir:codexFixture(t)}),CODEX_EXPECTED);
 const only=dir(t);put(only,'.claude.json','{}');
 assert.deepEqual(await discoverAiTool('claude_code',{homeDir:only}),{source:'claude_code',found:true,sessionCount:0,items:[]});
});

test('discoverAiTool: CLAUDE_CONFIG_DIR/CODEX_HOME override (.claude.json inside dir), blank ignored; env capture',async t=>{
 const home=claudeFixture(t),alt=dir(t);put(alt,'.claude.json',JSON.stringify({mcpServers:{only:{}}}));
 assert.deepEqual((await discoverAiTool('claude_code',{homeDir:home,configDirs:{claudeConfigDir:alt}})).items,[{kind:'mcp_server',title:'only',excerpt:'unknown'}]);
 assert.deepEqual(await discoverAiTool('claude_code',{homeDir:home,configDirs:{claudeConfigDir:'  '}}),CLAUDE_EXPECTED);
 const ch=codexFixture(t);assert.deepEqual(await discoverAiTool('codex',{homeDir:dir(t),configDirs:{codexHome:path.join(ch,'.codex')}}),CODEX_EXPECTED);
 assert.deepEqual(aiToolConfigDirsFromEnv({CLAUDE_CONFIG_DIR:'a',CODEX_HOME:'b'}),{claudeConfigDir:'a',codexHome:'b'});
 assert.deepEqual(describeAiToolDiscovery('claude_code'),{action:'read-ai-tool-setup',target:'Claude Code'});
 assert.deepEqual(describeAiToolDiscovery('codex'),{action:'read-ai-tool-setup',target:'Codex'});
});

test('discoverAiTool: non-absent fs errors propagate (EISDIR); sanitizer/truncation and toml scan',async t=>{
 const home=dir(t);fs.mkdirSync(path.join(home,'.codex/history.jsonl'),{recursive:true});
 await assert.rejects(discoverAiTool('codex',{homeDir:home}),e=>e.code==='EISDIR');
 assert.equal(sanitize('z'.repeat(200)),'z'.repeat(159)+'\u2026');assert.equal(sanitize('a'.repeat(200)),'[redacted]'); /* hex-like run hits Ojt[8] first */
 assert.equal(sanitize('x'.repeat(158)+'  yyy'),'x'.repeat(158)+'\u2026');
 assert.equal(sanitize(' see https://example.com/a  and C:\\Users\\x\\f.txt '),'see [link] and [path]');
 assert.equal(sanitize('token=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123'),'token=[redacted]');
 assert.deepEqual(codexMcpItems(undefined),[]);
 const bytes=await discoverAiToolBytes('codex',{homeDir:dir(t)});assert.equal(Buffer.from(bytes).toString('utf8'),'{"source":"codex","found":false,"sessionCount":0,"items":[]}');
});

function ucProvider(t,{permission='always',sa=false,aiToolConfigDirs}={}){
 const root=dir(t),prior=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;t.after(()=>{if(prior===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=prior});
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:permission}));
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic',root,permission,accountScope:'A',aiToolConfigDirs,hello:{label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:permission,supervised:true,variant:'synthetic',serverAuthoritative:sa}});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic'};p.proven=true;
 const frames=[];p.client={submitGrokBotUserComputerResponses:async(req)=>{frames.push(...req.frames);return{acceptedCount:req.frames.length}},withdrawGrokBotUserComputerPresence:async()=>({})};
 p.replies=new UcReplyLanes({canFlush:()=>!p.closing&&p.proven,send:async(batch)=>p.client.submitGrokBotUserComputerResponses({frames:batch}),reject:()=>{},isCancelled:()=>false,log:()=>{}});
 t.after(()=>p.beginShutdown());
 return{p,root,frames,wait:n=>until(()=>frames.length>=n)};
}
const q=(c,value,requestId='rq')=>parseQueued(new pb.GrokBotUserComputerQueuedRequest({id:'qid-'+requestId,frame:{requestId,frame:{case:c,value}}}));

test('UC v9r: discoverAiTool source gate; URL transfer frames → unsupported (w9r), not admitted',()=>{
 const ok=q('discoverAiTool',{source:'codex',approvalId:'ap',authorizedByStanding:true});
 assert.equal(ok.source,'codex');assert.equal(ok.approvalId,'ap');assert.deepEqual(ok.authorization,{kind:'standing'});assert.equal(ok.unsupported,undefined);
 assert.deepEqual(q('discoverAiTool',{source:'cursor'}).unsupported,{reply:{kind:'file-error',requestId:'rq',error:Z2}});
 assert.deepEqual(q('putFileToUrl',{}).unsupported,{reply:{kind:'control',requestId:'rq',message:{throw:{id:0,error:Z2}}}});
 assert.deepEqual(q('getFileFromUrl',{}).unsupported,{reply:{kind:'control',requestId:'rq',message:{throw:{id:0,error:Z2}}}});
 assert.deepEqual(q('getFileFromUrl',{},'').unsupported,{});
});

test('UC discover-ai-tool end-to-end: always → JSON file frame; ask refuses; local approval on "Codex" target allows',{timeout:10000},async t=>{
 const home=codexFixture(t),dirs={codexHome:path.join(home,'.codex')};
 const a=ucProvider(t,{aiToolConfigDirs:dirs});await a.p.handleQueued(q('discoverAiTool',{source:'codex'}));await a.wait(1);
 assert.equal(a.frames[0].frame.case,'file');assert.equal(a.frames[0].frame.value.seq,0);assert.equal(a.frames[0].frame.value.last,true);
 assert.deepEqual(JSON.parse(Buffer.from(a.frames[0].frame.value.data).toString('utf8')),CODEX_EXPECTED);
 const b=ucProvider(t,{permission:'ask',aiToolConfigDirs:dirs});await b.p.handleQueued(q('discoverAiTool',{source:'codex',authorizedByApproval:true}));await b.wait(1);
 assert.equal(b.frames[0].frame.case,'fileError');assert.equal(b.frames[0].frame.value.error,ASK_MSG);
 const c=ucProvider(t,{permission:'ask',aiToolConfigDirs:dirs});
 fs.writeFileSync(path.join(c.root,'local-tool-approvals.json'),JSON.stringify({approvals:[{id:'ap',action:'read-ai-tool-setup',target:'Codex',recordedAtMs:Date.now()}]}));
 await c.p.handleQueued(q('discoverAiTool',{source:'codex',approvalId:'ap'}));await c.wait(1);assert.equal(c.frames[0].frame.case,'file');
 const e=ucProvider(t,{aiToolConfigDirs:{codexHome:path.join(dir(t),'bad')}});fs.mkdirSync(path.join(e.root,'x'));
 fs.mkdirSync(path.join(e.p.aiToolConfigDirs.codexHome,'history.jsonl'),{recursive:true});
 await e.p.handleQueued(q('discoverAiTool',{source:'codex'}));await e.wait(1);assert.equal(e.frames[0].frame.case,'fileError');assert.match(e.frames[0].frame.value.error,/EISDIR/);
});

test('UC Y_: file payload above 1 MiB splits into seq-numbered chunks, last only on final',{timeout:10000},async t=>{
 const a=ucProvider(t);const bytes=Buffer.alloc(2*1024*1024+5,9);await a.p.emit({kind:'file',requestId:'big',bytes});await a.wait(3);
 assert.deepEqual(a.frames.map(f=>[f.frame.value.seq,f.frame.value.last,f.frame.value.data.length]),[[0,false,1048576],[1,false,1048576],[2,true,5]]);
});

async function boxPeer(t,{permission='always',maxFileBytes,aiToolConfigDirs}={}){
 const root=dir(t),data=dir(t),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({version:1,localToolPermission:permission}));
 const posted=[];let stream;
 const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream'});stream=res;res.write('data: {"kind":"welcome","providerId":"fixture"}\n\n')}
  else{for(const f of JSON.parse(body).frames)posted.push(f);res.writeHead(200);res.end('{}')}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const provider=new BoxProvider({connection:{baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-token',headers:{}},root,computerId:'synthetic',label:'lab',variant:'lab',permission,maxFileBytes,aiToolConfigDirs});
 const running=provider.start();
 t.after(async()=>{await provider.stop();stream?.destroy();await running;await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 await until(()=>posted.some(f=>f.kind==='hello'));
 return{root,posted,send:obj=>stream.write('data: '+JSON.stringify(obj)+'\n\n'),raw:s=>stream.write(s),reply:id=>posted.find(f=>f.requestId===id)};
}

test('Box upload: base64 decode, write-file authorization none, empty {kind:file} reply; refusal/size/escape errors',{timeout:15000},async t=>{
 const b=await boxPeer(t,{maxFileBytes:1000});
 b.send({kind:'upload',requestId:'u1',path:'d/out.bin',bytesBase64:Buffer.from('hello-box').toString('base64')});
 b.send({kind:'upload',requestId:'u0',path:'empty',bytesBase64:''});
 b.send({kind:'upload',requestId:'u2',path:'big',bytesBase64:Buffer.alloc(2000,1).toString('base64')});
 b.send({kind:'upload',requestId:'u3',path:'../escape',bytesBase64:'eA=='});
 b.send({kind:'upload',requestId:'u4',path:'bad'});
 await until(()=>['u1','u0','u2','u3'].every(id=>b.reply(id)));
 assert.deepEqual(b.reply('u1'),{kind:'file',requestId:'u1'});assert.equal(fs.readFileSync(path.join(b.root,'d/out.bin'),'utf8'),'hello-box');
 assert.deepEqual(b.reply('u0'),{kind:'file',requestId:'u0'});assert.equal(fs.readFileSync(path.join(b.root,'empty')).length,0);
 assert.deepEqual(b.reply('u2'),{kind:'file-error',requestId:'u2',error:fileTooLarge(2000,1000)});assert.equal(fs.existsSync(path.join(b.root,'big')),false);
 assert.equal(b.reply('u3').kind,'file-error');assert.match(b.reply('u3').error,/outside the allowed/);
 await delay(100);assert.equal(b.reply('u4'),undefined);
 const ask=await boxPeer(t,{permission:'ask'});
 ask.send({kind:'upload',requestId:'a1',path:'x',bytesBase64:'eA==',approvalId:'none',authorizedByApproval:true});
 await until(()=>ask.reply('a1'));assert.deepEqual(ask.reply('a1'),{kind:'file-error',requestId:'a1',error:ASK_MSG});assert.equal(fs.existsSync(path.join(ask.root,'x')),false);
});

test('Box SSE oversized frame (OJe): requestId → kJe file-error, stream continues; split oversize skipped to next blank line',{timeout:15000},async t=>{
 const b=await boxPeer(t,{maxFileBytes:1000});const limit=maxUploadFrameBytes(1000);assert.equal(limit,Math.ceil(4000/3)+65536);
 b.send({kind:'upload',requestId:'huge',path:'h',bytesBase64:'A'.repeat(limit+10)});
 b.raw('data: {"kind":"upload","requestId":"split","path":"s","bytesBase64":"'+'B'.repeat(limit+10));await delay(50);b.raw('BBBB"}\n\n');
 b.send({kind:'upload',requestId:'after',path:'ok',bytesBase64:'eQ=='});
 await until(()=>b.reply('huge')&&b.reply('after')&&b.reply('split'));
 assert.deepEqual(b.reply('huge'),{kind:'file-error',requestId:'huge',error:uploadFrameTooLarge(1000)});
 assert.deepEqual(b.reply('split'),{kind:'file-error',requestId:'split',error:uploadFrameTooLarge(1000)});
 assert.deepEqual(b.reply('after'),{kind:'file',requestId:'after'});
 assert.equal(fs.existsSync(path.join(b.root,'h')),false);assert.equal(fs.existsSync(path.join(b.root,'s')),false);
 assert.match(uploadFrameTooLarge(104857600),/^The upload exceeds Grok Bot's 100\.0 MiB limit/);
});

test('Box discover-ai-tool: authorization none, whole JSON as bytesBase64; invalid source dropped; ask refuses',{timeout:15000},async t=>{
 const home=claudeFixture(t);
 const b=await boxPeer(t,{aiToolConfigDirs:{claudeConfigDir:path.join(home,'.claude')}});
 // claudeConfigDir set → global config is <dir>/.claude.json (absent here) — exactly VJe's override rule.
 fs.copyFileSync(path.join(home,'.claude.json'),path.join(home,'.claude/.claude.json'));
 b.send({kind:'discover-ai-tool',requestId:'d1',source:'claude_code',authorizedByStanding:true});
 b.send({kind:'discover-ai-tool',requestId:'d2',source:'cursor'});
 await until(()=>b.reply('d1'));
 assert.equal(b.reply('d1').kind,'file');assert.deepEqual(JSON.parse(Buffer.from(b.reply('d1').bytesBase64,'base64').toString('utf8')),CLAUDE_EXPECTED);
 await delay(100);assert.equal(b.reply('d2'),undefined);
 const ask=await boxPeer(t,{permission:'ask'});ask.send({kind:'discover-ai-tool',requestId:'d3',source:'codex',authorizedByApproval:true});
 await until(()=>ask.reply('d3'));assert.deepEqual(ask.reply('d3'),{kind:'file-error',requestId:'d3',error:ASK_MSG});
});

test('ls (LocalLsExecutor D:129400–129483): stat preamble before the unreachable ripgrep build',async t=>{
 const {handleLs,RIPGREP_UNCONFIGURED,lsResolvePath,isCursorTerminalsDir}=require('../dist/exec/handlers');
 const root=dir(t);put(root,'file.txt','x');fs.mkdirSync(path.join(root,'sub'));
 fs.mkdirSync(path.join(root,'.cursor/projects/w1'),{recursive:true});
 const ls=async p=>{const got=[];await handleLs({root,requestId:'l',msgId:3,path:p,emit:f=>got.push(f)});return got};
 const err=g=>g[0].message.lsResult.error;
 assert.deepEqual(err(await ls('sub')),{path:path.join(root,'sub'),error:RIPGREP_UNCONFIGURED});
 assert.deepEqual(err(await ls(root)),{path:root,error:RIPGREP_UNCONFIGURED});
 assert.deepEqual(err(await ls('file.txt')),{path:path.join(root,'file.txt'),error:`Path is not a directory: ${path.join(root,'file.txt')}`});
 assert.deepEqual(err(await ls('missing')),{path:path.join(root,'missing'),error:`Path does not exist: ${path.join(root,'missing')}`});
 const term=path.join(root,'.cursor/projects/w1/terminals');
 assert.deepEqual(err(await ls(term)),{path:term,error:'No active terminals.'});
 const got=await ls('sub');assert.deepEqual(got[1],{kind:'control',requestId:'l',message:{streamClose:{id:3}}});
 assert.equal(isCursorTerminalsDir('/a/.cursor/projects/x/terminals/'),true);assert.equal(isCursorTerminalsDir('/a/.cursor/projects/x/terminals/t.txt'),false);
 assert.equal(lsResolvePath('~/q','/r'),path.join(os.homedir(),'q'));assert.equal(lsResolvePath('file:///tmp/z','/r'),'/tmp/z');assert.equal(lsResolvePath('','/r'),'/r');
});
