// t117u: exec approval chain vs daemon.formatted.cjs 0.79.3 (Qce L81473, AUe L81503, Yce L81255, wqt/SUe/xqt
// L81293–81330, Rqt L81428, wUe L81351, c5 L81276, v9r L178863, poll L178509ff, getStanding L179397).
// All data synthetic, in tmp dirs. No backend, no real account files, no official binary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../dist/exec/handlers');
const A = require('../dist/uc/approvals');
const { UserComputerProvider, parseQueued } = require('../dist/uc/provider');
const pb = require('../dist/generated/aiserver.v1_pb');

const NOW = 1_800_000_000_000;
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'uca-')); }
function files(d, approvals, retired) {
  const ap = path.join(d, 'local-tool-approvals.json'), rp = path.join(d, 'local-tool-retirements.json');
  if (approvals !== undefined) fs.writeFileSync(ap, typeof approvals === 'string' ? approvals : JSON.stringify(approvals));
  if (retired !== undefined) fs.writeFileSync(rp, typeof retired === 'string' ? retired : JSON.stringify(retired));
  return { approvalsPath: ap, retirementsPath: rp };
}
const TF = '/syn/terminals';
const rec = (o = {}) => ({ id: 'ap1', action: 'run-command', target: 'echo synthetic', recordedAtMs: NOW - 1000, ...o });
const shellD = A.describeExec({ shellStreamArgs: { command: 'echo synthetic' } }, TF);
function input(p, o = {}) {
  return { permission: 'ask', serverAuthoritative: false, authorization: { kind: 'none' }, describes: shellD,
    terminalsFolder: TF, nowMs: NOW, ...p, ...o };
}
const X = () => h.NEVER_MSG, I = () => h.ASK_MSG;

test('non-SA permission × ceiling matrix, without and with a matching approval', async () => {
  const d = dir(); const none = files(d + '-none'.replace(/.*/, d), undefined);
  const withA = files(d, { approvals: [rec()] });
  const eff = (p, c) => (c && { never: 0, ask: 1, always: 2 }[c] < { never: 0, ask: 1, always: 2 }[p] ? c : p);
  for (const p of ['never', 'ask', 'always']) for (const c of [undefined, 'never', 'ask', 'always']) {
    const base = { permission: eff(p, c), ceiling: c };
    const r0 = await A.execRefusal(input({ ...none, approvalsPath: path.join(d, 'missing.json') }, { ...base, approvalId: undefined }));
    const r1 = await A.execRefusal(input(withA, { ...base, approvalId: 'ap1' }));
    const e = eff(p, c);
    const exp0 = c === 'never' ? X() : e === 'always' ? undefined : e === 'never' ? X() : I();
    // Original: ceiling never refuses first; otherwise a matching approval allows even under effective never.
    const exp1 = c === 'never' ? X() : undefined;
    assert.equal(r0, exp0, `no approval p=${p} c=${c}`);
    assert.equal(r1, exp1, `approval p=${p} c=${c}`);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('SA: approval / standing allow regardless of local permission; none needs a scoped approval', async () => {
  const d = dir(); const f = files(d, { approvals: [rec({ accountScope: 'acct-A' })] });
  const sa = { serverAuthoritative: true, accountScope: 'acct-A', permission: 'never', ceiling: 'never' };
  assert.equal(await A.execRefusal(input(f, { ...sa, authorization: { kind: 'approval' } })), undefined);
  assert.equal(await A.execRefusal(input(f, { ...sa, authorization: { kind: 'standing' } })), undefined);
  assert.equal(await A.execRefusal(input(f, { ...sa })), I(), 'none, no approvalId → i5 (never Xh under SA)');
  assert.equal(await A.execRefusal(input(f, { ...sa, approvalId: 'ap1' })), undefined, 'none + scoped approval');
  assert.equal(await A.execRefusal(input(f, { ...sa, approvalId: 'ap1', accountScope: 'acct-B' })), I(), 'scope mismatch');
  assert.equal(await A.execRefusal(input(f, { ...sa, approvalId: 'ap1', accountScope: undefined })), I(), 'channel without scope');
  const g = files(dir(), { approvals: [rec()] });
  assert.equal(await A.execRefusal(input(g, { ...sa, approvalId: 'ap1' })), I(), 'record without scope under SA');
  fs.rmSync(d, { recursive: true, force: true });
});

test('non-SA ignores server authorization flags (never cross-account authority)', async () => {
  const d = dir(); const f = files(d, { approvals: [] });
  for (const kind of ['approval', 'standing']) {
    assert.equal(await A.execRefusal(input(f, { authorization: { kind } })), I());
    assert.equal(await A.execRefusal(input(f, { permission: 'never', authorization: { kind } })), X());
    assert.equal(await A.execRefusal(input(f, { permission: 'always', ceiling: 'never', authorization: { kind } })), X());
  }
  assert.deepEqual(A.authorizationOf({ authorizedByApproval: true, authorizedByStanding: true }), { kind: 'approval' });
  assert.deepEqual(A.authorizationOf({ authorizedByStanding: true }), { kind: 'standing' });
  assert.deepEqual(A.authorizationOf({}), { kind: 'none' });
});

test('approval refusals: missing / empty / unknown / mismatch / expired / retired / corrupt / unreadable', async () => {
  const d = dir();
  const ok = files(d, { approvals: [rec()] });
  const cases = [
    ['missing id', ok, { approvalId: undefined }],
    ['empty id', ok, { approvalId: '' }],
    ['unknown id', ok, { approvalId: 'nope' }],
    ['no describes', ok, { approvalId: 'ap1', describes: undefined }],
    ['target mismatch (read-file)', ok, { approvalId: 'ap1', describes: A.describeExec({ readArgs: { path: '/syn/x' } }, TF) }],
    ['expired', files(dir(), { approvals: [rec({ recordedAtMs: NOW - 3_600_001 })] }), { approvalId: 'ap1' }],
    ['retired', files(dir(), { approvals: [rec()] }, { retiredIds: ['ap1'] }), { approvalId: 'ap1' }],
    ['corrupt json', files(dir(), '{not json'), { approvalId: 'ap1' }],
    ['approvals not array', files(dir(), { approvals: { ap1: rec() } }), { approvalId: 'ap1' }],
    ['invalid action', files(dir(), { approvals: [rec({ action: 'run-anything' })] }), { approvalId: 'ap1' }],
    ['non-string target', files(dir(), { approvals: [rec({ target: 5 })] }), { approvalId: 'ap1' }],
    ['file missing', { approvalsPath: path.join(d, 'none.json'), retirementsPath: path.join(d, 'none2.json') }, { approvalId: 'ap1' }],
    ['path is a directory', { approvalsPath: d, retirementsPath: path.join(d, 'r.json') }, { approvalId: 'ap1' }],
  ];
  for (const [label, f, o] of cases) assert.equal(await A.execRefusal(input(f, o)), I(), label);
  // corrupt retirements file → treated as no retirements (original EUe); record still valid.
  assert.equal(await A.execRefusal(input(files(dir(), { approvals: [rec()] }, '{bad'), { approvalId: 'ap1' })), undefined);
});

test('original expiry boundary and timestamp-less records (kept as original, documented risk)', async () => {
  assert.equal(await A.execRefusal(input(files(dir(), { approvals: [rec({ recordedAtMs: NOW - 3_600_000 })] }), { approvalId: 'ap1' })), undefined, '= 1h still valid (> 36e5 expires)');
  const { recordedAtMs, ...noTs } = rec();
  assert.equal(await A.execRefusal(input(files(dir(), { approvals: [noTs] }), { approvalId: 'ap1' })), undefined, 'no recordedAtMs never expires (xqt)');
});

test('Yce verbatim: run-command resourcePath ⇄ forceBackground attach; terminal-file read', async () => {
  const f = files(dir(), { approvals: [rec({ target: 'other' }), { id: 'r1', action: 'read-file', target: '/z', resourcePath: TF, recordedAtMs: NOW }] });
  const force = A.describeExec({ forceBackgroundShellArgs: {} }, TF);
  assert.equal(await A.execRefusal(input(f, { approvalId: 'ap1', describes: force })), undefined);
  assert.equal(await A.execRefusal(input(f, { approvalId: 'ap1' })), I(), 'different command, no attach → no match');
  const termRead = A.describeExec({ readArgs: { path: TF + '/1.txt' } }, TF);
  assert.equal(termRead.attachToResourcePath, TF);
  assert.equal(await A.execRefusal(input(f, { approvalId: 'r1', describes: termRead })), undefined);
  assert.equal(A.describeExec({ readArgs: { path: TF + '/a/1.txt' } }, TF).attachToResourcePath, undefined);
  assert.deepEqual(A.describeExec({ lsArgs: {} }, TF), { action: 'list-directory', target: '' });
});

test('retireApproval (wUe): existing / not existing / repeat / prune / rm-when-empty / concurrent', async () => {
  const d = dir(); const f = files(d, { approvals: [rec(), rec({ id: 'ap2' }), rec({ id: 'ap3' })] });
  const read = () => JSON.parse(fs.readFileSync(f.retirementsPath, 'utf8')).retiredIds.sort();
  await A.retireApproval('ghost', f.approvalsPath, f.retirementsPath, NOW);
  assert.equal(fs.existsSync(f.retirementsPath), false, 'unknown id leaves no record');
  await A.retireApproval('ap1', f.approvalsPath, f.retirementsPath, NOW);
  assert.deepEqual(read(), ['ap1']);
  await A.retireApproval('ap1', f.approvalsPath, f.retirementsPath, NOW);
  assert.deepEqual(read(), ['ap1']);
  fs.writeFileSync(f.retirementsPath, JSON.stringify({ retiredIds: ['ap1', 'stale'] }));
  await A.retireApproval('ap2', f.approvalsPath, f.retirementsPath, NOW);
  assert.deepEqual(read(), ['ap1', 'ap2'], 'stale ids pruned');
  fs.writeFileSync(f.approvalsPath, JSON.stringify({ approvals: [] }));
  await A.retireApproval('ap3', f.approvalsPath, f.retirementsPath, NOW);
  assert.equal(fs.existsSync(f.retirementsPath), false, 'empty set removes the file');
  const many = Array.from({ length: 25 }, (_, i) => rec({ id: 'c' + i }));
  fs.writeFileSync(f.approvalsPath, JSON.stringify({ approvals: many }));
  await Promise.all(many.map((r) => A.retireApproval(r.id, f.approvalsPath, f.retirementsPath, NOW)));
  assert.equal(read().length, 25, 'per-file lock: no lost update');
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), []);
});

// ---- provider level ----
function env(perm, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucap-')); const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, 'f.txt'), 'hello');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: perm, ...extra }));
  const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = data;
  return { root, data, done: () => { process.env.SAND_DATA_ROOT = old; fs.rmSync(root, { recursive: true, force: true }); } };
}
function mk(root, sa = false, accountScope) {
  const p = new UserComputerProvider({ backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic', credential: 'synthetic-1', root, permission: 'always', accountScope,
    hello: { label: 't', localRoot: root, terminalsFolder: path.join(root, 'terminals'), standing: 'always', variant: 't', serverAuthoritative: sa } });
  const got = []; p.emit = (f) => { got.push(f); }; p.replies = { available: true };
  return { p, got };
}
const readQ = (id, file, meta = {}) => ({ id: 'q-' + id, requestId: id, kind: 2, serverMessage: { readArgs: { path: file } }, authorization: { kind: 'none' }, ...meta });
const waitFor = async (pred) => { for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('provider: approved exec runs with exec id 1; refused consumes none; cancelled-after-allow never starts', async () => {
  const e = env('ask'); const file = path.join(e.root, 'f.txt');
  fs.writeFileSync(path.join(e.data, 'local-tool-approvals.json'), JSON.stringify({ approvals: [{ id: 'okA', action: 'read-file', target: file, recordedAtMs: Date.now() }] }));
  const { p, got } = mk(e.root);
  try {
    h.resetExecIdCounter();
    p.backlog = [readQ('r0', file, { approvalId: 'bad' })]; p.runBacklog(); await waitFor(() => got.length >= 1);
    assert.deepEqual(got[0], { kind: 'control', requestId: 'r0', message: { throw: { id: 0, error: h.ASK_MSG } } });
    assert.equal(h.lastAllocatedExecIdOrZero(), 0);
    p.cancelledIds.add('r1');
    p.backlog = [readQ('r1', file, { approvalId: 'okA' })]; p.runBacklog(); await waitFor(() => got.length >= 2);
    assert.deepEqual(got[1], { kind: 'control', requestId: 'r1', message: { streamClose: { id: 0 } } });
    assert.equal(h.lastAllocatedExecIdOrZero(), 0, 'allowed but cancelled: no exec id');
    p.backlog = [readQ('r2', file, { approvalId: 'okA' })]; p.runBacklog(); await waitFor(() => got.some((f) => f.requestId === 'r2'));
    await waitFor(() => p.active.size === 0);
    assert.equal(h.lastAllocatedExecIdOrZero(), 1);
    assert.ok(got.filter((f) => f.requestId === 'r2').every((f) => f.kind !== 'file-error' && !(f.message && f.message.throw && f.message.throw.id === 0)));
    // SA provider: server flag honoured; same flag on the non-SA provider above was not.
    const s = mk(e.root, true, 'acct-A');
    s.p.backlog = [readQ('r3', file, { authorization: { kind: 'approval' } })]; s.p.runBacklog();
    await waitFor(() => s.p.active.size === 0);
    // t166: a separate provider owns its own v_ counter (D:135935, 179358) → its first exec id is 1, not 2.
    assert.equal(h.lastAllocatedExecIdOrZero(), 1);
    assert.equal(s.p.execIds.last(), 1); assert.equal(p.execIds.last(), 1);
    p.backlog = [readQ('r4', file, { authorization: { kind: 'approval' } })]; p.runBacklog(); await waitFor(() => got.some((f) => f.requestId === 'r4'));
    assert.deepEqual(got.find((f) => f.requestId === 'r4'), { kind: 'control', requestId: 'r4', message: { throw: { id: 0, error: h.ASK_MSG } } });
    s.p.closed = true;
  } finally { p.closed = true; await h.shutdownShells(); e.done(); }
});

test('provider: retire-approval is ACKed, persisted, no reply, no slot, no keepalive', async () => {
  const e = env('ask');
  fs.writeFileSync(path.join(e.data, 'local-tool-approvals.json'), JSON.stringify({ approvals: [{ id: 'z1', action: 'list-directory', target: '/', recordedAtMs: Date.now() }] }));
  const { p, got } = mk(e.root);
  const item = new pb.GrokBotUserComputerQueuedRequest({ id: 'queue-1', frame: { requestId: 'req-1', frame: { case: 'retireApproval', value: { approvalId: 'z1' } } } });
  let calls = 0, acks = [];
  p.channel = { backendUrl: 'x', machineId: 'synthetic', credential: 'synthetic-1' }; p.proven = true; // poll requires proven (D:pollOnce 178448–178455)
  p.client = { pollGrokBotUserComputerRequests: async (req) => { calls++; acks.push(...req.ackIds); return { requests: calls === 1 ? [item] : [] }; } };
  try {
    const q = parseQueued(item); assert.equal(q.approvalId, 'z1');
    await p.pollOnce(); await p.settleRetirements();
    assert.deepEqual(p.pendingAcks, ['queue-1']);
    assert.equal(got.length, 0); assert.equal(p.backlog.length, 0); assert.equal(p.active.size, 0);
    assert.equal(p.keepAliveDueAt.size, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.data, 'local-tool-retirements.json'), 'utf8')), { retiredIds: ['z1'] });
    await p.pollOnce(); assert.deepEqual(acks, ['queue-1']);
  } finally { p.closed = true; e.done(); }
});

test('parseQueued exec carries approvalId and c5 authorization', () => {
  const item = new pb.GrokBotUserComputerQueuedRequest({ id: 'q', frame: { requestId: 'r', frame: { case: 'exec',
    value: { serverMessageJson: JSON.stringify({ lsArgs: { path: '/' } }), approvalId: 'a', authorizedByStanding: true } } } });
  const q = parseQueued(item);
  assert.equal(q.approvalId, 'a'); assert.deepEqual(q.authorization, { kind: 'standing' });
});

test('serverAuthoritative: hello standing "", mode never flipped in place (true↔false needs a new provider)', () => {
  for (const sa of [false, true]) {
    const { p } = mk('/tmp', sa); p.replies = { available: true, resume() {} };
    p.channel = { backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic', credential: 'synthetic-1' };
    assert.equal(p.standingFor('always'), sa ? '' : 'always');
    const base = { backendUrl: 'http://127.0.0.1:9', machineId: 'synthetic', accountScope: undefined };
    assert.equal(p.updateChannel({ ...base, credential: 'synthetic-2', serverAuthoritative: !sa }), false);
    assert.equal(p.serverAuthoritative, sa); assert.equal(p.channel.credential, 'synthetic-1');
    assert.equal(p.updateChannel({ ...base, credential: 'synthetic-2', serverAuthoritative: sa }), true);
    assert.equal(p.serverAuthoritative, sa); assert.equal(p.channel.credential, 'synthetic-2');
    p.closed = true;
  }
});
