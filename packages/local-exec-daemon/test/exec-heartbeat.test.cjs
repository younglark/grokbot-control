// t112: official per-exec heartbeat wrapper (daemon.formatted.cjs L98140–98153, finally L98187–98193, zHt=3000 L98040).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../dist/exec/handlers.js');

const hbOf = (out) => out.filter((f) => f.message && f.message.heartbeat);
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('heartbeat: first at 3000 ms after the handler starts, then every 3000 ms after the previous write settled; id = exec id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const out = []; let finish;
  const job = h.withExecHeartbeat('r', 7, (f) => { out.push(f); }, () => new Promise((r) => { finish = r; }));
  t.mock.timers.tick(2999); await flush(); assert.equal(hbOf(out).length, 0);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(hbOf(out), [{ kind: 'control', requestId: 'r', message: { heartbeat: { id: 7 } } }]);
  t.mock.timers.tick(3000); await flush(); assert.equal(hbOf(out).length, 2);
  t.mock.timers.tick(3000); await flush(); assert.equal(hbOf(out).length, 3);
  finish(); await job;
  t.mock.timers.tick(30000); await flush(); assert.equal(hbOf(out).length, 3, 'timer cleared on completion');
});

test('heartbeat: next timer is armed only after the write settles (slow consumer)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const out = []; let release; let finish;
  const job = h.withExecHeartbeat('r', 1, (f) => { out.push(f); return new Promise((r) => { release = r; }); }, () => new Promise((r) => { finish = r; }));
  t.mock.timers.tick(3000); await flush(); assert.equal(hbOf(out).length, 1);
  t.mock.timers.tick(9000); await flush(); assert.equal(hbOf(out).length, 1, 'no new heartbeat while the previous write is pending');
  release(); await flush(); t.mock.timers.tick(3000); await flush(); assert.equal(hbOf(out).length, 2);
  finish(); release(); await job;
});

test('heartbeat: an async (and a sync) emit error is swallowed and ends the chain; the job is not aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = []; const onU = (e) => unhandled.push(e); process.on('unhandledRejection', onU);
  try {
    for (const mode of ['async', 'sync']) {
      let n = 0; let finish;
      const job = h.withExecHeartbeat('r', 1, (f) => { if (f.message.heartbeat) { n++; if (mode === 'sync') throw new Error('x'); return Promise.reject(new Error('x')); } }, () => new Promise((r) => { finish = r; }));
      t.mock.timers.tick(3000); await flush(); t.mock.timers.tick(30000); await flush();
      assert.equal(n, 1, `${mode}: chain stops after a failed write`);
      finish(); await job;
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onU); }
});

test('heartbeat: no heartbeat after streamClose/throw; run() failure still clears the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const out = []; let finish;
  const job = h.withExecHeartbeat('r', 3, (f) => { out.push(f); }, async (emit) => { await emit({ kind: 'control', requestId: 'r', message: { streamClose: { id: 3 } } }); await new Promise((r) => { finish = r; }); });
  await flush(); t.mock.timers.tick(10000); await flush(); assert.equal(hbOf(out).length, 0); finish(); await job;
  const bad = h.withExecHeartbeat('r', 4, () => {}, async () => { throw new Error('boom'); });
  await assert.rejects(bad, /boom/);
  t.mock.timers.tick(10000); await flush();
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
const run = (requestId, command, out) => h.dispatchExec({ root, requestId, serverMessage: { shellStreamArgs: { command, timeout: 20000 } }, permission: 'always', emit: (f) => { out.push(f); } });
const kinds = (out) => out.map((f) => f.message.heartbeat ? 'heartbeat' : Object.keys(f.message.shellStream || f.message).filter((k) => k !== 'id' && k !== 'localExecutionTimeMs')[0]);

test('real shell: sleep 3.4 → start, heartbeat, exit, streamClose with one exec id; nothing after close', async () => {
  const out = []; await run('real', 'sleep 3.4', out);
  await new Promise((r) => setTimeout(r, 3200));
  assert.deepEqual(kinds(out), ['start', 'heartbeat', 'exit', 'streamClose']);
  const ids = new Set(out.map((f) => f.message.id ?? Object.values(f.message).find((v) => v && typeof v === 'object' && 'id' in v).id));
  assert.equal(ids.size, 1);
});

test('real shell: cancel and shutdown end the heartbeat (no frame after streamClose)', async () => {
  const a = []; const pa = run('cx', 'sleep 30', a);
  await new Promise((r) => setTimeout(r, 3300)); assert.equal(hbOf(a).length, 1);
  assert.equal(h.cancelRequest('cx'), true); await pa;
  const b = []; const pb = run('sd', 'sleep 30', b);
  await new Promise((r) => setTimeout(r, 500)); await h.shutdownShells(); await pb;
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(kinds(a).at(-1), 'streamClose'); assert.equal(hbOf(a).length, 1);
  assert.equal(kinds(b).at(-1), 'streamClose'); assert.equal(hbOf(b).length, 0);
  assert.ok(a.find((f) => f.message.shellStream?.exit?.aborted));
});

test('no heartbeat for requests refused before the exec handler (permission) or unsupported', async () => {
  const out = [];
  await h.dispatchExec({ root, requestId: 'nv', serverMessage: { shellStreamArgs: { command: 'sleep 4' } }, permission: 'never', emit: (f) => { out.push(f); } });
  await h.dispatchExec({ root, requestId: 'un', serverMessage: { fooArgs: {} }, permission: 'always', emit: (f) => { out.push(f); } });
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(hbOf(out).length, 0);
});
