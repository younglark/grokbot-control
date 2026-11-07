'use strict';
function varint(n){const a=[];n>>>=0;while(n>0x7f){a.push((n&0x7f)|0x80);n>>>=7;}a.push(n);return Buffer.from(a);}
function encStr(fn,s){const b=Buffer.from(String(s),'utf8');return Buffer.concat([varint((fn<<3)|2),varint(b.length),b]);}
function encVarint(fn,n){return Buffer.concat([varint((fn<<3)|0),varint(n>>>0)]);}
function encBool(fn,v){return encVarint(fn,v?1:0);}
function encBytes(fn,b){return Buffer.concat([varint((fn<<3)|2),varint(b.length),b]);}
function encMsg(fn,m){return encBytes(fn,m);}
function encInt64(fn,n){
  let x=BigInt(n); const a=[]; if(x<0n)x=0n; while(x>0x7fn){a.push(Number(x&0x7fn)|0x80);x>>=7n;} a.push(Number(x));
  return Buffer.concat([varint((fn<<3)|0),Buffer.from(a)]);
}
function readVarint(buf,o){let x=0,s=0,i=o;for(;;){const b=buf[i++];x|=(b&0x7f)<<s;if(!(b&0x80))return[x>>>0,i];s+=7;if(s>35)throw Error('varint');}}
function decodeFields(buf){const out={};let i=0;while(i<buf.length){const[tag,j]=readVarint(buf,i);i=j;const fn=tag>>>3,wt=tag&7;if(wt===0){const[v,k]=readVarint(buf,i);i=k;out[fn]=out[fn]||[];out[fn].push({t:'v',v});}else if(wt===2){const[len,k]=readVarint(buf,i);i=k;out[fn]=out[fn]||[];out[fn].push({t:'b',v:buf.subarray(i,i+len)});i+=len;}else if(wt===5){out[fn]=out[fn]||[];out[fn].push({t:'f32',v:buf.readUInt32LE(i)});i+=4;}else if(wt===1){out[fn]=out[fn]||[];out[fn].push({t:'f64',v:buf.subarray(i,i+8)});i+=8;}else throw Error('wt '+wt+' at '+i);}return out;}
function firstStr(fields,fn){const a=fields[fn];if(!a||!a.length)return'';return a[0].t==='b'?a[0].v.toString('utf8'):'';}
function envelope(msg,end=false){const flags=end?2:0;const h=Buffer.alloc(5);h[0]=flags;h.writeUInt32BE(msg.length,1);return Buffer.concat([h,msg]);}
function endEnvelope(obj){const b=Buffer.from(JSON.stringify(obj||{}),'utf8');const h=Buffer.alloc(5);h[0]=2;h.writeUInt32BE(b.length,1);return Buffer.concat([h,b]);}
/** Strip Connect streaming envelopes; return first message payload (flags&1 compressed not supported). */
function unwrapConnectBody(buf){
  if(!buf || buf.length===0) return Buffer.alloc(0);
  // Heuristic: if looks like envelope (5+ byte header with reasonable length), unwrap
  if(buf.length>=5){
    const flags=buf[0];
    const len=buf.readUInt32BE(1);
    if((flags===0||flags===1||flags===2) && len<=buf.length-5 && len>0){
      return buf.subarray(5,5+len);
    }
  }
  return buf;
}
module.exports={varint,encStr,encVarint,encBool,encBytes,encMsg,encInt64,decodeFields,firstStr,envelope,endEnvelope,unwrapConnectBody};
