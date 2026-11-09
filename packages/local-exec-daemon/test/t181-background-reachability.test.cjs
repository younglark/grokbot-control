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
