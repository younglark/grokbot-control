// t153: UC outer upload + Box materialized download. Static evidence only; no official package/network.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const pb=require('../dist/generated/aiserver.v1_pb');
const {writeUploadFile,prepareDownload,readWholeFile,UC_MAX_FILE_BYTES,fileTooLarge}=require('../dist/uc/file-source');
const {UcReplyLanes}=require('../dist/uc/reply-lanes');
const {UserComputerProvider,parseQueued}=require('../dist/uc/provider');
const {uploadRefusal,describeUpload,downloadRefusal}=require('../dist/uc/approvals');
const {prepareBoxExecFrame}=require('../dist/exec/exec-codec');
const {handleDownload,ASK_MSG,NEVER_MSG}=require('../dist/exec/handlers');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const tick=async()=>{for(let i=0;i<40;i++)await Promise.resolve()};
function dir(t){const root=fs.mkdtempSync('/tmp/uc-upload-box-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
function lane(extra={}){return new UcReplyLanes({canFlush:()=>false,send:async()=>{},reject:()=>{},isCancelled:()=>false,log:()=>{},...extra})}
function provider(t,{permission='always',ceiling,sa=false}={}){
 const root=dir(t),prior=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=root;t.after(()=>{if(prior===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=prior});
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:1,localToolPermission:permission,...(ceiling?{localToolPermissionCeiling:ceiling}:{})}));
 const p=new UserComputerProvider({backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic',root,permission,accountScope:'A',hello:{label:'synthetic',localRoot:root,terminalsFolder:root+'/terminals',standing:permission,supervised:true,variant:'synthetic',serverAuthoritative:sa}});
 p.channel={backendUrl:'http://127.0.0.1:1',machineId:'synthetic',credential:'synthetic'};p.proven=true;
 const frames=[];p.client={submitGrokBotUserComputerResponses:async(req)=>{frames.push(...req.frames);return{acceptedCount:req.frames.length}},withdrawGrokBotUserComputerPresence:async()=>({})};
 p.replies=lane({canFlush:()=>!p.closing&&p.proven,send:async(batch)=>p.client.submitGrokBotUserComputerResponses({frames:batch})});
 t.after(()=>p.beginShutdown());
 return{p,root,frames,wait:async n=>{for(let i=0;i<200&&frames.length<n;i++)await tick();assert.ok(frames.length>=n,'expected frames')}};
}
const uploadQ=(file,bytes,extra={})=>parseQueued(new pb.GrokBotUserComputerQueuedRequest({id:'u',frame:{requestId:'up',frame:{case:'upload',value:{path:file,data:bytes,...extra}}}}));

test('describeUpload is write-file; refusal matrix matches global Qce, no default allow',async t=>{
 const root=dir(t),ap=path.join(root,'a.json'),rp=path.join(root,'r.json');
 fs.writeFileSync(ap,JSON.stringify({approvals:[{id:'a',action:'write-file',target:'f',accountScope:'A'}]}));
 assert.deepEqual(describeUpload('f'),{action:'write-file',target:'f'});
 const base={permission:'ask',serverAuthoritative:false,authorization:{kind:'none'},file:'f',terminalsFolder:root,approvalsPath:ap,retirementsPath:rp};
 for(const permission of ['never','ask','always'])for(const ceiling of [undefined,'never','ask','always'])for(const approved of [false,true]){
  const rank={never:0,ask:1,always:2},effective=ceiling&&rank[ceiling]<rank[permission]?ceiling:permission;
  const r=await uploadRefusal({...base,permission:effective,ceiling,approvalId:approved?'a':undefined,authorization:{kind:'approval'}});
  assert.equal(r,ceiling==='never'?NEVER_MSG:approved||effective==='always'?undefined:effective==='never'?NEVER_MSG:ASK_MSG);
 }
 const sa={...base,serverAuthoritative:true,permission:'never',ceiling:'never',accountScope:'A'};
 assert.equal(await uploadRefusal({...sa,authorization:{kind:'approval'}}),undefined);
 assert.equal(await uploadRefusal({...sa,authorization:{kind:'standing'}}),undefined);
 assert.equal(await uploadRefusal(sa),ASK_MSG);
 assert.equal(await uploadRefusal({...sa,approvalId:'a'}),undefined);
 assert.equal(await uploadRefusal({...base,approvalId:'a',file:'other'}),ASK_MSG);
});

test('writeUploadFile empty/small/exact/oversize, mkdir parent, refuse escapes, preserve existing mode',async t=>{
 const root=dir(t);
 for(const size of [0,17,1024]){await writeUploadFile(root,'nested/dir/f'+size,Buffer.alloc(size,0x41));assert.equal(fs.readFileSync(path.join(root,'nested/dir/f'+size)).length,size)}
 await assert.rejects(writeUploadFile(root,'big',Buffer.alloc(8),4),/exceeds Grok Bot/);
 await assert.rejects(writeUploadFile(root,'../escape',Buffer.from('x')),/outside the allowed/);
 const target=path.join(root,'mode');fs.writeFileSync(target,'old',{mode:0o640});await writeUploadFile(root,'mode',Buffer.from('new'));assert.equal(fs.readFileSync(target).toString(),'new');assert.equal(fs.statSync(target).mode&0o777,0o640);
});

test('UC upload end-to-end: authorized empty/small write, success empty file frame; refuse before write; path escape after allow',{timeout:10000},async t=>{
 for(const size of [0,9]){const e=provider(t);const q=uploadQ('out'+size,Buffer.alloc(size,0x42),{authorizedByApproval:true});assert.equal(q.path,'out'+size);assert.equal(q.bytes.length,size);await e.p.handleQueued(q);await e.wait(1);assert.equal(e.frames[0].frame.case,'file');assert.equal(e.frames[0].frame.value.seq,0);assert.equal(e.frames[0].frame.value.last,true);assert.equal(e.frames[0].frame.value.data.length,0);assert.equal(fs.readFileSync(path.join(e.root,'out'+size)).length,size)}
 const deny=provider(t,{permission:'ask'});await deny.p.handleQueued(uploadQ('nope',Buffer.from('x'),{authorizedByApproval:true}));await deny.wait(1);assert.equal(deny.frames[0].frame.case,'fileError');assert.equal(deny.frames[0].frame.value.error,ASK_MSG);assert.equal(fs.existsSync(path.join(deny.root,'nope')),false);
 const allow=provider(t,{permission:'never',ceiling:'never',sa:true});await allow.p.handleQueued(uploadQ('../escape',Buffer.from('x'),{authorizedByApproval:true}));await allow.wait(1);assert.match(allow.frames[0].frame.value.error,/outside the allowed/);
});

test('UC upload oversize refuses with Od text before path write',async t=>{
 const e=provider(t);const bytes=Buffer.alloc(UC_MAX_FILE_BYTES+1,7);await e.p.handleQueued(uploadQ('huge',bytes,{authorizedByApproval:true}));await e.wait(1);assert.equal(e.frames[0].frame.case,'fileError');assert.equal(e.frames[0].frame.value.error,fileTooLarge(bytes.length,UC_MAX_FILE_BYTES));assert.equal(fs.existsSync(path.join(e.root,'huge')),false);
});

test('Box prepareBoxExecFrame maps file bytes to bytesBase64; empty success omits payload',()=>{
 assert.deepEqual(prepareBoxExecFrame({kind:'file',requestId:'r',bytes:Buffer.from('ab')}),{kind:'file',requestId:'r',bytesBase64:Buffer.from('ab').toString('base64')});
 assert.deepEqual(prepareBoxExecFrame({kind:'file',requestId:'r'}),{kind:'file',requestId:'r'});
 assert.deepEqual(prepareBoxExecFrame({kind:'file-error',requestId:'r',error:'x'}),{kind:'file-error',requestId:'r',error:'x'});
});

test('Box materializer reads whole file through iqe helper; missing/symlink escape become file-error',async t=>{
 const root=dir(t);fs.writeFileSync(path.join(root,'ok'),'hello-box');const got=[];
 await handleDownload({root,requestId:'b',filePath:'ok',emit:f=>got.push(f)});
 assert.equal(got[0].kind,'file');assert.equal(Buffer.from(got[0].bytes).toString(),'hello-box');
 const miss=[];await handleDownload({root,requestId:'m',filePath:'missing',emit:f=>miss.push(f)});assert.equal(miss[0].kind,'file-error');assert.match(miss[0].error,/ENOENT/);
 const outside=dir(t);fs.writeFileSync(path.join(outside,'secret'),'s');fs.symlinkSync(outside,path.join(root,'out'));
 const bad=[];await handleDownload({root,requestId:'s',filePath:'out/secret',emit:f=>bad.push(f)});assert.match(bad[0].error,/symlink/);
});

test('Box downloadRefusal with forced none ignores SA flags; always materializes, ask refuses without writing reply path',async t=>{
 const root=dir(t),ap=path.join(root,'a.json'),rp=path.join(root,'r.json');fs.writeFileSync(ap,JSON.stringify({approvals:[{id:'a',action:'read-file',target:path.join(root,'f'),attachToResourcePath:path.join(root,'f')}]}));
 fs.writeFileSync(path.join(root,'f'),'data');
 // Non-SA ask without approval → ASK even if request carries approval flags (Box forces none).
 assert.equal(await downloadRefusal({file:path.join(root,'f'),permission:'ask',serverAuthoritative:false,authorization:{kind:'none'},approvalsPath:ap,retirementsPath:rp,terminalsFolder:root+'/t'}),ASK_MSG);
 assert.equal(await downloadRefusal({file:path.join(root,'f'),permission:'always',serverAuthoritative:false,authorization:{kind:'none'},approvalsPath:ap,retirementsPath:rp,terminalsFolder:root+'/t'}),undefined);
});

test('readWholeFile closes source after last/error and concatenates multi-chunk payloads',async t=>{
 const root=dir(t);const content=Buffer.alloc(1024*1024+20,0x5a);fs.writeFileSync(path.join(root,'big'),content);
 const whole=await readWholeFile(await prepareDownload(root,'big'));assert.ok(!('error' in whole));assert.deepEqual(Buffer.from(whole.bytes),content);
});
