'use strict';
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const out = process.env.LAB_OUT || '/tmp/electron-local-exec-daemon-out.json';
const result = { ok: false, steps: [], versions: process.versions };
function save() {
  try { fs.writeFileSync(out, JSON.stringify(result, null, 2)); } catch { /* ignore */ }
}
process.on('uncaughtException', (e) => {
  result.error = String(e && e.stack || e);
  save();
  try { app.exit(2); } catch { /* ignore */ }
});
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(() => {
  result.steps.push('ready');
  result.hasUtilityProcess = typeof utilityProcess?.fork === 'function';
  const daemon = process.env.LAB_DAEMON || '';
  const key = process.env.LAB_KEY || '';
  const computerId = process.env.LAB_COMPUTER_ID || 'synthetic-lab-machine';
  if (!result.hasUtilityProcess) {
    result.error = 'no utilityProcess.fork';
    save();
    app.exit(3);
    return;
  }
  if (!daemon || !key) {
    result.error = 'missing LAB_DAEMON/LAB_KEY';
    save();
    app.exit(4);
    return;
  }
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(daemon, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    serviceName: 'local-exec-daemon',
  });
  result.steps.push('forked');
  let output = '';
  child.stdout?.on('data', (b) => { output = (output + b.toString()).slice(0, 32768); });
  child.stderr?.on('data', (b) => { output = (output + b.toString()).slice(0, 32768); });
  const exitP = new Promise((r) => child.on('exit', (code) => { result.childExit = { code }; r(code); }));
  child.on('spawn', () => {
    result.steps.push('spawn');
    try {
      child.postMessage({ type: 'sand-local-exec-file-key', key, computerId });
      result.steps.push('postMessage');
    } catch (e) {
      result.postMessageError = String(e);
    }
  });
  const wait = Number(process.env.LAB_WAIT_MS || 3000);
  setTimeout(async () => {
    result.output = output;
    const data = process.env.SAND_DATA_ROOT;
    if (data) {
      try {
        result.discovery = JSON.parse(fs.readFileSync(data + '/local-exec-daemon.json', 'utf8'));
      } catch (e) {
        result.discoveryError = String(e);
      }
    }
    result.ok = !!(result.discovery?.pid) || result.steps.includes('postMessage');
    save();
    try { child.kill(); } catch { /* ignore */ }
    await Promise.race([exitP, new Promise((r) => setTimeout(r, 2500))]);
    result.output = output;
    result.afterKill = result.childExit;
    save();
    app.exit(result.ok ? 0 : 1);
  }, wait);
});
