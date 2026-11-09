'use strict';
// t198: Ko/Ud spawn path (Md, CE sharedBuildCache, spawnWorkload cgroup + FUSE cwd hop, BNe) and ls cancel → timeout.
// D = 0.79.3 daemon.formatted.cjs. Synthetic only (temp dirs, fake rg scripts, fake cgroup.procs file); no official binaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const W = require('../dist/exec/spawn-workload');
const H = require('../dist/exec/handlers');
const R = require('../dist/exec/ls-ripgrep');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const collect = (c) => new Promise((res) => {
  let out = ''; c.stdout?.on('data', (b) => { out += b; });
  c.once('error', (e) => res({ error: e, out })); c.once('close', (code) => res({ code, out }));
});

test('ZUt (D:16758): direct unless linux + /sys/fs/cgroup/… + no ".." + writable cgroup.procs; Oae text', () => {
  const ok = () => true;
  assert.deepEqual(W.ZUt('darwin', '/sys/fs/cgroup/a', ok), { kind: 'direct' });
  assert.deepEqual(W.ZUt('linux', undefined, ok), { kind: 'direct' });
  assert.deepEqual(W.ZUt('linux', '/tmp/x', ok), { kind: 'direct' });
  assert.deepEqual(W.ZUt('linux', '/sys/fs/cgroup/a/../b', ok), { kind: 'direct' });
  assert.deepEqual(W.ZUt('linux', '/sys/fs/cgroup/a', () => false), { kind: 'direct' });
  assert.deepEqual(W.ZUt('linux', '/sys/fs/cgroup/a.b/c_d', ok), { kind: 'armed', workloadCgroupDir: '/sys/fs/cgroup/a.b/c_d', executable: '/bin/sh',
    argumentPrefix: ['-c', `echo $$ 2>/dev/null > '/sys/fs/cgroup/a.b/c_d/cgroup.procs'; echo 0 2>/dev/null > /proc/$$/oom_score_adj; exec "$0" "$@"`] });
  // This test process has no CURSOR_WORKLOAD_CGROUP → direct, like an App started without it.
  if (process.env.CURSOR_WORKLOAD_CGROUP === undefined) assert.deepEqual(W.workloadMode(), { kind: 'direct' });
});

test('t$t armed: child writes its own pid into <dir>/cgroup.procs then execs the target (same pid); BNe hook gets pid', async () => {
  const dir = tmp('t198-cg-');
  try {
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), '');
    const pids = [];
    const sw = W.t$t({ kind: 'armed', workloadCgroupDir: dir, executable: '/bin/sh', argumentPrefix: ['-c', W.Oae({ workloadCgroupDir: dir })] }, (p) => pids.push(p));
    const c = sw(spawn, '/bin/sh', ['-c', 'echo $$'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const r = await collect(c);
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), String(c.pid));
    assert.equal(fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').trim(), String(c.pid));
    assert.deepEqual(pids, [c.pid]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_ae (D:15327): hop only on linux FUSE cwd, not with shell:true; args = sh -c UR cursor-fuse-cwd <cwd> cmd …', () => {
  const mi = '42 193 0:41 / /mnt/f rw,relatime - fuse.agent-store x rw\n43 1 0:5 / /mnt rw - ext4 /dev/sda rw\n';
  const opts = { readMountinfo: () => mi, processCwd: '/home/u', platform: 'linux' };
  const UR = `cd "$1" || { printf %s 'cursor-fuse-cwd:cd'; exit 79; }; shift; exec "$@"`;
  assert.deepEqual(W._ae('/bin/ls', ['-a'], { cwd: '/mnt/f/sub' }, opts),
    { command: '/bin/sh', args: ['-c', UR, 'cursor-fuse-cwd', '/mnt/f/sub', '/bin/ls', '-a'], options: { cwd: '/home/u' }, hopped: true, hopCwd: '/mnt/f/sub' });
  assert.equal(W._ae('/bin/ls', [], { cwd: '/mnt/other' }, opts).hopped, false);
  assert.equal(W._ae('/bin/ls', [], { cwd: '/mnt/f', shell: true }, opts).hopped, false);
  assert.equal(W._ae('/bin/ls', [], { cwd: '/mnt/f' }, { ...opts, platform: 'darwin' }).hopped, false);
  // spawning process itself on FUSE → hop from tmpdir
  assert.equal(W._ae('/bin/ls', [], { cwd: '/mnt/f' }, { ...opts, processCwd: '/mnt/f/x', tmpdir: '/T' }).options.cwd, '/T');
  assert.equal(W.FR({ CURSOR_SPAWN_CWD_HOP: '1' }), true);
  assert.equal(W.FR({ CURSOR_SPAWN_CWD_HOP: 'true' }), false);
});

const fuseRoot = (() => { try { return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((l) => l.split(' ')).find((f) => f.length >= 10 && f[f.indexOf('-', 6) + 1]?.startsWith('fuse.') && fs.statSync(f[4]).isDirectory())?.[4]; } catch { return undefined; } })();
test('real FUSE cwd hop (CURSOR_SPAWN_CWD_HOP=1): pwd lands in the FUSE dir; unreachable cwd → ENOENT "working directory is not accessible"', { skip: !fuseRoot && 'no FUSE mount on this box' }, async () => {
  const saved = process.env.CURSOR_SPAWN_CWD_HOP;
  process.env.CURSOR_SPAWN_CWD_HOP = '1';
  try {
    const sw = W.t$t({ kind: 'direct' }, () => {});
    const ok = await collect(sw(spawn, '/bin/sh', ['-c', 'pwd -P'], { cwd: fuseRoot, stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.equal(ok.code, 0); assert.equal(ok.out.trim(), fs.realpathSync(fuseRoot));
    const bad = path.join(fuseRoot, 't198-definitely-missing-' + process.pid);
    const r = await collect(sw(spawn, '/bin/true', [], { cwd: bad, stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.equal(r.error?.code, 'ENOENT'); assert.equal(r.error?.message, `working directory is not accessible: ${bad}`);
    assert.equal(r.out, ''); // marker swallowed
  } finally { saved === undefined ? delete process.env.CURSOR_SPAWN_CWD_HOP : (process.env.CURSOR_SPAWN_CWD_HOP = saved); }
});

test('Ud (D:20798): Md strips ELECTRON_RUN_AS_NODE/AGENT_HOST_DAEMON_*/SSH_CLIENT; enableSharedBuildCache adds CE under tmpdir/cursor-sandbox-cache/<id>, caller env wins', async () => {
  const env = { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', AGENT_HOST_DAEMON_Q: '1', SSH_CLIENT: 'x', SSH2_CLIENT: 'y', GOCACHE: '/mine' };
  const sh = ['-c', 'printf "%s|%s|%s|%s|%s|%s" "$ELECTRON_RUN_AS_NODE" "$AGENT_HOST_DAEMON_Q" "$SSH_CLIENT" "$SSH2_CLIENT" "$GOCACHE" "$NPM_CONFIG_CACHE"'];
  const a = await collect(W.Ud('/bin/sh', sh, { env: { ...env }, stdio: ['ignore', 'pipe', 'ignore'] }, { type: 'insecure_none' }));
  assert.equal(a.out, '||||/mine|');
  const b = await collect(W.Ud('/bin/sh', sh, { env: { ...env }, stdio: ['ignore', 'pipe', 'ignore'] }, { type: 'insecure_none', enableSharedBuildCache: true }));
  const [, , , , go, npm] = b.out.split('|');
  assert.equal(go, '/mine');
  const ce = W.CE();
  assert.equal(npm, ce.NPM_CONFIG_CACHE); // {...Md(process.env), ...CE(), ...callerEnv}: CE beats inherited, caller beats CE
  assert.match(ce.NPM_CONFIG_CACHE, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/cursor-sandbox-cache/[0-9a-f]{32}/npm$`));
  assert.equal(W.CE().GOCACHE, ce.GOCACHE); // one id per process
  assert.equal(fs.existsSync(path.dirname(ce.NPM_CONFIG_CACHE)), false); // CE creates nothing
  assert.throws(() => W.Ud('/bin/true', [], {}, { type: 'workspace_readwrite' }), /Sandbox policy 'workspace_readwrite' is not supported/);
});

test('shellStream with requestedSandboxPolicy INSECURE_NONE + enableSharedBuildCache gets CE env (fKt keeps it, D:20180–20205)', async () => {
  const root = tmp('t198-sh-');
  const saved = process.env.CARGO_TARGET_DIR; delete process.env.CARGO_TARGET_DIR;
  try {
    const run = async (pol) => {
      const got = [];
      await H.dispatchExec({ root, requestId: 's' + Math.random(), permission: 'always', emit: (f) => got.push(f),
        serverMessage: { shellStreamArgs: { command: 'printf "[%s]" "$CARGO_TARGET_DIR"', workingDirectory: root, timeout: 20000, ...(pol ? { requestedSandboxPolicy: pol } : {}) } } });
      for (let i = 0; i < 200 && !got.some((f) => f.message?.shellStream?.exit); i++) await new Promise((r) => setTimeout(r, 25));
      return got.filter((f) => f.message?.shellStream?.stdout).map((f) => f.message.shellStream.stdout.data).join('');
    };
    assert.equal(await run(undefined), '[]');
    assert.equal(await run({ type: 'TYPE_INSECURE_NONE', enableSharedBuildCache: true }), `[${W.CE().CARGO_TARGET_DIR}]`);
  } finally { saved === undefined ? delete process.env.CARGO_TARGET_DIR : (process.env.CARGO_TARGET_DIR = saved); fs.rmSync(root, { recursive: true, force: true }); }
});

test('ls cancel (handleCancel D:136353 → ctx abort) → LsResult.timeout with the partial tree, before timeoutMs', async () => {
  const root = tmp('t198-lc-'), bin = tmp('t198-bin-');
  try {
    const rg = path.join(bin, 'rg'); fs.writeFileSync(rg, '#!/bin/sh\nprintf "first.txt\\n"\nexec sleep 5\n', { mode: 0o755 });
    R.configureRipgrepPath(rg);
    const got = [];
    const t0 = Date.now();
    const p = H.handleLs({ root, requestId: 'lc', msgId: 1, path: root, emit: (f) => got.push(f), timeoutMs: 60000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(H.cancelRequest('lc'), true);
    await p;
    assert.ok(Date.now() - t0 < 4000);
    assert.deepEqual(got.find((f) => f.kind === 'client').message.lsResult,
      { timeout: { directoryTreeRoot: { absPath: root, childrenWereProcessed: true, childrenFiles: [{ name: 'first.txt' }] } } });
    assert.equal(H.cancelRequest('lc'), false); // finished → no longer tracked
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
});
