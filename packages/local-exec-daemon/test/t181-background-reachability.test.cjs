// t181: the three remaining background components are unreachable in the original daemon (Tft D:132604–132670
// passes no registry to $3 at D:132609, so ZO/d1e get backgroundWorkRegistry=undefined; forceBackgroundByToolCallId
// D:130809 has no caller; forceBackgroundShellExecutor is not registered). These tests pin that observable surface,
// plus the jHt unregistered-case texts (D:98041–98046). Synthetic only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const H=require('../dist/exec/handlers');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'t181-'));
const run=async(root,rid,sm)=>{const f=[];await H.dispatchExec({root,requestId:rid,permission:'always',serverMessage:sm,emit:x=>{f.push(x)}});await new Promise(r=>setTimeout(r,50));return f;};

test('forceBackgroundShellArgs is not registered in Tft → No handler throw + streamClose',async()=>{
  const f=await run(tmp(),'fb',{id:1,forceBackgroundShellArgs:{toolCallId:'tc-1'}});
  assert.equal(f[0].message.throw.error,'No handler found for server message of type forceBackgroundShellArgs');
  assert.ok(f[1].message.streamClose);
});

test('jHt texts for computerUseArgs / recordScreenArgs',async()=>{
  const a=await run(tmp(),'cu',{id:1,computerUseArgs:{}});
  assert.match(a[0].message.throw.error,/^Computer use is not enabled for this environment.*\(No computer-use handler is registered on this exec daemon\.\)$/);
  const b=await run(tmp(),'rs',{id:1,recordScreenArgs:{}});
  assert.match(b[0].message.throw.error,/^Screen recording is not enabled for this environment.*\(No record-screen handler is registered on this exec daemon\.\)$/);
});

test('outputNotification + no registry: spawn writes only terminals/{id}.txt and replies success+streamClose',async()=>{
  const root=tmp();
  const f=await run(root,'sp',{id:1,backgroundShellSpawnArgs:{command:'echo NOTIFY-ME',workingDirectory:'',outputNotification:{pattern:'NOTIFY'}}});
  assert.equal(f.length,2); assert.ok(f[0].message.backgroundShellSpawnResult.success); assert.ok(f[1].message.streamClose);
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(fs.readdirSync(root).sort(),['terminals']);
  assert.deepEqual(fs.readdirSync(path.join(root,'terminals')),[`${f[0].message.backgroundShellSpawnResult.success.shellId}.txt`]);
});

test('BACKGROUND handoff: no completion reply after the adopted shell exits (no completion queue)',async()=>{
  const root=tmp(); const frames=[];
  await H.dispatchExec({root,requestId:'bg',permission:'always',emit:x=>{frames.push(x)},
    serverMessage:{id:1,shellStreamArgs:{command:'sleep 0.3; echo DONE',workingDirectory:'',timeout:50,timeoutBehavior:'TIMEOUT_BEHAVIOR_BACKGROUND'}}});
  const n=frames.length; await new Promise(r=>setTimeout(r,900));
  assert.equal(frames.length,n,'no frames after backgrounded+streamClose');
  assert.ok(frames.some(x=>x.message?.shellStream?.backgrounded)); assert.ok(!frames.some(x=>x.message?.shellStream?.exit));
  const id=frames.find(x=>x.message?.shellStream?.backgrounded).message.shellStream.backgrounded.shellId;
  assert.match(fs.readFileSync(path.join(root,'terminals',`${id}.txt`),'utf8'),/DONE[\s\S]*exit_code: 0/);
});

const {spawn}=require('node:child_process');
const {BackgroundShellManager}=require('../dist/exec/background-shell');

test('outputNotification: immediate-exit command is not left running after adopt',async()=>{
  const root=tmp();
  const f=await run(root,'sp2',{id:1,backgroundShellSpawnArgs:{command:'echo NOTIFY-ME',workingDirectory:'',outputNotification:{pattern:'NOTIFY'}}});
  const id=f[0].message.backgroundShellSpawnResult.success.shellId;
  const mgr=require('../dist/exec/background-shell').backgroundShellManagerFor(root);
  const start=Date.now();
  while(mgr.isRunning(id) && Date.now()-start<2000) await new Promise(r=>setTimeout(r,20));
  assert.equal(mgr.isRunning(id),false,'header timer must stop after an already-exited spawn');
  assert.match(fs.readFileSync(path.join(root,'terminals',`${id}.txt`),'utf8'),/exit_code: 0/);
});

test('adopt of an already-exited child writes exit_code and lets the process exit',async()=>{
  const script= `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {BackgroundShellManager}=require(${JSON.stringify(require('node:path').join(__dirname,'../dist/exec/background-shell'))});
    (async()=>{
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'t181-exited-'));
      const child=spawn('true',[],{stdio:['ignore','pipe','pipe']});
      await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
      const mgr=new BackgroundShellManager(root);
      const id=mgr.generateShellId();
      await mgr.adopt({shellId:id,command:'true',workingDirectory:root,pid:child.pid,initialOutput:'',startTime:Date.now(),child});
      const start=Date.now();
      while(mgr.isRunning(id) && Date.now()-start<2000) await new Promise(r=>setTimeout(r,20));
      if(mgr.isRunning(id)) { process.stderr.write('still running after adopt\\n'); process.exit(3); }
      const text=fs.readFileSync(path.join(root,'terminals',id+'.txt'),'utf8');
      if(!/exit_code: 0/.test(text)) { process.stderr.write('missing exit_code\\n'); process.exit(4); }
    })().catch((e)=>{ process.stderr.write(String(e)+'\\n'); process.exit(1); });
  `;
  const child=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe']});
  let out='';
  child.stdout.on('data',(d)=>{out+=d;});
  child.stderr.on('data',(d)=>{out+=d;});
  const result=await new Promise((resolve)=>{
    const t=setTimeout(()=>{child.kill('SIGKILL');resolve({code:'timeout',out});},5000);
    child.once('close',(code,signal)=>{clearTimeout(t);resolve({code:code??signal,out});});
  });
  assert.equal(result.code,0,result.out||'subprocess should exit 0 after adopt of an already-exited child');
});
