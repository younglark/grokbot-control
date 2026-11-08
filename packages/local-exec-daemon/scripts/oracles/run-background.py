"""Research-only original daemon oracle. Inputs readonly, no real accounts.
PID/network/mount isolation; exact runner process-group kill at 25s hard deadline.
"""
import subprocess, os, signal, json, pathlib, hashlib, sys
root = pathlib.Path(__file__).resolve().parent
probe = sys.argv[1] if len(sys.argv) > 1 else 'background.cjs'
if probe not in ('background.cjs', 'background-long.cjs', 'uc-bad-frames.cjs', 'uc-truncated-poll.cjs', 'uc-keepalive.cjs'):
    raise SystemExit('unsupported probe')
lab = pathlib.Path('/workspace/local-exec-offline-lab-0793')
cmd = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session',
       '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
       '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/state',
       '--ro-bind', '/home/box/.local/node/bin', '/runtime', '--ro-bind', str(lab/'input'), '/input',
       '--ro-bind', str(root), '/scripts'] + (['--ro-bind', os.environ['REPO'], '/repo'] if os.environ.get('REPO') else []) + ['--clearenv'] + (['--setenv', 'PROBE_MAIN', '/repo/packages/local-exec-daemon/dist/index.js'] if os.environ.get('REPO') else []) + ['--setenv', 'PATH', '/runtime:/usr/bin:/bin',
       '--chdir', '/state', '/runtime/node', '/scripts/' + probe] + sys.argv[2:]
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env={'PATH':'/usr/bin:/bin'})
timed_out = False
try:
    out, err = p.communicate(timeout=60)
except subprocess.TimeoutExpired:
    timed_out = True
    os.killpg(p.pid, signal.SIGKILL)
    out, err = p.communicate()
manifest = dict(exit=p.returncode, hard_timeout=timed_out, runner_pid=p.pid, cleaned=p.poll() is not None,
                original_sha256=hashlib.sha256((lab/'input/main.cjs').read_bytes()).hexdigest())
print(json.dumps(manifest))
print(out.decode())
print(err[:4096].decode())
# Gate: probe exit, hard timeout, or (for JSON-emitting probes) any non-pass result fails the run.
bad = bool(p.returncode or timed_out)
if probe == 'uc-keepalive.cjs':
    try:
        d = json.loads(out.decode().splitlines()[0]); res = d.get('results') or []
        bad = bad or not res or any(r.get('status') != 'pass' for r in res)
    except Exception:
        bad = True
raise SystemExit(1 if bad else 0)
