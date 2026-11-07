// Simulated init-group lifecycle (all kill/proc/spawn intercepted; no real process is signalled).
// Derived from the independent probe /tmp/independent-r3-pgidguard/stale-lifecycle.cjs. MODE=residue: an
// original member survives init close.
const fs=require('fs'),cp=require('child_process'),{EventEmitter}=require('events'),{PassThrough}=require('stream');
const saved={ls:fs.readdirSync,read:fs.readFileSync,kill:process.kill,spawn:cp.spawn};let entries=process.env.MODE==='residue'?{'70005':'70005 (orig-residue) S 1 70001 70001 0 0\n'}:{},signals=[];const pgid=70001;
fs.readdirSync=(p,...a)=>p==='/proc'?Object.keys(entries):saved.ls(p,...a);
fs.readFileSync=(p,...a)=>{const m=/^\/proc\/(\d+)\/stat$/.exec(p);return m?entries[m[1]]:saved.read(p,...a)};
process.kill=(p,s)=>{signals.push([p,s]);return true};
cp.spawn=()=>{const c=new EventEmitter();c.pid=pgid;c.exitCode=null;c.signalCode=null;c.stdout=new PassThrough();process.nextTick(()=>{c.stdout.emit('data',Buffer.from('__GB_STATE_INIT__\n__GB_STATE_START__\n1\n/\n__GB_STATE_END__\n'));c.exitCode=0;c.emit('close',0)});return c};
(async()=>{const s=require(''+require('path').join(__dirname,'..','..','dist')+'/exec/shell-session.js');await s.initialSnapshot('/bin/bash');const afterOriginalClose=signals.slice();
// Model a later kernel allocation of the now-free number to a new session: that unrelated leader
// has also exited, leaving a much newer member. No original members survived initialization.
entries={'70002':'70002 (unrelated-new-session-child) S 1 70001 70001 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 999999 0 0\n'};
await s.terminateInitialSnapshot();console.log(JSON.stringify({originalGroupEmptyAtClose:true,afterOriginalClose,laterShutdownSignals:signals}));
})().finally(()=>{fs.readdirSync=saved.ls;fs.readFileSync=saved.read;process.kill=saved.kill;cp.spawn=saved.spawn});
