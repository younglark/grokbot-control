'use strict';
// Test-only Electron main: forks OUR dist with utilityProcess.fork (the App's launch shape) and relays the
// handoff via postMessage (parentPort). Run with a PUBLIC npm electron only, never the App's binary.
const { app, utilityProcess } = require('electron');
const entry = process.argv[process.argv.length - 1];
app.whenReady().then(() => {
  const env = { ...process.env }; const handoff = JSON.parse(env.DROPIN_HANDOFF); delete env.DROPIN_HANDOFF; delete env.ELECTRON_RUN_AS_NODE;
  const c = utilityProcess.fork(entry, [], { serviceName: 'sand-local-exec-daemon', env, stdio: 'inherit' });
  c.on('spawn', () => c.postMessage(handoff));
  c.on('exit', code => { console.log(`[utility-host] utility exited ${code}`); app.exit(code ?? 0); });
  const stop = () => { c.kill(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
});
