// t130u: index UC refresh lifecycle vs daemon.formatted.cjs 0.79.3
// Standing cadence: yre/hc serial tick + follow-up (D:L78435, L179481–179488);
// Ve body: await ae → SA close without withdraw → if (y) return → V.set+start, then C (D:L179343–179427);
// Process exit: IDe withdrawPresence:true (D:L79748–79749). Synthetic only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const distIndex = path.join(__dirname, '../dist/index.js');
const source = fs.readFileSync(distIndex, 'utf8');
const point = '    for (let i = 0; i < 50';
assert.equal(source.split(point).length, 2, 'expected single bootstrap loop anchor');
const code = source
  .replace(
    point,
    '    globalThis.audit = { refreshUc, requestUcRefresh, shutdown, getUc: () => uc, awaitUcRefresh: async () => { await ucRefresh; } };\n' + point,
  )
  .replace('main().catch(() => (0, handoff_1.exitFatal)());', 'module.exports = main;');
assert.notEqual(code, source);
assert.ok(code.includes('module.exports = main;'));

const defer = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const ch = (sa, credential = 'synthetic-v1') => ({
  backendUrl: 'http://synthetic.invalid',
  machineId: 'synthetic-machine',
  accountScope: 'synthetic-scope',
  credential,
  serverAuthoritative: sa,
});

async function harness(sa = false) {
  const instances = [];
  const events = [];
  let channel = sa === null ? null : ch(sa);
  let loader = async () => channel;
  let publisher = async () => {};
  let shellStop = async () => {};
  let discovery = null;
  class FakeProvider {
    constructor(opts) {
      this.opts = opts;
      this.serverAuthoritative = opts.hello.serverAuthoritative === true;
      this.stopped = false;
      this.started = false;
      this.lastStopOpts = undefined;
      instances.push(this);
      events.push('construct:' + instances.length);
    }
    async start() {
      events.push('start:' + instances.indexOf(this));
      this.started = true;
      if (this.stopped) this.startedAfterStop = true;
    }
    async stop(opts = {}) {
      this.lastStopOpts = opts;
      this.stopped = true;
      events.push('stop:' + instances.indexOf(this) + ':withdraw=' + (opts.withdrawPresence === true));
      if (this.stopGate) await this.stopGate.promise;
      events.push('stop-done:' + instances.indexOf(this));
    }
    beginShutdown() { this.closed = true; }
    updateChannel(c) { this.updated = c; return true; }
    async rehelloIfChanged() { this.updated = await this.opts.resolveChannel(); }
  }
  const mods = {
    './trace': { lifecycleTrace() {} },
    './exec/handlers': { shutdownShells: () => shellStop() },
    './util': {
      dataRootFromEnv: () => '/tmp/synthetic-only',
      localRootFromEnv: () => '/tmp/synthetic-only',
      logInfo: () => {},
      delay: async () => {},
      readJsonIfExists: async () => null,
    },
    './bootstrap/handoff': {
      awaitHandoff: async () => ({ ok: true, handoff: { key: 'synthetic-key', computerId: 'synthetic-computer' } }),
      exitFatal: () => { throw new Error('unexpected exitFatal'); },
    },
    './settings': { loadSettings: async () => ({ permission: 'ask' }) },
    './state/discovery': {
      publishDiscovery: () => publisher(),
      clearDiscovery: async () => {},
      isSupervised: async () => true,
      loadDiscovery: async () => discovery,
    },
    './state/connection': { loadConnection: async () => null },
    './box/provider': { BoxProvider: class { constructor() { throw new Error('box prohibited'); } } },
    './uc/provider': { UserComputerProvider: FakeProvider },
    './uc/credential': {
      loadSealedCredential: async () => {
        const value = await loader();
        return value?.machineId ? { backendUrl: value.backendUrl, userComputer: value } : value;
      },
      pickUserComputerChannel: (v) => v.userComputer ? { ...v.userComputer, backendUrl: v.backendUrl } : v,
    },
    './state/lease': { generationFromEnv: () => undefined, pidAlive: pid => pid === 456 },
    'node:os': { hostname: () => 'synthetic' },
    'node:path': require('node:path'),
  };
  let now = 0;
  const timers = [];
  const ctx = {
    module: { exports: {} },
    exports: {},
    require: (k) => {
      if (!(k in mods)) throw new Error('unmocked module ' + k);
      return mods[k];
    },
    process: { pid: 123, env: {}, on: () => {}, exit: () => events.push('exit') },
    console,
    Date,
    setInterval: () => ({ unref() {} }),
    setTimeout: (fn, ms) => { const timer = { fn, at: now + ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
  };
  vm.runInNewContext(code, ctx, { filename: 'index-under-lifecycle-test.js' });
  await ctx.module.exports();
  await ctx.audit.awaitUcRefresh();
  return {
    ...ctx.audit,
    advance: async ms => {
      const end = now + ms;
      for (;;) {
        const timer = timers.filter(t => !t.cancelled && t.at <= end).sort((a,b) => a.at-b.at)[0];
        if (!timer) break;
        timer.cancelled = true; now = timer.at; timer.fn(); await tick();
      }
      now = end;
    },
    now: () => now,
    timerCount: () => timers.filter(t => !t.cancelled).length,
    instances,
    events,
    setChannel: (v) => { channel = v; },
    setLoader: (v) => { loader = v; },
    setPublisher: (v) => { publisher = v; },
    setShellStop: (v) => { shellStop = v; },
    setDiscovery: value => { discovery = value; },
  };
}

test('index sequential false→true→false: old stop finishes before construct; SA stop does not withdraw', async () => {
  const h = await harness(false);
  assert.equal(h.instances.length, 1);
  h.setChannel(ch(true, 'synthetic-v2'));
  await h.refreshUc();
  h.setChannel(ch(false, 'synthetic-v3'));
  await h.refreshUc();
  assert.equal(h.instances.length, 3);
  assert.equal(h.instances[0].stopped, true);
  assert.equal(h.instances[1].stopped, true);
  assert.equal(h.instances[0].lastStopOpts?.withdrawPresence, undefined);
  assert.equal(h.instances[1].lastStopOpts?.withdrawPresence, undefined);
  assert.equal(h.getUc().opts.credential, 'synthetic-v3');
  assert.equal(h.getUc().serverAuthoritative, false);
  assert.ok(h.events.indexOf('stop-done:0') < h.events.indexOf('construct:2'));
  assert.ok(h.events.indexOf('stop-done:1') < h.events.indexOf('construct:3'));
});

test('index unchanged SA rotates credential without recreate', async () => {
  const h = await harness(true);
  h.setChannel(ch(true, 'synthetic-v2'));
  h.requestUcRefresh(); await h.awaitUcRefresh();
  assert.equal(h.instances.length, 1);
  assert.equal(h.getUc().updated.credential, 'synthetic-v2');
});

test('index shutdown while old.stop pending does not replace provider', async () => {
  const h = await harness();
  h.instances[0].stopGate = defer();
  h.setChannel(ch(true));
  const p = h.refreshUc();
  await tick();
  h.shutdown('synthetic');
  h.instances[0].stopGate.resolve();
  await p;
  await tick();
  assert.equal(h.instances.length, 1);
});

test('R1: overlapping refresh requests serialize; no construct before old.stop; one replacement; follow-up keeps latest', async () => {
  const h = await harness();
  const first = defer();
  const second = defer();
  const gate = defer();
  h.instances[0].stopGate = gate;
  let n = 0;
  h.setLoader(() => (++n === 1 ? first.promise : second.promise));
  h.requestUcRefresh();
  await tick();
  h.requestUcRefresh(); // must coalesce to follow-up, not a concurrent Ve
  first.resolve(ch(true, 'synthetic-v2'));
  await tick();
  const beforeOldStopped = h.instances.length;
  second.resolve(ch(true, 'synthetic-v3'));
  gate.resolve();
  await h.awaitUcRefresh();
  await tick();
  assert.equal(beforeOldStopped, 1, 'must not construct a replacement before old.stop settles');
  assert.equal(h.instances.length, 2, 'must have only one replacement');
  assert.equal(h.getUc().opts.credential, 'synthetic-v2');
  assert.equal(h.getUc().updated?.credential, 'synthetic-v3');
  assert.equal(h.instances[0].lastStopOpts?.withdrawPresence, undefined);
});

test('R2: shutdown during credential read must not create or start a provider', async () => {
  const h = await harness(null);
  const read = defer();
  const shell = defer();
  h.setLoader(() => read.promise);
  h.setShellStop(() => shell.promise);
  h.requestUcRefresh(); const p = h.awaitUcRefresh();
  await tick(); h.shutdown('synthetic');
  read.resolve(ch(true, 'synthetic-v2'));
  await p;
  await tick();
  assert.equal(h.instances.length, 0, 'no new provider during shutdown');
  shell.resolve();
  await tick();
});

test('R3: publish after start; shutdown during publish never starts after stop', async () => {
  const h = await harness();
  const publish = defer();
  let publishStarted = false;
  h.setPublisher(async () => {
    publishStarted = true;
    await publish.promise;
  });
  h.setChannel(ch(true, 'synthetic-v2'));
  h.requestUcRefresh(); const p = h.awaitUcRefresh();
  await tick();
  assert.equal(h.instances.length, 2);
  const startIdx = h.events.indexOf('start:1');
  assert.ok(startIdx >= 0, 'replacement must start before publish can finish');
  assert.equal(h.instances[1].started, true);
  assert.equal(publishStarted, true);
  h.shutdown('synthetic');
  await tick();
  publish.resolve();
  await p;
  await tick();
  assert.notEqual(h.instances[1].startedAfterStop, true);
});

test('provider.stop default skips withdraw; withdrawPresence true calls once', async () => {
  const { UserComputerProvider } = require('../dist/uc/provider');
  const root = fs.mkdtempSync('/tmp/uc-lifecycle-withdraw-');
  const calls = [];
  const p = new UserComputerProvider({
    backendUrl: 'http://synthetic.invalid',
    machineId: 'synthetic',
    credential: 'synthetic-token',
    root,
    permission: 'ask',
    hello: {
      label: 't',
      localRoot: root,
      terminalsFolder: root + '/terminals',
      standing: 'ask',
      supervised: true,
      variant: 't',
      serverAuthoritative: false,
    },
  });
  p.channel = { backendUrl: 'http://synthetic.invalid', machineId: 'synthetic', credential: 'synthetic-token' };
  p.client = {
    withdrawGrokBotUserComputerPresence: async (req) => { calls.push(req); return {}; },
  };
  p.replies = { drain: async () => true, stop() {} };
  await p.stop();
  assert.deepEqual(calls, []);
  // already stopped — second call is no-op
  await p.stop({ withdrawPresence: true });
  assert.deepEqual(calls, []);
  // fresh provider for explicit withdraw
  const p2 = new UserComputerProvider({
    backendUrl: 'http://synthetic.invalid',
    machineId: 'synthetic',
    credential: 'synthetic-token',
    root,
    permission: 'ask',
    hello: {
      label: 't',
      localRoot: root,
      terminalsFolder: root + '/terminals',
      standing: 'ask',
      supervised: true,
      variant: 't',
      serverAuthoritative: false,
    },
  });
  p2.channel = { backendUrl: 'http://synthetic.invalid', machineId: 'synthetic', credential: 'synthetic-token' };
  p2.client = {
    withdrawGrokBotUserComputerPresence: async (req) => { calls.push(req); return {}; },
  };
  p2.replies = { drain: async () => true, stop() {} };
  await p2.stop({ withdrawPresence: true });
  assert.equal(calls.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});


test('cadence is completion +2000ms, not start+2000; blocked tick and repeated pokes never overlap', async () => {
  const h = await harness();
  const gate = defer(); let reads = 0;
  h.setLoader(async () => { reads++; if (reads === 1) await gate.promise; return ch(false, 'synthetic-next'); });
  h.requestUcRefresh(); await tick();
  assert.equal(reads, 1);
  await h.advance(7000);
  assert.equal(reads, 1, 'no elapsed cadence timer can overlap a blocked tick');
  for (let i=0;i<20;i++) h.requestUcRefresh();
  gate.resolve(); await h.awaitUcRefresh();
  const completedReads = reads;
  assert.equal(completedReads, 4, 'two serial ticks, each refresh read + rehello read');
  await h.advance(1999); assert.equal(reads, completedReads);
  await h.advance(1); await h.awaitUcRefresh(); assert.equal(reads, completedReads+2);
});

test('shutdown disposes cadence and waits for tick + publish before exit', async () => {
  const h = await harness(); const publish=defer();
  h.setPublisher(() => publish.promise);
  h.requestUcRefresh(); await tick();
  h.shutdown('synthetic'); await tick();
  assert.equal(h.events.includes('exit'), false);
  publish.resolve(); await h.awaitUcRefresh(); await tick();
  assert.equal(h.events.includes('exit'), true);
  const n=h.instances.length; await h.advance(20000); assert.equal(h.instances.length,n);
  assert.equal(h.getUc().lastStopOpts.withdrawPresence,true);
});

test('removed credential scope closes provider without withdraw', async () => {
  const h=await harness(); h.setLoader(async()=>null);
  h.requestUcRefresh(); await h.awaitUcRefresh();
  assert.equal(h.getUc(),undefined); assert.equal(h.instances[0].stopped,true);
  assert.notEqual(h.instances[0].lastStopOpts.withdrawPresence,true);
});


test('standing publication cannot overwrite discovery owned by another live PID (D:L179202–179207)',async()=>{
 const h=await harness();let writes=0;h.setPublisher(async()=>{writes++});h.setDiscovery({pid:456});
 h.requestUcRefresh();await h.awaitUcRefresh();await h.advance(6000);await h.awaitUcRefresh();
 assert.equal(writes,0,'re-hello publications must preserve the superseding owner record');
 h.setDiscovery({pid:789});h.requestUcRefresh();await h.awaitUcRefresh();assert.equal(writes,1,'dead PID does not fence publication');
});
