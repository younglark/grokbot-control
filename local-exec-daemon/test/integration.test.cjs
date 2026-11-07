'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(ROOT, 'dist', 'index.js');
const KEY = Buffer.alloc(32, 7).toString('base64');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mkWorkspace(name, permission = 'always') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `ledc-${name}-`));
  fs.mkdirSync(path.join(base, 'root'));
  fs.mkdirSync(path.join(base, 'data'));
  fs.writeFileSync(path.join(base, 'root', 'probe.txt'), 'oracle-fixture\n');
  fs.writeFileSync(
    path.join(base, 'data', 'settings.json'),
    JSON.stringify({ version: 1, localToolPermission: permission }),
  );
  fs.writeFileSync(
    path.join(base, 'data', 'local-exec-supervisor.json'),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  );
  return base;
}

function startDaemon(base, mode = 'valid') {
  const env = {
    ...process.env,
    HOME: path.join(base, 'home'),
    SAND_DATA_ROOT: path.join(base, 'data'),
    SAND_USER_DATA_DIR: path.join(base, 'data'),
    SAND_LOCAL_EXEC_ROOT: path.join(base, 'root'),
    SAND_DISABLE_TELEMETRY: '1',
    SAND_BACKEND_URL: 'http://127.0.0.1:1',
  };
  fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  const child = cp.spawn(process.execPath, [DAEMON], {
    env,
    cwd: base,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (b) => { output = (output + b).slice(-32768); });
  child.stderr.on('data', (b) => { output = (output + b).slice(-32768); });
  const ended = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  child.on('spawn', () => {
    if (mode === 'valid') child.send({ type: 'sand-local-exec-file-key', key: KEY, computerId: 'synthetic-lab-machine' });
    if (mode === 'missing-id') child.send({ type: 'sand-local-exec-file-key', key: KEY });
    if (mode === 'malformed') child.send({ type: 'invalid', key: 'not-a-key' });
    if (mode === 'disconnect') child.disconnect();
  });
  return {
    child,
    base,
    ended,
    get output() { return output; },
    async close() {
      if (child.exitCode == null && !child.killed) {
        child.kill('SIGTERM');
        await Promise.race([ended, delay(2500)]);
        if (child.exitCode == null) child.kill('SIGKILL');
      }
      await ended;
    },
  };
}

function startFakeBox() {
  const frames = [];
  let stream = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/local-exec/requests') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ kind: 'welcome', providerId: 'synthetic-provider' }) + '\n\n');
      stream = res;
    } else if (req.url === '/local-exec/responses') {
      let s = '';
      req.on('data', (b) => { s += b; });
      req.on('end', () => {
        try {
          const j = JSON.parse(s);
          frames.push(...(j.frames || []));
        } catch { /* ignore */ }
        res.end('{}');
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    frames,
    server,
    ready,
    port: () => server.address().port,
    send: (j) => stream && stream.write('data: ' + JSON.stringify(j) + '\n\n'),
    async close() {
      stream?.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

async function waitFor(test, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (test()) return;
    await delay(40);
  }
  throw new Error('event deadline');
}

describe('P1 bootstrap', () => {
  for (const mode of ['disconnect', 'missing-id', 'malformed', 'none']) {
    it(`fatal on ${mode}`, async () => {
      const base = mkWorkspace(mode);
      const p = startDaemon(base, mode);
      try {
        const exit = await Promise.race([p.ended, delay(6500).then(() => null)]);
        assert.ok(exit, 'expected exit');
        assert.equal(exit.code, 1);
        assert.match(p.output, /\[sand-local-exec-daemon\] fatal: Error/);
      } finally {
        await p.close();
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  }

  it('valid handoff publishes discovery and clears on SIGTERM', async () => {
    const base = mkWorkspace('valid');
    const p = startDaemon(base, 'valid');
    try {
      await delay(800);
      assert.equal(p.child.exitCode, null, p.output);
      const disc = JSON.parse(fs.readFileSync(path.join(base, 'data', 'local-exec-daemon.json'), 'utf8'));
      assert.equal(disc.pid, p.child.pid);
      assert.ok(disc.filesKeyId);
      assert.equal(disc.filesKeyId, require('crypto').createHash('sha256').update(Buffer.from(KEY, 'base64')).digest('hex').slice(0, 16));
      p.child.kill('SIGTERM');
      const exit = await p.ended;
      assert.equal(exit.code, 0);
      assert.equal(fs.existsSync(path.join(base, 'data', 'local-exec-daemon.json')), false);
    } finally {
      await p.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('P1 box transport', () => {
  it('hello + read + shell + unsupported + path escape + cancel', async () => {
    const box = startFakeBox();
    await box.ready;
    const base = mkWorkspace('box');
    fs.writeFileSync(
      path.join(base, 'data', 'local-exec-daemon-connection.json'),
      JSON.stringify({ baseUrl: `http://127.0.0.1:${box.port()}` }),
    );
    const p = startDaemon(base, 'valid');
    try {
      await waitFor(() => box.frames.some((f) => f.kind === 'hello'));
      const hello = box.frames.find((f) => f.kind === 'hello');
      assert.equal(hello.localRoot, path.join(base, 'root'));
      assert.equal(hello.computerId, 'synthetic-lab-machine');
      assert.equal(hello.supervised, true);

      const send = (j) => box.send(j);

      send({ kind: 'exec', requestId: 'read', serverMessage: { id: 1, execId: 'lab', readArgs: { path: path.join(base, 'root', 'probe.txt'), toolCallId: 'lab' } } });
      await waitFor(() => box.frames.some((f) => f.requestId === 'read' && f.kind === 'control'));
      const readFrames = box.frames.filter((f) => f.requestId === 'read');
      assert.match(JSON.stringify(readFrames), /oracle-fixture/);
      assert.ok(readFrames.some((f) => f.message?.streamClose));

      send({ kind: 'exec', requestId: 'shell', serverMessage: { id: 3, execId: 'lab', shellStreamArgs: { command: 'printf lab-shell-oracle', workingDirectory: path.join(base, 'root'), toolCallId: 'lab', timeout: 2000 } } });
      await waitFor(() => box.frames.some((f) => f.requestId === 'shell' && f.message?.shellStream?.exit));
      assert.match(JSON.stringify(box.frames.filter((f) => f.requestId === 'shell')), /lab-shell-oracle/);

      send({ kind: 'exec', requestId: 'unsupported', serverMessage: { id: 4, writeShellStdinArgs: { shellId: '1', chars: 'x' } } });
      await waitFor(() => box.frames.some((f) => f.requestId === 'unsupported' && f.message?.throw));
      assert.match(JSON.stringify(box.frames.filter((f) => f.requestId === 'unsupported')), /No handler found/);

      send({ kind: 'exec', requestId: 'escape', serverMessage: { id: 5, readArgs: { path: '/etc/passwd', toolCallId: 'lab' } } });
      await waitFor(() => box.frames.some((f) => f.requestId === 'escape'));
      assert.match(JSON.stringify(box.frames.filter((f) => f.requestId === 'escape')), /outside the allowed/);

      send({ kind: 'exec', requestId: 'cancel-job', serverMessage: { id: 1, execId: 'cancel', shellStreamArgs: { command: 'sleep 30', workingDirectory: path.join(base, 'root'), toolCallId: 'c', timeout: 60000 } } });
      await waitFor(() => box.frames.some(f => f.requestId === "cancel-job" && f.message?.shellStream?.start));
      send({ kind: 'cancel', requestId: 'cancel-job' });
      await waitFor(() => box.frames.some((f) => f.requestId === 'cancel-job' && f.message?.shellStream?.exit?.aborted === true));
      const c = box.frames.find((f) => f.requestId === 'cancel-job' && f.message?.shellStream?.exit);
      assert.equal(c.message.shellStream.exit.abortReason, 'SHELL_ABORT_REASON_USER_ABORT');
      assert.equal(c.message.shellStream.exit.code, 4294967295);
    } finally {
      await p.close();
      await box.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('Never / Ask refuse download; symlink escape', async () => {
    for (const [perm, needle] of [['never', 'turned off'], ['ask', 'not approved']]) {
      const box = startFakeBox();
      await box.ready;
      const base = mkWorkspace(perm, perm);
      fs.writeFileSync(path.join(base, 'data', 'local-exec-daemon-connection.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${box.port()}` }));
      const p = startDaemon(base, 'valid');
      try {
        await waitFor(() => box.frames.some((f) => f.kind === 'hello'));
        box.send({ kind: 'download', requestId: 'denied', path: path.join(base, 'root', 'probe.txt') });
        await waitFor(() => box.frames.some((f) => f.requestId === 'denied'));
        assert.match(JSON.stringify(box.frames.filter((f) => f.requestId === 'denied')), new RegExp(needle));
      } finally {
        await p.close();
        await box.close();
        fs.rmSync(base, { recursive: true, force: true });
      }
    }

    const box = startFakeBox();
    await box.ready;
    const base = mkWorkspace('symlink');
    fs.writeFileSync(path.join(base, 'data', 'local-exec-daemon-connection.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${box.port()}` }));
    const outside = path.join(base, 'outside-target');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(path.dirname(outside), path.join(base, 'root', 'outside'));
    // Point symlink at parent of root so realpath escapes root
    fs.rmSync(path.join(base, 'root', 'outside'), { force: true });
    fs.symlinkSync(base, path.join(base, 'root', 'outside'));
    const p = startDaemon(base, 'valid');
    try {
      await waitFor(() => box.frames.some((f) => f.kind === 'hello'));
      box.send({ kind: 'download', requestId: 'symlink', path: path.join(base, 'root', 'outside', 'outside-target') });
      await waitFor(() => box.frames.some((f) => f.requestId === 'symlink'));
      assert.match(JSON.stringify(box.frames.filter((f) => f.requestId === 'symlink')), /resolves through a symlink/);
    } finally {
      await p.close();
      await box.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
