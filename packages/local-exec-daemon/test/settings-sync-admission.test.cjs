// t108u: per-request synchronous settings read (official pue existsSync/readFileSync, D:L82271/L82881),
// so one runBacklog() admission pass allocates exec ids and arms heartbeat timers before returning.
// Deterministic: no wall-clock spacing assertions; mocked setTimeout drives the heartbeat schedule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TRACE = path.join(os.tmpdir(), `adm-trace-${process.pid}.jsonl`); process.env.UC_TRACE_FILE = TRACE;
const settings = require('../dist/settings');
const { shutdownShells, resetExecIdCounter, lastAllocatedExecIdOrZero, handleShellStream, cancelRequest } = require('../dist/exec/handlers');
const { UserComputerProvider } = require('../dist/uc/provider');

test('loadSettingsSync re-reads the file on every call (no cache) and maps absent/damaged like loadSettings', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')); const env = { SAND_DATA_ROOT: data };
  try {
    assert.equal(settings.loadSettingsSync(env).permission, 'ask');
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'always' }));
    assert.equal(settings.loadSettingsSync(env).permission, 'always');
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'never' }));
    assert.equal(settings.loadSettingsSync(env).permission, 'never');
    fs.writeFileSync(path.join(data, 'settings.json'), '{bad');
    assert.deepEqual(settings.loadSettingsSync(env), await settings.loadSettings(env));
    assert.equal(settings.loadSettingsSync(env).damaged, true);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});


const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function mk(root) {
  const p = new UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic', credential: 'synthetic', root, permission: 'always',
    hello: { label: 'test', localRoot: root, terminalsFolder: root, standing: 'always', variant: 'test', serverAuthoritative: false } });
  const got = []; p.emit = (f) => { got.push(f); }; p.replies = { available: true };
  return { p, got };
}
function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')); const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'always' }));
  const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = data;
  return { root, done: () => { process.env.SAND_DATA_ROOT = old; fs.rmSync(root, { recursive: true, force: true }); } };
}
const shellQ = (id, command = 'sleep 5') => ({ id: 'q-' + id, requestId: id, kind: 2, serverMessage: { id: 1, shellStreamArgs: { command, timeout: 20000 } } });
const traceEvents = () => fs.readFileSync(TRACE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('admission pass (official order): reads synchronously, then ids + heartbeat arms after one await, before any shell preparation', async (t) => {
  const e = env(); const { p, got } = mk(e.root);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    fs.writeFileSync(TRACE, ''); resetExecIdCounter();
    const ids = Array.from({ length: 8 }, (_, i) => 'sh' + i);
    p.backlog = ids.map((id) => shellQ(id));
    p.runBacklog();
    assert.equal(lastAllocatedExecIdOrZero(), 0, 'no exec id inside the synchronous read pass (official await isLocalUseBlocked)');
    await tick();
    assert.equal(lastAllocatedExecIdOrZero(), 8);
    const ev = traceEvents().filter((x) => ['exec-id', 'hb-arm', 'shell-body', 'prep-call'].includes(x.ev));
    const firstPrep = ev.findIndex((x) => x.ev === 'shell-body' || x.ev === 'prep-call');
    const arms = ev.filter((x) => x.ev === 'hb-arm');
    assert.deepEqual(arms.map((x) => [x.rid, x.id]), ids.map((id, i) => [id, i + 1]), 'arms in admission order, ids 1..8');
    assert.ok(ev.lastIndexOf(arms[7]) < firstPrep, 'all 8 heartbeat timers armed before the first shell cwd/prepare work');
    t.mock.timers.tick(3000); await tick();
    const hb = got.filter((f) => f.message && f.message.heartbeat).map((f) => [f.requestId, f.message.heartbeat.id]);
    assert.deepEqual(hb, ids.map((id, i) => [id, i + 1]), 'all heartbeats due on the same 3000 ms tick');
  } finally { t.mock.timers.reset(); p.closed = true; await shutdownShells(); e.done(); }
});

test('cancel landing in the new admission await: no exec id, no start, no spawn; streamClose{id:0} (official O6r)', async () => {
  const e = env(); const { p, got } = mk(e.root);
  try {
    resetExecIdCounter();
    p.backlog = [shellQ('a', 'touch ran-a'), shellQ('b', 'touch ran-b')];
    p.runBacklog();
    p.cancelledIds.add('a'); // what the Poll cancel branch records for an active request
    await tick();
    const a = got.filter((f) => f.requestId === 'a');
    assert.deepEqual(a, [{ kind: 'control', requestId: 'a', message: { streamClose: { id: 0 } } }]);
    assert.equal(lastAllocatedExecIdOrZero(), 1, 'only b got an exec id');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(e.root, 'ran-a')), false);
  } finally { p.closed = true; await shutdownShells(); e.done(); }
});

test('stop landing in the new admission await: nothing is spawned after shutdown, each request gets streamClose{id:0}', async () => {
  const e = env(); const { p, got } = mk(e.root);
  try {
    resetExecIdCounter();
    p.backlog = [shellQ('x', 'touch ran-x')];
    p.runBacklog(); p.stopped = true;
    await tick(); await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(got, [{ kind: 'control', requestId: 'x', message: { streamClose: { id: 0 } } }]);
    assert.equal(fs.existsSync(path.join(e.root, 'ran-x')), false);
  } finally { p.closed = true; await shutdownShells(); e.done(); }
});

test('cancel landing in the new shell-body await: start, aborted exit, streamClose with the exec id; never spawned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')); const got = [];
  try {
    const job = handleShellStream({ root, requestId: 'c', msgId: 5, command: 'touch ran-c', emit: (f) => { got.push(f); } });
    assert.equal(cancelRequest('c'), true, 'lifecycle registered before the await');
    await job;
    const kinds = got.map((f) => f.message.shellStream ? Object.keys(f.message.shellStream)[0] : Object.keys(f.message)[0]);
    assert.deepEqual(kinds, ['start', 'exit', 'streamClose']);
    assert.equal(got[1].message.shellStream.exit.aborted, true); assert.equal(got[2].message.streamClose.id, 5);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(path.join(root, 'ran-c')), false);
  } finally { await shutdownShells(); fs.rmSync(root, { recursive: true, force: true }); }
});
