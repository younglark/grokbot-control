// t113u: official Aft cwdState on exec throw (daemon.formatted.cjs L132554–132566, attached at L136340–136347).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../dist/exec/handlers');
const { UserComputerProvider } = require('../dist/uc/provider');

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('cwdStateForThrow: non-shell → unset; empty shell wd probes root → exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  try {
    assert.equal(await h.cwdStateForThrow(root, { readArgs: { path: 'x' } }), 'unset');
    assert.equal(await h.cwdStateForThrow(root, { lsArgs: { path: root } }), 'unset');
    assert.equal(await h.cwdStateForThrow(root, {}), 'unset');
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: '' } }), 'exists');
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: {} }), 'exists');
    assert.equal(await h.cwdStateForThrow(root, { backgroundShellSpawnArgs: { workingDirectory: '' } }), 'exists');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cwdStateForThrow: shell cwd exists → exists; missing / file → missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  try {
    fs.mkdirSync(path.join(root, 'here'));
    fs.writeFileSync(path.join(root, 'notdir'), 'x');
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: 'here' } }), 'exists');
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: path.join(root, 'here') } }), 'exists');
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: 'gone' } }), 'missing');
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: 'notdir' } }), 'missing'); // ENOTDIR → missing
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cwdStateForThrow: non-ENOENT probe error → undefined (field omitted); timeout → undefined', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  try {
    t.mock.method(fs.promises, 'stat', async () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; });
    assert.equal(await h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: 'x' } }), undefined);
    t.mock.reset();
    t.mock.method(fs.promises, 'stat', () => new Promise(() => {})); // never settles → 1000 ms timeout
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = h.cwdStateForThrow(root, { shellStreamArgs: { workingDirectory: 'x' } });
    t.mock.timers.tick(1000); await tick();
    assert.equal(await p, undefined);
  } finally { t.mock.timers.reset(); t.mock.reset(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('requestError shell: exists / missing / omit; read/ls keep unset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-')); fs.mkdirSync(path.join(root, 'ok'));
  try {
    for (const [wd, want] of [['ok', 'exists'], ['nope', 'missing']]) {
      const got = [];
      await h.requestError('r', 3, new Error('boom'), (f) => { got.push(f); },
        { root, serverMessage: { shellStreamArgs: { workingDirectory: wd } } });
      assert.equal(got[0].cwdState, want);
      assert.deepEqual(got[0].message, { throw: { id: 3, error: 'boom' } });
      assert.equal(got[1].cwdState, undefined);
    }
    const got = [];
    tMockStatEacces: {
      const orig = fs.promises.stat;
      fs.promises.stat = async () => { const e = new Error('x'); e.code = 'EACCES'; throw e; };
      try {
        await h.requestError('r', 1, new Error('boom'), (f) => { got.push(f); },
          { root, serverMessage: { shellStreamArgs: { workingDirectory: 'ok' } } });
      } finally { fs.promises.stat = orig; }
    }
    assert.equal('cwdState' in got[0], false, 'probe failure omits cwdState');
    for (const sm of [{ readArgs: { path: 'f' } }, { lsArgs: { path: root } }]) {
      const g = [];
      await h.requestError('r', 2, new Error('x'), (f) => { g.push(f); }, { root, serverMessage: sm });
      assert.equal(g[0].cwdState, 'unset');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live shell throw before spawn: PathGuard → missing/exists by requested wd; read throw → unset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  fs.mkdirSync(path.join(root, 'sub'));
  try {
    const got = [];
    await h.handleShellStream({
      root, requestId: 's', msgId: 7, command: 'true',
      workingDirectory: path.join(root, '..', 'escape'), // PathGuardError
      emit: (f) => { got.push(f); },
    });
    const thr = got.find((f) => f.message?.throw);
    assert.ok(thr); assert.equal(thr.message.throw.id, 7);
    // Official Aft probes the requested workingDirectory string via bft+stat, not the guard result.
    // `root/../escape` resolves outside; if that path does not exist → missing.
    assert.equal(thr.cwdState, 'missing');
    const g2 = [];
    await h.handleRead({ root, requestId: 'r', msgId: 1, path: 'no-such', emit: (f) => { g2.push(f); } });
    assert.equal(g2.find((f) => f.message?.throw).cwdState, 'unset');
  } finally { await h.shutdownShells(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('UC permission refusal still throw{id:0} with no cwdState; cancel+always streamClose unaffected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'never' }));
  const old = process.env.SAND_DATA_ROOT; process.env.SAND_DATA_ROOT = data;
  const p = new UserComputerProvider({
    backendUrl: 'http://127.0.0.1:9', machineId: 's', credential: 's', root, permission: 'always',
    hello: { label: 't', localRoot: root, terminalsFolder: root, standing: 'always', variant: 't', serverAuthoritative: false },
  });
  const got = []; p.emit = (f) => { got.push(f); }; p.replies = { available: true };
  try {
    h.resetExecIdCounter();
    p.backlog = [{ id: 'q', requestId: 'n', kind: 2, serverMessage: { id: 1, shellStreamArgs: { command: 'true', workingDirectory: root } } }];
    p.runBacklog(); await tick();
    assert.deepEqual(got, [{ kind: 'control', requestId: 'n', message: { throw: { id: 0, error: h.NEVER_MSG } } }]);
    assert.equal('cwdState' in got[0], false);
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'always' }));
    got.length = 0;
    p.backlog = [{ id: 'q2', requestId: 'c', kind: 2, serverMessage: { id: 1, shellStreamArgs: { command: 'true' } } }];
    p.runBacklog(); p.cancelledIds.add('c'); await tick();
    assert.deepEqual(got, [{ kind: 'control', requestId: 'c', message: { streamClose: { id: 0 } } }]);
  } finally { p.closed = true; process.env.SAND_DATA_ROOT = old; await h.shutdownShells(); fs.rmSync(root, { recursive: true, force: true }); }
});
