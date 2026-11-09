// t168 gated drop-in checks (DROPIN_ACCEPTANCE=1): Box heartbeat cadence, discoverAiTool (UC + Box), putFileToUrl /
// getFileFromUrl, mb headers in non-dev envs, OS-level network change (unprivileged user+net namespace), and optionally
// the same lifecycle under a PUBLIC Electron build (DROPIN_ELECTRON=<path to electron from npm>; never the App's binary).
// Launches OUR dist/index.js only; synthetic HOME/credentials/backends. Matrix: docs/local-exec/dropin-acceptance.md.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { startBackend, startBox } = require('./helpers/dropin-backend.cjs');
const { launch, until, delay, MACHINE } = require('./helpers/dropin-launch.cjs');
const F = require('./helpers/ai-tool-fixture.cjs');
const pb = require('../dist/generated/aiserver.v1_pb');

const ENABLED = process.env.DROPIN_ACCEPTANCE === '1';
const NETNS_CHILD = process.env.DROPIN_NETNS_CHILD === '1';
const SKIP = !ENABLED && 'set DROPIN_ACCEPTANCE=1';
const UC_CRED = 'synthetic-uc-cred-x', BOX_CRED = 'synthetic-box-cred-x', SCOPE = 'synthetic:scope-x';
const EVID = process.env.DROPIN_EVIDENCE_DIR;
const save = (name, obj) => { if (EVID) { fs.mkdirSync(EVID, { recursive: true }); fs.writeFileSync(path.join(EVID, name), JSON.stringify(obj, null, 1)); } };
const UA = (os_, v) => `Mozilla/5.0 ${os_} AppleWebKit/537.36 (KHTML, like Gecko) Sand/${v} Safari/537.36`;
const mbExpected = (v, ns) => [['user-agent', UA('(X11; Linux x86_64)', v)], ['x-cursor-client-type', 'sand'], ['x-cursor-client-version', v],
  ['x-sand-box-namespace', ns], ['x-cursor-client-os', 'linux'], ['x-cursor-client-source', 'sand-desktop']];
const pick = (raw, names) => raw.filter(([k]) => names.has(k));

async function ucDaemon(t, o = {}) {
  const backend = startBackend({ credential: UC_CRED, machineId: MACHINE }); await backend.listen();
  const d = launch({ settings: o.settings, prepareHome: o.prepareHome, env: { SAND_BACKEND_URL: backend.url, ...o.env }, execPath: o.execPath,
    credential: { backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: false }] } });
  t.after(async () => { await d.stop(); await backend.close(); d.cleanup(); });
  await until(() => backend.log.some(x => x.kind === 'event' && x.case === 'connected'), 10000, 'uc connected');
  await until(() => backend.log.some(x => x.kind === 'poll'), 5000, 'connected poll');
  return { backend, d };
}

// ---------- 1. network change inside an unprivileged user+network namespace ----------
async function netnsScenario() {
  const sh = c => cp.execSync(c, { stdio: 'pipe' }).toString();
  sh('ip link set lo up');
  const t = { after: f => cleanups.push(f) }; const cleanups = [];
  try {
    const { backend, d } = await ucDaemon(t);
    // keep every Watch audibly alive (heartbeat(0) kicks the 15 s silence watchdog, D:178381, without a Poll) so only
    // network changes can end it
    const hb = setInterval(() => backend.heartbeat(0), 4000); cleanups.push(() => clearInterval(hb));
    await delay(4500); // ≥ 2 standing ticks (Rre 2 s) so the network fingerprint baseline (D9r) is taken
    const w0 = backend.state.watches.length, t0 = backend.now();
    sh('ip link add v0 type veth peer name v1 && ip link set v0 up && ip link set v1 up && ip addr add 10.77.0.1/24 dev v0');
    await until(() => backend.state.watches.length > w0, 6000, 'watch after change 1');
    const t1 = backend.state.watches[w0].t;
    await delay(3000);
    const t2c = backend.now(); sh('ip addr add 10.77.0.2/24 dev v0'); // inside the 30 s cooldown → deferred
    await delay(6000); const watchesAfter2 = backend.state.watches.length;
    await until(() => backend.state.watches.length > w0 + 1, 36000, 'deferred renewal');
    const t3 = backend.state.watches[w0 + 1].t;
    await delay(4000);
    const watchRaw = backend.raw.filter(r => r.url.endsWith('/WatchGrokBotUserComputerRequests'));
    const ends = backend.log.filter(x => x.kind === 'watch-end' && x.t >= t0).map(x => x.t);
    return { ok: true, changeAt: t0, firstRewatchMs: t1 - t0, secondChangeAt: t2c, watchesSoonAfterSecondChange: watchesAfter2 - w0, deferredRewatchMsAfterFirst: t3 - t1,
      watchEnds: ends, watchPorts: watchRaw.map(r => r.port), extraWatches: backend.state.watches.length - w0, renewedLogLines: (d.log().match(/renewed on a new connection after a network change/g) ?? []).length,
      log: d.log().slice(-2000) };
  } finally { for (const f of cleanups.reverse()) await f(); }
}
if (NETNS_CHILD) {
  test('netns child', { timeout: 90000 }, async () => { const r = await netnsScenario(); process.stdout.write('\nNETNS_RESULT ' + JSON.stringify(r) + '\n'); });
} else {
  test('network-change: real interface change in `unshare -rn` → Watch renewed now, second change coalesced into the 30 s cooldown', { skip: SKIP, timeout: 120000 }, async () => {
    const env = { ...process.env, DROPIN_NETNS_CHILD: '1' }; delete env.NODE_TEST_CONTEXT;
    const r = cp.spawnSync('unshare', ['-rn', process.execPath, __filename], { env, encoding: 'utf8', timeout: 110000 });
    const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('NETNS_RESULT '));
    assert.ok(line, `netns child produced no result (status ${r.status}): ${(r.stdout ?? '').slice(-1500)} ${(r.stderr ?? '').slice(-800)}`);
    const res = JSON.parse(line.slice('NETNS_RESULT '.length)); save('netns.json', res);
    // Original: standing tick ut() (D:179445–179456, Rre 2 s) → noteNetworkChange (178295–178313): arm n9r 30 s cooldown,
    // renewRequested + abort → watch() → "network-change" (178361) → renew (pollAbort, renewConnection = new E9r client,
    // "renewed" event) → continue with NO sleep (178272–178275). A change inside the hold only sets networkChangeDeferred;
    // when the 30 s hold fires it re-runs noteNetworkChange → one more renewal.
    assert.ok(res.firstRewatchMs <= 2500 + 600, `first renewal ${res.firstRewatchMs} ms`);
    assert.equal(res.watchesSoonAfterSecondChange, 1, 'second change inside the cooldown does not renew immediately');
    assert.ok(Math.abs(res.deferredRewatchMsAfterFirst - 30000) <= 2600, `deferred renewal ${res.deferredRewatchMsAfterFirst} ms after the first`);
    assert.equal(res.extraWatches, 2);
    assert.equal(new Set(res.watchPorts.slice(-3)).size, 3, 'each renewal dials a fresh connection (new client/agent)');
    assert.equal(res.renewedLogLines, 2);
  });
}

// ---------- 2. Box heartbeat cadence ----------
test('Box heartbeat: ping right after hello, then 10 s after each tick completes; slow ping POSTs do not stretch it', { skip: SKIP || NETNS_CHILD, timeout: 60000 }, async t => {
  const box = startBox({ pingDelayMs: 3000 }); await box.listen();
  const d = launch({ credential: { backendUrl: 'http://127.0.0.1:9', credential: BOX_CRED }, connection: { baseUrl: box.url, token: 'synthetic-box-token' }, env: { SAND_BACKEND_URL: 'http://127.0.0.1:9' } });
  t.after(async () => { await d.stop(); await box.close(); d.cleanup(); });
  await until(() => box.frames('ping').length >= 4, 45000, '4 pings');
  const posts = box.posts.map(p => ({ t: p.t, kinds: p.frames.map(f => f.kind) }));
  const hello = posts.find(p => p.kinds.includes('hello')).t, pings = posts.filter(p => p.kinds.includes('ping')).map(p => p.t);
  const gaps = pings.slice(1).map((x, i) => x - pings[i]);
  save('box-heartbeat.json', { posts, firstPingAfterHelloMs: pings[0] - hello, gaps });
  // Original: hello POST awaited, then heartbeat.start (D:137435) → first tick immediately; tick = currentSupervised +
  // fire-and-forget postBatch(ping) + dialedConnectionState; next tick CJe 10 s (97387) after completion (hc/yre 78435–78530).
  assert.ok(pings[0] - hello < 500, `first ping ${pings[0] - hello} ms after hello`);
  for (const g of gaps) assert.ok(g >= 9900 && g <= 10600, `gap ${g}`);
});

// ---------- 3+4. discoverAiTool and put/get-file-to/from-url on UC and Box ----------
test('discoverAiTool (UC + Box) output vs hand-derived original VJe result; putFileToUrl/getFileFromUrl', { skip: SKIP || NETNS_CHILD, timeout: 60000 }, async t => {
  const { backend, d } = await ucDaemon(t, { prepareHome: home => { F.buildClaude(home); F.buildCodex(home); } });
  const S = pb.GrokBotUserComputerDiscoverAiTool;
  backend.enqueue('q-ai1', 'ai-claude', { case: 'discoverAiTool', value: new S({ source: 'claude_code' }) });
  backend.enqueue('q-ai2', 'ai-codex', { case: 'discoverAiTool', value: new S({ source: 'codex' }) });
  backend.enqueue('q-ai3', 'ai-bad', { case: 'discoverAiTool', value: new S({ source: 'cursor' }) });
  backend.enqueue('q-put', 'put-1', { case: 'putFileToUrl', value: new pb.GrokBotUserComputerPutFileToUrl({}) });
  backend.enqueue('q-get', 'get-1', { case: 'getFileFromUrl', value: new pb.GrokBotUserComputerGetFileFromUrl({}) });
  backend.notify();
  await until(() => ['ai-claude', 'ai-codex', 'ai-bad', 'put-1', 'get-1'].every(id => backend.submitted(id).length), 8000, 'uc replies');
  const joinFile = id => Buffer.concat(backend.submitted(id).filter(f => f.case === 'file').map(f => Buffer.from(f.value.data ?? '', 'base64'))).toString('utf8');
  const uc = { claude: joinFile('ai-claude'), codex: joinFile('ai-codex'), bad: backend.submitted('ai-bad'), put: backend.submitted('put-1'), get: backend.submitted('get-1'),
    lastFlags: ['ai-claude', 'ai-codex'].map(id => backend.submitted(id).map(f => f.value.last ?? false)) };
  backend.notify(); await until(() => backend.state.queue.length === 0, 5000, 'acks').catch(() => {});
  save('discover-uc.json', uc);
  const Z2 = "This computer's local-exec daemon does not understand that request frame; update the desktop app.";
  assert.equal(uc.claude, JSON.stringify(F.EXPECTED_CLAUDE));
  assert.equal(uc.codex, JSON.stringify(F.EXPECTED_CODEX));
  assert.deepEqual(uc.lastFlags, [[true], [true]]);
  // w9r (D:178785–178793): invalid discover source → file-error z2; putFileToUrl/getFileFromUrl → v9r undefined → x9 throw z2.
  assert.deepEqual(uc.bad, [{ requestId: 'ai-bad', case: 'fileError', value: { error: Z2 } }]);
  for (const [id, fr] of [['put-1', uc.put], ['get-1', uc.get]]) {
    assert.equal(fr.length, 1); assert.equal(fr[0].case, 'control'); assert.deepEqual(JSON.parse(fr[0].value.messageJson), { throw: { error: Z2 } }, id);
  }
  assert.ok(['q-ai3', 'q-put', 'q-get'].every(id => backend.state.acked.has(id)), 'unsupported items are ACKed');

  // Box path: same fixture through a Box daemon (no UC credential).
  const box = startBox(); await box.listen();
  const bd = launch({ prepareHome: home => { F.buildClaude(home); }, credential: { backendUrl: 'http://127.0.0.1:9', credential: BOX_CRED }, connection: { baseUrl: box.url, token: 'synthetic-box-token' }, env: { SAND_BACKEND_URL: 'http://127.0.0.1:9' } });
  t.after(async () => { await bd.stop(); await box.close(); bd.cleanup(); });
  await until(() => box.connected() && box.frames('hello').length, 8000, 'box hello');
  box.send({ kind: 'discover-ai-tool', requestId: 'b-ai1', source: 'claude_code' });
  box.send({ kind: 'discover-ai-tool', requestId: 'b-ai2', source: 'codex' });
  box.send({ kind: 'discover-ai-tool', requestId: 'b-ai3', source: 'cursor' });
  box.send({ kind: 'put-file-to-url', requestId: 'b-put', url: 'http://127.0.0.1:9/x' });
  box.send({ kind: 'get-file-from-url', requestId: 'b-get', url: 'http://127.0.0.1:9/x' });
  box.send({ kind: 'download', requestId: 'b-sentinel', path: 'nope-does-not-exist.txt' });
  await until(() => box.reply('b-ai1').length && box.reply('b-ai2').length && box.reply('b-sentinel').length, 8000, 'box replies');
  await delay(500);
  const bx = { claude: Buffer.from(box.reply('b-ai1')[0].bytesBase64, 'base64').toString('utf8'), codex: box.reply('b-ai2'), bad: box.reply('b-ai3'), put: box.reply('b-put'), get: box.reply('b-get'), log: bd.log().slice(-1500) };
  save('discover-box.json', bx);
  assert.equal(bx.claude, JSON.stringify(F.EXPECTED_CLAUDE));
  assert.equal(Buffer.from(bx.codex[0].bytesBase64, 'base64').toString('utf8'), JSON.stringify(F.NOT_FOUND('codex')));
  // Box: rHt source enum(QP) → parse error → dropped (Mwr only answers messages-op) with a log line (D:137497–137521);
  // unknown kinds are ignored silently by Upe(t, nHt) (97455–97456).
  assert.deepEqual(bx.bad, []); assert.deepEqual(bx.put, []); assert.deepEqual(bx.get, []);
  assert.match(bx.log, /dropping unparseable request frame/);
});

// ---------- 5. mb headers in non-dev envs (UC Watch + connection exchange + hello variant) ----------
const ENVS = [
  // name, env, version (VPe), namespace (ese), hello variant HPe(ns) (D:79045 tse / 78973 ese / 78996 VPe / 78990 HPe)
  ['packaged', { SAND_PACKAGED: '1' }, '0.79.3', 'prod', 'sand'],
  ['lab', { SAND_PACKAGED: '1', SAND_LAB: '1' }, '0.79.3-lab', 'lab', 'sand-lab'],
  ['owner-dev', { SAND_PACKAGED: '1', SAND_BOX_OWNER_NAMESPACE: ' dev ' }, '0.79.3-dev', 'dev', 'sand-dev'],
  ['isolated', { SAND_ISOLATED_DEPLOYMENT: '1', SAND_CURSOR_WEBSITE_URL: 'http://127.0.0.1:9' }, '0.79.3-dev', 'prod', 'sand'],
  ['version-suffix', { SAND_PACKAGED: '1', SAND_CLIENT_APP_VERSION: ' 1.2.3-rc.1 ' }, '1.2.3', 'prod', 'sand'],
];
for (const [name, extra, v, ns, variant] of ENVS) {
  test(`mb headers e2e (${name}): exchange + UC Watch/Poll carry ${v}/${ns}; hellos say ${variant}`, { skip: SKIP || NETNS_CHILD, timeout: 40000 }, async t => {
    const backend = startBackend({ credential: UC_CRED, machineId: MACHINE }); await backend.listen();
    const box = startBox(); await box.listen();
    backend.exchange.reply = { status: 200, body: { baseUrl: box.url, token: 'synthetic-box-token', networkToken: '' } };
    // no connection file → resolveConnection throws → 3 failures (Cwr) → exchange (D:137344–137360, ge 179267)
    const d = launch({ env: { SAND_BACKEND_URL: backend.url, ...extra }, credential: { backendUrl: backend.url, credential: BOX_CRED } });
    t.after(async () => { await d.stop(); await backend.close(); await box.close(); d.cleanup(); });
    await until(() => box.frames('hello').length, 15000, 'box hello after exchange');
    d.writeCred({ backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: false }] });
    await until(() => backend.log.some(x => x.kind === 'poll'), 10000, 'uc poll');
    const MB = mbExpected(v, ns), names = new Set(MB.map(([k]) => k));
    const ex = backend.raw.find(r => r.url === '/sand-box/local-exec-connection');
    const uc = backend.raw.filter(r => r.url.startsWith('/aiserver.v1.GrokBotService/'));
    const sorted = [...MB].sort(([a], [b]) => a < b ? -1 : 1);
    const res = { exchange: ex && pick(ex.headers, new Set(['content-type', ...names])), uc: uc.map(r => ({ url: r.url, h: pick(r.headers, names) })),
      boxHelloVariant: box.frames('hello')[0].variant, ucHelloVariant: backend.state.watches[0].hello.variant };
    save(`mb-${name}.json`, res);
    assert.deepEqual(res.exchange, [['content-type', 'application/json'], ...MB]);
    assert.ok(uc.length >= 2); for (const r of res.uc) assert.deepEqual(r.h, sorted, r.url);
    assert.equal(res.boxHelloVariant, variant); assert.equal(res.ucHelloVariant, variant);
  });
}

// ---------- 6. public Electron (same version as the App ships) as the runtime ----------
const ELECTRON = process.env.DROPIN_ELECTRON;
test('undici default headers: plain Node vs public Electron (ELECTRON_RUN_AS_NODE=1 and utilityProcess.fork via xvfb) running OUR dist', { skip: SKIP || NETNS_CHILD || (!ELECTRON && 'set DROPIN_ELECTRON=<public electron binary>'), timeout: 60000 }, async t => {
  const runs = {};
  const XVFB = ['/usr/bin/xvfb-run', '/usr/local/bin/xvfb-run'].find(f => fs.existsSync(f));
  const host = path.join(__dirname, 'helpers', 'electron-utility-host.cjs');
  const variants = [['node', process.execPath, {}], ['electron-run-as-node', ELECTRON, { ELECTRON_RUN_AS_NODE: '1' }]];
  // utilityProcess.fork (the App's real launch shape) needs a display: headless via xvfb-run when present.
  if (XVFB) variants.push(['electron-utility-process', XVFB, {}, e => ['-a', ELECTRON, '--no-sandbox', host, e]]);
  for (const [label, execPath, env, argsFor] of variants) {
    const backend = startBackend({ credential: UC_CRED, machineId: MACHINE }); await backend.listen();
    const box = startBox(); await box.listen();
    backend.exchange.reply = { status: 200, body: { baseUrl: box.url, token: 'synthetic-box-token', networkToken: 'synthetic-net' } };
    const d = launch({ execPath, argsFor, env: { SAND_BACKEND_URL: backend.url, ...env }, credential: { backendUrl: backend.url, credential: BOX_CRED } });
    try {
      await until(() => box.frames('ping').length, 15000, `${label}: box ping\n${d.log()}`);
      d.writeCred({ backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: false }] });
      await until(() => backend.log.some(x => x.kind === 'poll'), 10000, `${label}: uc poll`);
      const strip = h => h.filter(([k]) => k !== 'host' && k !== 'content-length');
      runs[label] = { versions: null, exchange: strip(backend.raw.find(r => r.url === '/sand-box/local-exec-connection').headers),
        boxGet: strip(box.gets[0].raw), boxPost: strip(box.posts[0].raw), ucWatch: strip(backend.raw.find(r => r.url.endsWith('/WatchGrokBotUserComputerRequests')).headers) };
    } finally { await d.stop(); await backend.close(); await box.close(); d.cleanup(); }
  }
  runs.electronVersions = cp.execFileSync(ELECTRON, ['-e', 'process.stdout.write(JSON.stringify(process.versions))'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).toString();
  runs.nodeVersion = process.version;
  save('electron-headers.json', runs);
  for (const v of variants.slice(1)) for (const k of ['exchange', 'boxGet', 'boxPost', 'ucWatch']) assert.deepEqual(runs[v[0]][k], runs.node[k], `${v[0]} ${k}`);
});

// ---------- t168 found: SAND_NODE_PROXY_ENV (App system-proxy mode) ----------
test('SAND_NODE_PROXY_ENV: applied process-wide (http.setGlobalProxyFromEnv) → fetch/http traffic via the proxy; fingerprint in discovery', { skip: SKIP || NETNS_CHILD, timeout: 40000 }, async t => {
  const http = require('node:http'), crypto = require('node:crypto');
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  });
  // undici (fetch) tunnels even http:// targets with CONNECT; node:http agents send absolute-URI requests.
  proxy.on('connect', (req, sock, head) => {
    seen.push({ method: 'CONNECT', url: 'http://' + req.url + '/' });
    const [h, pt] = req.url.split(':'); const up = require('node:net').connect(+pt, h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r)); const purl = `http://127.0.0.1:${proxy.address().port}`;
  const backend = startBackend({ credential: UC_CRED, machineId: MACHINE }); await backend.listen();
  const box = startBox(); await box.listen();
  backend.exchange.reply = { status: 200, body: { baseUrl: box.url, token: 'synthetic-box-token', networkToken: '' } };
  const P = { HTTPS_PROXY: purl, HTTP_PROXY: purl, NO_PROXY: '' };
  const d = launch({ env: { SAND_BACKEND_URL: backend.url, SAND_NODE_PROXY_ENV: JSON.stringify(P) }, credential: { backendUrl: backend.url, credential: BOX_CRED } });
  t.after(async () => { await d.stop(); await backend.close(); await box.close(); proxy.closeAllConnections?.(); await new Promise(r => proxy.close(r)); d.cleanup(); });
  await until(() => box.frames('ping').length, 15000, 'box ping');
  d.writeCred({ backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: false }] });
  await until(() => backend.log.some(x => x.kind === 'poll'), 10000, 'uc poll');
  const disc = d.readDiscovery();
  const fp = crypto.createHash('sha256').update(JSON.stringify([P.HTTPS_PROXY, P.HTTP_PROXY, P.NO_PROXY])).digest('hex').slice(0, 16);
  const bh = new URL(box.url).host, kh = new URL(backend.url).host;
  const res = { proxied: seen.map(s => `${s.method} ${s.url}`), discoveryProxyFingerprint: disc?.proxyFingerprint, expectedFingerprint: fp,
    backendViaProxy: seen.some(s => new URL(s.url).host === kh), boxViaProxy: seen.some(s => new URL(s.url).host === bh),
    boxGetAbsoluteUri: seen.some(s => s.method === 'GET' && s.url.includes('/local-exec/requests')) };
  save('node-proxy.json', res);
  assert.equal(res.discoveryProxyFingerprint, fp);
  assert.ok(res.backendViaProxy && res.boxViaProxy, JSON.stringify(res));
  // t169 F6: the Box GET is a global fetch like the original (D:137396), so undici tunnels it (CONNECT) too.
  assert.equal(res.boxGetAbsoluteUri, false, JSON.stringify(res));
});
