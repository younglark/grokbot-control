// t139: actual compiled discovery/trace components, synthetic files and deterministic read gates only.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const discoveryCode=fs.readFileSync(path.join(__dirname,'../dist/state/discovery.js'),'utf8');
const traceCode=fs.readFileSync(path.join(__dirname,'../dist/trace.js'),'utf8');
const prefix='discovery:load-read-';
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
function setup(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uc-read-trace-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const target=path.join(root,'local-exec-daemon.json'),log=path.join(root,'trace.jsonl');
 const exitHandlers=[];let clock=0,clockReads=0,appendCalls=0,readCalls=0;
 const readFile=(...args)=>{readCalls++;assert.equal(args[0],target);assert.equal(args[1],'utf8');return options.readFile?options.readFile(...args):fs.promises.readFile(...args)};
 const fsShim={promises:{readFile},appendFileSync:(...args)=>{appendCalls++;if(options.appendFailure)throw Object.assign(Error('SYNTHETIC_TRACE_WRITE_FAILURE'),{code:'EIO'});return fs.appendFileSync(...args)}};
 const fakeProcess={pid:12345,env:options.enabled===false?{}:{LED_LIFECYCLE_TRACE:log,LED_LIFECYCLE_TRACE_MODE:options.mode??''},once:(ev,fn)=>{assert.equal(ev,'exit');exitHandlers.push(fn)}};
 const perf={timeOrigin:1000000,now:()=>{clockReads++;return ++clock}};
 function evaluate(code,modules){
  const module={exports:{}};
  const fn=vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{process:fakeProcess,performance:perf});
  fn(name=>{assert.ok(Object.hasOwn(modules,name),'unexpected module '+name);return modules[name]},module,module.exports);return module.exports;
 }
 const trace=evaluate(traceCode,{'node:fs':fsShim});
 const discovery=evaluate(discoveryCode,{'node:fs':fsShim,'node:path':path,'../trace':trace,'../util':{dataRootFromEnv:env=>env.SAND_DATA_ROOT,filesKeyIdFromBase64Key:()=>{throw Error('not used')},writeAtomic:()=>{throw Error('not used')}}});
 return{root,target,log,load:()=>discovery.loadDiscovery({SAND_DATA_ROOT:root}),write:value=>fs.writeFileSync(target,value),events:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],flush:()=>exitHandlers.forEach(fn=>fn()),advance:n=>{clock+=n},get appendCalls(){return appendCalls},get readCalls(){return readCalls},get clockReads(){return clockReads},get exitHandlerCount(){return exitHandlers.length}};
}
function sequence(h,names,{outcome,code,result,reason,owner}={}){
 const events=h.events();assert.deepEqual(events.map(e=>e.ev),names.map(n=>prefix+n));
 for(let i=0;i<events.length;i++){
  const e=events[i];assert.equal(e.pid,12345);assert.equal(e.readId,1);assert.equal(e.timeOrigin,1000000);assert.equal(e.w,e.timeOrigin+e.monoMs);if(i)assert.ok(e.monoMs>events[i-1].monoMs);
  assert.ok(Object.keys(e).every(k=>['w','monoMs','timeOrigin','pid','ev','readId','outcome','code','result','reason','owner'].includes(k)),Object.keys(e).join(','));
 }
 assert.equal(events.at(-1).outcome,outcome);
 if(code!==undefined)assert.equal(events.find(e=>e.ev===prefix+'io-error').code,code);
 if(result!==undefined){const parsed=events.find(e=>e.ev===prefix+'parse-end');assert.equal(parsed.result,result);if(reason!==undefined)assert.equal(parsed.reason,reason);if(owner!==undefined)assert.equal(parsed.owner,owner)}
 return events;
}

test('successful read separates observed I/O completion from parse/record result, without logging contents or paths',async t=>{
 const h=setup(t);h.write(JSON.stringify({pid:77,startedAt:1,filesKeyId:'SYNTHETIC_DO_NOT_LOG',credential:'SYNTHETIC_DO_NOT_LOG',servingAt:2,inflightCount:3,generation:4}));
 const record=await h.load();assert.equal(record.pid,77);assert.equal(record.filesKeyId,'SYNTHETIC_DO_NOT_LOG');assert.equal(h.readCalls,1);
 sequence(h,['start','io-end','parse-end','end'],{outcome:'record',result:'record',owner:77});const text=fs.readFileSync(h.log,'utf8');assert.ok(!text.includes('SYNTHETIC_DO_NOT_LOG'));assert.ok(!text.includes(h.root));
});

test('ENOENT is paired start/io-error/end with missing fallback and no parse event',async t=>{
 const h=setup(t);assert.equal(await h.load(),null);sequence(h,['start','io-error','end'],{outcome:'missing',code:'ENOENT'});assert.equal(h.readCalls,1);
});

test('damaged JSON has successful I/O and invalid-json parse result, never an I/O failure',async t=>{
 const h=setup(t);h.write('{"SYNTHETIC_DO_NOT_LOG":');assert.equal(await h.load(),null);sequence(h,['start','io-end','parse-end','end'],{outcome:'invalid-json',result:'invalid-json'});assert.ok(!fs.readFileSync(h.log,'utf8').includes('SYNTHETIC_DO_NOT_LOG'));
});

test('valid JSON with invalid record shapes retains null fallback and emits semantic parse outcome',async t=>{
 for(const [value,reason] of [[{pid:'SYNTHETIC_DO_NOT_LOG',startedAt:1},'pid'],[{pid:0,startedAt:1},'pid'],[{pid:1},'startedAt'],[null,undefined]]){
  const h=setup(t);h.write(JSON.stringify(value));assert.equal(await h.load(),null);sequence(h,['start','io-end','parse-end','end'],{outcome:'invalid-record',result:'invalid-record',reason});assert.ok(!fs.readFileSync(h.log,'utf8').includes('SYNTHETIC_DO_NOT_LOG'));
 }
});

test('deterministic EACCES emits only error code, preserving read-failure null fallback',async t=>{
 const h=setup(t,{readFile:async()=>{throw Object.assign(Error('SYNTHETIC_DO_NOT_LOG'),{code:'EACCES',path:'SYNTHETIC_DO_NOT_LOG'})}});
 assert.equal(await h.load(),null);sequence(h,['start','io-error','end'],{outcome:'io-error',code:'EACCES'});assert.ok(!fs.readFileSync(h.log,'utf8').includes('SYNTHETIC_DO_NOT_LOG'));
});

test('concurrent reads finish out of order while all I/O and result events retain their own correlation',async t=>{
 const a=defer(),b=defer();let n=0;const h=setup(t,{readFile:()=>++n===1?a.promise:b.promise});const first=h.load(),second=h.load();
 assert.deepEqual(h.events().map(e=>[e.ev,e.readId]),[[prefix+'start',1],[prefix+'start',2]]);
 b.resolve('{"pid":202,"startedAt":1}');assert.equal((await second).pid,202);
 assert.deepEqual(h.events().map(e=>e.readId),[1,2,2,2,2]);a.resolve('{"pid":101,"startedAt":1}');assert.equal((await first).pid,101);
 const events=h.events();assert.deepEqual(events.map(e=>e.readId),[1,2,2,2,2,1,1,1]);
 for(const [id,owner] of [[1,101],[2,202]]){const group=events.filter(e=>e.readId===id);assert.deepEqual(group.map(e=>e.ev),['start','io-end','parse-end','end'].map(s=>prefix+s));assert.equal(group[2].owner,owner);assert.equal(group[3].outcome,'record')}
 assert.equal(h.readCalls,2);
});

test('default disabled performs no trace write/clock read/exit hook for success, invalid JSON and failed I/O',async t=>{
 let mode='record';const h=setup(t,{enabled:false,readFile:async()=>{if(mode==='record')return '{"pid":5,"startedAt":1}';if(mode==='invalid')return '{';throw Object.assign(Error('synthetic'),{code:'ENOENT'})}});
 assert.equal((await h.load()).pid,5);mode='invalid';assert.equal(await h.load(),null);mode='missing';assert.equal(await h.load(),null);
 assert.equal(h.readCalls,3);assert.equal(h.appendCalls,0);assert.equal(h.clockReads,0);assert.equal(h.exitHandlerCount,0);assert.equal(fs.existsSync(h.log),false);
});

test('buffered mode timestamps events at the read boundaries, not at later exit flush',async t=>{
 const h=setup(t,{mode:'buffered'});h.write('{"pid":9,"startedAt":1}');assert.equal((await h.load()).pid,9);assert.equal(h.appendCalls,0);assert.equal(h.exitHandlerCount,1);h.advance(10000);h.flush();assert.equal(h.appendCalls,1);
 const events=sequence(h,['start','io-end','parse-end','end'],{outcome:'record',result:'record',owner:9});assert.deepEqual(events.map(e=>e.monoMs),[1,2,3,4]);
});

test('trace destination write failure cannot change successful read or null fallback',async t=>{
 let failRead=false;const h=setup(t,{appendFailure:true,readFile:async()=>{if(failRead)throw Object.assign(Error('synthetic'),{code:'EIO'});return '{"pid":11,"startedAt":1}'}});
 assert.equal((await h.load()).pid,11);failRead=true;assert.equal(await h.load(),null);assert.equal(h.appendCalls,7);assert.equal(h.readCalls,2);
});

test('unknown or hostile read error codes do not leak error messages or break fallback',async t=>{
 for(const error of [Error('SYNTHETIC_DO_NOT_LOG'),{code:'SYNTHETIC private secret'},Object.defineProperty({},'code',{get(){throw Error('SYNTHETIC_DO_NOT_LOG')}})]){
  const h=setup(t,{readFile:async()=>{throw error}});assert.equal(await h.load(),null);sequence(h,['start','io-error','end'],{outcome:'io-error',code:'UNKNOWN'});assert.ok(!fs.readFileSync(h.log,'utf8').includes('SYNTHETIC'));
 }
});
