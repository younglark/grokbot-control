// t169: Box requests stream via global fetch exactly as streamRequests (D:137396–137402, cmt D:137186, Owr D:137205):
// undici default headers, `!m.ok || body == null` (any 2xx), redirect "follow" (fetch default), getReader +
// TextDecoder({stream:true}) parsing. Synthetic local peer only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {BoxProvider}=require('../dist/box/provider');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await delay(10)}throw Error('deadline')}
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'t169-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}

async function peer(t,onGet,heartbeatMs=60000){
 const root=dir(t),data=dir(t),old=process.env.SAND_DATA_ROOT;process.env.SAND_DATA_ROOT=data;
 fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({version:1,localToolPermission:'always'}));
 const gets=[],bodies=[],streams=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  if(req.method==='GET'){gets.push({url:req.url,raw:req.rawHeaders,headers:req.headers});streams.push(res);onGet(req,res,gets.length)}
  else{bodies.push(JSON.parse(body));res.writeHead(200);res.end('{}')}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={baseUrl:`http://127.0.0.1:${server.address().port}`,token:'synthetic-token',headers:{'x-anyrun-network-token':'synthetic-net'}};
 const provider=new BoxProvider({connection,root,computerId:'synthetic',label:'lab',permission:'always',sidecar:()=>undefined,heartbeatMs});
 const running=provider.start();
 t.after(async()=>{await provider.stop();for(const s of streams)s.destroy();await Promise.race([running,delay(50)]);server.closeAllConnections?.();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.SAND_DATA_ROOT;else process.env.SAND_DATA_ROOT=old});
 return{gets,bodies,hello:()=>bodies.filter(b=>b.frames[0].kind==='hello')};
}
const sse=(res,status=200)=>{res.writeHead(status,{'content-type':'text/event-stream'});res.write(':\n\n')};

test('GET headers: cmt order (accept, connection headers, authorization) plus undici defaults, as global fetch sends them',{timeout:10000},async t=>{
 const p=await peer(t,(q,r)=>sse(r));
 await until(()=>p.hello().length===1);
 const h=[];for(let i=0;i<p.gets[0].raw.length;i+=2)h.push([p.gets[0].raw[i].toLowerCase(),p.gets[0].raw[i+1]]);
 assert.deepEqual(h.filter(([k])=>k!=='host'),[['connection','keep-alive'],['accept','text/event-stream'],['x-anyrun-network-token','synthetic-net'],['authorization','Bearer synthetic-token'],
  ['accept-language','*'],['sec-fetch-mode','cors'],['user-agent','node'],['accept-encoding','gzip, deflate']]);
});

test('any 2xx with a body is a connected stream (m.ok), not only 200',{timeout:10000},async t=>{
 const p=await peer(t,(q,r)=>sse(r,203));
 await until(()=>p.hello().length===1);
 assert.equal(p.gets.length,1);
});

test('redirects are followed (fetch default redirect:"follow")',{timeout:10000},async t=>{
 const p=await peer(t,(q,r)=>{if(q.url==='/local-exec/requests'){r.writeHead(307,{location:'/moved/requests'});r.end()}else sse(r)});
 await until(()=>p.hello().length===1);
 assert.deepEqual(p.gets.map(g=>g.url),['/local-exec/requests','/moved/requests']);
 assert.equal(p.gets[1].headers.authorization,'Bearer synthetic-token'); // same-origin redirect keeps it
});

test('non-2xx → j5e failure: no hello, retried after the 1 s backoff',{timeout:10000},async t=>{
 const p=await peer(t,(q,r,n)=>{if(n<2){r.writeHead(503);r.end('no')}else sse(r)});
 await until(()=>p.hello().length===1,4000);
 assert.equal(p.gets.length,2);
});

test('UTF-8 split across chunks and blank-line framing are decoded with stream:true',{timeout:10000},async t=>{
 const p=await peer(t,async(q,r)=>{sse(r);const b=Buffer.from('data: {"kind":"welcome","providerId":"中文-ü"}\n\n');
  const cut=b.indexOf(Buffer.from('文'))+1;r.write(b.subarray(0,cut));await delay(30);r.write(b.subarray(cut))},150);
 await until(()=>p.bodies.some(b=>b.providerId!==undefined));
 assert.equal(p.bodies.find(b=>b.providerId!==undefined).providerId,'中文-ü');
});
