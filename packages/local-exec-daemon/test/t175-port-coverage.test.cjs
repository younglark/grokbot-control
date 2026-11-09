// t175 port-coverage fixes (static evidence in docs/local-exec/port-coverage.md). Synthetic HOME/data only;
// never runs official code. Settings dedupe is per process, so settings cases run in child processes.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync,spawn}=require('node:child_process');
const dist=path.join(__dirname,'..','dist');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'t175-'));

test('crash guard (pTe/V7t D:78686–78712): uncaught errors are logged "(kept alive)" and the process stays up', async()=>{
  const src=`const {installCrashGuard}=require(${JSON.stringify(path.join(dist,'bootstrap','crash-guard'))});
const g=installCrashGuard('sand-local-exec-daemon');
setTimeout(()=>{throw new Error('boom-sync')},5);
setTimeout(()=>{Promise.reject(new Error('boom-async'))},10);
setTimeout(()=>{g.setReporter(()=>{throw new TypeError('rep')});throw new Error('boom-2')},20);
setTimeout(()=>{process.stdout.write('ALIVE');process.exit(0)},60);`;
  const r=spawnSync(process.execPath,['-e',src],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0); assert.equal(r.stdout,'ALIVE');
  assert.match(r.stderr,/\[sand-local-exec-daemon\] uncaughtException \(kept alive\): Error$/m);
  assert.match(r.stderr,/\[sand-local-exec-daemon\] unhandledRejection \(kept alive\): Error$/m);
  assert.match(r.stderr,/sand\.host\.crash_reporter_failed kind=uncaughtException error_class=/);
});

test('clearOwnDiscovery (PLe D:81000–81004) removes only a record naming this pid', async()=>{
  const {publishDiscovery,clearOwnDiscovery,discoveryPath}=require(path.join(dist,'state','discovery'));
  const env={SAND_DATA_ROOT:tmp()};
  await publishDiscovery({pid:424242,startedAt:1},undefined,env);
  assert.equal(await clearOwnDiscovery(process.pid,env),false);
  assert.ok(fs.existsSync(discoveryPath(env)));
  await publishDiscovery({pid:process.pid,startedAt:2},undefined,env);
  assert.equal(await clearOwnDiscovery(process.pid,env),true);
  assert.ok(!fs.existsSync(discoveryPath(env)));
  assert.equal(await clearOwnDiscovery(process.pid,env),false); // missing file: fail-open
});

function settingsChild(doc){
  const root=tmp(); fs.writeFileSync(path.join(root,'settings.json'),doc);
  const src=`const S=require(${JSON.stringify(path.join(dist,'settings'))});
const a=S.loadSettingsSync({SAND_DATA_ROOT:${JSON.stringify(root)}});S.loadSettingsSync({SAND_DATA_ROOT:${JSON.stringify(root)}});
process.stdout.write(JSON.stringify({permission:a.permission,damaged:a.damaged}));`;
  const r=spawnSync(process.execPath,['-e',src],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr); return {out:JSON.parse(r.stdout),err:r.stderr};
}
test('settings full schema (zqt/jUe): an invalid sibling field makes the file unreadable → ask, logged once', ()=>{
  const {out,err}=settingsChild(JSON.stringify({version:1,localToolPermission:'always',themePreference:'not-a-theme'}));
  assert.deepEqual(out,{permission:'ask',damaged:true});
  const lines=err.split('\n').filter(l=>l.includes('durable file damaged'));
  assert.equal(lines.length,1); assert.match(lines[0],/^\[local-exec-daemon\] durable file damaged path=settings\.json cause=.* copy=none$/);
});
test('settings: other numeric version → "durable file unsupported" (tGt)', ()=>{
  const {out,err}=settingsChild(JSON.stringify({version:2,localToolPermission:'always'}));
  assert.deepEqual(out,{permission:'ask',damaged:true});
  assert.match(err,/^\[local-exec-daemon\] durable file unsupported path=settings\.json version=2$/m);
});
test('settings: bad JSON → damaged SyntaxError line; valid file → no log', ()=>{
  const bad=settingsChild('{nope');
  assert.match(bad.err,/durable file damaged path=settings\.json cause=SyntaxError/);
  const ok=settingsChild(JSON.stringify({version:1,localToolPermission:'always'}));
  assert.deepEqual(ok.out,{permission:'always',damaged:false}); assert.doesNotMatch(ok.err,/durable file/);
});

test('t5e/i5r: shell timeout 0 defaults to 30 s unless background/hardTimeout', ()=>{
  const {shellTimeoutMs,DEFAULT_SHELL_TIMEOUT_MS}=require(path.join(dist,'exec','handlers'));
  assert.equal(DEFAULT_SHELL_TIMEOUT_MS,30000);
  assert.equal(shellTimeoutMs({}),30000);
  assert.equal(shellTimeoutMs({timeout:0}),30000);
  assert.equal(shellTimeoutMs({timeout:5000}),5000);
  assert.equal(shellTimeoutMs({isBackground:true}),0);
  assert.equal(shellTimeoutMs({timeoutBehavior:'TIMEOUT_BEHAVIOR_BACKGROUND'}),0);
  assert.equal(shellTimeoutMs({timeoutBehavior:'TIMEOUT_BEHAVIOR_CANCEL'}),30000);
  assert.equal(shellTimeoutMs({hardTimeout:1000}),0);
  assert.equal(shellTimeoutMs({timeout:7,isBackground:true}),7);
});

test('dispatchExec with pullOutput (now also the Box path) delivers output and streamClose', async()=>{
  // Indirect check via the shared dispatcher: with pullOutput the producer's frames still arrive in order.
  const H=require(path.join(dist,'exec','handlers'));
  const frames=[]; const root=tmp();
  await H.dispatchExec({root,requestId:'r-ki',serverMessage:{id:1,shellStreamArgs:{command:'echo KI',workingDirectory:''}},permission:'always',pullOutput:true,emit:f=>{frames.push(f)}});
  const text=JSON.stringify(frames);
  assert.match(text,/KI/); assert.match(text,/streamClose/);
});
