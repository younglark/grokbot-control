// t176: background shell (E_/r5e/ZO), admin denylist (Qk), requestedSandboxPolicy (Ud/ol),
// settings non-ENOENT rethrow (II.readText). Synthetic only; UC_SKIP_OFFICIAL=1; no official binaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const dist = path.join(__dirname, '..', 'dist');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 't176-'));

function framesOf(list) {
  return list.map(f => JSON.stringify(f)).join('\n');
}

test('denylist: empty allow; matching rule → rejected ZE text; unparsable→fail-closed fZt when forced', async () => {
  const { Qk, m3Structured, denylistDeniedReason, DENYLIST_PARSE_FAILED_REASON, zje, hZt, vhe } = require(path.join(dist, 'exec/denylist'));
  assert.equal(Qk({ command: 'echo hi', parsingResult: m3Structured('echo hi'), blockedCommands: [] }), undefined);
  const parsed = m3Structured('curl https://evil.example');
  assert.equal(parsed.parsingFailed, false);
  assert.ok(parsed.executableCommands.some(c => c.name === 'curl' || c.fullText.includes('curl')));
  const reason = Qk({ command: 'curl https://evil.example', parsingResult: parsed, blockedCommands: ['curl*'] });
  assert.equal(reason, denylistDeniedReason('curl*'));
  assert.match(reason, /administrator policy \(denylist rule: curl\*\)/);
  // Invalid catch-all rule always matches (zje via lse)
  assert.equal(zje({ rule: '*', command: 'echo x' }), true);
  assert.equal(hZt('echo', 'echo hi'), true);
  assert.equal(vhe({ matchForms: ['echo hi'], blockedCommands: ['echo'] }), 'echo');
  // Fail-closed when parsingFailed
  assert.equal(
    Qk({ command: 'x', parsingResult: { parsingFailed: true, executableCommands: [], hasRedirects: false, hasCommandSubstitution: false, redirects: [] }, blockedCommands: ['x'] }),
    DENYLIST_PARSE_FAILED_REASON,
  );
});

test('shellStream denylist reject emits rejected (no start) then streamClose', async () => {
  const H = require(path.join(dist, 'exec/handlers'));
  const root = tmp();
  const frames = [];
  await H.dispatchExec({
    root, requestId: 'deny1', permission: 'always',
    serverMessage: { id: 1, shellStreamArgs: { command: 'curl http://x', workingDirectory: '', adminCommandDenylist: ['curl*'] } },
    emit: f => frames.push(f),
  });
  const text = framesOf(frames);
  assert.match(text, /"rejected"/);
  assert.match(text, /denylist rule: curl\*/);
  assert.doesNotMatch(text, /"start"/);
  assert.match(text, /streamClose/);
});

test('requestedSandboxPolicy workspace_* without helper → start then sandboxUnsupported', async () => {
  const H = require(path.join(dist, 'exec/handlers'));
  const root = tmp();
  const frames = [];
  await H.dispatchExec({
    root, requestId: 'sbx1', permission: 'always',
    serverMessage: { id: 1, shellStreamArgs: {
      command: 'echo HI', workingDirectory: '',
      requestedSandboxPolicy: { type: 'TYPE_WORKSPACE_READONLY' },
    } },
    emit: f => frames.push(f),
  });
  const text = framesOf(frames);
  assert.match(text, /"start"/);
  assert.match(text, /sandboxUnsupported/);
  assert.match(text, /workspace_readonly/);
  assert.match(text, /Binary check failed/);
  assert.doesNotMatch(text, /"exit"/);
  assert.match(text, /streamClose/);
});

test('BACKGROUND soft timeout → backgrounded + terminals/{id}.txt; hardTimeout aborts bg shell', async () => {
  const H = require(path.join(dist, 'exec/handlers'));
  const root = tmp();
  const frames = [];
  await H.dispatchExec({
    root, requestId: 'bg1', permission: 'always',
    serverMessage: { id: 1, shellStreamArgs: {
      command: 'echo START; sleep 30; echo NEVER',
      workingDirectory: '',
      timeout: 200,
      timeoutBehavior: 'TIMEOUT_BEHAVIOR_BACKGROUND',
      hardTimeout: 800,
    } },
    emit: f => frames.push(f),
  });
  const text = framesOf(frames);
  assert.match(text, /"start"/);
  assert.match(text, /"backgrounded"/);
  assert.match(text, /SHELL_BACKGROUND_REASON_TIMEOUT|TIMEOUT/);
  assert.match(text, /streamClose/);
  assert.doesNotMatch(text, /"exit"/);
  const bg = frames.find(f => f.kind === 'client' && f.message?.shellStream?.backgrounded);
  assert.ok(bg);
  const shellId = bg.message.shellStream.backgrounded.shellId;
  assert.ok(shellId >= 1000);
  // Terminal file created by adopt
  const term = path.join(root, 'terminals', `${shellId}.txt`);
  // May take a moment for header write
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(term) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(term), 'terminals/{id}.txt missing');
  const body = fs.readFileSync(term, 'utf8');
  assert.match(body, /status: running|status: failed|status: succeeded|status: aborted/);
  assert.match(body, /command:/);
  // Wait for hardTimeout abort to settle
  await new Promise(r => setTimeout(r, 1200));
});

test('backgroundShellSpawnArgs → success with shellId and terminal file', async () => {
  const H = require(path.join(dist, 'exec/handlers'));
  const root = tmp();
  const frames = [];
  await H.dispatchExec({
    root, requestId: 'spawn1', permission: 'always',
    serverMessage: { id: 1, backgroundShellSpawnArgs: { command: 'sleep 2', workingDirectory: '' } },
    emit: f => frames.push(f),
  });
  const text = framesOf(frames);
  assert.match(text, /backgroundShellSpawnResult/);
  assert.match(text, /"success"/);
  const ok = frames.find(f => f.message?.backgroundShellSpawnResult?.success);
  assert.ok(ok);
  const shellId = ok.message.backgroundShellSpawnResult.success.shellId;
  const term = path.join(root, 'terminals', `${shellId}.txt`);
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(term) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(term));
  // Cleanup: abort
  const { backgroundShellManagerFor } = require(path.join(dist, 'exec/background-shell'));
  backgroundShellManagerFor(root).abort(shellId);
});

test('settings: non-ENOENT read error reports damaged then rethrows (II.readText)', () => {
  const root = tmp();
  // Create a directory named settings.json so readFileSync throws EISDIR
  fs.mkdirSync(path.join(root, 'settings.json'));
  const src = `
const S = require(${JSON.stringify(path.join(dist, 'settings'))});
try {
  S.loadSettingsSync({ SAND_DATA_ROOT: ${JSON.stringify(root)} });
  process.stdout.write('NO_THROW');
} catch (e) {
  process.stdout.write('THREW:' + (e && e.code ? e.code : e.name));
}
`;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^THREW:/);
  assert.match(r.stderr, /durable file damaged path=settings\.json cause=.* copy=none/);
});
