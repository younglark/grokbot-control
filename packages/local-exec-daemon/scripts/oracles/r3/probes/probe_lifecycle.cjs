const fs=require('fs');const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{fs.mkdirSync('/state/home',{recursive:true});fs.mkdirSync('/state/root');process.env.HOME='/state/home';process.env.SHELL='/bin/bash';
const h=require('/repo/packages/local-exec-daemon/dist/exec/handlers.js');const s=require('/repo/packages/local-exec-daemon/dist/exec/shell-session.js');
fs.writeFileSync('/state/home/.bash_profile','echo $$ > /state/init-pid\nsleep 2\necho INIT_CONTINUED > /state/init-after-shutdown\n'.replaceAll('\\n','\n'));
let frames=[];let task=h.handleShellStream({root:'/state/root',requestId:'shut',msgId:1,command:'echo COMMAND_RAN > /state/command-ran',emit:f=>frames.push(f)});
while(!fs.existsSync('/state/init-pid'))await delay(10);
const pid=Number(fs.readFileSync('/state/init-pid','utf8'));await h.shutdownShells();await task;
let alive;try{process.kill(pid,0);alive=true}catch{alive=false}
await delay(2200);console.log(JSON.stringify({shutdownReturned:true,initAliveAtReturn:alive,initContinuedAfterShutdown:fs.existsSync('/state/init-after-shutdown'),commandRan:fs.existsSync('/state/command-ran'),frames}));
let err;try{await h.handleShellStream({root:'/state/root',requestId:'bad-emit',msgId:2,command:'echo NO',workingDirectory:'/state/root/missing',emit:()=>Promise.reject(new Error('synthetic emission failure'))})}catch(e){err=e.message}
let settled=false;h.shutdownShells().then(()=>settled=true);await delay(200);console.log(JSON.stringify({noticeEmitError:err,shutdownSettled:settled}));
const okAll=!alive&&!fs.existsSync('/state/init-after-shutdown')&&!fs.existsSync('/state/command-ran')&&settled;console.log(okAll?'LIFECYCLE PASS':'LIFECYCLE FAIL');process.exit(okAll?0:1)
})().catch(e=>{console.error(e);process.exit(1)});
