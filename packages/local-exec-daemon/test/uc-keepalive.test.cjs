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
  assert.notEqual(run('stall', (u) => { u.keepalives[1].t += 400; }), 0);
  assert.notEqual(run('cancel', (u) => { u.sh8 = []; }), 0);
  assert.notEqual(run('cancel', (u) => { u.results[0].status = 'fail'; }), 0);
});

const lab = '/workspace/local-exec-offline-lab-0793/input/main.cjs';
for (const s of ['backlog', 'cancel', 'stall', 'exhausted', 'pressure', 'rotation', 'stall-cancel', 'overflow', 'hb-hold-exit', 'hb-hold-burst']) {
  test(`oracle: ours vs official golden, scenario ${s} (bwrap, real daemon process)`, { skip: !(fs.existsSync('/usr/bin/bwrap') && fs.existsSync(lab)) }, () => {
    const r = spawnSync('python3', [path.join(dir, 'run-background.py'), 'uc-keepalive.cjs', s], { env: { ...process.env, REPO: path.resolve(__dirname, '..', '..', '..') }, encoding: 'utf8', timeout: 70000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-')); const f = path.join(tmp, 'ours.json');
    fs.writeFileSync(f, r.stdout.split('\n').find((l) => l.startsWith('{"scenario')));
    const d = spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), path.join(dir, 'keepalive-official', `${s}.json`), f], { encoding: 'utf8' });
    assert.equal(d.status, 0, d.stdout);
  });
}

test('t112 heartbeat boundary control: recorded b48082b runs (no exec heartbeat; KA named all running execs) FAIL the gate', () => {
  for (const s of ['hb-hold-exit', 'hb-hold-burst']) {
    const r = spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), path.join(dir, 'keepalive-official', `${s}.json`), path.join(dir, 'keepalive-negative', `${s}-b48082b.json`)], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, r.stdout); assert.match(r.stdout, /sh3: data differs: .*heartbeat/);
  }
});

// ---- t104 review regressions (P2-1..P2-4, P3) ----
test('P2-1 closing replies: held by lane or bounded deferral, otherwise the work stays retryable (never ACK-then-drop)', async () => {
  const { p } = mk();
  const unhandled = []; const onU = (e) => unhandled.push(e); process.on('unhandledRejection', onU);
  try {
    let release; const sent = [];
    p.replies = new ReplyQueue(async (body) => { sent.push(body); if (sent.length === 1) await new Promise((r) => { release = r; }); }, () => {}, 1 << 20, 4, (b) => Buffer.concat(b));
    const stored = [];
    for (let i = 0; i < 200; i++) stored.push(p.storeClosing({ id: `q${i}`, requestId: `r${i}`, kind: 2 }, 'busy'));
    const n = stored.filter(Boolean).length;
    const cap = 4 + p.closingRoom(); assert.ok(cap >= 4 + 128 && n === Math.min(200, cap), 'lane (4 frames) + bounded deferral'); assert.deepEqual(stored.slice(n), Array(200 - n).fill(false));
    assert.equal(p.pendingClosings.length, n - 4);
    // a rejected busy item is left unacknowledged: removed from pendingAcks and seen → redelivered
    p.seen.add('q199'); p.pendingAcks.push('q199'); p.unack({ id: 'q199', requestId: 'r199', kind: 2 }); p.pendingAcks.length = 0;
    assert.equal(p.seen.has('q199'), false); assert.deepEqual(p.pendingAcks, []);
    // deferred closings are held + keepalive-eligible (official replies.requestIds())
    p.noteAdmitted('r10', 0);
    assert.ok(p.heldRequestIds().has('r10')); assert.ok(p.keepAliveEligibleIds(1).has('r10'));
    release(); await new Promise((r) => setTimeout(r, 10));
    for (let k = 0; k < 100 && p.pendingClosings.length; k++) { p.flushClosings(); await new Promise((r) => setTimeout(r, 2)); }
    assert.equal(p.pendingClosings.length, 0); assert.ok(await p.replies.drain(500));
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onU); }
});

test('P2-1 backlog drain keeps items whose closing reply cannot be held; cancel stays unacknowledged without room', async () => {
  const { p } = mk();
  p.replies = { offer: () => false, enqueue: async () => {}, available: false };
  p.pendingClosings = Array.from({ length: uc.UC_PENDING_CLOSINGS_MAX }, (_, i) => ({ kind: 'control', requestId: `x${i}`, message: { throw: { id: 0, error: 'e' } } }));
  p.lastPolledAt = 1; p.backlog = [{ id: 'b1', requestId: 'b1', kind: 2 }];
  p.superviseBacklog(1 + 16000);
  assert.deepEqual(p.backlog.map((q) => q.requestId), ['b1'], 'not dropped');
  assert.equal(p.closingRoom(), 0);
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

test('P2-2 fence at the failure site: RPC 401 then rotation in a microtask (before the lane catch) does not block the new channel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-rot-')); const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = root;
  try {
    const p = new UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic-m', credential: 'synthetic-old', root, permission: 'always',
      hello: { label: 'lab', localRoot: root, terminalsFolder: root, standing: 'always', variant: 'lab', supervised: true, serverAuthoritative: false } });
    let rejectRPC; const creds = [];
    p.client = {
      submitGrokBotUserComputerResponses: (req) => { creds.push(req.credential); return creds.length === 1 ? new Promise((_, r) => { rejectRPC = r; }) : Promise.resolve({ acceptedCount: req.frames.length }); },
      pollGrokBotUserComputerRequests: async () => ({ requests: [] }), withdrawGrokBotUserComputerPresence: async () => ({}),
      watchGrokBotUserComputerRequests: async function* (_, { signal }) { yield { event: { case: 'connected', value: {} } }; await new Promise((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); }); },
    };
    const running = p.start();
    while (!p.proven) await new Promise((r) => setImmediate(r));
    await p.emit({ kind: 'control', requestId: 'q', message: { throw: { error: 'synthetic' } } });
    let rotated = false;
    rejectRPC(new ConnectError('rejected', Code.Unauthenticated));
    queueMicrotask(() => { rotated = p.updateChannel({ backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic-m', credential: 'synthetic-new' }); });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(rotated, true); assert.equal(p.blocked, false); assert.equal(p.abort.signal.aborted, false); assert.equal(p.replies.failure, undefined);
    assert.ok(await p.replies.drain(1000)); assert.deepEqual(creds, ['synthetic-old', 'synthetic-new'], 'same reply retried on the new channel');
    // control: a 401 for the current channel still closes admission
    const q = new ReplyQueue(async () => { throw new (require('../dist/transport/replies.js').HttpStatusError)(401, 'cur'); }, (e) => e.epoch === 'cur');
    q.enqueue(Buffer.from('x'), ['x']); await new Promise((r) => setTimeout(r, 5)); assert.equal(String(q.failure), 'Error: reply HTTP 401');
    await p.stop(); await running;
  } finally { process.env.SAND_DATA_ROOT = old; fs.rmSync(root, { recursive: true, force: true }); }
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
    // t112: ours now emits the official exec heartbeat; the official data is compared as-is (no heartbeat filtering).
    const u = JSON.parse(JSON.stringify(o));
    mut(u);
    const a = path.join(tmp, 'o.json'), b = path.join(tmp, 'u.json'); fs.writeFileSync(a, JSON.stringify(o)); fs.writeFileSync(b, JSON.stringify(u));
    return spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), a, b], { encoding: 'utf8' }); };
  const ok = (r) => assert.equal(r.status, 0, r.stdout); const no = (r) => assert.notEqual(r.status, 0, r.stdout);
  ok(run('backlog', () => {}));
  no(run('backlog', (u) => { u.data = {}; u.dataSubmits = {}; u.dataSeq = []; }));             // all data submits deleted
  no(run('backlog', (u) => { for (const k of Object.keys(u.data)) u.data[k] = u.data[k].filter((m) => !m.heartbeat); })); // t112: no heartbeat (pre-t112 ours) fails
  no(run('backlog', (u) => { const i = u.data.sh3.findIndex((m) => m.heartbeat); u.data.sh3.splice(i, 1); }));        // one heartbeat missing
  no(run('backlog', (u) => { u.data.sh3.push({ heartbeat: { id: u.data.sh3[0].id } }); }));                             // heartbeat after streamClose
  no(run('backlog', (u) => { u.data.sh3.find((m) => m.heartbeat).heartbeat.id = 99; }));                                // heartbeat with another exec id
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

test('strict keepalive gate (one-tick late = UNRESOLVED fail) / overflow rules: deliberate lateness and dropped busy terminals fail', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kad4-'));
  const run = (s, mut) => { const o = JSON.parse(fs.readFileSync(path.join(dir, 'keepalive-official', `${s}.json`)));
    const u = JSON.parse(JSON.stringify(o)); mut(u);
    const a = path.join(tmp, 'o.json'), b = path.join(tmp, 'u.json'); fs.writeFileSync(a, JSON.stringify(o)); fs.writeFileSync(b, JSON.stringify(u));
    return spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), a, b], { encoding: 'utf8' }); };
  const ok = (r) => assert.equal(r.status, 0, r.stdout); const no = (r) => assert.notEqual(r.status, 0, r.stdout);
  const ka = (u, i, dt) => { u.keepalives[i].t += dt; };
  const r = run('rotation', (u) => ka(u, 2, 508)); no(r); assert.match(r.stdout, /UNRESOLVED tick-boundary/);  // one-tick late is never green
  no(run('rotation', (u) => ka(u, 2, 500)));
  no(run('rotation', (u) => ka(u, 2, 400)));                 // late but not one tick
  no(run('rotation', (u) => ka(u, 2, 620)));                 // more than one tick ±50
  no(run('rotation', (u) => ka(u, 2, 1000)));                // two ticks
  no(run('rotation', (u) => { ka(u, 0, 500); ka(u, 1, 500); ka(u, 2, 500); }));  // first keepalive never
  no(run('rotation', (u) => { ka(u, 1, 500); ka(u, 2, 1000); }));                 // a second shift
  no(run('rotation', (u) => { ka(u, 1, 500); ka(u, 2, 500); }));                  // shifted cadence also fails
  ok(run('overflow', () => {}));
  no(run('overflow', (u) => { u.terminal = u.terminal.slice(0, 184); }));       // acked but no terminal (t104 finding)
  no(run('overflow', (u) => { u.acked = u.acked.slice(0, 150); u.terminal = u.terminal.filter((t) => u.acked.includes(t.requestId)); }));
  no(run('overflow', (u) => { u.busyStarted = ['busy3']; }));
  no(run('overflow', (u) => { u.terminal[0].error = 'other'; }));
});

test('rotation tick slip root cause: provider keeps no sub-30s poll timer beside the 500 ms keepalive tick (official S9r)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-cad-')); const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = root;
  const oSI = global.setInterval, oST = global.setTimeout; const intervals = [], timeouts = [];
  global.setInterval = (fn, ms, ...a) => { intervals.push(ms); return oSI(fn, ms, ...a); };
  global.setTimeout = (fn, ms, ...a) => { timeouts.push(ms); return oST(fn, ms, ...a); };
  try {
    const p = new UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'm', credential: 'c', root, permission: 'always',
      hello: { label: 'lab', localRoot: root, terminalsFolder: root, standing: 'always', variant: 'lab', supervised: true, serverAuthoritative: false } });
    p.client = { pollGrokBotUserComputerRequests: async () => ({ requests: [] }), submitGrokBotUserComputerResponses: async (r) => ({ acceptedCount: r.frames.length }), withdrawGrokBotUserComputerPresence: async () => ({}),
      watchGrokBotUserComputerRequests: async function* (_, { signal }) { yield { event: { case: 'connected', value: {} } }; await new Promise((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); }); } };
    const running = p.start(); while (!p.proven) await new Promise((r) => setImmediate(r));
    global.setInterval = oSI; global.setTimeout = oST;
    assert.deepEqual(intervals, [uc.UC_SAFETY_POLL_MS]); assert.equal(uc.UC_SAFETY_POLL_MS, 30000);
    assert.ok(timeouts.includes(500), 'keepalive tick 500 ms');
    await p.stop(); await running;
  } finally { global.setInterval = oSI; global.setTimeout = oST; process.env.SAND_DATA_ROOT = old; fs.rmSync(root, { recursive: true, force: true }); }
});

test('unacknowledged busy items are re-polled once closing room exists (event-driven, no fast poll timer)', async () => {
  const { p } = mk(); let polls = 0; p.pollOnce = async () => { polls++; };
  p.replies = { offer: () => false, enqueue: async () => {}, available: false };
  p.pendingClosings = Array.from({ length: uc.UC_PENDING_CLOSINGS_MAX }, (_, i) => ({ kind: 'control', requestId: `x${i}`, message: { throw: { id: 0, error: 'e' } } }));
  p.seen.add('q'); p.pendingAcks.push('q'); p.unack({ id: 'q', requestId: 'r', kind: 2 });
  p.flushClosings(); assert.equal(polls, 0, 'no room yet');
  p.replies.offer = () => true; p.flushClosings();
  assert.equal(p.pendingClosings.length, 0); assert.equal(polls, 1); p.flushClosings(); assert.equal(polls, 1, 'once');
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

// ---- t107 cancel behind overflow (combined pressure) ----
test('closing deferral is budgeted (count + bytes): at the budget items stay unACKed, never dropped', () => {
  const { p } = mk(); p.replies = { offer: () => false, enqueue: async () => {}, available: false };
  let held = 0; for (let i = 0; i < 20000; i++) { if (p.storeClosing({ id: `q${i}`, requestId: 'r'.repeat(64) + i, kind: 2 }, 'busy')) held++; else break; }
  assert.ok(held >= 264 && held < 20000, `bounded, but holds backlog + 200 busy (held ${held})`);
  assert.ok(p.pendingClosings.reduce((n, f) => n + uc.closingCost(f.requestId), 0) <= uc.UC_PENDING_CLOSINGS_MAX_BYTES);
  assert.equal(p.storeClosing({ id: 'z', requestId: 'z', kind: 2 }, 'busy'), false); assert.equal(p.pendingClosings.length, held);
});
const coCases = { 'cancel-overflow': { busy: 200, check: 'assert-cancel.py' }, 'cancel-overflow-long': { busy: 520, check: 'assert-cancel.py' }, 'cancel-overflow-backlog': { busy: 488, check: 'assert-terminal.py' } };
for (const [sc, c] of Object.entries(coCases)) for (const who of ['official', 'ours']) {
  test(`oracle ${sc} (${who}): every busy ACKed and the cancel is reachable / its terminal retained`, { skip: !(fs.existsSync('/usr/bin/bwrap') && fs.existsSync(lab)) || (who === 'official' && process.env.UC_SKIP_OFFICIAL === '1' && 'UC_SKIP_OFFICIAL=1: official binary not run this round') }, () => {
    const env = { ...process.env }; if (who === 'ours') env.REPO = path.resolve(__dirname, '..', '..', '..'); else delete env.REPO;
    const r = spawnSync('python3', [path.join(dir, 'run-background.py'), 'uc-keepalive.cjs', sc], { env, encoding: 'utf8', timeout: 70000, maxBuffer: 256 << 20 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('{"scenario')); const d = JSON.parse(line);
    assert.equal(d.busyAcked, c.busy);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'co-')); const f = path.join(tmp, `${who}.json`); fs.writeFileSync(f, line);
    const a = spawnSync('python3', [path.join(dir, c.check), f], { encoding: 'utf8' }); assert.equal(a.status, 0, a.stdout);
  });
}
// ---- t108 atomic cancel of backlog entries (reserve actual frames before removal/ACK) ----
test('cancel of backlog entries is atomic: reserved by actual frame cost, else nothing removed and cancel stays unACKed', async () => {
  const { GrokBotUserComputerQueuedRequest } = require('../dist/generated/aiserver.v1_pb.js');
  const { p } = mk(); p.proven = true; p.lastPolledAt = Date.now();
  p.replies = { available: false, requestIds: () => new Set(), submitting: [], offer: () => false, enqueue: () => Promise.reject(new Error('cap')), drop: () => 0 };
  for (let i = 0; i < 4677; i++) assert.ok(p.storeClosing({ id: `q${i}`, requestId: `f${i}`.padEnd(64, 'x'), kind: 2 }, 'busy'));
  const target = 'target'.padEnd(1024, 't');
  assert.ok(p.closingRoom() > 0 && uc.closingCost(target) > uc.UC_PENDING_CLOSINGS_MAX_BYTES - p.pendingClosings.reduce((n, f) => n + uc.closingCost(f.requestId), 0), 'estimate says room, actual target does not fit');
  // two backlog entries of the same request: neither half-saved nor half-removed
  p.backlog.push({ id: 'b1', requestId: target, kind: 2 }, { id: 'b2', requestId: target, kind: 2 });
  const before = p.pendingClosings.length; const acks = []; let n = 0;
  p.client = { pollGrokBotUserComputerRequests: async (req) => { acks.push([...req.ackIds]); return { requests: n++ ? [] : [GrokBotUserComputerQueuedRequest.fromJson({ id: 'cancel-target', frame: { requestId: target, cancel: {} } })] }; } };
  await p.pollOnce(); await p.pollOnce();
  assert.equal(p.backlog.length, 2); assert.equal(p.cancelledIds.has(target), false);
  assert.equal(p.pendingClosings.length, before); assert.deepEqual(acks, [[], []]);
  // room appears → the redelivered cancel commits both closings and is ACKed
  p.pendingClosings.splice(0, 20); n = 0; await p.pollOnce(); await p.pollOnce();
  assert.equal(p.backlog.length, 0); assert.equal(p.pendingClosings.filter((f) => f.requestId === target).length, 2);
  assert.deepEqual(acks.at(-1), ['cancel-target']);
});

// ---- t109 original reply lanes: submit retry/drop, closing budget, cross-batch lane order ----
const lanesMod = require('../dist/uc/reply-lanes.js');
const { HttpStatusError } = require('../dist/transport/replies.js');
const pbm = require('../dist/generated/aiserver.v1_pb.js');
const ucFrame = (id, msg, control = false) => new pbm.GrokBotUserComputerResponseFrame({ requestId: id, frame: control
  ? { case: 'control', value: new pbm.GrokBotUserComputerControlMessage({ messageJson: JSON.stringify(msg) }) }
  : { case: 'client', value: new pbm.GrokBotUserComputerClientMessage({ messageJson: JSON.stringify(msg) }) } });
const stdoutF = (id) => ucFrame(id, { id: 1, shellStream: { stdout: { data: 'PAYLOAD' } } });
const exitF = (id) => ucFrame(id, { id: 1, shellStream: { exit: { code: 0 } } });
const closeF = (id) => ucFrame(id, { streamClose: { id: 1 } }, true);
function mkLanes(send, extra = {}) {
  let t = 0; const logs = []; const sleeps = [];
  const l = new lanesMod.UcReplyLanes({ send, reject: extra.reject ?? (() => true), isCancelled: extra.isCancelled ?? (() => false),
    now: () => t, sleep: async (ms, signal) => { sleeps.push(ms); t += ms; if (signal.aborted) throw new Error('aborted'); await new Promise((r) => setImmediate(r)); if (signal.aborted) throw new Error('aborted'); }, log: (m) => logs.push(m) });
  return { l, logs, sleeps, adv: (ms) => { t += ms; } };
}
const kindsOf = (fs) => fs.map((f) => f.frame.case === 'control' ? 'streamClose' : Object.keys(JSON.parse(f.frame.value.messageJson).shellStream)[0]);
test('submit: 3 attempts 200 ms apart, then only closing frames are kept (stdout dropped), as official', async () => {
  const calls = []; let fail = 3;
  const { l, logs, sleeps } = mkLanes(async (fs) => { calls.push(kindsOf(fs)); if (fail-- > 0) throw new Error('503'); });
  l.push([stdoutF('r'), exitF('r'), closeF('r')]); await l.flush(); while (l.readyCount || calls.length < 4) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.slice(0, 3).map((c) => c.length), [3, 3, 3]); assert.deepEqual(calls[3], ['exit', 'streamClose']);
  assert.deepEqual(sleeps.slice(0, 2), [200, 200]); assert.equal(sleeps[2], 500, 'closing backoff 500 ms');
  assert.match(logs[0], /keeping 2 of 3 response frames that close requests and dropping the rest/);
});
test('closing frames expire 30 s after their first submit; backoff 500→4000 ms', async () => {
  const sent = []; const { l, logs, sleeps } = mkLanes(async (fs) => { sent.push(fs.length); throw new Error('503'); });
  l.push([exitF('r'), closeF('r')]); await l.flush();
  for (let k = 0; k < 2000 && !logs.some((m) => /past their retry budget/.test(m)); k++) await new Promise((r) => setImmediate(r));
  assert.ok(logs.at(-1).includes('keeping 0 of 2') && logs.at(-1).includes('2 closing frames past their retry budget'));
  const backoff = sleeps.filter((ms) => ms !== 200); assert.deepEqual(backoff.slice(0, 5), [500, 1000, 2000, 4000, 4000]);
  assert.equal(l.readyCount, 0);
});
test('take(): lanes keep Map order across batches (taken lanes move to the end), requeue goes to the front', () => {
  const { l } = mkLanes(async () => {});
  for (let i = 0; i < 257; i++) l.push([closeF('L' + i), closeF('L' + i), closeF('L' + i)]);
  const batches = []; for (let b; (b = l.take()).length;) batches.push(b);
  assert.deepEqual(batches.map((b) => b.length), [256, 256, 256, 3]);
  assert.equal(batches.findIndex((b) => b.some((f) => f.requestId === 'L256')) + 1, 2, 'late lane in batch 2 (official), not 4');
  l.push([closeF('a')]); l.push([closeF('b')]); const t = l.take(); l.requeue(t.slice(1)); assert.deepEqual(l.laneOrder(), ['b']);
  l.push([closeF('c')]); l.requeue([closeF('z')]); assert.deepEqual(l.laneOrder(), ['z', 'b', 'c']);
});
test('retry boundaries: cancel aborts a retrying batch (gone), stale 401 retries on the current channel, current 401 pauses, stop ends the wait', async () => {
  // cancel during retry wait
  let cancelled = false; const a = mkLanes(async () => { throw new Error('503'); }, { isCancelled: () => cancelled });
  a.l.push([stdoutF('c'), exitF('c')]); const p = a.l.flush(); await new Promise((r) => setImmediate(r)); cancelled = true; a.l.drop((id) => id === 'c'); await p;
  assert.equal(a.l.readyCount, 0); assert.equal(a.logs.length, 0, 'aborted batch is not classified');
  // stale 401 → requeue and retry at once
  let n = 0; const b = mkLanes(async () => { if (n++ === 0) throw new HttpStatusError(401, 'old'); }, { reject: () => false });
  b.l.push([stdoutF('s')]); await b.l.flush(); assert.equal(n, 2); assert.equal(b.l.readyCount, 0); assert.equal(b.l.failure, undefined);
  // current 401 → requeued and paused until resume()
  let m = 0; const c = mkLanes(async () => { if (m++ === 0) throw new HttpStatusError(401, 'cur'); }, { reject: () => true });
  c.l.push([stdoutF('p')]); await c.l.flush(); assert.equal(c.l.readyCount, 1); assert.ok(c.l.failure); c.l.resume(); await new Promise((r) => setImmediate(r)); assert.equal(c.l.readyCount, 0);
  // stop during the retry wait: batch requeued (held), no further attempts
  let k = 0; const d = mkLanes(async () => { k++; throw new Error('503'); }); d.l.push([exitF('x')]); const q = d.l.flush(); d.l.stop(); await q;
  assert.ok(k <= 1); assert.equal(d.l.readyCount, 1);
});
for (const [sc, mode] of [['retry-probe', 'retry'], ['retry-expiry', 'expiry'], ['fairness-native', 'fair']]) {
  test(`oracle ${sc}: ours vs official golden (${mode})`, { skip: !(fs.existsSync('/usr/bin/bwrap') && fs.existsSync(lab)) }, () => {
    const r = spawnSync('python3', [path.join(dir, 'run-background.py'), 'uc-keepalive.cjs', sc], { env: { ...process.env, REPO: path.resolve(__dirname, '..', '..', '..') }, encoding: 'utf8', timeout: 70000, maxBuffer: 256 << 20 });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-')); const f = path.join(tmp, 'ours.json');
    fs.writeFileSync(f, r.stdout.split('\n').find((l) => l.startsWith('{"scenario')));
    const c = spawnSync('python3', [path.join(dir, 'check-mechanism.py'), mode, path.join(dir, 'keepalive-official', `${sc}.json`), f], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stdout);
  });
}


// ---- t110 resume wake across flush mutex (P2) + mechanism comparator negatives (P3) ----
test('resume during an in-flight 401 flush is honored after the mutex clears (two microtasks, real start/stop)', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')); fs.mkdirSync(path.join(root, 'terminals'));
  const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = root;
  const { ConnectError, Code } = require('@connectrpc/connect');
  const turn = () => new Promise((r) => setImmediate(r));
  const schedule = (n, f) => (n ? queueMicrotask(() => schedule(n - 1, f)) : f());
  try {
    for (let run = 0; run < 3; run++) {
      const p = new uc.UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'm', credential: 'old', root, permission: 'always',
        hello: { label: 'lab', localRoot: root, terminalsFolder: path.join(root, 'terminals'), standing: 'always', variant: 'lab', supervised: true, serverAuthoritative: false } });
      let rejectRPC; const creds = []; const sent = [];
      p.client = {
        submitGrokBotUserComputerResponses: (req) => { creds.push(req.credential); sent.push(req.frames.map((f) => f.requestId)); return creds.length === 1 ? new Promise((_, r) => { rejectRPC = r; }) : Promise.resolve({ acceptedCount: req.frames.length }); },
        pollGrokBotUserComputerRequests: async () => ({ requests: [] }),
        withdrawGrokBotUserComputerPresence: async () => ({}),
        watchGrokBotUserComputerRequests: async function* (_, { signal }) { yield { event: { case: 'connected', value: {} } }; await new Promise((r) => { if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); }); },
      };
      const running = p.start(); while (!p.proven) await turn();
      await p.emit({ kind: 'control', requestId: 'q', message: { throw: { error: 'synthetic' } } });
      rejectRPC(new ConnectError('synthetic', Code.Unauthenticated));
      schedule(2, () => p.updateChannel({ backendUrl: 'http://127.0.0.1:9', machineId: 'm', credential: 'new' }));
      const drained = await p.replies.drain(1200);
      assert.equal(drained, true, `run ${run}: retained frame must flush on the new channel without a nudge`);
      assert.deepEqual(creds, ['old', 'new']);
      assert.deepEqual(sent, [['q'], ['q']]);
      assert.equal(p.replies.readyCount, 0);
      assert.equal(p.replies.failure, undefined);
      await p.stop(); await running;
    }
  } finally { process.env.SAND_DATA_ROOT = old; fs.rmSync(root, { recursive: true, force: true }); }
});

test('check-mechanism: full-content negatives FAIL (lane identity/order, exit code, streamClose id, attempts, retarget, truncation)', () => {
  const dir = path.join(__dirname, '..', 'scripts', 'oracles'); const py = path.join(dir, 'check-mechanism.py');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-neg-')); const gold = (n) => path.join(dir, 'keepalive-official', n);
  const load = (n) => JSON.parse(fs.readFileSync(gold(n), 'utf8'));
  const run = (mode, g, obj) => { const f = path.join(tmp, `${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return spawnSync('python3', [py, mode, gold(g), f], { encoding: 'utf8' }); };
  for (const [m, g] of [['retry', 'retry-probe.json'], ['expiry', 'retry-expiry.json'], ['fair', 'fairness-native.json']]) assert.equal(run(m, g, load(g)).status, 0, `${m} positive`);
  const mapIds = (fn) => { const d = load('fairness-native.json'); d.busyBatches.forEach((b) => { b.ids = b.ids.map(fn); b.frames.forEach((f) => { f.requestId = fn(f.requestId); }); }); return d; };
  const exp = (fn) => { const d = load('retry-expiry.json'); fn(d); return d; };
  const shiftFrom = (a, i, dt) => { for (let j = i; j < a.length; j++) a[j].t += dt; };
  const neg = {
    'lane1->lane2': ['fair', 'fairness-native.json', mapIds((i) => (i === 'busyLane1' ? 'busyLane2' : i))],
    'lane1->999': ['fair', 'fairness-native.json', mapIds((i) => (i === 'busyLane1' ? 'busyLane999' : i))],
    'swap lane1/2': ['fair', 'fairness-native.json', mapIds((i) => ({ busyLane1: 'busyLane2', busyLane2: 'busyLane1' }[i] ?? i))],
    'fair truncated': ['fair', 'fairness-native.json', (() => { const d = load('fairness-native.json'); d.busyBatches = d.busyBatches.slice(0, 2); return d; })()],
    'exit 37 everywhere': ['retry', 'retry-probe.json', (() => { const d = load('retry-probe.json'); const set = (fs_) => fs_.forEach((f) => { if (f.message?.shellStream?.exit) f.message.shellStream.exit.code = 37; }); set(d.accepted); d.attempts.forEach((a) => set(a.frames)); return d; })()],
    'accepted streamClose.id 999': ['retry', 'retry-probe.json', (() => { const d = load('retry-probe.json'); d.accepted.forEach((f) => { if (f.message?.streamClose) f.message.streamClose.id = 999; }); return d; })()],
    'empty attempts': ['retry', 'retry-probe.json', (() => { const d = load('retry-probe.json'); d.attempts = []; return d; })()],
    'retarget accepted': ['retry', 'retry-probe.json', (() => { const d = load('retry-probe.json'); d.accepted.forEach((f) => { f.requestId = 'other'; }); return d; })()],
    // t112 independent review: model gates (fixed 3×200 ms, closing backoff, wake only with Watch evidence)
    'retry early re-submit (0325924: 2 ms after exhaustion)': ['retry', 'retry-probe.json', (() => { const d = load('retry-probe.json'); d.attempts[4].t = d.attempts[3].t + 2; return d; })()],
    'retry gap 350 ms inside a round': ['retry', 'retry-probe.json', (() => { const d = load('retry-probe.json'); shiftFrom(d.attempts, 2, 150); return d; })()],
    'expiry only one failure in round 2': ['expiry', 'retry-expiry.json', exp((d) => { d.attempts.splice(2, 2); })],
    'expiry 4 attempts instead of 34': ['expiry', 'retry-expiry.json', exp((d) => { d.attempts = d.attempts.slice(0, 4); })],
    'expiry early closing re-submit (2 ms)': ['expiry', 'retry-expiry.json', exp((d) => { shiftFrom(d.attempts, 4, d.attempts[3].t + 2 - d.attempts[4].t); })],
    'expiry 100 extra identical attempts': ['expiry', 'retry-expiry.json', exp((d) => { const last = d.attempts.at(-1); for (let i = 1; i <= 100; i++) d.attempts.push({ ...JSON.parse(JSON.stringify(last)), t: last.t + 200 * i }); })],
    'expiry 99 extra attempts as 33 rounds': ['expiry', 'retry-expiry.json', exp((d) => { const last = d.attempts.at(-1); let t = last.t; for (let r = 0; r < 33; r++) { t += 4000; for (let i = 0; i < 3; i++) d.attempts.push({ ...JSON.parse(JSON.stringify(last)), t: t + 200 * i }); t += 400; } })],
    'expiry wake round without Watch evidence': ['expiry', 'retry-expiry.json', exp((d) => { d.watches = d.watches.slice(0, 1); })],
    'expiry frame content changed in a late round': ['expiry', 'retry-expiry.json', exp((d) => { const f = d.attempts.at(-1).frames.find((x) => x.message?.shellStream?.exit); f.message.shellStream.exit.code = 37; })],
    'fair 257-frame batch with unknown id': ['fair', 'fairness-native.json', (() => { const d = load('fairness-native.json'); const b = d.busyBatches[1]; b.ids.push('mystery'); b.frames.push({ ...JSON.parse(JSON.stringify(b.frames[0])), requestId: 'mystery' }); return d; })()],
    'fair unknown id replaces non-busy frame': ['fair', 'fairness-native.json', (() => { const d = load('fairness-native.json'); const b = d.busyBatches[0]; const i = b.ids.findIndex((x) => !x.startsWith('busyLane')); b.ids[i] = 'mystery'; b.frames[i].requestId = 'mystery'; return d; })()],
    'fair frame content changed': ['fair', 'fairness-native.json', (() => { const d = load('fairness-native.json'); const f = d.busyBatches[2].frames[5]; f.message = { changed: true }; return d; })()],
  };
  for (const [k, [m, g, d]] of Object.entries(neg)) { const r = run(m, g, d); assert.notEqual(r.status, 0, `${k} must FAIL: ${r.stdout}`); }
});

test('flush state machine: frames queued while the first Submit hangs, then 3×503 → closing backoff 500 ms before re-submit (no immediate re-flush)', async () => {
  // Manual clock: sleeps resolve only when the test releases them, so a re-submit that skips the
  // 500 ms closing backoff is observable (send #5 would happen while the 500 ms sleep is pending).
  const pending = []; const events = []; let releaseFirst; let n = 0;
  const l = new lanesMod.UcReplyLanes({ reject: () => true, isCancelled: () => false, log: () => {}, now: () => 0,
    sleep: (ms, signal) => new Promise((res, rej) => { pending.push({ ms, res }); signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); }),
    send: async (fs_) => {
      n++; events.push({ n, kinds: kindsOf(fs_), pendingSleeps: pending.map((p) => p.ms) });
      if (n === 1) return new Promise((r) => { releaseFirst = r; });
      if (n >= 2 && n <= 4) throw new Error('503');
    } });
  const tick = async (k = 20) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };
  l.push([ucFrame('r', { id: 1, shellStream: { start: {} } })]); const f = l.flush(); await tick();
  l.push([stdoutF('r')]); void l.flush(); l.push([exitF('r')]); void l.flush(); l.push([closeF('r')]); void l.flush();
  releaseFirst(); await tick();
  for (let a = 0; a < 2; a++) { assert.equal(pending.at(-1).ms, 200); pending.pop().res(); await tick(); } // 200 ms between attempts
  await f; await tick();
  assert.equal(n, 4, 'no re-submit before the closing backoff elapses');
  assert.deepEqual(pending.map((p) => p.ms), [500], 'closing backoff 500 ms pending');
  pending.pop().res(); await tick();
  assert.equal(n, 5);
  assert.deepEqual(events.map((e) => e.kinds), [['start'], ['stdout', 'exit', 'streamClose'], ['stdout', 'exit', 'streamClose'], ['stdout', 'exit', 'streamClose'], ['exit', 'streamClose']]);
  // a frame enqueued during the backoff flushes immediately (official enqueue → flush)
  // a resume that clears a pause while the owner is inside submit() is observed by the owner (not swallowed)
  let m = 0; let rel; const b = mkLanes(async () => { m++; if (m === 1) return new Promise((_, rej) => { rel = rej; }); });
  b.l.push([closeF('x')]); const g = b.l.flush(); await new Promise((r) => setImmediate(r));
  rel(new HttpStatusError(401, 'cur')); queueMicrotask(() => queueMicrotask(() => b.l.resume())); await g;
  for (let k = 0; k < 20 && b.l.readyCount; k++) await new Promise((r) => setImmediate(r));
  assert.equal(m, 2); assert.equal(b.l.readyCount, 0); assert.equal(b.l.failure, undefined);
});
