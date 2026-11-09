// t171: remaining-difference fixes. Synthetic data only; never launches the official daemon.
const test = require('node:test'), assert = require('node:assert/strict'), cp = require('node:child_process'), path = require('node:path');
const { ConnectError, Code } = require('@connectrpc/connect');
const { createOutageLedger, outageCause, WATCH_OUTAGE_EVENT } = require('../dist/uc/outage-ledger');
const { parseHandoff, FILE_KEY_HANDOFF_TYPE } = require('../dist/bootstrap/handoff');
const { DeadlineExceededError } = require('../dist/box/provider');

function fakeLedger() {
  let now = Date.UTC(2026, 0, 1), mono = 1000; const logs = [], events = [], timers = [];
  const ledger = createOutageLedger({ now: () => now, monotonicNow: () => mono, log: l => logs.push(l), write: r => events.push(r),
    schedule: (ms, fn) => { const t = { ms, fn, live: true, dispose() { t.live = false; } }; timers.push(t); return t; } });
  const advance = ms => { now += ms; mono += ms; };
  const fire = () => { const t = timers.filter(x => x.live).pop(); t.live = false; t.fn(); };
  return { ledger, logs, events, timers, advance, fire, iso: () => new Date(now).toISOString() };
}

test('outage ledger (Z1t D:177641–177830): startup outage ≥60 s emits the watch_outage record and exact lines', () => {
  const f = fakeLedger();
  f.advance(2000); f.ledger.dialing();
  assert.match(f.logs[0], /^\[user-computer-watch\] \S+Z dialing \(attempt 1\)$/);
  f.advance(61000); f.fire(); // monitor tick: 63 s out → "still out" once per minute
  assert.equal(f.logs[1], `[user-computer-watch] ${f.iso()} still out 63000 ms, phase dialing`);
  f.ledger.connected('synthetic-machine');
  assert.equal(f.logs[2], `[user-computer-watch] ${f.iso()} connected after 63000 ms out (attempts 1)`);
  assert.equal(f.events.length, 1);
  assert.deepEqual(Object.keys(f.events[0]), ['machineId', 'outcome', 'startedBy', 'outageMs', 'outageMonoMs', 'lastStreamMs', 'attempts', 'dialMs',
    'longestDialMs', 'channelMissingMs', 'ends', 'tickLateMaxMs', 'tickMonoLateMaxMs', 'quietMaxMs', 'quietPhase']);
  assert.equal(f.events[0].outcome, 'reconnected'); assert.equal(f.events[0].startedBy, 'startup'); assert.equal(f.events[0].dialMs, 61000);
  assert.equal(f.events[0].quietPhase, 'dialing'); assert.equal(f.events[0].tickLateMaxMs, 58000);
  assert.equal(f.timers.filter(t => t.live).length, 0, 'monitor disposed after reconnect');
  f.advance(500); const err = Object.assign(new Error('synthetic'), { code: 'ECONNRESET' });
  f.ledger.ended('error', err);
  assert.equal(f.logs[3], `[user-computer-watch] ${f.iso()} ended error after 500 ms connected, cause ECONNRESET`);
  f.advance(10); f.ledger.ended('closed');
  assert.equal(f.logs[4], `[user-computer-watch] ${f.iso()} closed after 10 ms out (attempts 0)`);
  assert.equal(f.events.length, 1, 'short outage writes no event');
  f.ledger.close(); assert.equal(f.logs.length, 5, 'closed is terminal');
});

test('outage ledger: short outages write no event; channel missing logs once per phase entry; JSON line shape', () => {
  const f = fakeLedger();
  f.ledger.dialing(); f.advance(100); f.ledger.connected('m');
  assert.equal(f.events.length, 0);
  f.advance(50); f.ledger.channelMissing(); f.ledger.channelMissing();
  assert.deepEqual(f.logs.slice(2).map(l => l.replace(/^\S+ \S+ /, '')), ['channel missing']);
  assert.equal(WATCH_OUTAGE_EVENT, 'sand.local_exec_daemon.watch_outage');
});

test('outage cause (X8r D:177611–177626)', () => {
  assert.equal(outageCause(undefined), undefined);
  assert.equal(outageCause(new ConnectError('x', Code.Unavailable)), 'unavailable');
  assert.equal(outageCause(new DeadlineExceededError('x')), 'deadline');
  assert.equal(outageCause(new Error('x')), 'other');
  assert.equal(outageCause(Object.assign(new Error('x'), { code: 'EWHATEVER' })), 'E_OTHER');
  assert.equal(outageCause(new Error('x', { cause: Object.assign(new Error('y'), { code: 'ETIMEDOUT' }) })), 'ETIMEDOUT');
});

test('handoff parse (Uae D:79679–79687): type gate, lenient key → null unless 32 bytes, computerId trimmed ≤127', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  assert.equal(parseHandoff({ type: 'other', key }), null);
  assert.deepEqual(parseHandoff({ type: FILE_KEY_HANDOFF_TYPE, key, computerId: '  synthetic  ' }), { key, computerId: 'synthetic' });
  assert.equal(parseHandoff({ type: FILE_KEY_HANDOFF_TYPE, key: Buffer.alloc(16).toString('base64'), computerId: 'c' }).key, null);
  assert.equal(parseHandoff({ type: FILE_KEY_HANDOFF_TYPE, computerId: 'x'.repeat(128) }).computerId, undefined);
});

function forkHandoff(send) {
  const code = `const {awaitHandoff}=require(${JSON.stringify(path.join(__dirname, '../dist/bootstrap/handoff'))});
    awaitHandoff(1500).then(r=>{process.stdout.write(JSON.stringify(r));});`;
  return new Promise(resolve => {
    const c = cp.spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
    let out = ''; c.stdout.on('data', d => out += d);
    c.on('exit', () => resolve(out ? JSON.parse(out) : null));
    send(c);
  });
}
test('handoff IPC (iqr D:187232–187283): invalid message ignored, first valid wins; disconnect → null key, no computerId', async () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  const r = await forkHandoff(c => { c.send({ type: 'noise' }); c.send({ type: FILE_KEY_HANDOFF_TYPE, key, computerId: ' cid ' }); });
  assert.deepEqual(r, { key, computerId: 'cid' });
  const d = await forkHandoff(c => c.disconnect());
  assert.equal(d.key, null); assert.equal(d.computerId, undefined);
});
