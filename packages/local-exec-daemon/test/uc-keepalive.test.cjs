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
for (const s of ['cancel', 'stall']) {
  test(`oracle: ours vs official golden, scenario ${s} (bwrap, real daemon process)`, { skip: !(fs.existsSync('/usr/bin/bwrap') && fs.existsSync(lab)) }, () => {
    const r = spawnSync('python3', [path.join(dir, 'run-background.py'), 'uc-keepalive.cjs', s], { env: { ...process.env, REPO: path.resolve(__dirname, '..', '..', '..') }, encoding: 'utf8', timeout: 70000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-')); const f = path.join(tmp, 'ours.json');
    fs.writeFileSync(f, r.stdout.split('\n')[1]);
    const d = spawnSync('python3', [path.join(dir, 'keepalive-diff.py'), path.join(dir, 'keepalive-official', `${s}.json`), f], { encoding: 'utf8' });
    assert.equal(d.status, 0, d.stdout);
  });
}
