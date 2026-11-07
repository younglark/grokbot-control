'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { startUcFakePeer, SYN_CRED, SYN_MACHINE } = require('../test/helpers/uc-fake-peer.cjs');
const { sealJson } = require('../dist/uc/sealed.js');
const { UC_P2_GAPS } = require('../dist/uc/types.js');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(ROOT, 'dist', 'index.js');
const KEY = Buffer.alloc(32, 7).toString('base64');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const peer = startUcFakePeer();
  await peer.listen();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledc-uc-smoke-'));
  fs.mkdirSync(path.join(base, 'root'));
  fs.mkdirSync(path.join(base, 'data'));
  fs.mkdirSync(path.join(base, 'home'));
  fs.writeFileSync(path.join(base, 'root', 'probe.txt'), 'oracle-fixture\n');
  fs.writeFileSync(path.join(base, 'data', 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'always' }));
  fs.writeFileSync(path.join(base, 'data', 'local-exec-supervisor.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  fs.writeFileSync(
    path.join(base, 'data', 'local-exec-daemon-credential.json'),
    sealJson(KEY, JSON.stringify({
      backendUrl: `http://127.0.0.1:${peer.port()}`,
      userComputer: { credential: SYN_CRED, machineId: SYN_MACHINE },
    })),
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
  child.send({ type: 'sand-local-exec-file-key', key: KEY, computerId: SYN_MACHINE });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !peer.log.some((x) => x.kind === 'watch')) await delay(40);
  peer.enqueueExec('smoke-read', { id: 1, readArgs: { path: path.join(base, 'root', 'probe.txt'), toolCallId: 't' } });
  while (Date.now() - t0 < 12000 && !peer.log.some((x) => x.kind === 'submit' && x.count > 0)) await delay(40);
  child.kill('SIGTERM');
  await Promise.race([ended, delay(3000)]);
  await peer.close();
  const ok = peer.log.some((x) => x.kind === 'watch') && peer.log.some((x) => x.kind === 'submit');
  console.log(JSON.stringify({
    ok,
    watch: peer.log.find((x) => x.kind === 'watch')?.hello || null,
    submitHints: peer.log.filter((x) => x.kind === 'submit'),
    withdraw: peer.log.some((x) => x.kind === 'withdraw'),
    gaps: UC_P2_GAPS,
  }, null, 2));
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
