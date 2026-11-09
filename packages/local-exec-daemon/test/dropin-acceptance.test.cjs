// t165 drop-in acceptance: launches OUR built daemon (dist/index.js) the way the App's spawn fallback L$e launches
// the original (scenario-matrix §1: spawn(process.execPath, entryArgv, {detached, stdio:["ignore",log,log,"ipc"]}) +
// send({type:"sand-local-exec-file-key", key, computerId}); env R$e = {...process.env, ...e.env, SAND_LOCAL_EXEC_GENERATION,
// NODE_USE_SYSTEM_CA:"1"} minus ELECTRON_RUN_AS_NODE; no argv) against synthetic fake peers: UC (generated Connect
// GrokBotService), Box JSON/SSE, and the plain-HTTP connection exchange. Synthetic credentials/HOME/config only.
// The official daemon is never executed. Matrix: docs/local-exec/dropin-acceptance.md.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { startBackend, startBox } = require('./helpers/dropin-backend.cjs');
const pb = require('../dist/generated/aiserver.v1_pb');
const { sealJson } = require('../dist/uc/sealed');
const { openMaybeSealed } = require('../dist/state/connection');

const ENABLED = process.env.DROPIN_ACCEPTANCE === '1';
const KEY = Buffer.alloc(32, 9).toString('base64'); // synthetic IPC file key
const MACHINE = 'synthetic-dropin-machine', UC_CRED = 'synthetic-uc-cred-1', UC_CRED2 = 'synthetic-uc-cred-2', BOX_CRED = 'synthetic-box-cred', SCOPE = 'synthetic:scope';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(f, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await f(); if (v) return v; await delay(20); } throw new Error('deadline: ' + what); }

test('drop-in acceptance: one realistic lifecycle of dist/index.js against synthetic UC/Box/exchange peers',
  { skip: !ENABLED && 'set DROPIN_ACCEPTANCE=1 (≈75 s, real 15 s silence + 2×10 s channelRetry + 1/2/4 s reconnect timers)', timeout: 240000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dropin-'));
  const home = path.join(base, 'home'), data = path.join(base, 'data'), root = path.join(base, 'root');
  for (const d of [home, data, root]) fs.mkdirSync(d, { recursive: true });
  const terminals = path.join(root, 'terminals');
  fs.writeFileSync(path.join(root, 'probe.txt'), 'dropin-download-fixture\n');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ version: 1, localToolPermission: 'ask', messagesEnabled: true }));
  fs.writeFileSync(path.join(data, 'local-exec-supervisor.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const nowMs = Date.now();
  const approval = (id, action, target, extra = {}) => ({ id, action, target, recordedAtMs: nowMs, ...extra });
  fs.writeFileSync(path.join(data, 'local-tool-approvals.json'), JSON.stringify({ approvals: [
    approval('ap-uc-exec', 'run-command', 'echo UC_LOCAL_APPROVED', { resourcePath: terminals }),
    approval('ap-uc-dl', 'read-file', 'probe.txt'),
    approval('ap-uc-up', 'write-file', 'uc-upload.txt'),
    approval('ap-uc-sleep', 'run-command', 'sleep 30', { resourcePath: terminals }),
    approval('ap-box-exec', 'run-command', 'echo BOX_OK', { resourcePath: terminals }),
    approval('ap-box-dl', 'read-file', 'probe.txt'),
    approval('ap-box-up', 'write-file', 'box-upload.txt'),
  ] }));
  const obs = []; const note = (step, ok, detail) => obs.push({ step, ok, detail });
  const backend = startBackend({ credential: UC_CRED, machineId: MACHINE }); await backend.listen();
  const box1 = startBox(), box2 = startBox(); await box1.listen(); await box2.listen();
  const credFile = path.join(data, 'local-exec-daemon-credential.json'), connFile = path.join(data, 'local-exec-daemon-connection.json');
  const writeCred = obj => fs.writeFileSync(credFile, sealJson(KEY, JSON.stringify(obj)));
  writeCred({ backendUrl: backend.url, credential: BOX_CRED });
  fs.writeFileSync(connFile, sealJson(KEY, JSON.stringify({ baseUrl: box1.url, token: 'synthetic-box-token-1' })));
  const logFile = path.join(base, 'daemon.log'); const logFd = fs.openSync(logFile, 'a');
  // R$e env; ELECTRON_RUN_AS_NODE removed; HOME and every data path synthetic.
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), SAND_DATA_ROOT: data, SAND_USER_DATA_DIR: data,
    SAND_LOCAL_EXEC_ROOT: root, SAND_BACKEND_URL: backend.url, SAND_CLIENT_APP_VERSION: '0.79.3',
    SAND_LOCAL_EXEC_GENERATION: '7', NODE_USE_SYSTEM_CA: '1' };
  const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], { env, cwd: base, detached: true, stdio: ['ignore', logFd, logFd, 'ipc'] });
  let exit = null; const exited = new Promise(r => child.on('exit', (code, signal) => { exit = { code, signal }; r(); }));
  t.after(async () => { if (exit === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } await Promise.race([exited, delay(2000)]); await backend.close(); await box1.close(); await box2.close();
    if (process.env.DROPIN_EVIDENCE_DIR) { fs.mkdirSync(process.env.DROPIN_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.DROPIN_EVIDENCE_DIR, 'observed.json'), JSON.stringify({ obs, backendLog: backend.log, box1: { gets: box1.gets.map(g => ({ t: g.t, status: g.status })), posts: box1.posts }, box2: { gets: box2.gets.map(g => ({ t: g.t, status: g.status })), posts: box2.posts }, exchange: backend.exchange.requests, raw: backend.raw.slice(0, 40), exit, daemonLog: fs.readFileSync(logFile, 'utf8').slice(-20000) }, null, 1)); }
    fs.rmSync(base, { recursive: true, force: true }); });
  const readDiscovery = () => { try { return JSON.parse(openMaybeSealed(fs.readFileSync(path.join(data, 'local-exec-daemon.json'), 'utf8'), KEY)); } catch { return null; } };

  // 1. handoff (D:awaitHandoff / cqr 187314–187348) — IPC message, no argv.
  child.send({ type: 'sand-local-exec-file-key', key: KEY, computerId: MACHINE });
  // 2. discovery publish (D:lgt C 179193–179239, CLe 80993)
  const disc = await until(readDiscovery, 8000, 'discovery');
  note('discovery', disc.pid === child.pid && disc.startedAt > 0, { keys: Object.keys(disc).sort(), sealed: fs.readFileSync(path.join(data, 'local-exec-daemon.json'), 'utf8').includes('sandSealedFile'), generation: disc.generation });

  // 3. Box channel (no UC channel yet): hello at connect, leading ping, requests.
  await until(() => box1.connected(), 8000, 'box connect');
  await until(() => box1.frames('hello').length && box1.frames('ping').length, 5000, 'box hello+ping');
  const bh = box1.frames('hello')[0];
  note('box-hello', true, { hello: bh, auth: box1.gets[0].headers.authorization ?? null, getHeaders: Object.keys(box1.gets[0].headers).sort() });
  box1.send({ kind: 'welcome', providerId: 'synthetic-provider' });
  box1.send({ kind: 'exec', requestId: 'box-exec-1', approvalId: 'ap-box-exec', serverMessage: { id: 41, shellStreamArgs: { command: 'echo BOX_OK', workingDirectory: '', timeout: 5000 } } });
  box1.send({ kind: 'download', requestId: 'box-dl-1', path: 'probe.txt', approvalId: 'ap-box-dl' });
  box1.send({ kind: 'upload', requestId: 'box-up-1', path: 'box-upload.txt', bytesBase64: Buffer.from('BOX_UPLOAD').toString('base64'), approvalId: 'ap-box-up' });
  box1.send({ kind: 'messages-op', requestId: 'box-msg-1', op: { kind: 'check-permissions' } });
  await until(() => box1.reply('box-exec-1').some(f => JSON.stringify(f).includes('streamClose')) && box1.reply('box-dl-1').length && box1.reply('box-up-1').length && box1.reply('box-msg-1').length, 8000, 'box replies');
  note('box-exec', JSON.stringify(box1.reply('box-exec-1')).includes('BOX_OK'), box1.reply('box-exec-1'));
  // t166: inner id from the Box executor's own counter (v_.nextExecId = 1, D:135935; o.id = a, D:136332–136333).
  note('box-exec-id', box1.reply('box-exec-1').every(f => (f.message.id ?? f.message.streamClose?.id) === 1), { ids: box1.reply('box-exec-1').map(f => f.message.id ?? f.message.streamClose?.id) });
  note('box-download', true, box1.reply('box-dl-1'));
  note('box-upload', fs.existsSync(path.join(root, 'box-upload.txt')), box1.reply('box-up-1'));
  note('box-messages-op', true, box1.reply('box-msg-1'));
  note('box-providerId', box1.posts.at(-1).providerId === 'synthetic-provider', { lastProviderId: box1.posts.at(-1).providerId });

  // 4. connection exchange after 3 consecutive Box failures (Cwr = 3, D:137183; ge 179267–179277; O9r 179117–179145)
  backend.exchange.reply = { status: 200, body: { baseUrl: box2.url, token: 'synthetic-box-token-2', networkToken: 'synthetic-net-token' } };
  const failStart = Date.now(); box1.setStatus(503);
  await until(() => box2.connected(), 20000, 'box redial after exchange');
  const conn = JSON.parse(openMaybeSealed(fs.readFileSync(connFile, 'utf8'), KEY));
  note('exchange', backend.exchange.requests.length === 1, { failedGets: box1.gets.filter(g => g.status !== 200).map(g => g.t), exchangeBody: backend.exchange.requests[0]?.body, exchangeHeaders: backend.exchange.requests[0]?.headers, conn, connSealed: fs.readFileSync(connFile, 'utf8').includes('sandSealedFile'), box2Auth: box2.gets[0]?.headers?.authorization, box2NetToken: box2.gets[0]?.headers?.['x-anyrun-network-token'], msToRedial: Date.now() - failStart });

  // 5. UC channel appears (non-SA, local approvals) → UC Watch; Box goes idle (D:X 179262, onLoopEvent 179404–179412)
  writeCred({ backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: false }] });
  await until(() => backend.log.some(x => x.kind === 'event' && x.case === 'connected'), 10000, 'uc connected');
  const w1 = backend.state.watches[0];
  note('uc-hello', true, { hello: w1.hello, headers: Object.keys(w1.headers).filter(k => k.startsWith('x-') || k === 'user-agent').sort().map(k => [k, w1.headers[k]]), presenceLen: w1.presenceToken.length });
  await until(() => box2.gets.length >= 1 && !box2.connected(), 8000, 'box idles for UC').catch(() => {});
  note('box-idle-for-uc', !box2.connected(), { box2Gets: box2.gets.length });

  // 6. UC requests: exec (local approval), download, upload, messages-op, localTool; heartbeat-triggered poll; ACKs.
  // The connected-triggered poll (D:178396) must land before the queue is filled, so the heartbeat gate is isolated.
  // t171: connected issues requestPoll and the per-Watch safety poll's leading tick back to back (D:178391–178395);
  // the second lands as a coalesced re-poll (D:178432–178450). Wait for both, and let the second settle, before filling
  // the queue, or it would drain the new items and race the heartbeat(0) snapshot below.
  await until(() => backend.log.filter(x => x.kind === 'poll').length >= 2, 5000, 'connected poll burst');
  await delay(300);
  const E = (sm, extra = {}) => ({ case: 'exec', value: new pb.GrokBotUserComputerExec({ serverMessageJson: JSON.stringify(sm), ...extra }) });
  backend.enqueue('q-exec', 'uc-exec-1', E({ id: 1, shellStreamArgs: { command: 'echo UC_LOCAL_APPROVED', workingDirectory: '', timeout: 5000 } }, { approvalId: 'ap-uc-exec', authorizedByApproval: true }));
  backend.enqueue('q-dl', 'uc-dl-1', { case: 'download', value: new pb.GrokBotUserComputerDownload({ path: 'probe.txt', approvalId: 'ap-uc-dl', authorizedByApproval: true }) });
  backend.enqueue('q-up', 'uc-up-1', { case: 'upload', value: new pb.GrokBotUserComputerUpload({ path: 'uc-upload.txt', data: Buffer.from('UC_UPLOAD'), authorizedByApproval: true, approvalId: 'ap-uc-up' }) });
  backend.enqueue('q-msg', 'uc-msg-1', { case: 'messagesOp', value: new pb.GrokBotUserComputerMessagesOp({ opJson: JSON.stringify({ kind: 'check-permissions' }) }) });
  backend.enqueue('q-lt', 'uc-lt-1', { case: 'localTool', value: new pb.GrokBotUserComputerLocalToolCall({ toolId: 'mac_read_obsidian', inputJson: '{}', conversationId: 'synthetic-conv' }) });
  const pollsBefore = backend.log.filter(x => x.kind === 'poll').length;
  backend.heartbeat(0); await delay(300);
  const pollsAfterHb0 = backend.log.filter(x => x.kind === 'poll').length;
  backend.heartbeat(5);
  await until(() => ['uc-exec-1', 'uc-dl-1', 'uc-up-1', 'uc-msg-1', 'uc-lt-1'].every(id => backend.submitted(id).length) && backend.submitted('uc-exec-1').some(f => JSON.stringify(f).includes('streamClose')), 10000, 'uc replies');
  backend.notify(); await until(() => backend.state.queue.length === 0, 5000, 'acks');
  note('uc-heartbeat-gate', pollsAfterHb0 === pollsBefore, { pollsBefore, pollsAfterHb0 });
  note('uc-acks', backend.state.acked.size === 5, { acked: [...backend.state.acked].sort() });
  for (const id of ['uc-exec-1', 'uc-dl-1', 'uc-up-1', 'uc-msg-1', 'uc-lt-1']) note(id, true, backend.submitted(id));
  note('uc-upload-file', fs.existsSync(path.join(root, 'uc-upload.txt')), null);
  const ucIds = fr => fr.map(f => { const m = JSON.parse(f.value.messageJson); return m.id ?? m.streamClose?.id; });
  // t166: the first UC provider's own counter starts at 1 even though Box already ran an exec (D:179358 fresh v_).
  note('uc-exec-id', ucIds(backend.submitted('uc-exec-1')).every(i => i === 1), { ids: ucIds(backend.submitted('uc-exec-1')) });

  // t166 mb headers (D:mb 79034–79044 via eke(process.env,"desktop") 79157 → jAt 79135; synthetic env: SAND_PACKAGED/SAND_LAB
  // unset → tse "sand-dev" (79045); ese(undefined,"sand-dev",false) = "dev" (78973); VPe("0.79.3","dev") = "0.79.3-dev"
  // (78996, LAt 78970); BAt("desktop") = "sand-desktop" (79007); FAt/$At linux (79021–79033).
  const MB = [['user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Sand/0.79.3-dev Safari/537.36'],
    ['x-cursor-client-type', 'sand'], ['x-cursor-client-version', '0.79.3-dev'], ['x-sand-box-namespace', 'dev'],
    ['x-cursor-client-os', 'linux'], ['x-cursor-client-source', 'sand-desktop']];
  const mbNames = new Set(MB.map(([k]) => k));
  const pick = (raw, names) => raw.filter(([k]) => names.has(k));
  // Exchange O9r (179124): fetch headers {"content-type", ...mb(client)} → insertion order on the wire.
  const exRaw = backend.raw.find(r => r.url === '/sand-box/local-exec-connection')?.headers ?? [];
  const exOk = JSON.stringify(pick(exRaw, new Set(['content-type', ...mbNames]))) === JSON.stringify([['content-type', 'application/json'], ...MB]);
  // UC E9r (177883): interceptor header.set(mb) on connect-node 1.6.1 (same version bundled, d8r 175951 `new Headers`)
  // → names iterate sorted; values exact; no authorization header on UC.
  const ucRaw = backend.raw.filter(r => r.url.startsWith('/aiserver.v1.GrokBotService/'));
  const sortedMb = [...MB].sort(([a], [b]) => a < b ? -1 : 1);
  const ucBad = ucRaw.filter(r => JSON.stringify(pick(r.headers, mbNames)) !== JSON.stringify(sortedMb) || r.headers.some(([k]) => k === 'authorization'));
  // Box cmt (137186): {accept|content-type, ...connection.headers, authorization} only — no mb headers.
  // (accept on POST / user-agent "node" are undici fetch defaults appended after the init headers, not cmt.)
  const getApp = new Set(['accept', 'authorization', 'x-anyrun-network-token']), postApp = new Set(['content-type', 'authorization', 'x-anyrun-network-token']);
  const b1Get = pick(box1.gets[0].raw, getApp), b2Get = pick(box2.gets[0].raw, getApp), b2Post = pick(box2.posts[0].raw, postApp);
  const boxNoMb = [...box1.gets, ...box2.gets, ...box1.posts, ...box2.posts].every(r => !r.raw.some(([k, v]) => (mbNames.has(k) && k !== 'user-agent' && k !== 'accept') || (k === 'user-agent' && v.includes('Sand/'))));
  const boxOk = JSON.stringify(b1Get) === JSON.stringify([['accept', 'text/event-stream'], ['authorization', 'Bearer synthetic-box-token-1']])
    && JSON.stringify(b2Get) === JSON.stringify([['accept', 'text/event-stream'], ['x-anyrun-network-token', 'synthetic-net-token'], ['authorization', 'Bearer synthetic-box-token-2']])
    && JSON.stringify(b2Post) === JSON.stringify([['content-type', 'application/json'], ['x-anyrun-network-token', 'synthetic-net-token'], ['authorization', 'Bearer synthetic-box-token-2']]);
  note('mb-headers', exOk && ucBad.length === 0 && ucRaw.length > 0 && boxOk && boxNoMb, { boxNoMb, exchange: exRaw, ucSample: ucRaw[0], ucRequests: ucRaw.length, ucBad: ucBad.map(r => r.url), box1Get: b1Get, box2Get: b2Get, box2Post: b2Post });

  // 7. silent renewal: no Watch event for 15 s after connected → renew + re-Watch within 0–2 s (D:178266–178280, t9r, r9r)
  const silentFrom = Date.now(); const watchesBefore = backend.state.watches.length;
  await until(() => backend.state.watches.length > watchesBefore, 22000, 'silent re-watch');
  note('silent-renewal', true, { msAfterLastEvent: Date.now() - silentFrom });

  // 8. unauthorized: a Poll 401 → rejectCredential → Watch "unauthorized" → x gains the scope → 10 s channelRetry → re-Watch
  await until(() => backend.log.filter(x => x.kind === 'event' && x.case === 'connected').length >= 2 && backend.state.watches.length >= 2, 5000, 'connected after silent');
  await delay(300);
  backend.state.pollAuthFail = 1; const unauthFrom = Date.now(); const wBefore = backend.state.watches.length; const b2Before = box2.gets.length;
  backend.notify();
  const rejected = await until(() => (readDiscovery()?.rejectedAccountScopes ?? []).includes(SCOPE) && readDiscovery(), 5000, 'rejected scope published').catch(() => null);
  await until(() => backend.state.watches.length > wBefore, 15000, 'unauthorized re-watch');
  // onLoopEvent unauthorized → x.add(scope) + Te.wakeFromReconnectBackoff (D:179408); X() false → Box dials meanwhile.
  const boxDuring = box2.gets.length > b2Before;
  note('unauthorized', !!rejected && boxDuring, { msToRewatch: Date.now() - unauthFrom, rejectedPublished: !!rejected, boxRedialedDuringWindow: boxDuring });
  await until(() => !(readDiscovery()?.rejectedAccountScopes ?? []).includes(SCOPE), 5000, 'scope cleared on connected').catch(() => {});
  await until(() => !box2.connected(), 5000, 'box idle again').catch(() => {});

  // t166 cancel of a running exec (UC): handleCancel → execManager abort{id: execId} → cancel (D:136353–136364).
  backend.enqueue('q-sleep', 'uc-sleep-1', E({ id: 5, shellStreamArgs: { command: 'sleep 30', workingDirectory: '', timeout: 60000 } }, { approvalId: 'ap-uc-sleep', authorizedByApproval: true }));
  backend.notify();
  await until(() => backend.submitted('uc-sleep-1').some(f => JSON.stringify(f).includes('start')), 5000, 'sleep start');
  const cancelAt = Date.now();
  backend.enqueue('q-cancel', 'uc-sleep-1', { case: 'cancel', value: new pb.GrokBotUserComputerCancel({}) });
  backend.notify();
  await until(() => backend.submitted('uc-sleep-1').some(f => f.case === 'control'), 5000, 'cancel terminal');
  note('uc-cancel-running', Date.now() - cancelAt < 5000, { msToTerminal: Date.now() - cancelAt, frames: backend.submitted('uc-sleep-1'), ids: ucIds(backend.submitted('uc-sleep-1')) });

  // t166 retireApproval: ACKed, persisted, no reply frame (D:178509–178555, wUe 81351); the approval no longer authorises.
  backend.enqueue('q-retire', 'uc-retire-1', { case: 'retireApproval', value: new pb.GrokBotUserComputerRetireApproval({ approvalId: 'ap-uc-exec' }) });
  backend.notify();
  await until(() => backend.state.acked.has('q-retire') || backend.state.queue.every(q => q.id !== 'q-retire'), 5000, 'retire acked').catch(() => {});
  await delay(300);
  backend.enqueue('q-exec2', 'uc-exec-2', E({ id: 6, shellStreamArgs: { command: 'echo UC_LOCAL_APPROVED', workingDirectory: '', timeout: 5000 } }, { approvalId: 'ap-uc-exec', authorizedByApproval: true }));
  backend.notify();
  await until(() => backend.submitted('uc-exec-2').length, 5000, 'retired exec reply');
  const retFile = path.join(data, fs.readdirSync(data).find(n => /retire/i.test(n)) ?? 'none');
  const ex2 = backend.submitted('uc-exec-2');
  note('uc-retire-approval', backend.submitted('uc-retire-1').length === 0 && ex2.length === 1 && ex2[0].case === 'control' && ex2[0].value.messageJson.includes('not approved'),
    { retireReplies: backend.submitted('uc-retire-1'), exec2: ex2, retirementsFile: path.basename(retFile), retirements: fs.existsSync(retFile) ? fs.readFileSync(retFile, 'utf8').slice(0, 400) : null });

  // t166 Watch 401 with a renewed credential: Watch Unauthenticated → s = "unauthorized" (D:178256) → channel cleared,
  // sleep channelRetry Q1t = 10 s (178280–178284) → resolveChannel re-reads the sealed credential → Watch with the new one.
  // Same accountScope/SA → Ve keeps the provider (D:179352: SA equal → continue), so no withdraw / no recreate.
  backend.state.credential = UC_CRED2; const w401 = backend.state.watches.length, b2Before401 = box2.gets.length, wd401 = backend.log.filter(x => x.kind === 'withdraw').length;
  backend.endWatch();
  await until(() => backend.state.watches.length > w401, 5000, 'watch with old credential');
  const rejWatch = backend.state.watches[w401];
  writeCred({ backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED2, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: false }] });
  const rej401 = await until(() => (readDiscovery()?.rejectedAccountScopes ?? []).includes(SCOPE), 5000, 'rejected scope (watch 401)').catch(() => false);
  await until(() => backend.state.watches.slice(w401 + 1).some(w => w.credential === UC_CRED2), 16000, 'watch with renewed credential');
  const renewedWatch = backend.state.watches.slice(w401 + 1).find(w => w.credential === UC_CRED2);
  const boxDuring401 = box2.gets.length > b2Before401;
  await until(() => !(readDiscovery()?.rejectedAccountScopes ?? []).includes(SCOPE), 5000, 'scope cleared (watch 401)').catch(() => {});
  note('watch-401-renewed', rejWatch.credential === UC_CRED && !!rej401 && boxDuring401 && backend.state.watches.slice(w401 + 1).every(w => w.credential === UC_CRED2) && backend.log.filter(x => x.kind === 'withdraw').length === wd401,
    { rejectedWatchCredential: rejWatch.credential, msToRenewedWatch: renewedWatch.t - rejWatch.t, watchesBetween: backend.state.watches.length - w401 - 1, rejectedPublished: !!rej401, boxRedialedDuringWindow: boxDuring401, withdraws: backend.log.filter(x => x.kind === 'withdraw').length - wd401 });
  await until(() => !box2.connected(), 5000, 'box idle (watch 401)').catch(() => {});

  // t166 backendReturn early wake: 4 Watch Unavailable → reconnectBackoff 1/2/4 s then an 8 s sleep (Q8r 177834, doubling);
  // noteFailure(Unavailable) marks backend-down (w8r 176402); the standing tick (Rre 2 s, 78811) reads
  // local-exec-backend-return.json (He 179436) → noteBackendReturn → wake after random·g8r (≤ 2 s, 176381/176445).
  await until(() => backend.log.filter(x => x.kind === 'event' && x.case === 'connected').length > 0 && backend.liveWatch(), 5000, 'live watch');
  await delay(300);
  backend.state.watchUnavailable = 4; const wBr = backend.state.watches.length;
  backend.endWatch();
  await until(() => backend.log.filter(x => x.kind === 'watch-unavailable').length >= 4, 15000, '4 outages');
  const outages = backend.log.filter(x => x.kind === 'watch-unavailable').map(x => x.t);
  await delay(300);
  const markerAt = backend.now(); fs.writeFileSync(path.join(data, 'local-exec-backend-return.json'), JSON.stringify({ at: Date.now() }));
  await until(() => backend.state.watches.length > wBr + 4, 12000, 'woken watch');
  const woke = backend.state.watches[wBr + 4].t;
  const gaps = outages.slice(1).map((t, i) => t - outages[i]);
  note('backend-return-wake', woke - outages[3] < 7000 && woke - markerAt <= 4600, { outageGapsMs: gaps, msFromLastOutageToWatch: woke - outages[3], msFromMarkerToWatch: woke - markerAt });
  await until(() => backend.liveWatch() && backend.log.filter(x => x.kind === 'event' && x.case === 'connected').at(-1).t >= woke, 5000, 'connected after wake').catch(() => {});

  // 9. SA flip → provider recreated (close without withdraw, D:179352–179356) → standing "" + authorizedByStanding exec
  const connectedBeforeSA = backend.log.filter(x => x.kind === 'event' && x.case === 'connected').length;
  const withdrawsBefore = backend.log.filter(x => x.kind === 'withdraw').length; const wSA = backend.state.watches.length;
  writeCred({ backendUrl: backend.url, credential: BOX_CRED, userComputers: [{ credential: UC_CRED2, machineId: MACHINE, accountScope: SCOPE, serverAuthoritative: true }] });
  await until(() => backend.state.watches.slice(wSA).some(w => w.hello?.serverAuthoritative === true) && backend.log.filter(x => x.kind === 'event' && x.case === 'connected').length > connectedBeforeSA, 10000, 'SA watch');
  await delay(300);
  backend.enqueue('q-sa', 'uc-sa-1', E({ id: 2, shellStreamArgs: { command: 'echo SA_STANDING', workingDirectory: '', timeout: 5000 } }, { authorizedByStanding: true }));
  backend.notify();
  await until(() => backend.submitted('uc-sa-1').some(f => JSON.stringify(f).includes('streamClose')), 8000, 'SA exec');
  note('sa-flip', backend.log.filter(x => x.kind === 'withdraw').length === withdrawsBefore, { saHello: backend.state.watches.slice(wSA).find(w => w.hello?.serverAuthoritative)?.hello, withdrawsDuringFlip: backend.log.filter(x => x.kind === 'withdraw').length - withdrawsBefore });
  note('uc-sa-1', JSON.stringify(backend.submitted('uc-sa-1')).includes('SA_STANDING'), backend.submitted('uc-sa-1'));
  // t166: the SA recreate builds a fresh v_ (D:179358) → its counter restarts at 1.
  note('sa-exec-id', ucIds(backend.submitted('uc-sa-1')).every(i => i === 1), { ids: ucIds(backend.submitted('uc-sa-1')) });

  // 10. graceful shutdown: SIGTERM → withdraw (presence of the live Watch) → discovery cleared → exit 0 (D:IDe 79748–79749, lgt.close 179528)
  const live = backend.liveWatch();
  child.kill('SIGTERM'); await Promise.race([exited, delay(10000)]);
  const wd = backend.log.filter(x => x.kind === 'withdraw');
  note('shutdown', exit?.code === 0 && !fs.existsSync(path.join(data, 'local-exec-daemon.json')), { exit, withdraws: wd.length, presenceMatches: wd.at(-1)?.presenceToken === live?.presenceToken });

  // Hard assertions: every step observed (details compared against the original in the matrix doc).
  const failed = obs.filter(o => !o.ok).map(o => o.step);
  assert.deepEqual(failed, [], JSON.stringify(obs.filter(o => !o.ok), null, 1).slice(0, 4000));
});
