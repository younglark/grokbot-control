'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const KEY = Buffer.alloc(32, 7).toString('base64');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Electron parentPort handoff (simulated)', () => {
  it('accepts handoff via process.parentPort message data', async () => {
    // Spawn a tiny harness that injects parentPort then loads dist handoff
    const script = `
      const { EventEmitter } = require('events');
      const path = require('path');
      const ee = new EventEmitter();
      process.parentPort = {
        once(ev, cb) { ee.once(ev, cb); },
        on(ev, cb) { ee.on(ev, cb); },
        emit(ev, data) { ee.emit(ev, data); },
      };
      // Prevent Node IPC path
      Object.defineProperty(process, 'connected', { get: () => false });
      process.channel = undefined;
      const { awaitHandoff } = require(${JSON.stringify(path.join(ROOT, 'dist/bootstrap/handoff.js'))});
      (async () => {
        const p = awaitHandoff(2000);
        setTimeout(() => {
          process.parentPort.emit('message', { data: {
            type: 'sand-local-exec-file-key',
            key: ${JSON.stringify(KEY)},
            computerId: 'synthetic-lab-machine',
          }});
        }, 50);
        const r = await p;
        if (r.computerId === undefined || r.key === null) { console.error(JSON.stringify(r)); process.exit(2); }
        console.log(JSON.stringify({ ok: true, computerId: r.computerId }));
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const child = cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0, out);
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.ok, true);
    assert.equal(j.computerId, 'synthetic-lab-machine');
  });
});

describe('Electron utilityProcess smoke', () => {
  it('forks local-exec-daemon daemon via lab Electron (skip if missing)', async (t) => {
    const electron =
      process.env.LOCAL_EXEC_DAEMON_ELECTRON ||
      '/workspace/local-exec-offline-lab-0793/electron-host/node_modules/electron/dist/electron';
    if (!fs.existsSync(electron)) {
      t.skip('Electron binary not available');
      return;
    }
    const runner = path.join(ROOT, 'scripts', 'electron-smoke.cjs');
    // Ensure dist built
    const r = cp.spawnSync(process.execPath, [runner], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env },
    });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch {
      parsed = { ok: false, raw: r.stdout, err: r.stderr, status: r.status };
    }
    if (parsed.skipped) {
      t.skip(parsed.reason || 'skipped');
      return;
    }
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.discovery?.pid, JSON.stringify(parsed));
    // electron-smoke exits 0 on ok; tolerate status null if ok payload
    if (r.status != null && r.status !== 0 && !parsed.ok) {
      assert.fail(JSON.stringify(parsed));
    }
  });
});
