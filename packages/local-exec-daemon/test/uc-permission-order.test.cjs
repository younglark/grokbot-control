// t112u: UC exec permission handling after the admission await, per daemon.formatted.cjs handleExecRequest
// L136318–136332: blocked → x9 control throw{id:0,error} (L136410), no exec id; cancelled → O6r streamClose{id:0};
// then nextExecId++. Deterministic: mocked setTimeout for the heartbeat checks, no wall-clock spacing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../dist/exec/handlers');
const { UserComputerProvider } = require('../dist/uc/provider');

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function env(perm, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'up-')); const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, 'f.txt'), 'hello');
  const set = (p) => fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: p, ...extra }));
  set(perm);
  const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = data;
  return { root, set, done: () => { process.env.SAND_DATA_ROOT = old; fs.rmSync(root, { recursive: true, force: true }); } };
}
function mk(root, serverAuthoritative = false) {
  const p = new UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic', credential: 'synthetic', root, permission: 'always',
    hello: { label: 'test', localRoot: root, terminalsFolder: root, standing: 'always', variant: 'test', serverAuthoritative } });
  const got = []; p.emit = (f) => { got.push(f); }; p.replies = { available: true };
  return { p, got };
}
const shellQ = (id, command) => ({ id: 'q-' + id, requestId: id, kind: 2, serverMessage: { id: 1, shellStreamArgs: { command, timeout: 20000 } } });
const refusal = (rid, error) => [{ kind: 'control', requestId: rid, message: { throw: { id: 0, error } } }];
async function admit(p, qs, between) { p.backlog = qs; p.runBacklog(); if (between) between(); await tick(); }

for (const [perm, msg, label] of [['never', () => h.NEVER_MSG, 'Xh'], ['ask', () => h.ASK_MSG, 'i5']]) {
  test(`${perm}: exactly one control throw{id:0, ${label}}, no exec id, no spawn, no heartbeat`, async (t) => {
    const e = env(perm); const { p, got } = mk(e.root);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      h.resetExecIdCounter();
      await admit(p, [shellQ('s', 'touch ran')]);
      assert.deepEqual(got, refusal('s', msg()));
      assert.equal(got.some((f) => f.kind === 'file-error'), false, 'old (wrong) fileError form not produced');
      assert.equal(h.lastAllocatedExecIdOrZero(), 0, 'refusal consumes no exec id');
      t.mock.timers.tick(9000); await tick();
      assert.equal(got.length, 1, 'no heartbeat or other frame follows');
    } finally { t.mock.timers.reset(); p.closed = true; await h.shutdownShells(); e.done(); }
    assert.equal(fs.existsSync(path.join(e.root, 'ran')), false);
  });
}

test('ceiling never caps always → Xh; serverAuthoritative (no authorization support) → i5', async () => {
  let e = env('always', { localToolPermissionCeiling: 'never' }); let m = mk(e.root);
  try { h.resetExecIdCounter(); await admit(m.p, [shellQ('c', 'true')]); assert.deepEqual(m.got, refusal('c', h.NEVER_MSG)); }
  finally { m.p.closed = true; e.done(); }
  e = env('always'); m = mk(e.root, true);
  try { await admit(m.p, [shellQ('sa', 'true')]); assert.deepEqual(m.got, refusal('sa', h.ASK_MSG)); assert.equal(h.lastAllocatedExecIdOrZero(), 0); }
  finally { m.p.closed = true; e.done(); }
});

test('after a refusal the next allowed exec still gets id 1 (counter not consumed)', async () => {
  const e = env('never'); const { p, got } = mk(e.root);
  try {
    h.resetExecIdCounter();
    await admit(p, [shellQ('denied', 'true')]);
    e.set('always');
    await admit(p, [shellQ('ok', 'echo hi')]);
    for (let i = 0; i < 200 && !got.some((f) => f.requestId === 'ok' && f.message?.streamClose); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(got.find((f) => f.requestId === 'ok' && f.message?.shellStream?.start).message.id, 1);
    assert.equal(got.find((f) => f.requestId === 'ok' && f.message?.streamClose).message.streamClose.id, 1);
  } finally { p.closed = true; await h.shutdownShells(); e.done(); }
});

test('blocked is checked before cancelled: cancel + never → throw (not streamClose); cancel + always → streamClose{id:0}', async () => {
  let e = env('never'); let m = mk(e.root);
  try { h.resetExecIdCounter(); await admit(m.p, [shellQ('cn', 'touch ran')], () => m.p.cancelledIds.add('cn')); assert.deepEqual(m.got, refusal('cn', h.NEVER_MSG)); }
  finally { m.p.closed = true; e.done(); }
  e = env('always'); m = mk(e.root);
  try {
    await admit(m.p, [shellQ('ca', 'touch ran')], () => m.p.cancelledIds.add('ca'));
    assert.deepEqual(m.got, [{ kind: 'control', requestId: 'ca', message: { streamClose: { id: 0 } } }]);
    assert.equal(h.lastAllocatedExecIdOrZero(), 0); await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(path.join(e.root, 'ran')), false);
  } finally { m.p.closed = true; await h.shutdownShells(); e.done(); }
});

test('stop guard (ours, not official): stop + always → streamClose{id:0}; stop + never → refusal first', async () => {
  let e = env('always'); let m = mk(e.root);
  try { h.resetExecIdCounter(); await admit(m.p, [shellQ('st', 'touch ran')], () => { m.p.stopped = true; }); assert.deepEqual(m.got, [{ kind: 'control', requestId: 'st', message: { streamClose: { id: 0 } } }]); }
  finally { m.p.closed = true; await h.shutdownShells(); e.done(); }
  e = env('never'); m = mk(e.root);
  try { await admit(m.p, [shellQ('sn', 'true')], () => { m.p.stopped = true; }); assert.deepEqual(m.got, refusal('sn', h.NEVER_MSG)); }
  finally { m.p.closed = true; e.done(); }
});

test('always: read / ls / shell unaffected (ids 1..3 in admission order, each closed with its id)', async () => {
  const e = env('always'); const { p, got } = mk(e.root);
  try {
    h.resetExecIdCounter();
    await admit(p, [
      { id: 'q-r', requestId: 'r', kind: 2, serverMessage: { id: 1, readArgs: { path: 'f.txt' } } },
      { id: 'q-l', requestId: 'l', kind: 2, serverMessage: { id: 1, lsArgs: { path: e.root } } },
      shellQ('s', 'echo hi'),
    ]);
    const closed = () => ['r', 'l', 's'].every((id) => got.some((f) => f.requestId === id && f.message?.streamClose));
    for (let i = 0; i < 300 && !closed(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(['r', 'l', 's'].map((id) => got.find((f) => f.requestId === id && f.message?.streamClose).message.streamClose.id), [1, 2, 3]);
    assert.equal(got.some((f) => f.message?.throw), false);
  } finally { p.closed = true; await h.shutdownShells(); e.done(); }
});

test('Box path unchanged: dispatchExec with never still answers file-error (no UC change leaks into Box)', async () => {
  const got = []; h.resetExecIdCounter();
  await h.dispatchExec({ root: os.tmpdir(), requestId: 'b', serverMessage: { id: 1, shellStreamArgs: { command: 'true' } }, permission: 'never', emit: (f) => { got.push(f); } });
  assert.deepEqual(got, [{ kind: 'file-error', requestId: 'b', error: h.NEVER_MSG }]);
});

// Fixed expectations copied verbatim from the original 0.79.3 daemon (Xh L81193, i5 L81199; `${lt.X}` = "X",
// `\u2192` = "→"). The original source is not part of this repo; the optional cross-check below runs only
// where a local analysis copy exists (UC_ORIGINAL_SOURCE), so CI does not depend on it.
const XH = 'Local tools are turned off. The user has set local tool access to "Never", so Shell, Read, and AwaitShell with machineId, plus CopyToBox and CopyFromBox, cannot run on their computer. Do not retry them while this setting remains "Never". Use your own computer instead by omitting machineId, or ask the user to change the setting in Settings \u2192 Bot \u2192 Execution on Local Computer. If they change it away from "Never", you may try again.';
const I5 = 'That action was not approved on the user\'s computer, so nothing ran. Ask the user to approve it (or to set Settings \u2192 Bot \u2192 Execution on Local Computer to "Always allow"), and use your own computer (Shell, Read, AwaitShell) in the meantime.';
test('refusal texts equal the fixed Xh / i5 expectations', () => { assert.equal(h.NEVER_MSG, XH); assert.equal(h.ASK_MSG, I5); });
const SRC = process.env.UC_ORIGINAL_SOURCE || '';
test('optional: refusal texts verbatim against a local original source copy (Xh L81193 / i5 L81199)', { skip: !(SRC && fs.existsSync(SRC)) && 'UC_ORIGINAL_SOURCE not set (optional local cross-check)' }, () => {
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const lt = { Shell: 'Shell', Read: 'Read', AwaitShell: 'AwaitShell', CopyToBox: 'CopyToBox', CopyFromBox: 'CopyFromBox' };
  const tpl = (n, name) => { const l = lines[n - 1]; assert.ok(l.trim().startsWith(name + ' = `'), `L${n} is ${name}`); return l.slice(l.indexOf('`') + 1, l.lastIndexOf('`')).replace(/\$\{lt\.(\w+)\}/g, (_, k) => lt[k]).replace(/\\u2192/g, '\u2192'); };
  assert.equal(h.NEVER_MSG, tpl(81193, 'Xh'));
  assert.equal(h.ASK_MSG, tpl(81199, 'i5'));
});
