'use strict';
// UC keepalive (official sendKeepAlives/keepAliveDueAt, daemon.formatted.cjs L178601–178661) and the
// related data-submit deadline / cancelled-backlog closing frame. Unit tests stub the Connect client;
// the oracle test runs ours in bwrap against the same fake peer as the recorded official goldens.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Code, ConnectError } = require('@connectrpc/connect');
const uc = require('../dist/uc/provider.js');
const { UserComputerProvider, selectKeepAliveIds } = uc;
const { ReplyQueue } = require('../dist/transport/replies.js');

function mk() {
  const p = new UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'm', credential: 'c', root: '/tmp', permission: 'always',
    hello: { label: 't', localRoot: '/tmp', terminalsFolder: '/tmp', standing: 'always', variant: 't', serverAuthoritative: false } });
  const calls = [];
  let fail;
  p.client = { submitGrokBotUserComputerResponses: async (req, o) => { calls.push({ req, o }); if (fail) throw fail; return { acceptedCount: req.frames.length }; } };
  p.channel = { backendUrl: 'http://127.0.0.1:9', machineId: 'm', credential: 'c' };
  p.replies = new ReplyQueue(async () => {}, () => {});
  p.proven = true;
  return { p, calls, setFail: (e) => { fail = e; } };
}

test('selectKeepAliveIds: nothing due → none; due → all eligible within 1.5s window, earliest first, capped at 256', () => {
  const due = new Map([['a', 1000], ['b', 2400], ['c', 2600], ['x', 0]]);
  const el = new Set(['a', 'b', 'c']);
  assert.deepEqual(selectKeepAliveIds(due, el, 999), []);
  assert.deepEqual(selectKeepAliveIds(due, el, 1000), ['a', 'b']);
  const big = new Map(Array.from({ length: 300 }, (_, i) => [`r${i}`, i]));
  assert.equal(selectKeepAliveIds(big, new Set(big.keys()), 300).length, 256);
});

test('eligibility: backlog and queued replies yes; running-only, cancelled, stuck (≥120s) submitting no', async () => {
  const { p } = mk();
  p.active.add('run'); p.backlog.push({ requestId: 'bk' }); p.cancelledIds.add('bk2'); p.backlog.push({ requestId: 'bk2' });
  p.replies.submitting = ['sub']; p.replies.submittingSince = 0;
  assert.deepEqual([...p.keepAliveEligibleIds(1000)].sort(), ['bk', 'sub']);
  assert.deepEqual([...p.keepAliveEligibleIds(120000)].sort(), ['bk']);
});

test('sendKeepAlives: proven gate, messagesAccepted frames, admit +1s, heard +3s, prune unheld', async () => {
  const { p, calls } = mk();
  p.backlog.push({ requestId: 'bk' }); p.noteAdmitted('bk', 0); p.keepAliveDueAt.set('gone', 0);
  p.proven = false; assert.deepEqual(await p.sendKeepAlives(1000), []); assert.equal(calls.length, 0);
  p.proven = true;
  assert.deepEqual(await p.sendKeepAlives(999), []);
  assert.equal(p.keepAliveDueAt.has('gone'), false, 'unheld ids pruned');
  assert.deepEqual(await p.sendKeepAlives(1000), ['bk']);
  const f = calls[0].req.frames[0];
  assert.equal(f.requestId, 'bk'); assert.equal(f.frame.case, 'messagesAccepted');
  assert.equal(calls[0].o.timeoutMs, 3000);
  const heard = p.keepAliveDueAt.get('bk');
  assert.deepEqual(await p.sendKeepAlives(heard - 1), []);
  assert.deepEqual(await p.sendKeepAlives(heard), ['bk']);
});

test('ResourceExhausted pauses keepalives 5s; auth error closes admission', async () => {
  const { p, calls, setFail } = mk();
  p.backlog.push({ requestId: 'bk' }); p.noteAdmitted('bk', -1e6);
  setFail(new ConnectError('x', Code.ResourceExhausted));
  const t0 = performance.now();
  await p.sendKeepAlives(t0); assert.equal(calls.length, 1);
  setFail(undefined);
  assert.deepEqual(await p.sendKeepAlives(t0 + 4000), []);
  assert.deepEqual(await p.sendKeepAlives(performance.now() + 5001), ['bk']);
  const b = mk(); b.p.backlog.push({ requestId: 'x' }); b.p.noteAdmitted('x', -1e6);
  b.setFail(new ConnectError('x', Code.Unauthenticated));
  await b.p.sendKeepAlives(1000); assert.equal(b.p.blocked, true);
});

test('ReplyQueue exposes queued/submitting request ids', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const q = new ReplyQueue(async () => { await gate; }, () => {});
  q.enqueue(Buffer.from('a'), ['r1']); q.enqueue(Buffer.from('b'), ['r2']);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(q.submitting, ['r1']); assert.deepEqual([...q.requestIds()], ['r2']);
  release(); await q.drain(500);
  assert.deepEqual(q.submitting, []); assert.deepEqual([...q.requestIds()], []);
});

const dir = path.join(__dirname, '..', 'scripts', 'oracles');
test('keepalive-diff negative: missing keepalives / wrong id / late offset / missing cancel frame fail', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kad-'));
  const run = (s, mut) => { const o = JSON.parse(fs.readFileSync(path.join(dir, 'keepalive-official', `${s}.json`)));
    const u = JSON.parse(JSON.stringify(o)); mut(u);
    const a = path.join(tmp, 'o.json'), b = path.join(tmp, 'u.json'); fs.writeFileSync(a, JSON.stringify(o)); fs.writeFileSync(b, JSON.stringify(u));
    return spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), a, b]).status; };
  assert.equal(run('backlog', () => {}), 0);
  assert.notEqual(run('backlog', (u) => { u.keepalives = []; }), 0);
  assert.notEqual(run('backlog', (u) => { u.keepalives[0].ids = ['sh0']; }), 0);
  assert.notEqual(run('stall', (u) => { u.keepalives[1].t += 500; }), 0);
  assert.notEqual(run('cancel', (u) => { u.sh8 = []; }), 0);
  assert.notEqual(run('cancel', (u) => { u.results[0].status = 'fail'; }), 0);
});

const lab = '/workspace/local-exec-offline-lab-0793/input/main.cjs';
for (const s of ['backlog', 'cancel', 'stall', 'exhausted', 'pressure', 'rotation', 'stall-cancel']) {
  test(`oracle: ours vs official golden, scenario ${s} (bwrap, real daemon process)`, { skip: !(fs.existsSync('/usr/bin/bwrap') && fs.existsSync(lab)) }, () => {
    const r = spawnSync('python3', [path.join(dir, 'run-background.py'), 'uc-keepalive.cjs', s], { env: { ...process.env, REPO: path.resolve(__dirname, '..', '..', '..') }, encoding: 'utf8', timeout: 70000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-')); const f = path.join(tmp, 'ours.json');
    fs.writeFileSync(f, r.stdout.split('\n').find((l) => l.startsWith('{"scenario')));
    const d = spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), path.join(dir, 'keepalive-official', `${s}.json`), f], { encoding: 'utf8' });
    assert.equal(d.status, 0, d.stdout);
  });
}

// ---- t104 review regressions (P2-1..P2-4, P3) ----
test('P2-1 closing replies under reply-lane pressure: async capacity rejection is deferred, bounded, retried; no unhandled rejection', async () => {
  const { p } = mk();
  const unhandled = []; const onU = (e) => unhandled.push(e); process.on('unhandledRejection', onU);
  const errs = []; const oldErr = console.error; console.error = (m) => errs.push(String(m));
  try {
    let accept = false; const sent = [];
    p.replies = { available: false, enqueue: (body, ids) => accept ? (sent.push(ids[0]), Promise.resolve()) : Promise.reject(new Error('reply producer capacity exceeded')) };
    for (let i = 0; i < 200; i++) p.emitBusy({ id: `q${i}`, requestId: `r${i}`, kind: 2 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0);
    assert.equal(p.pendingClosings.length, 128, 'bounded');
    assert.ok(errs.some((m) => /closing reply for r\d+ dropped/.test(m)), 'overflow is logged, not silent');
    accept = true; p.replies.available = true; p.flushClosings();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.pendingClosings.length, 0); assert.equal(sent.length, 128); assert.equal(sent[0], 'r0', 'order kept');
  } finally { process.off('unhandledRejection', onU); console.error = oldErr; }
});

test('P2-2 channel fencing: a stale channel\'s 401 (keepalive or rejectCredential) does not close the rotated channel', async () => {
  const { p } = mk();
  const old = p.channel; const fresh = { ...old, credential: 'c-new' };
  p.backlog.push({ requestId: 'bk' }); p.noteAdmitted('bk', -1e6);
  p.client = { submitGrokBotUserComputerResponses: async () => { p.channel = fresh; throw new ConnectError('x', Code.Unauthenticated); } };
  await p.sendKeepAlives(1000);
  assert.equal(p.blocked, false, 'old-credential keepalive 401 after rotation ignored');
  p.rejectCredential(old); assert.equal(p.blocked, false);
  p.rejectCredential(fresh); assert.equal(p.blocked, true, 'current channel 401 still closes');
});

test('P2-3 ReplyQueue.drop aborts an all-cancelled in-flight submit and moves on; mixed batch keeps going; stop aborts', async () => {
  const signals = []; const bodies = [];
  const q = new ReplyQueue((body, signal) => { bodies.push(body.toString()); signals.push(signal);
    return new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); if (!body.toString().startsWith('one')) setTimeout(res, 10); }); }, () => {});
  q.enqueue(Buffer.from('one-a'), ['one']);
  await new Promise((r) => setImmediate(r));
  q.enqueue(Buffer.from('two-a'), ['two']);
  assert.deepEqual(q.submitting, ['one']);
  const t0 = performance.now();
  assert.equal(q.drop((id) => id === 'one'), 1);
  assert.ok(await q.drain(500)); assert.ok(performance.now() - t0 < 200, 'next request not stuck behind the cancelled 120s submit');
  assert.deepEqual(bodies, ['one-a', 'two-a']); assert.equal(signals[0].aborted, true);
  // mixed in-flight batch (merge on): not aborted when only one of its requests is cancelled
  let release; const sent2 = []; const q2 = new ReplyQueue((body, signal) => new Promise((res, rej) => { sent2.push(body.toString()); release = res; signal.addEventListener('abort', () => rej(new Error('aborted'))); }), () => {}, 1 << 20, 256, (b) => Buffer.concat(b));
  q2.enqueue(Buffer.from('w'), ['two']); await new Promise((r) => setImmediate(r));
  q2.enqueue(Buffer.from('x'), ['one']); q2.enqueue(Buffer.from('y'), ['two']); release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(q2.submitting.sort(), ['one', 'two']);
  assert.equal(q2.drop((id) => id === 'one'), 0); release(); assert.ok(await q2.drain(200)); assert.deepEqual(sent2, ['w', 'xy']);
  const q3 = new ReplyQueue((body, signal) => new Promise((res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), () => {});
  q3.enqueue(Buffer.from('z'), ['z']); await new Promise((r) => setImmediate(r));
  q3.stop(); await new Promise((r) => setImmediate(r)); assert.deepEqual(q3.submitting, []);
});

test('ReplyQueue merge: queued frames go out in one submit (official replies.take)', async () => {
  let release; const bodies = [];
  const q = new ReplyQueue(async (body) => { bodies.push(body.toString()); if (bodies.length === 1) await new Promise((r) => { release = r; }); }, () => {}, 1 << 20, 256, (b) => Buffer.concat(b));
  q.enqueue(Buffer.from('a'), ['r']); await new Promise((r) => setImmediate(r));
  q.enqueue(Buffer.from('b'), ['r']); q.enqueue(Buffer.from('c'), ['r']); release();
  assert.ok(await q.drain(500)); assert.deepEqual(bodies, ['a', 'bc']);
});

test('P3 keepalive-diff semantic data rules (negative + allowed-difference cases)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kad3-'));
  const run = (s, mut) => { const o = JSON.parse(fs.readFileSync(path.join(dir, 'keepalive-official', `${s}.json`)));
    const u = JSON.parse(JSON.stringify(o)); for (const k of Object.keys(u.data)) u.data[k] = u.data[k].filter((m) => !(m && Object.keys(m).length === 1 && m.heartbeat));
    mut(u);
    const a = path.join(tmp, 'o.json'), b = path.join(tmp, 'u.json'); fs.writeFileSync(a, JSON.stringify(o)); fs.writeFileSync(b, JSON.stringify(u));
    return spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), a, b], { encoding: 'utf8' }); };
  const ok = (r) => assert.equal(r.status, 0, r.stdout); const no = (r) => assert.notEqual(r.status, 0, r.stdout);
  ok(run('backlog', () => {}));
  no(run('backlog', (u) => { u.data = {}; u.dataSubmits = {}; u.dataSeq = []; }));             // all data submits deleted
  no(run('backlog', (u) => { delete u.data.sh3; }));                                           // one request's data missing
  no(run('backlog', (u) => { u.data.sh3 = u.data.sh3.filter((m) => !m.streamClose); }));        // lifecycle: no streamClose
  no(run('backlog', (u) => { u.data.sh3 = u.data.sh3.filter((m) => !m.shellStream?.exit); }));  // lifecycle: no exit
  no(run('backlog', (u) => { u.data.sh3.find((m) => m.shellStream?.stdout).shellStream.stdout.data = 'done9\n'; }));
  no(run('backlog', (u) => { u.data.sh3.forEach((m) => { if (m.shellStream?.stdout) m.id = 77; }); }));  // inconsistent exec id
  ok(run('backlog', (u) => { const i = u.data.sh3.findIndex((m) => m.shellStream?.stdout); const d = u.data.sh3[i].shellStream.stdout.data;
    u.data.sh3.splice(i, 1, { id: u.data.sh3[i].id, shellStream: { stdout: { data: d.slice(0, 2) } } }, { id: u.data.sh3[i].id, shellStream: { stdout: { data: d.slice(2) } } }); })); // chunking allowed
  ok(run('backlog', (u) => { const a = u.data.sh3, b = u.data.sh5; const ia = a.find((m) => 'id' in m).id, ib = b.find((m) => 'id' in m).id;
    const sw = (arr, x) => arr.forEach((m) => { if ('id' in m) m.id = x; for (const v of Object.values(m)) if (v && typeof v === 'object' && Object.keys(v).join() === 'id') v.id = x; }); sw(a, ib); sw(b, ia); })); // exec-id renumbering allowed
  no(run('stall-cancel', (u) => { u.closes = u.closes.filter((c) => c.ended); }));             // stalled submit not aborted
  no(run('stall-cancel', (u) => { u.firstNonKeepalive.two += 2000; }));                        // next request stuck
  no(run('rotation', (u) => { u.keepalives = u.keepalives.filter((k) => k.t <= u.marks.old401); })); // channel blocked after stale 401
  no(run('pressure', (u) => { u.results = [{ name: 'pressure', status: 'fail', error: 'daemon died before cleanup' }]; u.daemonAlive = false; }));
  no(run('pressure', (u) => { u.keepalives.push({ t: u.marks.cancel + 1000, ids: ['sh9'] }); })); // cancelled id still keepalived
});

const labOk = fs.existsSync('/usr/bin/bwrap') && fs.existsSync('/workspace/local-exec-offline-lab-0793/input/main.cjs');
test('P2-4 death gate: daemon SIGKILLed mid-run → scenario result fail, runner exit non-zero, comparator non-zero', { skip: !labOk }, () => {
  const r = spawnSync('python3', [path.join(dir, 'run-background.py'), 'uc-keepalive.cjs', 'stall', '--kill-at=3000'], { env: { ...process.env, REPO: path.resolve(__dirname, '..', '..', '..') }, encoding: 'utf8', timeout: 70000 });
  assert.notEqual(r.status, 0, r.stdout);
  const line = r.stdout.split('\n').find((l) => l.startsWith('{"scenario')); assert.ok(line, r.stdout);
  const d = JSON.parse(line); assert.equal(d.daemonAlive, false); assert.equal(d.results[0].status, 'fail');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kadg-')); const f = path.join(tmp, 'ours.json'); fs.writeFileSync(f, line);
  assert.notEqual(spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), path.join(dir, 'keepalive-official', 'stall.json'), f]).status, 0);
});
