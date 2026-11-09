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
    '    globalThis.audit = { publish, requestOwnershipTick, awaitOwnershipTick: async () => { await ownershipTask; }, setInflight: value => { inflightCount = value; }, setSuperseded: value => { supersededSinceMs = value; }, refreshUc, requestUcRefresh, shutdown, getUc: () => uc, awaitUcRefresh: async () => { await ucRefresh; } };\n' + point,
  )
  .replace('main().catch(error => (0, handoff_1.exitFatal)(error));', 'module.exports = main;'); // t160: fatal now reports xt(e)
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

async function harness(sa = false, hooks = {}) {
  const instances = [];
  const events = [];
  let channel = sa === null ? null : ch(sa);
  let loader = async () => channel;
  let publisher = hooks.publisher ?? (async () => {});
  let shellStop = async () => {};
  let discovery = { pid: 123 };
  let supervised = async () => true;
  const traces = [];
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
    noteBackendReturn() { events.push('provider:backend-return'); }
    noteNetworkChange() { events.push('provider:network-change'); }
    async rehelloIfChanged() { this.updated = await this.opts.resolveChannel(); }
  }
  const boxes = [];
  const written = [];
  const mods = {
    './trace': { lifecycleTrace(ev, info) { traces.push({ev, at: now, ...info}); } },
    './exec/handlers': { shutdownShells: () => shellStop() },
    './util': {
      dataRootFromEnv: () => '/tmp/synthetic-only',
      localRootFromEnv: () => '/tmp/synthetic-only',
      logInfo: message => { hooks.onLog?.(message); },
      delay: async () => {},
      readJsonIfExists: async () => null,
    },
    './bootstrap/handoff': {
      awaitHandoff: async () => ({ ok: true, handoff: { key: 'synthetic-key', computerId: 'synthetic-computer' } }),
      exitFatal: () => { throw new Error('unexpected exitFatal'); },
    },
    './settings': { loadSettings: async () => ({ permission: 'ask' }) },
    './state/discovery': {
      publishDiscovery: rec => publisher(rec),
      clearDiscovery: async () => {},
      isSupervised: () => supervised(),
      loadDiscovery: async () => hooks.readDiscovery ? hooks.readDiscovery() : discovery,
    },
    './state/connection': { loadConnection: async () => null, writeConnection: async (c, k) => { written.push({ c, k }); } },
    // t159: the original always constructs and starts the Box provider (D:Te 179316–179331); this fake never dials.
    './box/provider': { BoxProvider: class { constructor(opts) { this.opts = opts; boxes.push(this); } async start() {} redial() {} wakeFromReconnectBackoff() {} async stop() {} beginShutdown() {} } },
    './state/connection-exchange': require('../dist/state/connection-exchange'),
    './uc/local-tools': { createDeviceTools: () => ({ announced: () => [], offers: () => false }) },
    // t162: Rt (D:179463) runs He (backend-return marker) and ut (network fingerprint) before Ve each standing tick.
    './state/standing-signals': { createStandingSignals: o => ({
      backendReturn: async notify => { events.push('signal:backend-return'); if (hooks.backendReturned?.()) notify(); },
      networkChange: notify => { events.push('signal:network'); if (hooks.networkChanged?.()) notify(); },
      startedAt: o.startedAt,
    }) },
    './uc/provider': { UserComputerProvider: FakeProvider },
    // t154: index captures CLAUDE_CONFIG_DIR/CODEX_HOME once at start (D:187322–187325).
    './uc/ai-tool-discovery': { aiToolConfigDirsFromEnv: () => ({}) },
    // t158: UC hello capabilities consult the sidecar lookup (D:y5 84695); absent on Linux.
    './box/messages-op': { locateSidecar: () => undefined },
    './uc/credential': {
      loadSealedCredential: async () => {
        const value = await loader();
        return value?.machineId ? { backendUrl: value.backendUrl, userComputer: value } : value;
      },
      pickUserComputerChannel: (v) => v.userComputer ? { ...v.userComputer, backendUrl: v.backendUrl } : v,
    },
    './state/lease': { generationFromEnv: () => undefined, pidAlive: pid => pid === 456, loadLease: async () => null, ownershipDecision: args => require('../dist/state/lease').ownershipDecision(args) },
    'node:os': { hostname: () => 'synthetic' },
    'node:path': require('node:path'),
  };
  let now = 0;
  const timers = [];
  const intervals = [];
  const ctx = {
    module: { exports: {} },
    exports: {},
    require: (k) => {
      if (!(k in mods)) throw new Error('unmocked module ' + k);
      return mods[k];
    },
    process: { pid: 123, env: {}, on: () => {}, exit: () => events.push('exit') },
    console,
    Date: class extends Date { static now() { return now; } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    setTimeout: (fn, ms) => { const timer = { fn, at: now + ms, cancelled: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
  };
  vm.runInNewContext(code, ctx, { filename: 'index-under-lifecycle-test.js' });
  await ctx.module.exports();
  await ctx.audit.awaitUcRefresh();
  await tick();
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
    ownershipTick: async () => { ctx.audit.requestOwnershipTick(); await ctx.audit.awaitOwnershipTick(); await tick(); },
    traces, intervals, setSupervised: fn => { supervised = fn; },
    now: () => now,
    timerCount: () => timers.filter(t => !t.cancelled).length,
    instances,
    boxes,
    written,
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


// t137u: fixed-expectation scheduling gates. These establish mechanisms, not the historical timeout's cause.
test('C/T: twenty requests during one blocked write coalesce into one follow-up with the latest state',async()=>{
 const h=await harness(),entered=defer(),gate=defer();let writes=0;const snapshots=[];
 h.setPublisher(async rec=>{snapshots.push(rec.inflightCount);if(++writes===1){entered.resolve();await gate.promise}});
 const first=h.publish();await entered.promise;h.setInflight(7);const pokes=Array.from({length:20},()=>h.publish());
 gate.resolve();await first;await Promise.all(pokes);
 assert.equal(writes,2,'one running write plus one coalesced follow-up, not a per-request chain');
 assert.deepEqual(snapshots,[0,7],'follow-up captures current state');
});

test('C/T: a busy publish caller returns immediately, but shutdown still awaits the tracked running publication',async()=>{
 const h=await harness(),entered=defer(),gate=defer();let writes=0;
 h.setPublisher(async()=>{writes++;entered.resolve();await gate.promise});
 const first=h.publish();await entered.promise;let busyReturned=false;const poke=h.publish().then(()=>busyReturned=true);await tick();const returnedBeforeRelease=busyReturned;
 h.shutdown('synthetic');await tick();assert.equal(h.events.includes('exit'),false);
 gate.resolve();await first;await poke;await tick();assert.equal(h.events.includes('exit'),true);assert.equal(writes,1);
 assert.equal(returnedBeforeRelease,true,'busy C returns; close must wait T separately');
});

test('C/T: observed superseded latch blocks publication even if discovery changes back before the next ownership tick',async()=>{
 const h=await harness();let writes=0;h.setPublisher(async()=>{writes++});h.setDiscovery({pid:123});h.setSuperseded(10);
 await h.publish();assert.equal(writes,0,'D:L179207 A guard must precede the fresh read');
 h.setSuperseded(undefined);await h.publish();assert.equal(writes,1);
});

test('C/T: a failed write releases the batch and still processes a pending follow-up',async()=>{
 const h=await harness(),entered=defer(),gate=defer();let writes=0;
 h.setPublisher(async()=>{if(++writes===1){entered.resolve();await gate.promise;throw Error('synthetic EIO')}});
 const first=h.publish();await entered.promise;const pokes=Array.from({length:3},()=>h.publish());gate.resolve();await first;await Promise.all(pokes);
 assert.equal(writes,2);await h.publish();assert.equal(writes,3,'running flag and tracked promise must be released after failure');
});

test('ready: discovery visible while initial publication is unfinished is not started; a live replacement is preserved',async()=>{
 const entered=defer(),gate=defer();let owner=null,started=false,writes=0;
 const boot=harness(false,{readDiscovery:()=>owner,publisher:async rec=>{writes++;owner={pid:rec.pid};entered.resolve();await gate.promise},onLog:message=>{if(/started \(pid /.test(message))started=true}});
 await entered.promise;assert.equal(owner.pid,123);assert.equal(started,false,'visible discovery alone is not readiness');owner={pid:456};gate.resolve();const h=await boot;
 assert.equal(started,true);assert.equal(owner.pid,456);assert.equal(writes,1);assert.equal(h.instances.length,1);
});

test('ready: started does not promise publisher quiescence; a leading standing write may be in flight',async()=>{
 const entered=defer(),gate=defer();let started=false,writes=0;
 const boot=harness(false,{publisher:async()=>{if(++writes===3){entered.resolve();await gate.promise}},onLog:message=>{if(/started \(pid /.test(message))started=true}});
 await entered.promise;assert.equal(started,true,'leading policy tick may overlap external observation of started');gate.resolve();await boot;
});

test('guard/rename: preserve the original non-CAS window; an already-started write may replace a later live owner',async()=>{
 const h=await harness(),entered=defer(),gate=defer();let writes=0,owner=123;
 h.setPublisher(async()=>{writes++;entered.resolve();await gate.promise;owner=123;h.setDiscovery({pid:123})});
 const first=h.publish();await entered.promise;owner=456;h.setDiscovery({pid:456});gate.resolve();await first;
 assert.equal(owner,123,'do not invent an after-read CAS or change original ownership policy');assert.equal(writes,1);
});

test('PID/exit: real synthetic child is alive until exit; signal exit is distinguishable from clean exit',async()=>{
 const cp=require('node:child_process'),{once}=require('node:events');const {pidAlive}=require('../dist/state/lease');
 assert.equal(pidAlive(process.pid),true);
 const child=cp.spawn(process.execPath,['-e',"process.send('ready');process.on('message',()=>process.exit(0));"],{stdio:['ignore','ignore','ignore','ipc']});
 const ended=once(child,'exit');await once(child,'message');assert.equal(pidAlive(child.pid),true);child.send('stop');const [code,signal]=await ended;
 assert.equal(code,0);assert.equal(signal,null);assert.equal(child.exitCode,0);assert.equal(pidAlive(child.pid),false);
 const signalled=cp.spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000);"],{stdio:['ignore','ignore','ignore','ipc']});
 const signalExit=once(signalled,'exit');await once(signalled,'message');signalled.kill('SIGTERM');const [badCode,badSignal]=await signalExit;
 assert.equal(badCode,null);assert.equal(badSignal,'SIGTERM');assert.notEqual(signalled.exitCode,0,'fixture exitPromise must not mistake a signal for clean superseded exit');
});


test('ownership clears A before republishing a dead owner, after retaining it for a live owner with inflight work',async()=>{
 const h=await harness();let writes=0;h.setPublisher(async()=>{writes++});h.setInflight(1);h.setDiscovery({pid:456});
 await h.ownershipTick();assert.equal(h.events.includes('exit'),false);await h.publish();assert.equal(writes,0);
 h.setDiscovery({pid:789});await h.ownershipTick();assert.equal(writes,1,'D:L179502 clears A before C, not after awaiting it');assert.equal(h.events.includes('exit'),false);
});

test('post-ready overwrite schedule can avoid superseded exit across ten ownership ticks; not a captured historical cause',async()=>{
 const entered=defer(),gate=defer();let owner=null,writes=0,started=false;
 const boot=harness(false,{readDiscovery:()=>owner,publisher:async rec=>{if(++writes===3){entered.resolve();await gate.promise}owner={pid:rec.pid}},onLog:message=>{if(/started \(pid /.test(message))started=true}});
 await entered.promise;assert.equal(started,true);owner={pid:456};gate.resolve();const h=await boot;assert.equal(owner.pid,123);
 for(let i=0;i<10;i++)await h.ownershipTick();assert.equal(h.events.includes('exit'),false);
 // Original policy exits once it actually observes a live replacement and no work; no timeout/assertion relaxation.
 owner={pid:456};await h.ownershipTick();assert.equal(h.events.includes('exit'),true);
});


test('policy registration: standing leads before ownership, both before ready; no ownership setInterval',async()=>{
 const h=await harness();const names=h.traces.map(t=>t.ev);
 assert.ok(names.indexOf('standing:begin')<names.indexOf('ownership:begin'));
 assert.ok(names.indexOf('ownership:begin')<names.indexOf('startup:ready'));
 assert.deepEqual(h.intervals.map(t=>t.ms),[1000],'only existing Box retry uses setInterval');
});

test('independent clocks: leading ownership then completion+10000; standing leads then completion+2000',async()=>{
 const h=await harness();const times=ev=>h.traces.filter(t=>t.ev===ev).map(t=>t.at);
 assert.deepEqual(times('ownership:begin'),[0]);assert.deepEqual(times('standing:begin'),[0,0]);
 await h.advance(1999);assert.deepEqual(times('standing:begin'),[0,0]);
 await h.advance(1);assert.deepEqual(times('standing:begin'),[0,0,2000]);assert.deepEqual(times('ownership:begin'),[0]);
 await h.advance(7999);assert.deepEqual(times('ownership:begin'),[0]);
 await h.advance(1);assert.deepEqual(times('ownership:begin'),[0,10000]);assert.deepEqual(times('standing:begin'),[0,0,2000,4000,6000,8000,10000]);
});

test('gated ownership: no overlapping tick; coalesced follow-up; cadence anchored to completion, standing unaffected',async()=>{
 const h=await harness(),gate=defer();let reads=0;
 h.setSupervised(async()=>{if(++reads===1)await gate.promise;return true});
 h.requestOwnershipTick();await tick();for(let i=0;i<20;i++)h.requestOwnershipTick();
 await h.advance(25000);assert.equal(reads,1);assert.ok(h.traces.filter(t=>t.ev==='standing:begin').length>=13);
 gate.resolve();await h.awaitOwnershipTick();assert.equal(reads,2,'one running + one follow-up');
 await h.advance(9999);assert.equal(reads,2);await h.advance(1);assert.equal(reads,3);
 assert.equal(h.traces.filter(t=>t.ev==='ownership:begin').at(-1).at,35000);
});

test('gated standing read cannot defer independent ownership cadence',async()=>{
 const h=await harness(),gate=defer();h.setLoader(()=>gate.promise);h.requestUcRefresh();await tick();
 await h.advance(20000);assert.deepEqual(h.traces.filter(t=>t.ev==='ownership:begin').map(t=>t.at),[0,10000,20000]);
 gate.resolve(ch(false));await h.awaitUcRefresh();await h.advance(1999);
 const n=h.traces.filter(t=>t.ev==='standing:begin').length;await h.advance(1);assert.equal(h.traces.filter(t=>t.ev==='standing:begin').length,n+1);
});

test('shutdown disposes independent ownership schedule even when an ownership read settles later',async()=>{
 const h=await harness(),gate=defer();let reads=0;h.setSupervised(async()=>{reads++;await gate.promise;return true});
 h.requestOwnershipTick();await tick();h.shutdown('synthetic');await tick();gate.resolve();await h.awaitOwnershipTick();
 const before=h.traces.filter(t=>t.ev==='ownership:begin').length;await h.advance(30000);
 assert.equal(reads,1);assert.equal(h.traces.filter(t=>t.ev==='ownership:begin').length,before);assert.equal(h.timerCount(),0);
});

// ---- t159: Box always runs; resolveConnection / onConnectionStale (ge) / onLoopEvent wiring (D:179262–179331, 179404–179412)
const http159 = require('node:http');
async function fakeExchange(handler) {
  const seen = [];
  const server = http159.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: b }); handler(req, res); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

test('t159 Box is constructed at startup with resolveConnection/resolveResponseConnection/onConnectionStale; variant = HPe(boxNamespace)', async () => {
  const h = await harness(false);
  assert.equal(h.boxes.length, 1);
  const o = h.boxes[0].opts;
  assert.equal(o.connection, undefined);
  assert.equal(o.variant, 'sand-dev');
  assert.equal(typeof o.onConnectionStale, 'function');
  // a live UC channel keeps the Box dial idle (C9r); responses still resolve via `we` (P9r when no file)
  await assert.rejects(o.resolveConnection(), e => e.name === 'SandLocalExecConnectionError' && /box dial stays idle/.test(e.message));
  await assert.rejects(o.resolveResponseConnection(), e => e.name === 'SandLocalExecConnectionError' && /no gateway connection yet/.test(e.message));
  h.setChannel(null);
  await assert.rejects(o.resolveConnection(), e => /no gateway connection yet/.test(e.message));
});

test('t159 ge: exchange runs only with a top-level credential and no serving UC channel; result written with the IPC key', async () => {
  const srv = await fakeExchange((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ baseUrl: 'http://gw.synthetic', token: 'synthetic-gw', gatewayPortToken: 'synthetic-port' })); });
  try {
    const h = await harness(false);
    const stale = h.boxes[0].opts.onConnectionStale;
    // UC channel present (not refused) → X() true → no exchange
    h.setLoader(async () => ({ backendUrl: srv.url, credential: 'synthetic-box', userComputer: ch(false) }));
    await stale();
    assert.equal(srv.seen.length, 0);
    // no top-level credential → no exchange
    h.setLoader(async () => ({ backendUrl: srv.url, userComputers: [] }));
    await stale();
    assert.equal(srv.seen.length, 0);
    // credential only → POST, then vLe(connection, key)
    h.setLoader(async () => ({ backendUrl: srv.url, credential: 'synthetic-box' }));
    await stale();
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].url, '/sand-box/local-exec-connection');
    assert.deepEqual(JSON.parse(srv.seen[0].body), { credential: 'synthetic-box' });
    assert.equal(h.written.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.written[0].c)), { baseUrl: 'http://gw.synthetic', token: 'synthetic-gw', headers: { 'x-anyrun-port-token': 'synthetic-port' } });
    assert.equal(h.written[0].k, 'synthetic-key');
  } finally { await srv.close(); }
});

test('t159 ge: unavailable exchange logs the original text and writes nothing', async () => {
  const srv = await fakeExchange((req, res) => { res.writeHead(503); res.end(); });
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    const h = await harness(null);
    h.setLoader(async () => ({ backendUrl: srv.url, credential: 'synthetic-box' }));
    await h.boxes[0].opts.onConnectionStale();
    assert.ok(logs.includes('[local-exec-daemon] connection exchange unavailable (status): http_503'), logs.join('\n'));
    assert.equal(h.written.length, 0);
  } finally { console.error = orig; await srv.close(); }
});

test('t159 onLoopEvent: unauthorized adds the scope (Box may dial, discovery lists it); connected removes it and redials', async () => {
  const published = [];
  const h = await harness(false, { publisher: async rec => { published.push(rec); } });
  const box = h.boxes[0]; let wakes = 0, redials = 0;
  box.wakeFromReconnectBackoff = () => { wakes++; }; box.redial = () => { redials++; };
  const ev = h.instances[0].opts.onLoopEvent;
  ev({ kind: 'disconnected', reason: 'unauthorized' });
  assert.equal(wakes, 1);
  await tick(); await tick();
  assert.deepEqual([...published.at(-1).rejectedAccountScopes], ['synthetic-scope']); // vm-realm array → copy
  await assert.rejects(box.opts.resolveConnection(), e => /no gateway connection yet/.test(e.message)); // X() false now
  ev({ kind: 'connected' });
  assert.equal(redials, 1);
  await tick(); await tick();
  assert.equal(published.at(-1).rejectedAccountScopes, undefined);
  ev({ kind: 'channel-missing' });
  assert.equal(wakes, 2);
});

test('t160 index passes no hello capabilities; the provider builds them on every Watch (D:hello 178137–178175)', async () => {
  const h = await harness(false);
  assert.equal(h.instances[0].opts.hello.capabilities, undefined);
});

test('t160 servingAt starts at startedAt (m = p) and every completed standing tick sets it to now (Rt m = l(), D:179478)', async () => {
  const recs = [];
  const h = await harness(false, { publisher: async rec => { recs.push(rec); } });
  assert.ok(recs.length > 0);
  assert.equal(recs[0].servingAt, recs[0].startedAt);
  await h.advance(4100);
  const last = recs.at(-1);
  assert.ok(last.servingAt > last.startedAt, JSON.stringify(recs.map(r => r.servingAt)));
  assert.ok(last.servingAt <= h.now());
});

test('t162 standing tick (Rt D:179462–179463): backend-return marker, then network fingerprint, then credential/Ve; changes reach the UC provider', async () => {
  let ret = false, net = false;
  const h = await harness(false, { backendReturned: () => ret, networkChanged: () => net });
  const ev = h.events;
  const first = ev.indexOf('signal:backend-return');
  assert.ok(first >= 0, ev.join(','));
  assert.equal(ev[first + 1], 'signal:network');
  assert.ok(!ev.includes('provider:backend-return') && !ev.includes('provider:network-change'));
  ret = true; net = true; const n = ev.length;
  await h.advance(2100);
  const tail = ev.slice(n);
  assert.ok(tail.indexOf('provider:backend-return') >= 0 && tail.indexOf('provider:backend-return') < tail.indexOf('provider:network-change'), tail.join(','));
});
