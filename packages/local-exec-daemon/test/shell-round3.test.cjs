'use strict';
// Round-3 review regressions: shutdown kills the shared init group, emit failures settle the
// lifecycle, helper locals never shadow user env (official golden: locale), and the session cwd
// persists when workingDirectory is omitted (official golden: cwdpersist).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'led-r3-'));
const home = path.join(base, 'home'); fs.mkdirSync(home);
process.env.HOME = home; process.env.SHELL = '/bin/bash';
for (const k of ['CURSOR_REQUEST_ID', 'CURSOR_CONVERSATION_ID', 'CURSOR_AGENT_STORE', 'SUDO_ASKPASS', 'ELECTRON_RUN_AS_NODE', 'LC_ALL']) delete process.env[k];
const { handleShellStream, cancelRequest, shutdownShells } = require('../dist/exec/handlers.js');
const { resetShellState } = require('../dist/exec/shell-session.js');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freshRoot = (n) => { const r = path.join(base, n); fs.mkdirSync(r, { recursive: true }); return fs.realpathSync(r); };
const setProfile = (t) => { fs.writeFileSync(path.join(home, '.bash_profile'), t); resetShellState(); };
const out = (fr, k = 'stdout') => fr.map((f) => f.message?.shellStream?.[k]?.data || '').join('');
const exitOf = (fr) => fr.find((f) => f.message?.shellStream?.exit)?.message.shellStream.exit;
function golden(name) {
  const d = require(`./fixtures/official-0793-oracle-r3-${name}.json`);
  const by = Object.fromEntries(d.events.map((e) => [e.name, e.frames]));
  return (c) => by[c];
}
async function run(root, requestId, command, extra = {}) {
  const got = [];
  await handleShellStream({ root, requestId, msgId: 1, command, timeout: 5000, emit: (f) => got.push(f), ...extra });
  return got;
}

test('shutdown terminates and awaits the shared init process group', async () => {
  const root = freshRoot('shut');
  const mark = path.join(base, 'init-after'); const pidf = path.join(base, 'init-pid');
  setProfile(`echo $$ > '${pidf}'\nsleep 2\necho X > '${mark}'\n`);
  const frames = [];
  const task = handleShellStream({ root, requestId: 'shut', msgId: 1, command: `echo RAN > '${path.join(base, 'ran')}'`, emit: (f) => frames.push(f) });
  while (!fs.existsSync(pidf)) await delay(10);
  const pid = Number(fs.readFileSync(pidf, 'utf8'));
  await shutdownShells(); await task;
  let alive; try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  assert.equal(alive, false, 'init bash must be gone when shutdownShells resolves');
  await delay(2300);
  assert.equal(fs.existsSync(mark), false, 'init profile must not continue after shutdown');
  assert.equal(fs.existsSync(path.join(base, 'ran')), false);
  assert.equal(exitOf(frames).abortReason, 'SHELL_ABORT_REASON_USER_ABORT');
});

test('ordinary cancel does not kill shared init for other waiters', async () => {
  const root = freshRoot('cancel');
  setProfile('sleep 0.5\n');
  const a = []; const b = [];
  const ta = handleShellStream({ root, requestId: 'ca', msgId: 1, command: 'echo A', emit: (f) => a.push(f) });
  const tb = handleShellStream({ root, requestId: 'cb', msgId: 2, command: 'echo B', emit: (f) => b.push(f) });
  await delay(100); cancelRequest('ca'); await Promise.all([ta, tb]);
  assert.equal(exitOf(a).aborted, true);
  assert.equal(out(b), 'B\n');
});

test('failed notice emit settles lifecycle (no leaked registration, bounded emits)', async () => {
  const root = freshRoot('emitfail'); setProfile('');
  let calls = 0;
  await handleShellStream({ root, requestId: 'bad', msgId: 3, command: 'echo NO', workingDirectory: path.join(root, 'missing'),
    emit: () => { calls++; return Promise.reject(new Error('synthetic')); } });
  let settled = false; shutdownShells().then(() => { settled = true; });
  await delay(100);
  assert.equal(settled, true, 'no registered task may remain');
  assert.ok(calls <= 2, `emit attempts bounded, got ${calls}`);
  // a throwing (sync) emit on every frame is equally bounded
  calls = 0;
  await handleShellStream({ root, requestId: 'bad2', msgId: 4, command: 'echo NO', emit: () => { calls++; throw new Error('sync'); } });
  settled = false; shutdownShells().then(() => { settled = true; }); await delay(100);
  assert.equal(settled, true); assert.ok(calls <= 3, `got ${calls}`);
});

test('locale: helper vars never shadow user LC_ALL (official golden locale)', async () => {
  const g = golden('locale'); const root = freshRoot('locale'); setProfile('');
  const s = await run(root, 'locale-save', 'export LC_ALL=C.UTF-8; echo FIRST=$LC_ALL');
  const r = await run(root, 'locale-read', 'echo NEXT=$LC_ALL');
  assert.equal(out(s), out(g('locale-save'))); assert.equal(out(r), out(g('locale-read')));
  assert.equal(out(r), 'NEXT=C.UTF-8\n');
});

test('cwd: omitted workingDirectory reuses previous final cwd; explicit overrides (official golden cwdpersist)', async () => {
  const g = golden('cwdpersist'); const root = freshRoot('cwdp'); fs.mkdirSync(path.join(root, 'sub')); setProfile('');
  const rel = (s) => s.split('/state/r3/root').join(root);
  const s = await run(root, 'cwd-session-save', 'cd sub; pwd');
  const r = await run(root, 'cwd-session-read', 'pwd');
  assert.equal(out(s), rel(out(g('cwd-session-save')))); assert.equal(out(r), rel(out(g('cwd-session-read'))));
  assert.equal(exitOf(r).cwd, rel(exitOf(g('cwd-session-read')).cwd));
  const e = await run(root, 'explicit', 'pwd', { workingDirectory: root });
  assert.equal(out(e), `${root}\n`);
  // session cwd outside root is never reused
  await run(root, 'escape', 'cd /tmp; pwd');
  const n = await run(root, 'after-escape', 'pwd');
  assert.equal(out(n), `${root}\n`);
  // newline path never reaches the script
  await run(root, 'nl', `d=$'x\\ntouch ${path.join(base, 'pwn')}'; mkdir -p "$d"; cd -- "$d"`);
  const after = await run(root, 'nl-next', 'echo ok');
  assert.equal(out(after), 'ok\n'); assert.equal(fs.existsSync(path.join(base, 'pwn')), false);
});

test('init leader exits first: same-PGID background residue is reaped, marker never written', async () => {
  const root = freshRoot('initgroups');
  const bgp = path.join(base, 'bg-pid'), mark = path.join(base, 'bg-after');
  setProfile(`(echo $BASHPID > '${bgp}'; sleep 1.3; echo X > '${mark}') </dev/null >/dev/null 2>&1 &\n`);
  const fr = await run(root, 'init-bg', 'echo READY');
  assert.equal(out(fr), 'READY\n');
  const bpid = Number(fs.readFileSync(bgp, 'utf8'));
  const alive = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/\) Z /.test(st); } catch { return false; } };
  assert.equal(alive(bpid), false, 'residue reaped at init completion');
  await shutdownShells();
  await delay(1600);
  assert.equal(fs.existsSync(mark), false, 'background never continued');
});

test('PGID ownership: retired after init close; reused number never reclaimed (simulated, no real signals)', () => {
  const { spawnSync } = require('node:child_process');
  const h = path.join(__dirname, 'helpers', 'pgid-stale-lifecycle.cjs');
  const a = JSON.parse(spawnSync(process.execPath, [h], { encoding: 'utf8' }).stdout);
  assert.deepEqual(a.afterOriginalClose, []); assert.deepEqual(a.laterShutdownSignals, []);
  const b = JSON.parse(spawnSync(process.execPath, [h], { encoding: 'utf8', env: { ...process.env, MODE: 'residue' } }).stdout);
  assert.deepEqual(b.afterOriginalClose, [[-70001, 'SIGKILL']], 'original residue reaped once at close');
  assert.deepEqual(b.laterShutdownSignals, [[-70001, 'SIGKILL']], 'no second signal at shutdown');
});
