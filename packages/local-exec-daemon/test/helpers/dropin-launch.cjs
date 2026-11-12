'use strict';
// t168: reusable launcher for gated drop-in tests. Starts OUR dist/index.js the way the App's spawn fallback L$e does
// (spawn(execPath, [entry], {detached, stdio:["ignore",log,log,"ipc"]}) + send({type:"sand-local-exec-file-key",...}),
// env R$e shape; main-core.cjs 0.79.3). Synthetic HOME/data/credentials only; never the official daemon.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { sealJson } = require('../../dist/uc/sealed');
const { openMaybeSealed } = require('../../dist/state/connection');

const KEY = Buffer.alloc(32, 9).toString('base64');
const MACHINE = 'synthetic-dropin-machine';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await f(); if (v) return v; await delay(20); } throw new Error('deadline: ' + what); }

function launch(o) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dropin-x-'));
  const home = path.join(base, 'home'), data = path.join(base, 'data'), root = path.join(base, 'root');
  for (const d of [home, data, root]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(o.settings ?? { version: 1, localToolPermission: 'always', messagesEnabled: true }));
  fs.writeFileSync(path.join(data, 'local-exec-supervisor.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  if (o.approvals) fs.writeFileSync(path.join(data, 'local-tool-approvals.json'), JSON.stringify({ approvals: o.approvals({ root, home, terminals: path.join(root, 'terminals') }) }));
  o.prepareHome?.(home, root);
  const credFile = path.join(data, 'local-exec-daemon-credential.json'), connFile = path.join(data, 'local-exec-daemon-connection.json');
  const writeCred = obj => fs.writeFileSync(credFile, sealJson(KEY, JSON.stringify(obj)));
  if (o.credential) writeCred(o.credential);
  if (o.connection) fs.writeFileSync(connFile, sealJson(KEY, JSON.stringify(o.connection)));
  const logFile = path.join(base, 'daemon.log'); const logFd = fs.openSync(logFile, 'a');
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), SAND_DATA_ROOT: data, SAND_USER_DATA_DIR: data,
    SAND_LOCAL_EXEC_ROOT: root, SAND_CLIENT_APP_VERSION: '0.79.4', SAND_LOCAL_EXEC_GENERATION: '7', NODE_USE_SYSTEM_CA: '1', ...o.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const execPath = o.execPath ?? process.execPath;
  const entry = path.join(__dirname, '..', '..', 'dist', 'index.js');
  // o.argsFor: wrap the entry (e.g. an Electron utilityProcess host); the host relays the handoff it finds in DROPIN_HANDOFF.
  if (o.argsFor) env.DROPIN_HANDOFF = JSON.stringify({ type: 'sand-local-exec-file-key', key: KEY, computerId: MACHINE });
  const child = cp.spawn(execPath, o.argsFor ? o.argsFor(entry) : [entry], { env, cwd: base, detached: true, stdio: o.argsFor ? ['ignore', logFd, logFd] : ['ignore', logFd, logFd, 'ipc'] });
  let exit = null; const exited = new Promise(r => child.on('exit', (code, signal) => { exit = { code, signal }; r(); }));
  if (!o.argsFor) child.send({ type: 'sand-local-exec-file-key', key: KEY, computerId: MACHINE });
  const readDiscovery = () => { try { return JSON.parse(openMaybeSealed(fs.readFileSync(path.join(data, 'local-exec-daemon.json'), 'utf8'), KEY)); } catch { return null; } };
  return {
    base, home, data, root, child, env, KEY, MACHINE, writeCred, readDiscovery, logFile,
    log: () => fs.readFileSync(logFile, 'utf8'),
    exit: () => exit, exited,
    async stop() { if (exit === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(8000)]); } if (exit === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await Promise.race([exited, delay(2000)]); } return exit; },
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

module.exports = { launch, until, delay, KEY, MACHINE };
