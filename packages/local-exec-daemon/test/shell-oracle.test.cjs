'use strict';
// Compares our shell semantics with frames recorded from the unchanged official
// 0.79.3 daemon (fixtures/official-0793-oracle-r3.json). Stdout/stderr chunks are
// merged; ids/localExecutionTimeMs ignored. Full-process differential lives in
// /workspace/local-exec-oracle-r3 (scripts/run_r3.py + diff.py).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const oracle = require('./fixtures/official-0793-oracle-r3.json').cases;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'led-sh-'));
const home = path.join(base, 'home'); const root = path.join(base, 'root');
fs.mkdirSync(home); fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(home, '.bash_profile'), 'export PROFVAR=prof\n. ~/.bashrc\n');
fs.writeFileSync(path.join(home, '.bashrc'), 'export RCVAR=rc\nexport PATH=$HOME/rcbin:$PATH\nrcfn(){ :; }\nalias rcal="echo rcal"\nRCPLAIN=plain\n');
process.env.HOME = home;
const { handleShellStream } = require('../dist/exec/handlers.js');
const { resetShellState } = require('../dist/exec/shell-session.js');
const { prepareBoxExecFrame } = require('../dist/exec/exec-codec.js');
const real = fs.realpathSync(root);

function norm(frames, rootPath) {
  const out = [];
  for (const f of frames) {
    const wire = rootPath === '\0' ? f : prepareBoxExecFrame(f); // ours → generated Exec* codec (wire form)
    const m = JSON.parse(JSON.stringify(wire.message).split(rootPath).join('<ROOT>'));
    delete m.id; if (m.streamClose) delete m.streamClose.id; delete m.localExecutionTimeMs;
    const ss = m.shellStream || {};
    for (const k of Object.keys(ss)) if (ss[k] && typeof ss[k] === 'object') delete ss[k].localExecutionTimeMs;
    const key = ['stdout', 'stderr'].find((k) => ss[k]);
    const last = out[out.length - 1];
    if (key && last && last.key === key) { last.m.shellStream[key].data += ss[key].data; continue; }
    out.push({ kind: f.kind, m, key });
  }
  return out.map(({ kind, m }) => ({ kind, m }));
}
// Same sequence/order as the official run (state is daemon-global).
const SEQ = {
  'sh-state1': ['cd sub; export R3VAR=persisted; r3fn(){ echo fn; }; alias r3al="echo al"; echo set', ''],
  'sh-state2': ['echo "PWD2=$PWD"; echo "VAR2=${R3VAR:-unset}"; type r3fn >/dev/null 2>&1 && echo FN2=1 || echo FN2=0', ''],
  'sh-state3-nocwd': ['echo "PWD3=$PWD"; echo "VAR3=${R3VAR:-unset}"', null],
  'sh-exitcode': ['echo out; echo err >&2; exit 7', ''],
  'sh-init': ['echo "RC=${RCVAR:-unset} PROF=${PROFVAR:-unset} RCPLAIN=${RCPLAIN:-unset}"; echo "PATH=$PATH"; type rcfn >/dev/null 2>&1 && echo RCFN=1 || echo RCFN=0; alias rcal >/dev/null 2>&1 && echo RCAL=1 || echo RCAL=0', ''],
  'sh-plain1': ['PLAINV=1; alias myal="echo x"; shopt -s nullglob; set -o noglob', ''],
  'sh-plain2': ['echo "PLAINV=${PLAINV:-unset}"; alias myal >/dev/null 2>&1 && echo MYAL=1 || echo MYAL=0; shopt -q nullglob && echo NULLGLOB=1 || echo NULLGLOB=0; [[ $- == *f* ]] && echo NOGLOB=1 || echo NOGLOB=0', ''],
  'sh-exit1': ['export EXV=1; exit 3', ''],
  'sh-exit2': ['echo "EXV=${EXV:-unset}"; unset R3VAR', ''],
  'sh-unset2': ['echo "R3=${R3VAR:-unset}"', ''],
  'sh-badcwd': ['pwd', '/nope'],
};
test('shell semantics match official 0.79.3 oracle frames', async () => {
  resetShellState();
  for (const [name, [cmd, cwdSuffix]] of Object.entries(SEQ)) {
    const got = [];
    await handleShellStream({ root, requestId: name, msgId: 1, command: cmd,
      workingDirectory: cwdSuffix === null ? undefined : real + cwdSuffix, timeout: 5000, emit: (f) => got.push(f) });
    const want = norm(oracle[name], '\0').map((x) => {
      // oracle PATH used /runtime:/usr/bin:/bin; compare only the rcbin prefix for PATH lines
      return x;
    });
    let g = norm(got, real);
    if (name === 'sh-init') {
      const fix = (arr, h) => arr.map((x) => { if (x.m.shellStream?.stdout) x.m.shellStream.stdout.data = x.m.shellStream.stdout.data.replace(/^PATH=([^\n]*)$/m, (_, p) => 'PATH_HEAD=' + p.split(':')[0].replace(h, '<HOME>')); return x; });
      g = fix(g, home); fix(want, '<HOME>');
    }
    assert.deepEqual(g, want, name);
  }
});
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
