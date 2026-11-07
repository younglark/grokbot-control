'use strict';
// Regressions for the t101u independent review (P1-1..P2-7). Where the official 0.79.3
// behavior is the target, expectations come from fixtures/official-0793-oracle-r3-edges.json
// (recorded from the unchanged official daemon). Where official is unsafe (newline cwd
// injection), the test asserts the documented safety deviation instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const oracle = require('./fixtures/official-0793-oracle-r3-edges.json').cases;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'led-shr-'));
const home = path.join(base, 'home'); fs.mkdirSync(home);
process.env.HOME = home;
// The test host's own inherited env must not mask snapshot behavior (daemon inherits process.env).
for (const k of ['CURSOR_REQUEST_ID', 'CURSOR_CONVERSATION_ID', 'CURSOR_AGENT_STORE', 'SUDO_ASKPASS', 'ELECTRON_RUN_AS_NODE', 'http_proxy', 'HTTPS_PROXY']) delete process.env[k];
const { handleShellStream, cancelRequest, shutdownShells } = require('../dist/exec/handlers.js');
const { resetShellState, commitShell, parseState, STATE_START, STATE_END } = require('../dist/exec/shell-session.js');
const { prepareBoxExecFrame } = require('../dist/exec/exec-codec.js');

function freshRoot(name) { const r = path.join(base, name); fs.mkdirSync(r, { recursive: true }); return fs.realpathSync(r); }
function setProfile(text) { fs.writeFileSync(path.join(home, '.bash_profile'), text); fs.rmSync(path.join(home, '.bashrc'), { force: true }); resetShellState(); }
async function run(root, requestId, command, extra = {}) {
  const got = [];
  await handleShellStream({ root, requestId, msgId: 1, command, workingDirectory: root, timeout: 5000, emit: (f) => got.push(f), ...extra });
  return got;
}
const out = (frames, k = 'stdout') => frames.map((f) => f.message?.shellStream?.[k]?.data || '').join('');
const exitOf = (frames) => frames.find((f) => f.message?.shellStream?.exit)?.message.shellStream.exit;
const oracleOut = (name, k = 'stdout') => oracle[name].map((f) => f.message?.shellStream?.[k]?.data || '').join('');
function shapes(frames, rootReal) {
  // wire form via generated codec; drop timing and id (oracle ids are daemon-global sequence)
  return frames.map((f) => {
    const w = f.kind === 'client' ? prepareBoxExecFrame(f) : f;
    const m = JSON.parse(JSON.stringify(w.message).split(rootReal).join('<ROOT>'));
    delete m.id; delete m.localExecutionTimeMs; if (m.streamClose) delete m.streamClose.id;
    for (const v of Object.values(m.shellStream || {})) if (v && typeof v === 'object') delete v.localExecutionTimeMs;
    return { kind: f.kind, m };
  });
}
const oracleShapes = (name) => oracle[name].map((f) => { const m = JSON.parse(JSON.stringify(f.message)); delete m.id; if (m.streamClose) delete m.streamClose.id; return { kind: f.kind, m }; });

test('P1-1 cancel during slow first snapshot: oracle frames, command never runs, timeout not armed pre-spawn', async () => {
  setProfile('sleep 2\n');
  const root = freshRoot('cancel');
  const p = run(root, 'c1', 'echo SHOULD_NOT_EXECUTE; echo ran > cancelled-marker', { timeout: 100 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(cancelRequest('c1'), true, 'request registered while waiting for snapshot');
  const frames = await p;
  assert.deepEqual(shapes(frames, root), oracleShapes('cancel-init'));
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(fs.existsSync(path.join(root, 'cancelled-marker')), false);
  const chk = await run(root, 'c2', 'if [ -e cancelled-marker ]; then echo CANCELLED_RAN; else echo CANCELLED_NOT_RUN; fi');
  assert.equal(out(chk), oracleOut('cancel-check'));
});

test('P1-1 shared snapshot wait: cancelling one waiter does not affect another; shutdown covers pre-spawn', async () => {
  setProfile('sleep 1\n');
  const root = freshRoot('shared');
  const a = run(root, 's1', 'echo ran-a > a-marker');
  const b = run(root, 's2', 'echo B_OK');
  await new Promise((r) => setTimeout(r, 100));
  cancelRequest('s1');
  const [fa, fb] = await Promise.all([a, b]);
  assert.equal(exitOf(fa).abortReason, 'SHELL_ABORT_REASON_USER_ABORT');
  assert.equal(fs.existsSync(path.join(root, 'a-marker')), false);
  assert.equal(out(fb), 'B_OK\n');
  assert.equal(exitOf(fb).aborted, undefined);
  setProfile('sleep 1\n');
  const c = run(root, 's3', 'echo ran-c > c-marker');
  await new Promise((r) => setTimeout(r, 100));
  await shutdownShells();
  const fc = await c;
  assert.equal(exitOf(fc).aborted, true);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(fs.existsSync(path.join(root, 'c-marker')), false);
});

test('P1-2 SECURITY deviation: newline / quote in cwd is data, never script (official injects)', async () => {
  setProfile('');
  const root = freshRoot('cwdinj');
  for (const dir of ['sub\nprintf CWD_INJECTED > injected-marker\n#', "it's\n'$(touch q-marker)'"]) {
    fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, '.target'), dir);
    const s = await run(root, 'save', 'cd -- "$(cat .target)"; :');
    assert.equal(exitOf(s).cwd, path.join(root, dir), 'exit.cwd is the full path');
    const h = await run(root, 'next', 'echo HARMLESS; pwd');
    assert.equal(out(h), `HARMLESS\n${root}\n`);
    assert.equal(out(h, 'stderr'), '');
  }
  assert.equal(fs.existsSync(path.join(root, 'injected-marker')), false);
  assert.equal(fs.existsSync(path.join(root, 'q-marker')), false);
  // Official evidence that this is a deliberate deviation:
  assert.equal(oracleOut('cwd-check'), 'CWD_EXECUTED\n');
});

test('P2-3 request-scoped / helper vars are not carried across calls (oracle vars-read)', async () => {
  setProfile('');
  const root = freshRoot('vars');
  await run(root, 'v1', 'export CURSOR_REQUEST_ID=synthetic-request CURSOR_CONVERSATION_ID=synthetic-conversation CURSOR_AGENT_STORE=synthetic-store SUDO_ASKPASS=synthetic-helper ELECTRON_RUN_AS_NODE=1 http_proxy=x HTTPS_PROXY=y KEEP=1');
  const r = await run(root, 'v2', "printf 'REQUEST=%s CONV=%s STORE=%s ASKPASS=%s ELECTRON=%s\\n' \"${CURSOR_REQUEST_ID-unset}\" \"${CURSOR_CONVERSATION_ID-unset}\" \"${CURSOR_AGENT_STORE-unset}\" \"${SUDO_ASKPASS-unset}\" \"${ELECTRON_RUN_AS_NODE-unset}\"; echo \"${http_proxy-unset} ${HTTPS_PROXY-unset} ${KEEP-unset}\"");
  assert.equal(out(r), oracleOut('vars-read') + 'unset unset 1\n');
});

test('P2-4 incomplete/oversized dump never commits; complete builtin-only dump keeps functions and aliases', async () => {
  setProfile('');
  const root = freshRoot('atomic');
  await run(root, 'a1', "my-fn(){ printf 'special\\n'; }; alias edgeal=$'echo first\\nalias second'; export KEEPV=old");
  // Truncated / missing-end / garbage dumps are rejected and leave state untouched.
  const good = Buffer.from(`${STATE_START}\n1\n/\nbuiltin export KEEPV=bad\n${STATE_END}\n`);
  for (const bad of [good.subarray(0, good.length - 3), Buffer.from(`${STATE_START}\n99\n/\n`), Buffer.from('garbage'), Buffer.alloc(0)]) {
    assert.equal(parseState(bad), null);
    assert.equal(commitShell(bad, false), undefined);
  }
  assert.equal(commitShell(good, true), undefined, 'aborted run never commits');
  const r = await run(root, 'a2', 'echo "KEEPV=$KEEPV"; my-fn; alias edgeal');
  assert.equal(out(r), "KEEPV=old\nspecial\nalias edgeal='echo first\nalias second'\n");
  // PATH without external tools: state still saved completely (documented deviation: official keeps old state).
  await run(root, 'a3', 'export PATH=/nonexistent; export EDGE_LAST=x');
  const r2 = await run(root, 'a4', 'echo "LAST=${EDGE_LAST-unset}"; type my-fn >/dev/null && echo FN; alias edgeal >/dev/null && echo AL; export PATH=/usr/bin:/bin');
  assert.equal(out(r2), 'LAST=x\nFN\nAL\n');
});

test('P2-5 multi-line alias round-trips exactly (oracle alias-read) and quoted values (oracle quoted-read)', async () => {
  setProfile('');
  const root = freshRoot('alias');
  await run(root, 'al1', "alias edgeal=$'echo first\\nalias second'");
  assert.equal(out(await run(root, 'al2', 'alias edgeal')), oracleOut('alias-read'));
  await run(root, 'q1', "export EDGE=$'quote\\' line1\\nline2 $(echo unsafe)'; alias qedge=$'echo \\'single\\''");
  assert.equal(out(await run(root, 'q2', 'printf "%s\\n" "$EDGE"; alias qedge')), oracleOut('quoted-read'));
});

test('P2-6 errexit/nounset/pipefail are not persisted (oracle options-read)', async () => {
  setProfile('');
  const root = freshRoot('opts');
  await run(root, 'o1', 'set -e -u -o pipefail');
  const r = await run(root, 'o2', '[[ $- == *e* ]] && echo ERREXIT=1 || echo ERREXIT=0; set -o | /bin/grep pipefail; false; echo AFTER_FALSE');
  assert.equal(out(r), oracleOut('options-read'));
  assert.equal(exitOf(r).code, 0);
});

test('P2-7 symlinked root works without workingDirectory (oracle rootlink); escapes still refused', async () => {
  setProfile('');
  const real = freshRoot('rl-real');
  const link = path.join(base, 'rl-link'); fs.symlinkSync(real, link);
  const got = [];
  await handleShellStream({ root: link, requestId: 'rl', msgId: 1, command: 'pwd', timeout: 5000, emit: (f) => got.push(f) });
  assert.deepEqual(shapes(got, real), oracleShapes('rootlink-default'));
  const outside = freshRoot('rl-outside'); fs.symlinkSync(outside, path.join(real, 'escape'));
  const esc = [];
  await handleShellStream({ root: link, requestId: 'rle', msgId: 1, command: 'pwd', workingDirectory: path.join(link, 'escape'), timeout: 5000, emit: (f) => esc.push(f) });
  assert.ok(esc.some((f) => f.message?.throw), 'symlink escape refused');
});

test.after(() => fs.rmSync(base, { recursive: true, force: true }));
