'use strict';
// t196: ls ripgrep-tree path (LocalLsExecutor D:129394–129542, kO D:107439, yer D:107400, nl/b0 D:19002–19015).
// Synthetic temp dirs only; the "rg" used is the box's /usr/bin/rg or tiny fake scripts. No official binaries run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../dist/exec/handlers');
const R = require('../dist/exec/ls-ripgrep');


const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const ls = async (root, extra = {}) => {
  const got = [];
  await H.handleLs({ root, requestId: 'l', msgId: 1, path: root, emit: (f) => got.push(f), ...extra });
  const c = got.find((f) => f.kind === 'client');
  assert.ok(got.some((f) => f.kind === 'control' && f.message.streamClose), 'stream closes');
  return c.message.lsResult;
};
const fake = (dir, body) => { const p = path.join(dir, 'fake-rg'); fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); return p; };
const RG = fs.existsSync('/usr/bin/rg') ? '/usr/bin/rg' : null;

// Order matters: Z2 is module state (no reset hook); unconfigured cases run first.
test('unconfigured (0.79.3 App state): exact nl() error, sandbox not consulted first, b0 identity', async () => {
  assert.equal(R.getRipgrepPath(), undefined);
  const root = tmp('t196-u-');
  try {
    assert.deepEqual(await ls(root), { error: { path: root, error: H.RIPGREP_UNCONFIGURED } });
    assert.deepEqual(await ls(root, { sandboxPolicy: { type: 'TYPE_WORKSPACE_READWRITE' } }), { error: { path: root, error: H.RIPGREP_UNCONFIGURED } });
    const env = { PATH: '/a:/b', X: '1' };
    assert.equal(R.b0(env), env);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('b0 after configure: PATH gets rg dir first, CURSOR_RIPGREP_PATH set; relative path → identity', () => {
  R.configureRipgrepPath('rg-relative');
  const e0 = { PATH: '/a' };
  assert.equal(R.b0(e0), e0);
  R.configureRipgrepPath('/opt/x/bin/rg');
  assert.deepEqual(R.b0({ PATH: '/a:/opt/x/bin:/b', Y: '2' }), { PATH: '/opt/x/bin:/a:/b', Y: '2', CURSOR_RIPGREP_PATH: '/opt/x/bin/rg' });
  assert.deepEqual(R.b0({ Path: '/z' }), { Path: '/opt/x/bin:/z', CURSOR_RIPGREP_PATH: '/opt/x/bin/rg' }); // mWt keeps the existing key (IGe)
  assert.deepEqual(R.b0({}), { PATH: '/opt/x/bin:/usr/local/bin:/usr/bin:/bin', CURSOR_RIPGREP_PATH: '/opt/x/bin/rg' });
});

test('kO argv/cwd/env as yer spawns it; exit 1 with no output → empty success tree', async () => {
  const root = tmp('t196-argv-'), bin = tmp('t196-bin-'), out = path.join(bin, 'argv.txt');
  const saved = { E: process.env.ELECTRON_RUN_AS_NODE, A: process.env.AGENT_HOST_DAEMON_X, O: process.env.T196_OUT, T: process.env.CURSOR_RIPWALK_THREADS, C: process.env.CURSOR_RIPGREP_PATH };
  // yer passes Md(process.env) — no b0 — so CURSOR_RIPGREP_PATH is only whatever the parent env had; clear it here.
  try {
    process.env.ELECTRON_RUN_AS_NODE = '1'; process.env.AGENT_HOST_DAEMON_X = '1'; process.env.T196_OUT = out;
    delete process.env.CURSOR_RIPWALK_THREADS; delete process.env.CURSOR_RIPGREP_PATH;
    R.configureRipgrepPath(fake(bin, 'printf "%s\\n" "$@" > "$T196_OUT"; printf "cwd=%s\\n" "$(pwd)" >> "$T196_OUT"; printf "env=%s|%s|%s\\n" "$ELECTRON_RUN_AS_NODE" "$AGENT_HOST_DAEMON_X" "$CURSOR_RIPGREP_PATH" >> "$T196_OUT"; exit 1'));
    const r = await ls(root, { ignore: ['*.js', 'node_modules'] });
    assert.deepEqual(r, { success: { directoryTreeRoot: { absPath: root, childrenWereProcessed: true } } });
    const thr = String(Math.min(2, os.availableParallelism()));
    assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n'), [
      '--files', '--hidden', '--no-require-git', '--no-config', '--color=never', '--threads', thr,
      '--case-sensitive', '--iglob', '!*.js', '--iglob', '!node_modules', `cwd=${root}`, 'env=||']);
    process.env.CURSOR_RIPWALK_THREADS = '0';
    await ls(root);
    assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n').slice(0, 6), ['--files', '--hidden', '--no-require-git', '--no-config', '--color=never', '--case-sensitive']);
  } finally {
    for (const [k, v] of [['ELECTRON_RUN_AS_NODE', saved.E], ['AGENT_HOST_DAEMON_X', saved.A], ['T196_OUT', saved.O], ['CURSOR_RIPWALK_THREADS', saved.T], ['CURSOR_RIPGREP_PATH', saved.C]])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('rg failure with no results → LsResult.error "Ripgrep failed (exit N) with no results: <stderr>"', async () => {
  const root = tmp('t196-f-'), bin = tmp('t196-bin-');
  try {
    R.configureRipgrepPath(fake(bin, 'echo boom >&2; exit 2'));
    assert.deepEqual(await ls(root), { error: { path: root, error: 'Ripgrep failed (exit 2) with no results: boom\n' } });
    R.configureRipgrepPath(path.join(bin, 'missing-rg'));
    const r = await ls(root);
    assert.match(r.error.error, /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('non-insecure_none sandbox policy once configured → Ud/ol unsupported text', async () => {
  const root = tmp('t196-s-');
  try {
    R.configureRipgrepPath(RG || '/usr/bin/rg');
    const r = await ls(root, { sandboxPolicy: { type: 'TYPE_WORKSPACE_READONLY' } });
    assert.match(r.error.error, /^Sandbox policy 'workspace_readonly' is not supported on this system\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('timeout: partial tree from lines seen before the deadline → LsResult.timeout', async () => {
  const root = tmp('t196-t-'), bin = tmp('t196-bin-');
  try {
    R.configureRipgrepPath(fake(bin, 'printf "early.txt\\nsub/late.md\\n"; exec sleep 5'));
    const t0 = Date.now();
    const r = await ls(root, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 4000);
    assert.deepEqual(r, { timeout: { directoryTreeRoot: {
      absPath: root, childrenWereProcessed: true, childrenFiles: [{ name: 'early.txt' }],
      childrenDirs: [{ absPath: path.join(root, 'sub'), childrenWereProcessed: true, childrenFiles: [{ name: 'late.md' }] }] } } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('real rg: sorted tree (localeCompare), hidden files, .gitignore honoured, LsArgs.ignore via dispatchExec', { skip: !RG && 'no rg on box' }, async () => {
  const root = tmp('t196-r-');
  try {
    R.configureRipgrepPath(RG);
    for (const [p, c] of [['z.txt', 'z'], ['A.md', 'a'], ['.hidden', 'h'], ['.gitignore', 'ign.log\n'], ['ign.log', 'x'],
      ['b/x.ts', 'x'], ['b/c/deep.json', '{}'], ['a/y.js', 'y']]) {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c);
    }
    const r = await ls(root);
    const node = (p, files, dirs = []) => ({ absPath: path.join(root, p), childrenWereProcessed: true,
      ...(dirs.length ? { childrenDirs: dirs } : {}), ...(files.length ? { childrenFiles: files.map((name) => ({ name })) } : {}) });
    assert.deepEqual(r, { success: { directoryTreeRoot: node('', ['.gitignore', '.hidden', 'A.md', 'z.txt'], [
      node('a', ['y.js']), node('b', ['x.ts'], [node('b/c', ['deep.json'])])]) } });
    // Through dispatchExec: lsArgs.ignore → --iglob !*.js removes a/ entirely (dirs only come from files).
    const got = [];
    await H.dispatchExec({ root, requestId: 'd', permission: 'always', serverMessage: { lsArgs: { path: root, ignore: ['*.js'] } }, emit: (f) => got.push(f) });
    const c = got.find((f) => f.kind === 'client');
    assert.ok(c, JSON.stringify(got));
    assert.deepEqual(c.message.lsResult.success.directoryTreeRoot.childrenDirs.map((d) => path.basename(d.absPath)), ['b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real rg: 2500-char budget overflow → childrenWereProcessed=false, numFiles + extension counts on chain', { skip: !RG && 'no rg on box' }, async () => {
  const root = tmp('t196-b-');
  try {
    R.configureRipgrepPath(RG);
    const names = [];
    for (let i = 0; i < 40; i++) { const n = String(i).padStart(2, '0') + 'f'.repeat(97) + '.txt'; names.push(n); fs.writeFileSync(path.join(root, n), ''); }
    const t = (await ls(root)).success.directoryTreeRoot;
    const kept = (t.childrenFiles || []).map((f) => f.name);
    assert.equal(t.childrenWereProcessed, undefined); // false → omitted in proto JSON
    assert.ok(root.length + kept.reduce((a, n) => a + n.length, 0) <= 2500);
    assert.equal(kept.length, Math.floor((2500 - root.length) / 103));
    assert.equal(t.numFiles, 40 - kept.length);
    assert.deepEqual(t.fullSubtreeExtensionCounts, { '.txt': 40 - kept.length });
    assert.deepEqual(kept, [...kept].sort((a, b) => a.localeCompare(b)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
