'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(ROOT, 'dist', 'index.js');
const KEY = Buffer.alloc(32, 7).toString('base64');
const LAB_ELECTRON =
  process.env.LOCAL_EXEC_DAEMON_ELECTRON ||
  '/workspace/local-exec-offline-lab-0793/electron-host/node_modules/electron/dist/electron';
const APP = path.join(__dirname, 'electron-host/min-app');

(async () => {
  if (!fs.existsSync(LAB_ELECTRON)) {
    console.log(JSON.stringify({
      ok: false,
      skipped: true,
      reason: `Electron binary missing at ${LAB_ELECTRON}`,
    }));
    process.exit(0);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledc-el-'));
  fs.mkdirSync(path.join(base, 'root'));
  fs.mkdirSync(path.join(base, 'data'));
  fs.mkdirSync(path.join(base, 'home'));
  fs.writeFileSync(
    path.join(base, 'data', 'settings.json'),
    JSON.stringify({ version: 1, localToolPermission: 'always' }),
  );
  fs.writeFileSync(
    path.join(base, 'data', 'local-exec-supervisor.json'),
    JSON.stringify({ pid: process.pid, at: Date.now() }),
  );
  const out = path.join(base, 'out.json');
  const env = {
    ...process.env,
    HOME: path.join(base, 'home'),
    SAND_DATA_ROOT: path.join(base, 'data'),
    SAND_USER_DATA_DIR: path.join(base, 'data'),
    SAND_LOCAL_EXEC_ROOT: path.join(base, 'root'),
    SAND_DISABLE_TELEMETRY: '1',
    LAB_DAEMON: DAEMON,
    LAB_KEY: KEY,
    LAB_COMPUTER_ID: 'synthetic-lab-machine',
    LAB_OUT: out,
    LAB_WAIT_MS: '3500',
    ELECTRON_RUN_AS_NODE: '', // ensure unset for host
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const run = (cmd, args) =>
    new Promise((resolve) => {
      const child = cp.spawn(cmd, args, {
        env,
        cwd: APP,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const deadline = setTimeout(() => {
        if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exact experiment group gone */ }
      }, 20000);
      child.once('error', e => { clearTimeout(deadline); resolve({code:1,output:String(e.message)}); });
      child.stdout.on('data', (b) => { output += b; });
      child.stderr.on('data', (b) => { output += b; });
      child.on('exit', (code) => { clearTimeout(deadline); resolve({ code, output }); });
    });

  let result = await run('xvfb-run', ['-a', LAB_ELECTRON, APP]);
  if (result.code !== 0 && !fs.existsSync(out)) {
    // retry without xvfb if DISPLAY set
    result = await run(LAB_ELECTRON, [APP]);
  }

  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignore */ }
  const ok = !!(parsed && parsed.ok && parsed.discovery && parsed.discovery.pid);
  console.log(JSON.stringify({
    ok,
    skipped: false,
    electronExit: result.code,
    discovery: parsed?.discovery || null,
    steps: parsed?.steps || [],
    outputTail: (parsed?.output || result.output || '').slice(-500),
    error: parsed?.error || null,
  }, null, 2));
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})();
