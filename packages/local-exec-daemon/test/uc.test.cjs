'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { startUcFakePeer, SYN_CRED, SYN_MACHINE } = require('./helpers/uc-fake-peer.cjs');
const { sealJson } = require('../dist/uc/sealed.js');
const { ownershipDecision, leaseIsActive, generationFromEnv } = require('../dist/state/lease.js');
const { unsealJson } = require('../dist/uc/sealed.js');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(ROOT, 'dist', 'index.js');
const KEY = Buffer.alloc(32, 7).toString('base64');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mkWorkspace(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ledc-uc-${name}-`));
  fs.mkdirSync(path.join(base, 'root'));
  fs.mkdirSync(path.join(base, 'data'));
  fs.mkdirSync(path.join(base, 'home'));
  fs.writeFileSync(path.join(base, 'root', 'probe.txt'), 'oracle-fixture\n');
  fs.writeFileSync(
    path.join(base, 'data', 'settings.json'),
    JSON.stringify({ version: 1, localToolPermission: 'always' }),
  );
  fs.writeFileSync(
    path.join(base, 'data', 'local-exec-supervisor.json'),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  );
  return base;
}

async function waitFor(test, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (test()) return;
    await delay(40);
  }
  throw new Error('event deadline');
}

describe('sealed credential', () => {
  it('roundtrips AES-GCM sandSealedFile:1', () => {
    const payload = {
      backendUrl: 'http://127.0.0.1:9',
      userComputer: { credential: SYN_CRED, machineId: SYN_MACHINE, accountScope: 'lab:scope' },
    };
    const sealed = sealJson(KEY, JSON.stringify(payload));
    const plain = unsealJson(KEY, sealed);
    assert.equal(JSON.parse(plain).userComputer.machineId, SYN_MACHINE);
    assert.throws(() => unsealJson(Buffer.alloc(32, 9).toString('base64'), sealed));
  });
});

describe('UC Connect fake peer loop', () => {
  it('Watch/Poll/Submit/Withdraw with real read content', async () => {
    const peer = startUcFakePeer();
    await peer.listen();
    const base = mkWorkspace('loop');
    const cred = {
      backendUrl: `http://127.0.0.1:${peer.port()}`,
      userComputer: {
        credential: SYN_CRED,
        machineId: SYN_MACHINE,
        accountScope: 'lab:scope-1',
        serverAuthoritative: false,
      },
    };
    fs.writeFileSync(
      path.join(base, 'data', 'local-exec-daemon-credential.json'),
      sealJson(KEY, JSON.stringify(cred)),
    );
    const env = {
      ...process.env,
      HOME: path.join(base, 'home'),
      SAND_DATA_ROOT: path.join(base, 'data'),
      SAND_USER_DATA_DIR: path.join(base, 'data'),
      SAND_LOCAL_EXEC_ROOT: path.join(base, 'root'),
      SAND_DISABLE_TELEMETRY: '1',
      SAND_LOCAL_EXEC_GENERATION: '3',
    };
    const child = cp.spawn(process.execPath, [DAEMON], {
      env,
      cwd: base,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout.on('data', (b) => { output = (output + b).slice(-16384); });
    child.stderr.on('data', (b) => { output = (output + b).slice(-16384); });
    const ended = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    try {
      child.send({ type: 'sand-local-exec-file-key', key: KEY, computerId: SYN_MACHINE });
      await waitFor(() => peer.log.some((x) => x.kind === 'watch'));
      const watch = peer.log.find((x) => x.kind === 'watch');
      assert.equal(watch.hello.localRoot, path.join(base, 'root'));
      assert.equal(watch.credentialLen, SYN_CRED.length);
      assert.equal(watch.hello.supervised, true);

      const disc = JSON.parse(fs.readFileSync(path.join(base, 'data', 'local-exec-daemon.json'), 'utf8'));
      assert.equal(disc.generation, 3);

      peer.enqueueExec('uc-read-1', {
        id: 1,
        execId: 'lab',
        readArgs: { path: path.join(base, 'root', 'probe.txt'), toolCallId: 'lab' },
      });
      await waitFor(() => peer.log.some((x) => x.kind === 'submit' && x.count > 0));
      assert.ok(peer.log.some((x) => x.kind === 'poll'), 'poll missing');
      const hint = JSON.stringify(peer.log.filter((x) => x.kind === 'submit'));
      assert.match(hint, /oracle-fixture/);
    } finally {
      child.kill('SIGTERM');
      await Promise.race([ended, delay(3000)]);
      if (child.exitCode == null) child.kill('SIGKILL');
      await peer.close();
      // Withdraw may race shutdown
      await delay(100);
      assert.ok(
        peer.log.some((x) => x.kind === 'withdraw'),
        'withdraw best-effort',
      );
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects wrong credential (unauth)', async () => {
    const peer = startUcFakePeer();
    await peer.listen();
    peer.setUnauth(true);
    const base = mkWorkspace('unauth');
    const cred = {
      backendUrl: `http://127.0.0.1:${peer.port()}`,
      userComputer: { credential: 'wrong-cred', machineId: SYN_MACHINE },
    };
    fs.writeFileSync(
      path.join(base, 'data', 'local-exec-daemon-credential.json'),
      sealJson(KEY, JSON.stringify(cred)),
    );
    const child = cp.spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        HOME: path.join(base, 'home'),
        SAND_DATA_ROOT: path.join(base, 'data'),
        SAND_LOCAL_EXEC_ROOT: path.join(base, 'root'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const ended = new Promise((r) => child.on('exit', (c, s) => r({ code: c, signal: s })));
    try {
      child.send({ type: 'sand-local-exec-file-key', key: KEY, computerId: SYN_MACHINE });
      await delay(1500);
      assert.ok(peer.log.some((x) => x.kind === 'watch'));
      assert.equal(child.exitCode, null, 'daemon stays up on unauth');
    } finally {
      child.kill('SIGTERM');
      await Promise.race([ended, delay(2500)]);
      await peer.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('generation / lease / ownership helpers', () => {
  it('generationFromEnv parses SAND_LOCAL_EXEC_GENERATION', () => {
    assert.equal(generationFromEnv({ SAND_LOCAL_EXEC_GENERATION: '7' }), 7);
    assert.equal(generationFromEnv({}), undefined);
    assert.equal(generationFromEnv({ SAND_LOCAL_EXEC_GENERATION: 'x' }), undefined);
  });

  it('leaseIsActive and ownershipDecision basics', () => {
    const now = 1_000_000;
    assert.equal(leaseIsActive({ until: now + 1000 }, now), true);
    assert.equal(leaseIsActive({ until: now - 1 }, now), false);
    assert.equal(
      ownershipDecision({ supervisedFresh: true, lease: null, inflightCount: 0, nowMs: now }),
      'keep',
    );
    assert.equal(
      ownershipDecision({
        supervisedFresh: false,
        lease: { until: now + 5000 },
        inflightCount: 0,
        nowMs: now,
      }),
      'keep',
    );
    assert.equal(
      ownershipDecision({
        supervisedFresh: false,
        lease: { until: now - 1 },
        inflightCount: 0,
        nowMs: now,
      }),
      'exit',
    );
    assert.equal(
      ownershipDecision({
        supervisedFresh: false,
        lease: null,
        inflightCount: 2,
        supervisorStaleForMs: 1000,
        nowMs: now,
      }),
      'keep',
    );
  });

  it('lease file shape loadable by daemon data root', async () => {
    const { loadLease } = require('../dist/state/lease.js');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledc-lease-'));
    fs.mkdirSync(path.join(base, 'data'));
    const until = Date.now() + 60_000;
    fs.writeFileSync(path.join(base, 'data', 'local-exec-update-lease.json'), JSON.stringify({ until }));
    const lease = await loadLease({ SAND_DATA_ROOT: path.join(base, 'data') });
    assert.equal(lease.until, until);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('known gaps (documented skips)', () => {
  it('generation preempt / dual-daemon race', (t) => {
    t.skip('requires App-side SAND_LOCAL_EXEC_GENERATION bump or second daemon race under same discovery; generation superseded/pid race not yet instrumented');
  });
  it('UC backlog64 / inflight8 busy under load', (t) => {
    t.skip('happy-path Poll/Submit proven; dedicated busy/backlog pressure oracle not instrumented this round');
  });
});
