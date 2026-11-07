'use strict';
// Gate negative tests for scripts/oracles/r3/diff.py + run_r3.py: the strict differential must
// fail on missing results, dropped cases, probe failures, and on any ruled (deviation) case whose
// content is replaced or drifts beyond its pinned fields. Positive: recorded golden runs pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = path.join(__dirname, '..', 'scripts', 'oracles', 'r3');
const gold = path.join(dir, 'golden');
const rules = JSON.parse(fs.readFileSync(path.join(dir, 'deviations.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected-cases.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
const load = (side, p) => JSON.parse(fs.readFileSync(path.join(gold, `${side}-${p}.json`), 'utf8'));
function diff(p, off, ours) {
  const a = path.join(tmp, `o-${p}.json`), b = path.join(tmp, `u-${p}.json`);
  fs.writeFileSync(a, JSON.stringify(off)); fs.writeFileSync(b, JSON.stringify(ours));
  const r = spawnSync('python3', [path.join(dir, 'diff.py'), a, b, '--probe', p, '--rules', path.join(dir, 'deviations.json'), '--expected', path.join(dir, 'expected-cases.json')], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

test('positive: every golden probe passes with exactly the ruled cases allowed', () => {
  let cases = 0, allowed = 0;
  for (const p of Object.keys(expected)) {
    const r = diff(p, load('official', p), load('ours', p));
    assert.equal(r.code, 0, r.out);
    const m = /cases=(\d+) same=(\d+) allowed=(\d+) diff=0 errors=0/.exec(r.out); cases += +m[1]; allowed += +m[3];
  }
  assert.equal(cases, 46); assert.equal(allowed, new Set(rules.map((x) => x.case)).size); assert.equal(allowed, 10);
});

test('negative: missing results / empty events / step failure / dropped case', () => {
  const p = 'main';
  const noRes = load('ours', p); noRes.results = []; assert.notEqual(diff(p, load('official', p), noRes).code, 0);
  const noEv = load('ours', p); noEv.events = []; assert.notEqual(diff(p, load('official', p), noEv).code, 0);
  const fail = load('ours', p); fail.results[3].status = 'fail'; assert.notEqual(diff(p, load('official', p), fail).code, 0);
  const off = load('official', p), ours = load('ours', p);
  for (const d of [off, ours]) { d.events = d.events.filter((e) => e.name !== 'sh-exit1'); d.results = d.results.filter((e) => e.name !== 'sh-exit1'); }
  const r = diff(p, off, ours); assert.notEqual(r.code, 0); assert.match(r.out, /missing \['sh-exit1'\]/);
  const orphan = load('ours', p); orphan.results = orphan.results.filter((e) => e.name !== 'ls');
  assert.notEqual(diff(p, load('official', p), orphan).code, 0);
});

const cases = [...new Set(rules.map((x) => `${x.probe}/${x.case}`))];
for (const pc of cases) {
  const [p, c] = pc.split('/');
  test(`deviation ${pc}: positive passes, arbitrary throw / drift fails`, () => {
    assert.equal(diff(p, load('official', p), load('ours', p)).code, 0);
    const thrown = load('ours', p);
    const ev = thrown.events.find((e) => e.name === c);
    ev.frames = [{ kind: 'client', requestId: c, message: { id: ev.frames[0].message.id, shellStream: { throw: { error: 'arbitrary' } } } },
      { kind: 'control', requestId: c, message: { streamClose: { id: ev.frames[0].message.id } } }];
    const r = diff(p, load('official', p), thrown); assert.notEqual(r.code, 0, r.out); assert.match(r.out, new RegExp(`DIFF +${c}`));
    // drift: change exit code on ours (outside every pinned field) must also fail
    const drift = load('ours', p);
    const ex = drift.events.find((e) => e.name === c).frames.find((f) => f.message?.shellStream?.exit);
    ex.message.shellStream.exit.code = 77;
    assert.notEqual(diff(p, load('official', p), drift).code, 0);
  });
}

test('run_r3.py propagates probe failure (missing lab → non-zero)', () => {
  const r = spawnSync('python3', [path.join(dir, 'run_r3.py'), 'neg'], { env: { ...process.env, LAB: path.join(tmp, 'nolab'), OUT: tmp, PROBE: 'main' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  const r2 = spawnSync('python3', [path.join(dir, 'run_r3.py'), 'neg2'], { env: { ...process.env, OUT: tmp, PROBE: 'does-not-exist' }, encoding: 'utf8' });
  assert.notEqual(r2.status, 0);
});

test('run_r3.py: probe exits 0 but reports a failed step → non-zero (pass control → 0)', { skip: !fs.existsSync('/usr/bin/bwrap') }, () => {
  const lab = path.join(tmp, 'lab'); fs.mkdirSync(path.join(lab, 'input'), { recursive: true });
  const scripts = path.join(tmp, 'scripts'); fs.mkdirSync(path.join(scripts, 'probes'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'run_r3.py'), path.join(scripts, 'run_r3.py'));
  const mk = (status) => fs.writeFileSync(path.join(scripts, 'probes', 'probe_neg.cjs'),
    `console.log(JSON.stringify({results:[{name:'step',status:${JSON.stringify(status)}}],events:[{name:'step',frames:[]}]}));process.exit(0)`);
  const runIt = () => spawnSync('python3', [path.join(scripts, 'run_r3.py'), 'neg-step'], { env: { ...process.env, LAB: lab, OUT: tmp, PROBE: 'neg' }, encoding: 'utf8' });
  mk('pass'); const ok = runIt(); assert.equal(ok.status, 0, ok.stderr);
  mk('fail'); const bad = runIt(); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /PROBE STEP FAILED/);
});
