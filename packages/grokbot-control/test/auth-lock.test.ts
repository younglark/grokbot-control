import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withAdvisoryLock } from '../src/auth/lock.js';
import { GbcError } from '../src/errors.js';

function holder(file: string) {
 const script = `import {withAdvisoryLock} from './src/auth/lock.ts'; await withAdvisoryLock(process.env.LOCK_FILE, async()=>{console.log('HELD'); await new Promise(()=>{setInterval(()=>{},1000)});});`;
 const p = spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{env:{...process.env,LOCK_FILE:file},stdio:['ignore','pipe','pipe']});
 const ready = new Promise<void>((r,j)=> { p.stdout.once('data',()=>r()); p.once('exit',()=>j(new Error('holder exited before ready'))); });
 const done = new Promise<void>(r=>p.once('close',()=>r()));
 return {p,ready,done};
}
test('native owner survives backdated mtime, timeout/cancel leave owner intact; crash releases permanent inode', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gbc-native-'));
 const file=path.join(dir,'permanent.lock');
 const h=holder(file);
 try {
  await h.ready;
  const inode=fs.statSync(file).ino;
  fs.utimesSync(file,new Date(0),new Date(0));
  let ticks=0; const interval=setInterval(()=>ticks++,5);
  await assert.rejects(withAdvisoryLock(file,async()=>assert.fail('stole live owner lock'),{waitMs:100}), (e:GbcError)=>e.code==='auth_refresh_lock_timeout');
  clearInterval(interval); assert.ok(ticks>2,'event loop must remain responsive');
  const ac=new AbortController(); setTimeout(()=>ac.abort(),30);
  await assert.rejects(withAdvisoryLock(file,async()=>assert.fail('canceled callback ran'),{waitMs:1000,signal:ac.signal}), (e:GbcError)=>e.code==='auth_lock_canceled');
  assert.equal(h.p.exitCode,null);
  h.p.kill('SIGKILL'); await h.done;
  await withAdvisoryLock(file,async()=>assert.equal(fs.statSync(file).ino,inode),{waitMs:2000});
  assert.equal(fs.statSync(file).ino,inode);
 } finally { if(h.p.exitCode===null) {h.p.kill('SIGKILL');await h.done;} fs.rmSync(dir,{recursive:true,force:true}); }
});
test('abort after acquisition cannot cancel exchange; callback error releases native handle',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gbc-native-')); const file=path.join(dir,'lock');
 try {
  const ac=new AbortController();
  const result=await withAdvisoryLock(file,async()=>{ac.abort();await new Promise(r=>setTimeout(r,20));return 'saved';},{signal:ac.signal});
  assert.equal(result,'saved');
  await assert.rejects(withAdvisoryLock(file,async()=>{throw new Error('fixture failure');}));
  await withAdvisoryLock(file,async()=>{}, {waitMs:0});
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing native binding fails closed with actionable install hint', async()=>{
 const script=`import Module from 'node:module'; const original=Module._load; Module._load=function(name,...rest){if(name==='fs-native-extensions')throw new Error('fixture missing');return original.call(this,name,...rest)}; const {withAdvisoryLock}=await import('./src/auth/lock.ts'); try{await withAdvisoryLock('unused',async()=>{});process.exitCode=1}catch(e){console.log(JSON.stringify({code:e.code,message:e.message}))}`;
 const p=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script]);let out='';p.stdout.on('data',d=>out+=d);
 await new Promise<void>(r=>p.once('close',()=>r()));
 assert.match(out,/auth_lock_unavailable/);assert.match(out,/npm ci/);assert.equal(p.exitCode,0);
});
