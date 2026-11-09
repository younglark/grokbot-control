// t155: Box hello-at-connect / heartbeat / providerId reset; Box messages-op + Mwr; standing grants + setting class.
// Synthetic fixtures and a local fake peer only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {BoxProvider,sameConnection}=require('../dist/box/provider');
const M=require('../dist/box/messages-op');
const A=require('../dist/uc/approvals');
const {ASK_MSG}=require('../dist/exec/handlers');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(10)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t155-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}

async function boxPeer(t,{settings={version:1,localToolPermission:'always'},welcome=true,postStatus=()=>200,opts={}}={}){
 const root=dir(t),data=dir(t),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify(settings));
 const bodies=[],posted=[],gets=[];let stream;
 const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  if(req.method==='GET'){gets.push(req.headers);res.writeHead(200,{'content-type':'text/event-stream'});stream=res;res.write(':\n\n');if(welcome===true||(typeof welcome==='function'&&welcome(gets.length)))res.write(`data: {"kind":"welcome","providerId":"p${gets.length}"}\n\n`)}
  else{const b=JSON.parse(body);bodies.push({at:Date.now(),...b});const st=postStatus(b);if(st===200)for(const f of b.frames)posted.push(f);res.writeHead(st);res.end('{}')}});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-token',headers:{}};
 const provider=new BoxProvider({connection,root,computerId:'synthetic',label:'lab',variant:'lab',permission:'always',sidecar:()=>undefined,...opts});
 const running=provider.start();
 t.after(async()=>{await provider.stop();stream?.destroy();await Promise.race([running,new Promise(r=>setTimeout(r,50))]);await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 return{root,data,connection,provider,bodies,posted,gets,stream:()=>stream,send:obj=>stream.write('data: '+JSON.stringify(obj)+'\n\n'),reply:id=>posted.filter(f=>f.requestId===id)};
}

test('Box hello is POSTed at connect (no welcome needed), shape per D:137408–137425, no standing, providerId absent',{timeout:10000},async t=>{
 const b=await boxPeer(t,{welcome:false});
 await until(()=>b.bodies.some(x=>x.frames[0].kind==='hello'));
 const h=b.bodies.find(x=>x.frames[0].kind==='hello');
 assert.equal(h.providerId,undefined);
 assert.deepEqual(h.frames,[{kind:'hello',localRoot:b.root,terminalsFolder:b.root+'/terminals',computerId:'synthetic',label:'lab',supervised:false,variant:'lab',capabilities:{messagesOpGeneration:4}}]);
 await until(()=>b.bodies.some(x=>x.frames[0].kind==='ping'));
 assert.deepEqual(b.bodies.find(x=>x.frames[0].kind==='ping').frames,[{kind:'ping',supervised:false}]);
});

test('Box hello advertises messagesOp only when the sidecar is located (D:y5 84695)',{timeout:10000},async t=>{
 const b=await boxPeer(t,{opts:{sidecar:()=>'/synthetic/Grok Bot Dev Computer Use.app'}});
 await until(()=>b.posted.some(f=>f.kind==='hello'));
 assert.deepEqual(b.posted.find(f=>f.kind==='hello').capabilities,{messagesOp:true,messagesOpGeneration:4});
});

test('Box heartbeat: leading ping, then every intervalMs after completion; welcome only sets providerId',{timeout:10000},async t=>{
 const b=await boxPeer(t,{opts:{heartbeatMs:150}});
 await until(()=>b.bodies.filter(x=>x.frames[0].kind==='ping').length>=3);
 const pings=b.bodies.filter(x=>x.frames[0].kind==='ping');
 assert.ok(pings[2].at-pings[1].at>=140,`gap ${pings[2].at-pings[1].at}`);
 assert.equal(pings.at(-1).providerId,'p1');
 assert.equal(b.posted.filter(f=>f.kind==='hello').length,1);
});

test('Box providerId reset when the stream ends; next connect re-sends hello without providerId',{timeout:10000},async t=>{
 const b=await boxPeer(t,{welcome:n=>n===1,opts:{heartbeatMs:60000}});
 await until(()=>b.stream());
 b.send({kind:'welcome',providerId:'late'});
 await until(()=>b.bodies.some(x=>x.providerId!==undefined));
 await until(()=>b.gets.length===1);await delay(50);
 b.stream().end();
 await until(()=>b.bodies.filter(x=>x.frames[0].kind==='hello').length===2);
 assert.equal(b.bodies.filter(x=>x.frames[0].kind==='hello')[1].providerId,undefined);
 await until(()=>b.bodies.filter(x=>x.frames[0].kind==='ping').length===2);
 assert.equal(b.bodies.filter(x=>x.frames[0].kind==='ping')[1].providerId,undefined);
});

test('Box heartbeat "moved" check aborts only the current stream and redials with the new connection',{timeout:10000},async t=>{
 let token='synthetic-token';
 const b=await boxPeer(t,{opts:{heartbeatMs:100,resolveConnection:async()=>({baseUrl:b.connection.baseUrl,token,headers:{}})}});
 await until(()=>b.gets.length===1);await delay(150);
 token='synthetic-token-2';
 await until(()=>b.gets.length===2);
 assert.equal(b.gets[1].authorization,'Bearer synthetic-token-2');
 assert.equal(sameConnection({baseUrl:'x',token:'a',headers:{h:'1'}},{baseUrl:'x',token:'a',headers:{h:'1'}}),true);
 assert.equal(sameConnection({baseUrl:'x',token:'a',headers:{h:'1'}},{baseUrl:'x',token:'a',headers:{}}),false);
});

test('Box hello dropped after 3 failed POSTs with the original log line',{timeout:10000},async t=>{
 const errs=[];const orig=console.error;console.error=(...a)=>errs.push(a.join(' '));t.after(()=>{console.error=orig});
 const b=await boxPeer(t,{welcome:false,opts:{heartbeatMs:60000},postStatus:x=>x.frames[0].kind==='hello'?500:200});
 // t159: match this provider's cause; an earlier test's provider may still drop its own batch (ECONNREFUSED) after stop.
 await until(()=>errs.some(e=>e.includes('dropping 1-frame response batch after 3 failed POSTs: SandLocalExecResponsePostError (http_500)')));
 assert.equal(b.bodies.filter(x=>x.frames[0].kind==='hello').length,3);
});

test('Box messages-op Mwr: schema failures reply messages-error z2 when requestId is a non-empty string',{timeout:10000},async t=>{
 const orig=console.error;console.error=()=>{};t.after(()=>{console.error=orig});
 const b=await boxPeer(t);await until(()=>b.posted.some(f=>f.kind==='hello'));
 b.send({kind:'messages-op',requestId:'bad1',op:{kind:'nope'}});
 b.send({kind:'messages-op',requestId:'bad2',op:{kind:'check-permissions',extra:1}});
 b.send({kind:'messages-op',requestId:'bad3',op:{kind:'activity',since:'2026-01-01'}});
 b.send({kind:'messages-op',requestId:'',op:{kind:'nope'}});
 b.send({kind:'messages-op',op:{kind:'nope'}});
 await until(()=>b.reply('bad3').length===1);await delay(100);
 for(const id of ['bad1','bad2','bad3'])assert.deepEqual(b.reply(id),[{kind:'messages-error',requestId:id,error:M.UNSUPPORTED_FRAME}]);
 assert.equal(b.posted.filter(f=>f.kind==='messages-error').length,3);
});

test('Box messages-op: default settings → o5; capability gates; check-permissions bypasses; Linux runner → sidecar_missing',{timeout:10000},async t=>{
 const b=await boxPeer(t);await until(()=>b.posted.some(f=>f.kind==='hello'));
 b.send({kind:'messages-op',requestId:'r1',op:{kind:'search',needle:'x'}});
 b.send({kind:'messages-op',requestId:'r2',op:{kind:'check-permissions'},sendKey:'k',draftCard:true});
 await until(()=>b.reply('r1').length&&b.reply('r2').length);
 assert.deepEqual(b.reply('r1'),[{kind:'messages-error',requestId:'r1',error:M.MESSAGES_OFF}]);
 // v6r lets check-permissions through, but Qce's setting class (nk → read-messages) still refuses with o5 (D:81490).
 assert.deepEqual(b.reply('r2'),[{kind:'messages-error',requestId:'r2',error:M.MESSAGES_OFF}]);
 fs.writeFileSync(path.join(b.data,'settings.json'),JSON.stringify({version:1,localToolPermission:'always',messagesEnabled:true,messagesReadEnabled:false}));
 b.send({kind:'messages-op',requestId:'r3',op:{kind:'items'}});
 b.send({kind:'messages-op',requestId:'r4',op:{kind:'find-contacts',query:' a '}});
 await until(()=>b.reply('r3').length&&b.reply('r4').length);
 assert.equal(b.reply('r3')[0].error,M.CAPABILITY_OFF.read);
 assert.equal(b.reply('r4')[0].error,'sidecar_missing');
 fs.writeFileSync(path.join(b.data,'settings.json'),JSON.stringify({version:1,localToolPermission:'always',messagesEnabled:true}));
 b.send({kind:'messages-op',requestId:'r5',op:{kind:'activity',since:'2026-01-01T00:00:00Z'}});
 await until(()=>b.reply('r5').length);assert.equal(b.reply('r5')[0].error,'sidecar_missing');
 fs.writeFileSync(path.join(b.data,'settings.json'),JSON.stringify({version:1,localToolPermission:'always',messagesEnabled:'yes'}));
 b.send({kind:'messages-op',requestId:'r6',op:{kind:'items'}});
 await until(()=>b.reply('r6').length);assert.equal(b.reply('r6')[0].error,M.MESSAGES_OFF);
});

test('Box messages-op send: subject class needs an approval (no accountScope → no standing); approved send validates then sidecar_missing; finishedSends replay',{timeout:10000},async t=>{
 const b=await boxPeer(t,{settings:{version:1,localToolPermission:'always',messagesEnabled:true}});await until(()=>b.posted.some(f=>f.kind==='hello'));
 fs.writeFileSync(path.join(b.data,'local-tool-standing-grants.v1.json'),JSON.stringify({version:1,grants:[{scope:'action',action:'send-imessage',accountScope:'A',grantedAtMs:1}]}));
 b.send({kind:'messages-op',requestId:'s1',op:{kind:'send',to:'+15550001111',text:'hi'}});
 await until(()=>b.reply('s1').length);assert.equal(b.reply('s1')[0].error,ASK_MSG);
 const rec=(id,target)=>({id,action:'send-imessage',target,recordedAtMs:Date.now()});
 fs.writeFileSync(path.join(b.data,'local-tool-approvals.json'),JSON.stringify({version:1,approvals:[rec('a1','+15550001111\nhi'),rec('a2','bad to\nhi'),rec('a3','bad chat!\nhi')]}));
 const before=fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('messages-mac-send-')).length;
 b.send({kind:'messages-op',requestId:'s2',approvalId:'a1',op:{kind:'send',to:'+15550001111',text:'hi'}});
 b.send({kind:'messages-op',requestId:'s3',approvalId:'a2',op:{kind:'send',to:'bad to',text:'hi'}});
 b.send({kind:'messages-op',requestId:'s4',approvalId:'a3',op:{kind:'send',chatId:'bad chat!',text:'hi'}});
 await until(()=>b.reply('s2').length&&b.reply('s3').length&&b.reply('s4').length);
 assert.deepEqual([b.reply('s2')[0].error,b.reply('s3')[0].error,b.reply('s4')[0].error],['sidecar_missing','send_recipient_invalid','send_chat_id_invalid']);
 assert.equal(fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('messages-mac-send-')).length,before);
 // replay: same requestId + identical op → identical reply without re-authorizing (approval file removed)
 fs.rmSync(path.join(b.data,'local-tool-approvals.json'));
 b.send({kind:'messages-op',requestId:'s2',approvalId:'a1',op:{kind:'send',to:'+15550001111',text:'hi'}});
 await until(()=>b.reply('s2').length===2);assert.deepEqual(b.reply('s2')[1],b.reply('s2')[0]);
 b.send({kind:'messages-op',requestId:'s2',op:{kind:'send',to:'+15550001111',text:'changed'}});
 await until(()=>b.reply('s2').length===3);assert.equal(b.reply('s2')[2].error,ASK_MSG);
});

test('messages-op units: nk describes, v6r gate, Ed lookup, runner validation order',async t=>{
 assert.deepEqual(M.describeMessagesOp({kind:'send',to:' A@B.com ',text:'x'}),{action:'send-imessage',target:' A@B.com \nx',description:'Send a message',recipient:'a@b.com'});
 assert.deepEqual(M.describeMessagesOp({kind:'send',chatId:'c1',text:'x'}),{action:'send-imessage',target:'c1\nx',description:'Send a message'});
 assert.equal(M.describeMessagesOp({kind:'send',to:'bob',text:'x'}).recipient,undefined);
 assert.deepEqual(M.describeMessagesOp({kind:'find-contacts',query:'q'}),{action:'read-messages',target:'your Contacts',description:'Find people in Contacts'});
 assert.equal(M.describeMessagesOp({kind:'items'}).target,'your Messages history');
 assert.equal(M.capabilityRefusal('check-permissions',{read:false,send:false}),undefined);
 assert.equal(M.capabilityRefusal('find-contacts',{read:false,send:true}),undefined);
 assert.equal(M.capabilityRefusal('send',{read:true,send:false}),M.CAPABILITY_OFF.send);
 assert.deepEqual(M.messagesCapabilities(false,{read:true,send:true}),{read:false,send:false});
 const d=dir(t),app=path.join(d,'Side.app');fs.mkdirSync(app);
 assert.equal(M.locateSidecar({GROK_BOT_SIDECAR_APP:app},'/usr/bin/node',d),app);
 assert.equal(M.locateSidecar({},'/usr/bin/node',d),undefined);
 await assert.rejects(M.runMessagesOp({kind:'send',to:'+15550001111',text:''},undefined),/^Error: send_text_empty$/);
 await assert.rejects(M.runMessagesOp({kind:'send',to:'+1555',text:'x'},undefined),/send_recipient_invalid/);
 await assert.rejects(M.runMessagesOp({kind:'items'},undefined),/^Error: sidecar_missing$/);
 await assert.rejects(M.runMessagesOp({kind:'items'},app),/helper_snapshot-messages-db_failed/);
});

test('standing grants (D:JLe/$Le/Cqt/LLe) and Qce setting/subject classes',async t=>{
 const d=dir(t),f=path.join(d,'g.json');
 const g=A.parseStandingGrants({version:1,grants:[
  {scope:'action',action:'send-imessage',accountScope:' A ',grantedAtMs:0},
  {scope:'subject',action:'use-app',accountScope:'A',recipient:' Safari ',grantedAtMs:5},
  {scope:'action',action:'read-messages',accountScope:'A',grantedAtMs:0},
  {scope:'subject',action:'send-imessage',accountScope:'A',recipient:'a\nb',grantedAtMs:0},
  {scope:'action',action:'send-imessage',accountScope:'',grantedAtMs:0},
  {scope:'action',action:'send-imessage',accountScope:'B',grantedAtMs:-1}]});
 assert.deepEqual([...g.keys()],[JSON.stringify(['A','action','send-imessage']),JSON.stringify(['A','subject','use-app','Safari'])]);
 assert.equal(A.parseStandingGrants({version:2,grants:[]}).size,0);
 assert.equal(A.standingEligible({action:'use-app',permission:'ask',ceiling:'ask'}),false);
 assert.equal(A.standingEligible({action:'send-imessage',permission:'ask'}),false);
 assert.equal(A.standingEligible({action:'send-imessage',permission:'ask',messagesEnabled:true}),true);
 fs.writeFileSync(f,JSON.stringify({version:1,grants:[{scope:'action',action:'send-imessage',accountScope:'A',grantedAtMs:0},{scope:'subject',action:'use-app',accountScope:'A',recipient:'Safari',grantedAtMs:0}]}));
 const base={permission:'ask',serverAuthoritative:false,authorization:{kind:'none'},terminalsFolder:'/t',approvalsPath:path.join(d,'none.json'),retirementsPath:path.join(d,'none2.json'),standingGrantsPath:f,messagesEnabled:true};
 const send={action:'send-imessage',target:'+1\nx',recipient:'+1'};
 assert.deepEqual(await A.decideExecLocalUse({...base,accountScope:'A',describes:send}),{kind:'allow'});
 assert.deepEqual(await A.decideExecLocalUse({...base,accountScope:'A',approvalId:'x',describes:send}),{kind:'ask'});
 assert.deepEqual(await A.decideExecLocalUse({...base,describes:send}),{kind:'ask'});
 assert.deepEqual(await A.decideExecLocalUse({...base,accountScope:'B',describes:send}),{kind:'ask'});
 assert.deepEqual(await A.decideExecLocalUse({...base,accountScope:'A',messagesEnabled:false,describes:send}),{kind:'ask'});
 assert.deepEqual(await A.decideExecLocalUse({...base,accountScope:'A',describes:{action:'use-app',target:'x',recipient:'Safari'}}),{kind:'allow'});
 assert.deepEqual(await A.decideExecLocalUse({...base,accountScope:'A',describes:{action:'use-app',target:'x',recipient:'Notes'}}),{kind:'ask'});
 assert.deepEqual(await A.decideExecLocalUse({...base,describes:{action:'read-messages',target:'x'}}),{kind:'allow'});
 assert.deepEqual(await A.decideExecLocalUse({...base,messagesEnabled:false,describes:{action:'read-messages',target:'x'}}),{kind:'refused',error:A.MESSAGES_OFF_MSG});
 assert.equal((await A.decideExecLocalUse({...base,permission:'never',describes:{action:'read-messages',target:'x'}})).kind,'refused');
 assert.equal(A.MESSAGES_OFF_MSG,M.MESSAGES_OFF);
});
