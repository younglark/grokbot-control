// Synthetic assertion/opt-in checks only: this test never launches the official daemon.
const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
const dir=path.join(__dirname,'../scripts/oracles/ownership');
const {OFFICIAL_LOG,OFFICIAL_SHA256,assertSupersededExit}=require(path.join(dir,'assertions.cjs'));
test('oracle exact official superseded literal accepts actual output, rejects the historical approximate literal',()=>{
 const ok={code:0,signal:null};assert.doesNotThrow(()=>assertSupersededExit('[sand-local-exec-daemon] started (pid 9); serving local exec over the gateway\n'+OFFICIAL_LOG+'\n',ok,'official'));
 assert.throws(()=>assertSupersededExit('[sand-local-exec-daemon] received superseded, shutting down\n',ok,'official'));
 assert.throws(()=>assertSupersededExit(OFFICIAL_LOG,{code:1,signal:null},'official'));
 assert.throws(()=>assertSupersededExit(OFFICIAL_LOG,{code:null,signal:'SIGTERM'},'official'));
 assert.throws(()=>assertSupersededExit('prefix '+OFFICIAL_LOG,ok,'official'));
});
test('t171: the independent daemon prints the original superseded text (l$t D:79742–79747); the old shortened literal is rejected',()=>{
 const old='[sand-local-exec-daemon] received superseded, shutting down\n';
 assert.doesNotThrow(()=>assertSupersededExit(OFFICIAL_LOG+'\n',{code:0,signal:null},'implementation'));
 assert.throws(()=>assertSupersededExit(old,{code:0,signal:null},'implementation'));
 assert.throws(()=>assertSupersededExit(OFFICIAL_LOG,{code:0,signal:null},'unknown'));
});
test('oracle is opt-in with mandatory explicit artifact/runtime: no-argument invocation refuses before any daemon',()=>{
 const run=cp.spawnSync('python3',[path.join(dir,'launch.py')],{encoding:'utf8'});
 assert.equal(run.status,2);assert.match(run.stderr,/--artifact/);assert.match(run.stderr,/--node/);
 const node=cp.spawnSync(process.execPath,[path.join(dir,'run.cjs')],{encoding:'utf8'});
 assert.notEqual(node.status,0);assert.match(node.stderr,/no default execution/);
});
test('historical results preserve inner timeout and first official harness failure, rather than claiming all green',()=>{
 const data=JSON.parse(fs.readFileSync(path.join(dir,'historical-official.json')));
 assert.equal(OFFICIAL_SHA256,'5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be');
 assert.equal(data.officialProcesses,2);assert.match(data.firstScenario.businessExpectation,/FAILED/);
 assert.match(data.firstScenario.harnessStatus,/exit 1/);assert.equal(data.control.results[0].exit.code,0);
 assert.equal(data.historicalTimeoutRootCause,'NOT established');assert.equal(data.officialDefaultOwnershipMs,10000);
});
