import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileCredentialStore } from '../src/auth/store.js';
import { jwt } from './jwt-helper.js';

const API = 'https://api2.cursor.sh';
test('actual Node processes: force coalescing, rotation reuse, logout/login CAS, crash recovery and terminal revocation', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-process-'));
 process.env.GBT_CREDENTIALS_DIR = dir;
 const store = new FileCredentialStore();
 const seed = () => store.save({kind:'cursor', backend:API, access_token:jwt(1), refresh_token:'mock-r1', updated_at_ms:0, expires_at_ms:1000, revision:1, session_id:'s1', client_id:'test-id', credential_source:'login_poll'});
 seed();
 let requests = 0;
 let terminal = false;
 const server = http.createServer((_req,res) => {
  if (_req.url === '/auth/poll') { res.writeHead(200, {'content-type':'application/json'});res.end(JSON.stringify({accessToken:jwt(Math.floor(Date.now()/1000)+3600,{sub:'u2'}),refreshToken:'new-login-pair'}));return; }
  requests++;
  setTimeout(() => { if (!res.destroyed) { res.writeHead(terminal ? 400 : 200, {'content-type':'application/json'}); res.end(JSON.stringify(terminal ? {error:'invalid_grant'} : {access_token:jwt(Math.floor(Date.now()/1000)+3600),refresh_token:'mock-r2'})); } }, 400);
 });
 await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
 const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const script = `import {createAuthProvider} from './src/auth/provider.ts';
 const a=createAuthProvider({kind:'cursor',backend:'${API}',refreshDeadlineMs:Number(process.env.DEADLINE||20000),http:{fetch:(_u,i)=>fetch('${url}'+new URL(_u).pathname,i)}});
 process.stdout.write('START\\n');
 try { let r; if(process.env.MODE==='logout') r=await a.logout(); else if(process.env.MODE==='login') {await a.beginLogin();r=await a.pollLogin();} else r=await a.refresh({force:true}); console.log(JSON.stringify(r)); } catch(e) { console.log(JSON.stringify({code:e.code})); }`;
 function child(deadline='20000', mode='refresh') {
  const p=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script], {env:{...process.env,GBT_CREDENTIALS_DIR:dir,DEADLINE:deadline,MODE:mode},stdio:['ignore','pipe','pipe']});
  let out=''; p.stdout.on('data',d=>out+=d);
  const done=new Promise<string>(r=>p.once('close',()=>r(out)));
  return {p,done};
 }
 const waitRequest=async (n:number) => { const end=Date.now()+5000; while(requests<n && Date.now()<end) await new Promise(r=>setTimeout(r,10)); assert.ok(requests>=n); };
 try {
  const jobs=Array.from({length:4},()=>child());
  const results=await Promise.all(jobs.map(j=>j.done));
  assert.equal(requests,1); assert.equal(results.filter(s=>s.includes('"refreshed":true')).length,1);
  assert.equal(store.load('cursor',API)!.refresh_token,'mock-r2');
  seed(); const stale=child(); await waitRequest(2); await child('20000','logout').done; await stale.done;
  assert.equal(store.load('cursor',API),undefined);
  seed(); const old=child(); await waitRequest(3); await child('20000','login').done; await old.done;
  assert.equal(store.load('cursor',API)!.refresh_token,'new-login-pair');
  seed(); const crash=child(); await waitRequest(4); crash.p.kill('SIGKILL'); await crash.done;
  const recovery=await child().done; assert.ok(recovery.includes('"refreshed":true'));
  seed(); const timed=await child('50').done; assert.ok(timed.includes('auth_refresh_timeout')); assert.ok(store.load('cursor',API));
  seed(); terminal=true; const revoked=await child().done; assert.ok(revoked.includes('auth_revoked')); assert.equal(store.load('cursor',API),undefined);
 } finally { await new Promise<void>(r=>server.close(()=>r())); fs.rmSync(dir,{recursive:true,force:true}); }
});
