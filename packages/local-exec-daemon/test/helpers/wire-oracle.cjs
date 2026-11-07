'use strict';
// Independent frozen-proto test codec. Never imports production modules.
// Field numbers: schema-0.79.3/aiserver.v1.proto. Golden checks in followup tests.
const B = Buffer;
function integer(x) { let n=BigInt(x); const bytes=[]; do { let b=Number(n&127n); n>>=7n; bytes.push(b|(n?128:0)); } while(n); return B.from(bytes); }
function encVarint(n,v) { return B.concat([integer(n*8),integer(v)]); }
function encBytes(n,b) { return B.concat([integer(n*8+2),integer(b.length),b]); }
function encStr(n,v) { return encBytes(n,B.from(v)); }
function decodeFields(bytes) {
 let at=0;const fields={};
 function read(){let n=0n;for(let i=0;i<10;i++){if(at>=bytes.length)throw Error('oracle truncated');const b=bytes[at++];n|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return n;}throw Error('oracle overflow');}
 while(at<bytes.length){const tag=read(),field=Number(tag>>3n),wire=Number(tag&7n);let item;
 if(wire===0){const n=read();item={t:'v',v:Number(n)};}
 else if(wire===2){const size=Number(read());if(at+size>bytes.length)throw Error('oracle bounds');item={t:'b',v:bytes.subarray(at,at+size)};at+=size;}
 else throw Error('oracle unsupported wire');
 (fields[field]||=[]).push(item);
 }return fields;
}
function firstStr(f,n){return f[n]?.[0]?.t==='b'?f[n][0].v.toString():'';}
function envelope(b,end=false){const h=B.alloc(5);h[0]=end?2:0;h.writeUInt32BE(b.length,1);return B.concat([h,b]);}
function takeEnvelopes(buf){let pos=0;const messages=[];while(pos+5<=buf.length){const size=buf.readUInt32BE(pos+1);if(pos+5+size>buf.length)throw Error('oracle envelope truncated');if(buf[pos]===0)messages.push(buf.subarray(pos+5,pos+5+size));pos+=5+size;}return {messages};}
module.exports={encVarint,encBytes,encStr,encMsg:encBytes,encBool:(n,v)=>encVarint(n,v?1:0),encInt64:encVarint,decodeFields,firstStr,envelope,endEnvelope:x=>envelope(B.from(JSON.stringify(x)),true),takeEnvelopes,unwrapConnectBody:x=>x};
