'use strict';
// Server bytes are independently authored; only the system-under-test uses generated types.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createClient,ConnectError,Code}=require('@connectrpc/connect');
const {createConnectTransport}=require('@connectrpc/connect-node');
const wire=require('./helpers/wire-oracle.cjs');
const m=require('../dist/generated/aiserver.v1_pb');
const {GrokBotService}=require('../dist/generated/svc_aiserver.v1.GrokBotService_connect');
const {parseQueued}=require('../dist/uc/provider');

async function fixture(handle,run){
 const server=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>handle(req,res,Buffer.concat(chunks)))});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const client=createClient(GrokBotService,createConnectTransport({baseUrl:`http://127.0.0.1:${server.address().port}`,httpVersion:'1.1',useBinaryFormat:true}));
 try{await run(client)}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
}

test('generated runtime preserves unknown fields, last-oneof-wins and exact >2^53 int64',()=>{
 const frame=Buffer.concat([wire.encStr(1,'request'),wire.encMsg(2,wire.encStr(1,'{"id":1}')),wire.encMsg(6,Buffer.alloc(0))]);
 const raw=Buffer.concat([wire.encStr(1,'queue'),wire.encMsg(2,frame),wire.encInt64(3,9007199254740993n),wire.encStr(99,'future')]);
 const item=m.GrokBotUserComputerQueuedRequest.fromBinary(raw);
 assert.equal(item.enqueuedAtMs,9007199254740993n);assert.equal(item.toJson().enqueuedAtMs,'9007199254740993');
 assert.equal(item.frame.frame.case,'cancel');assert.equal(parseQueued(item).kind,6);
 assert.equal(wire.firstStr(wire.decodeFields(Buffer.from(item.toBinary())),99),'future');
 assert.equal(m.GrokBotUserComputerQueuedRequest.fromJson(item.toJson()).enqueuedAtMs,9007199254740993n);
});

test('generated oneof/JSON canonical mapping rejects invalid int64, accepts unknown binary case as unsupported',()=>{
 assert.throws(()=>m.GrokBotUserComputerQueuedRequest.fromJson({enqueuedAtMs:'not-int64'}));
 const raw=Buffer.concat([wire.encStr(1,'q'),wire.encMsg(2,Buffer.concat([wire.encStr(1,'r'),wire.encMsg(80,Buffer.alloc(0))]))]);
 assert.match(parseQueued(m.GrokBotUserComputerQueuedRequest.fromBinary(raw)).parseError,/understand/);
});

test('Connect HTTP/1.1 handles split envelopes and successful EndStream metadata', {timeout:4000},async()=>{
 await fixture((req,res,body)=>{
  assert.equal(req.httpVersion,'1.1');assert.equal(req.url,'/aiserver.v1.GrokBotService/WatchGrokBotUserComputerRequests');
  assert.equal(req.headers['content-type'],'application/connect+proto');
  const request=wire.decodeFields(wire.takeEnvelopes(body).messages[0]);assert.equal(wire.firstStr(request,2),'synthetic-only');
  const bytes=Buffer.concat([wire.envelope(wire.encMsg(1,Buffer.alloc(0))),wire.envelope(wire.encMsg(2,Buffer.alloc(0))),wire.endEnvelope({metadata:{'x-lab':['yes']}})]);
  res.writeHead(200,{'content-type':'application/connect+proto'});res.write(bytes.subarray(0,3));setTimeout(()=>res.end(bytes.subarray(3)),5);
 },async client=>{const events=[];for await(const e of client.watchGrokBotUserComputerRequests({credential:'synthetic-only'},{timeoutMs:2000}))events.push(e.event.case);assert.deepEqual(events,['connected','notify'])});
});

test('Connect EndStream auth codes and malformed/truncated framing are surfaced, not swallowed', {timeout:6000},async()=>{
 for(const payload of [wire.endEnvelope({error:{code:'unauthenticated',message:'synthetic'}}),Buffer.from('00000000050a','hex')]){
  await fixture((req,res)=>{res.writeHead(200,{'content-type':'application/connect+proto'});res.end(payload)},async client=>{
   await assert.rejects(async()=>{for await(const e of client.watchGrokBotUserComputerRequests({},{timeoutMs:1000}))void e},error=>error instanceof ConnectError&&(payload[0]===2?error.code===Code.Unauthenticated:true));
  });
 }
});

test('Connect malformed nested protobuf rejects complete Poll response; repaired next Poll works', {timeout:4000},async()=>{
 let round=0;
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'application/proto'});res.end(round++===0?wire.encMsg(1,Buffer.concat([wire.encStr(1,'identified'),Buffer.from('12ff','hex')])):Buffer.alloc(0))},async client=>{
  await assert.rejects(()=>client.pollGrokBotUserComputerRequests({},{timeoutMs:1000}));
  assert.deepEqual((await client.pollGrokBotUserComputerRequests({},{timeoutMs:1000})).requests,[]);
 });
});

test('available inner policy enums use generated canonical JSON names/numbers',()=>{
 const {SandboxPolicy,ShellAbortReason}=require('../dist/generated/agent.v1_pb');
 const {proto3}=require('@bufbuild/protobuf');
 assert.deepEqual(SandboxPolicy.fromJson({type:'TYPE_INSECURE_NONE'}).toJson(),{type:'TYPE_INSECURE_NONE'});
 assert.equal(SandboxPolicy.fromJson({type:99}).toJson().type,99);
 assert.equal(proto3.getEnumType(ShellAbortReason).findNumber(ShellAbortReason.TIMEOUT).name,'SHELL_ABORT_REASON_TIMEOUT');
 assert.throws(()=>SandboxPolicy.fromJson({type:'NOT_AN_ENUM'}));
});

test('Watch AbortSignal cancels HTTP/1.1 stream and HTTP401 maps to auth status', {timeout:6000},async()=>{
 await fixture((req,res)=>{res.writeHead(200,{'content-type':'application/connect+proto'});res.write(wire.envelope(wire.encMsg(1,Buffer.alloc(0))))},async client=>{
  const controller=new AbortController();let count=0;
  await assert.rejects(async()=>{for await(const e of client.watchGrokBotUserComputerRequests({},{signal:controller.signal,timeoutMs:2000})){count++;controller.abort()}},error=>error instanceof ConnectError&&error.code===Code.Canceled);
  assert.equal(count,1);
 });
 await fixture((req,res)=>{res.writeHead(401);res.end()},async client=>{
  await assert.rejects(()=>client.submitGrokBotUserComputerResponses({},{timeoutMs:1000}),error=>error instanceof ConnectError&&error.code===Code.Unauthenticated);
 });
});
