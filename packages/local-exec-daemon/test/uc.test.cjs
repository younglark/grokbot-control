'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { startUcFakePeer, SYN_CRED, SYN_MACHINE } = require('./helpers/uc-fake-peer.cjs');
const { sealJson } = require('../dist/uc/sealed.js');
const { ownershipDecision, leaseIsActive, generationFromEnv, pidAlive } = require('../dist/state/lease.js');
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
    // Official FDe supersededForMs branch (daemon.formatted.cjs L79885–79886)
    assert.equal(
      ownershipDecision({
        supervisedFresh: true,
        lease: { until: now + 99999 },
        inflightCount: 0,
        supersededForMs: 0,
        nowMs: now,
      }),
      'exit',
    );
    assert.equal(
      ownershipDecision({
        supervisedFresh: false,
        lease: null,
        inflightCount: 1,
        supersededForMs: 1_000,
        nowMs: now,
      }),
      'keep',
    );
    assert.equal(
      ownershipDecision({
        supervisedFresh: false,
        lease: null,
        inflightCount: 1,
        supersededForMs: 120_001,
        nowMs: now,
      }),
      'exit',
    );
    assert.equal(pidAlive(process.pid), true);
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

describe('ownership PID superseded + UC admission gate + superviseBacklog', () => {
  it('discovery naming another live pid exits as superseded (FDe/Jae/hce)', { timeout: 15000 }, async () => {
    const cp = require('node:child_process');
    const http = require('node:http');
    const streams = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"kind":"welcome"}\n\n');
          streams.push(res);
        } else res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'led-super-'));
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'never' }));
    fs.writeFileSync(path.join(data, 'local-exec-supervisor.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.writeFileSync(
      path.join(data, 'local-exec-daemon-connection.json'),
      JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
    );
    const child = cp.fork(path.resolve(__dirname, '../dist/index.js'), [], {
      env: { ...process.env, SAND_DATA_ROOT: data, SAND_LOCAL_EXEC_ROOT: dir, SAND_LOCAL_EXEC_GENERATION: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stdout += String(chunk); });
    child.send({
      type: 'sand-local-exec-file-key',
      key: Buffer.alloc(32, 9).toString('base64'),
      computerId: 'synthetic',
    });
    const discoveryPath = path.join(data, 'local-exec-daemon.json');
    const until = (pred, ms = 8000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          try {
            if (pred()) return resolve();
          } catch {}
          if (Date.now() - t0 > ms) return reject(new Error('timeout'));
          setTimeout(tick, 50);
        };
        tick();
      });
    try {
      await until(() => fs.existsSync(discoveryPath) && JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).pid === child.pid);
      const prev = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      fs.writeFileSync(discoveryPath, JSON.stringify({ ...prev, pid: process.pid, generation: 2 }));
      await until(() => child.exitCode === 0, 10000);
      assert.equal(child.exitCode, 0);
      assert.match(
        stdout,
        /received superseded, shutting down/,
        `expected superseded shutdown log, got: ${stdout.slice(-500)}`,
      );
    } finally {
      if (child.exitCode === null) {
        const end = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await end;
      }
      streams.forEach((s) => s.destroy());
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UC poll admission gate: fill active+backlog via poll then busy (not e2e load oracle)', { timeout: 15000 }, async () => {
    // Exercises the official 8+64 admission gate through pollOnce parse/admit.
    // Jobs hang so active stays saturated; this is NOT a network/backpressure load oracle.
    const http = require('node:http');
    const wire = require('./helpers/wire-oracle.cjs');
    const { UserComputerProvider } = require('../dist/uc/provider');
    let seq = 0;
    const makeBatch = (n) => {
      const parts = [];
      for (let i = 0; i < n; i++) {
        const id = `q-${seq}`;
        const req = `r-${seq}`;
        seq += 1;
        const frame = Buffer.concat([
          wire.encStr(1, req),
          wire.encMsg(2, wire.encStr(1, '{"id":1,"readArgs":{"path":"probe.txt"}}')),
        ]);
        parts.push(wire.encMsg(1, Buffer.concat([wire.encStr(1, id), wire.encMsg(2, frame)])));
      }
      return Buffer.concat(parts);
    };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const fields = wire.decodeFields(body);
        const limit = fields[4]?.[0]?.v ?? 1;
        res.writeHead(200, { 'content-type': 'application/proto' });
        res.end(makeBatch(Number(limit)));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const p = new UserComputerProvider({
      backendUrl: `http://127.0.0.1:${port}`,
      machineId: 'synthetic',
      credential: 'synthetic',
      root: '/tmp',
      permission: 'ask',
      hello: {
        label: 'lab',
        localRoot: '/tmp',
        terminalsFolder: '/tmp',
        standing: 'ask',
        variant: 'lab',
        serverAuthoritative: false,
      },
    });
    const got = [];
    p.channel = { backendUrl: `http://127.0.0.1:${port}`, machineId: 'synthetic', credential: 'synthetic' };
    p.replies = { available: true };
    p.emit = (f) => got.push(f);
    // Hang admitted work so active remains at capacity (admission still via poll).
    // Rejectable so the test process does not leak forever-pending handles.
    const cancelHang = [];
    p.handleQueued = () => new Promise((_, reject) => { cancelHang.push(reject); });
    try {
      for (let i = 0; i < 20 && !(p.active.size >= 8 && p.backlog.length >= 64); i++) {
        await p.pollOnce();
      }
      assert.equal(p.active.size, 8, `active=${p.active.size} backlog=${p.backlog.length} seq=${seq}`);
      assert.equal(p.backlog.length, 64, `active=${p.active.size} backlog=${p.backlog.length}`);
      const before = got.length;
      await p.pollOnce();
      const busy = got.slice(before).filter((f) =>
        /busy with other requests right now/i.test(f.message?.throw?.error || f.error || ''),
      );
      assert.ok(busy.length >= 1, JSON.stringify(got.slice(before)));
      assert.equal(p.backlog.length, 64, 'busy rejection must not grow backlog');
    } finally {
      for (const reject of cancelHang) reject(new Error('test cleanup'));
      p.beginShutdown();
      await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => server.close(r));
    }
  });

  it('superviseBacklog drains stale backlog after 15s and nudges poll after 5s', async () => {
    const http = require('node:http');
    const {
      UserComputerProvider,
      UC_BACKLOG_CLOSED_BEFORE_START,
      UC_BACKLOG_STALE_MS,
      UC_BACKLOG_NUDGE_MS,
    } = require('../dist/uc/provider');
    let polls = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        polls += 1;
        res.writeHead(200, { 'content-type': 'application/proto' });
        res.end(Buffer.alloc(0));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const p = new UserComputerProvider({
      backendUrl: `http://127.0.0.1:${port}`,
      machineId: 'synthetic',
      credential: 'synthetic',
      root: '/tmp',
      permission: 'ask',
      hello: {
        label: 'lab',
        localRoot: '/tmp',
        terminalsFolder: '/tmp',
        standing: 'ask',
        variant: 'lab',
        serverAuthoritative: false,
      },
    });
    const got = [];
    p.channel = { backendUrl: `http://127.0.0.1:${port}`, machineId: 'synthetic', credential: 'synthetic' };
    // available:false so a nudged pollOnce cannot runBacklog-steal the fixture item
    p.replies = { available: false };
    p.emit = (f) => got.push(f);
    p.backlog = [
      { id: 'stale-1', requestId: 'stale-req', kind: 2, serverMessage: {} },
    ];
    const now = Date.now();
    p.lastPolledAt = now - (UC_BACKLOG_NUDGE_MS + 100);
    const pollsBefore = polls;
    p.superviseBacklog(now);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(polls > pollsBefore, '5s nudge should request poll');
    assert.equal(p.backlog.length, 1, 'nudge must not drain');

    // Stale drain does not require replies.available (official abandons queued work).
    p.lastPolledAt = now - (UC_BACKLOG_STALE_MS + 1);
    p.superviseBacklog(now);
    assert.equal(p.backlog.length, 0);
    assert.ok(
      got.some(
        (f) =>
          f.requestId === 'stale-req' &&
          (f.message?.throw?.error === UC_BACKLOG_CLOSED_BEFORE_START || f.error === UC_BACKLOG_CLOSED_BEFORE_START),
      ),
      JSON.stringify(got),
    );
    await new Promise((r) => server.close(r));
  });
});
