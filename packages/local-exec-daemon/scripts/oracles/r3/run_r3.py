import subprocess,sys,json,pathlib,os,signal
# Usage: OUT=/tmp/r3 python3 run_r3.py <label> [KEY=VAL ...] [BIND:src:dst]
# Requires bwrap + LAB dir with input/main.cjs (unchanged official 0.79.3, not in repo) and input/node_modules.
import os as _o
scripts=pathlib.Path(__file__).resolve().parent; lab=pathlib.Path(_o.environ.get('LAB','/workspace/local-exec-offline-lab-0793'))
outdir=pathlib.Path(_o.environ.get('OUT','/tmp/local-exec-oracle-r3')); outdir.mkdir(parents=True,exist_ok=True)
label=sys.argv[1]; extra=sys.argv[2:]  # extra: KEY=VAL setenv pairs, or BIND:src:dst
cmd=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/state','--ro-bind','/home/box/.local/node/bin','/runtime','--ro-bind',str(lab/'input'),'/input','--ro-bind',str(scripts),'/scripts','--clearenv','--setenv','PATH','/runtime:/usr/bin:/bin']
for e in extra:
  if e.startswith('BIND:'): _,a,b=e.split(':'); cmd+=['--ro-bind',a,b]
  else: k,v=e.split('=',1); cmd+=['--setenv',k,v]
cmd+=['--chdir','/state','/runtime/node','/scripts/probes/probe_'+_o.environ.get('PROBE','main')+'.cjs']
p=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={'PATH':'/usr/bin:/bin'})
try: out,err=p.communicate(timeout=90)
except subprocess.TimeoutExpired: os.killpg(p.pid,signal.SIGKILL); out,err=p.communicate()
(outdir/f'{label}.json').write_bytes(out[:2000000]); (outdir/f'{label}.stderr.txt').write_bytes(err[:65536])
(outdir/f'{label}.cmd.json').write_text(json.dumps({'cmd':cmd,'exit':p.returncode}))
print('exit',p.returncode, err.decode()[:500])
