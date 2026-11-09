// Fixed expectations from Ki/wE/UC static evidence. No official code/package loaded.
const test=require('node:test'),assert=require('node:assert/strict');
const {createWritableIterable,withExecChannelHeartbeat}=require('../dist/exec/output-channel');
const {withExecHeartbeat}=require('../dist/exec/handlers');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const tick=async()=>{for(let i=0;i<60;i++)await Promise.resolve()};
const frame=n=>({kind:'control',requestId:'synthetic',message:{streamClose:{id:n}}});
test('Ki queued producer blocks before and after first delivery; NEXT pull acknowledges',async()=>{
 const c=createWritableIterable(),it=c[Symbol.asyncIterator]();let done=false;const w=c.write('a').then(()=>done=true);await tick();assert.equal(done,false);assert.equal((await it.next()).value,'a');await tick();assert.equal(done,false);const next=it.next();await w;assert.equal(done,true);c.close();assert.equal((await next).done,true);
});
test('Ki waiting reader delivery still requires next pull; prefetch exception matches original',async()=>{
 const c=createWritableIterable(),it=c[Symbol.asyncIterator](),read=it.next();let done=false;const w=c.write('a').then(()=>done=true);await read;await tick();assert.equal(done,false);const next=it.next();await w;c.close();await next;
 const d=createWritableIterable(),di=d[Symbol.asyncIterator](),a=di.next(),b=di.next();let first=false,second=false;const wa=d.write('a').then(()=>first=true),wb=d.write('b').then(()=>second=true);await tick();assert.equal(first,true);assert.equal(second,false);assert.equal((await a).value,'a');assert.equal((await b).value,'b');const more=di.next();await Promise.all([wa,wb]);d.close();await more;
});
test('Ki close acknowledges delivered, rejects queued, completes readers; reentry and later writes',async()=>{
 const c=createWritableIterable(),it=c[Symbol.asyncIterator](),a=c.write('a'),b=c.write('b').catch(e=>e);await it.next();c.close();c.close();await a;assert.equal((await b).name,'WriteIterableClosedError');assert.equal((await it.next()).done,true);assert.equal((await c.write('late').catch(e=>e)).name,'WriteIterableClosedError');
 const d=createWritableIterable(),di=d[Symbol.asyncIterator](),reader=di.next();d.close();assert.equal((await reader).done,true);
});
test('Ki throw preserves error identity for delivered/queued/pending/subsequent operations',async()=>{
 const c=createWritableIterable(),it=c[Symbol.asyncIterator](),error=Error('synthetic');const a=c.write('a').catch(e=>e),b=c.write('b').catch(e=>e);await it.next();c.throw(error);c.throw(Error('ignored'));assert.equal(await a,error);assert.equal(await b,error);assert.equal(await it.next().catch(e=>e),error);assert.equal(await c.write('late').catch(e=>e),error);
 const d=createWritableIterable(),di=d[Symbol.asyncIterator](),read=di.next().catch(e=>e);d.throw(error);assert.equal(await read,error);
});
test('Ki iterator return / throw settle pending operations with original return-vs-throw distinction',async()=>{
 const c=createWritableIterable(),it=c[Symbol.asyncIterator](),a=c.write('a'),b=c.write('b').catch(e=>e);await it.next();await it.return();await a;assert.match((await b).message,/Iterator was closed/);assert.equal((await it.next()).done,true);
 const d=createWritableIterable(),di=d[Symbol.asyncIterator](),error=Error('iterator throw'),read=di.next().catch(e=>e);await di.throw(error);assert.equal(await read,error);assert.equal(await di.next().catch(e=>e),error);
});
test('bridge Promise consumer extension holds producer ack until next pull; normal completion drains all frames',async()=>{
 const gate=defer(),out=[];let firstAck=false,finallyRan=false;
 const job=withExecChannelHeartbeat('synthetic',1,f=>{out.push(f);if(out.length===1)return gate.promise},async write=>{try{await write(frame(1));firstAck=true;await write(frame(2))}finally{finallyRan=true}});
 await tick();assert.equal(out.length,1);assert.equal(firstAck,false);gate.resolve();await job;assert.equal(firstAck,true);assert.equal(finallyRan,true);assert.deepEqual(out.map(f=>f.message.streamClose.id),[1,2]);
});
test('heartbeat waits for next pull, not delivery, when a consumer is gated',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const gate=defer(),finish=defer(),out=[];let blocked=true;
 const job=withExecChannelHeartbeat('synthetic',1,f=>{out.push(f);if(blocked)return gate.promise},()=>finish.promise);
 t.mock.timers.tick(3000);await tick();assert.equal(out.length,1);t.mock.timers.tick(9000);await tick();assert.equal(out.length,1);
 blocked=false;gate.resolve();await tick();t.mock.timers.tick(2999);await tick();assert.equal(out.length,1);t.mock.timers.tick(1);await tick();assert.equal(out.length,2);finish.resolve();await job;
});
test('UC streamClose is a message, not channel close: heartbeat can follow until producer finally; legacy Box unchanged',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const gate=defer(),out=[];let ack=false;
 const job=withExecChannelHeartbeat('synthetic',1,f=>{out.push(f)},async write=>{await write(frame(1));ack=true;await gate.promise});await tick();assert.equal(ack,true);t.mock.timers.tick(3000);await tick();assert.equal(out.length,2);assert.ok(out[1].message.heartbeat);gate.resolve();await job;t.mock.timers.tick(30000);await tick();assert.equal(out.length,2);
 const legacy=defer(),old=[];const box=withExecHeartbeat('synthetic',1,f=>{old.push(f)},async emit=>{await emit(frame(1));await legacy.promise});await tick();t.mock.timers.tick(3000);await tick();assert.equal(old.length,1);legacy.resolve();await box;
});
test('sync and async consumer errors close pending writes, cancel context, run producer finally, no unhandled rejection',async()=>{
 const unhandled=[];const onError=e=>unhandled.push(e);process.on('unhandledRejection',onError);
 try{for(const mode of ['sync','async']){let finallyRan=false,cancels=0;const error=Error('consumer '+mode);
 const job=withExecChannelHeartbeat('synthetic',1,()=>{if(mode==='sync')throw error;return Promise.reject(error)},async write=>{try{await write(frame(1));await write(frame(2))}finally{finallyRan=true}},()=>{cancels++});
 await assert.rejects(job,e=>e===error);await tick();assert.equal(cancels,1);assert.equal(finallyRan,true);
 }await new Promise(r=>setImmediate(r));assert.deepEqual(unhandled,[])}finally{process.off('unhandledRejection',onError)}
});
test('unexpected producer error propagates through channel to outer executor without hanging consumer',async()=>{
 const error=Error('synthetic producer');let finallyRan=false;const out=[];
 const job=withExecChannelHeartbeat('synthetic',1,f=>{out.push(f)},async write=>{try{await write(frame(1));throw error}finally{finallyRan=true}});
 await assert.rejects(job,e=>e===error);assert.equal(finallyRan,true);assert.equal(out.length,1);
});
