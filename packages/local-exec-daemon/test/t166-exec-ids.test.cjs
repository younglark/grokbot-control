// t166: inner exec message ids are per executor (v_.nextExecId = 1, D:135935; o.id = nextExecId++, D:136332–136333).
// Box owns one v_ (D:137251); each UC provider owns a fresh one (D:179358), also after an SA recreate (D:179352–179366).
// Synthetic commands only; never runs the official binary.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const H=require('../dist/exec/handlers');
const {BoxProvider}=require('../dist/box/provider');
const {UserComputerProvider}=require('../dist/uc/provider');

async function run(root,ids,rid,cmd){
 const frames=[];
 await H.dispatchExec({root,requestId:rid,serverMessage:{id:77,shellStreamArgs:{command:cmd,workingDirectory:'',timeout:5000}},permission:'always',execIds:ids,emit:f=>{frames.push(f)}});
 return frames.filter(f=>f.kind==='client').map(f=>f.message.id);
}

test('ExecIdCounter: each counter starts at 1 and ignores the server id; counters are independent',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'t166-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const box=new H.ExecIdCounter(),ucA=new H.ExecIdCounter();
 assert.deepEqual([...new Set(await run(root,box,'b1','echo b1'))],[1]);
 assert.deepEqual([...new Set(await run(root,ucA,'u1','echo u1'))],[1]);
 assert.deepEqual([...new Set(await run(root,box,'b2','echo b2'))],[2]);
 assert.deepEqual([...new Set(await run(root,ucA,'u2','echo u2'))],[2]);
 const ucB=new H.ExecIdCounter(); // SA recreate → fresh v_
 assert.equal(ucB.last(),0);
 assert.deepEqual([...new Set(await run(root,ucB,'u3','echo u3'))],[1]);
 assert.equal(box.last(),2);assert.equal(ucA.last(),2);assert.equal(ucB.last(),1);
});

test('providers own distinct counters (Box one per daemon, UC one per provider instance)',()=>{
 assert.ok(BoxProvider.prototype!==undefined);
 const fields=src=>/readonly execIds = new ExecIdCounter\(\)/.test(fs.readFileSync(path.join(__dirname,'..','src',src),'utf8'));
 assert.ok(fields('box/provider.ts'));assert.ok(fields('uc/provider.ts'));
 assert.equal(typeof UserComputerProvider,'function');
});
