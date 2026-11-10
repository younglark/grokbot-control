import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  EXIT,
  LIFECYCLE_SCRIPTS,
  parseArgs,
  tagName,
  stripLifecycleScripts,
  assertPreconditions,
  pushCommands,
  formatError,
  inspectRepo,
  assertWorktree,
} from '../scripts/release-github.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts/release-github.mjs');

test('parseArgs accepts known flags and rejects unknown ones', () => {
  assert.deepEqual(parseArgs([]), { skipTests: false, allowBranch: false, dryRun: false, push: false, help: false });
  assert.equal(parseArgs(['--skip-tests', '--allow-branch', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--force']), (err) => err.exit === EXIT.usage && /unknown flag/.test(err.message));
  assert.throws(() => parseArgs(['--skip']), (err) => err.exit === EXIT.usage);
  assert.throws(() => parseArgs(['--push', '--dry-run']), (err) => err.exit === EXIT.usage && /cannot be combined/.test(err.message));
});

test('tagName formats npm-v and rejects junk', () => {
  assert.equal(tagName('0.2.0'), 'npm-v0.2.0');
  assert.equal(tagName('1.0.0-rc.1'), 'npm-v1.0.0-rc.1');
  assert.throws(() => tagName('latest'), (err) => err.exit === EXIT.usage);
});

test('stripLifecycleScripts removes pack/install hooks and keeps bins/runtime scripts', () => {
  const stripped = stripLifecycleScripts({
    name: 'grokbot-control',
    version: '0.2.0',
    bin: { gbc: './dist/cli/main.js', 'gbc-mcp': './dist/mcp/main.js' },
    scripts: {
      prepack: 'npm run build',
      build: 'tsc -p tsconfig.json',
      prepare: 'echo no',
      gbc: 'node dist/cli/main.js',
      mcp: 'node dist/mcp/main.js',
      test: 'node --test',
    },
  });
  for (const name of LIFECYCLE_SCRIPTS) assert.equal(stripped.scripts[name], undefined);
  assert.equal(stripped.scripts.gbc, 'node dist/cli/main.js');
  assert.equal(stripped.scripts.mcp, 'node dist/mcp/main.js');
  assert.equal(stripped.bin.gbc, './dist/cli/main.js');
});

test('assertPreconditions and pushCommands cover the main safety rails', () => {
  assert.throws(
    () => assertPreconditions({ branch: 'main', porcelain: ' M foo', allowBranch: false, tag: 'npm-v0.2.0', tagExists: false }),
    (err) => err.exit === EXIT.precondition && /not clean/.test(err.message),
  );
  assert.throws(
    () => assertPreconditions({ branch: 'build/github-distribution', porcelain: '', allowBranch: false, tag: 'npm-v0.2.0', tagExists: false }),
    (err) => err.exit === EXIT.precondition && /must run on main/.test(err.message),
  );
  assert.doesNotThrow(() =>
    assertPreconditions({ branch: 'build/github-distribution', porcelain: '', allowBranch: true, tag: 'npm-v0.2.0', tagExists: false }),
  );
  assert.throws(
    () => assertPreconditions({ branch: 'main', porcelain: '', allowBranch: false, tag: 'npm-v0.2.0', tagExists: true }),
    (err) => err.exit === EXIT.conflict,
  );
  assert.deepEqual(pushCommands({ branch: 'build/github-distribution', tag: 'npm-v0.2.0' }), {
    branch: 'git push -u origin build/github-distribution',
    main: 'git push origin main',
    tag: 'git push origin refs/tags/npm-v0.2.0',
  });
  assert.equal(pushCommands({ branch: 'main', tag: 'npm-v0.2.0' }).branch, null);
  const err = formatError(Object.assign(new Error('x'), { code: 'usage', hint: 'try --help' }));
  assert.equal(err.ok, false);
  assert.equal(err.hint, 'try --help');
});

function spawn(args, opts = {}) {
  const { cwd = repo, input } = opts;
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, UC_SKIP_OFFICIAL: '1' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('CLI --help writes usage to stdout and exits 0; unknown flags exit 2 with JSON on stderr', () => {
  const help = spawn(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /EXIT CODES/);
  assert.match(help.stdout, /--allow-branch/);
  const bad = spawn(['--limt']);
  assert.equal(bad.status, EXIT.usage);
  const payload = JSON.parse(bad.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'usage');
  assert.match(payload.hint, /--skip-tests/);
  assert.equal(bad.stdout, '');
});

test('inspectRepo and assertWorktree reject a missing git dir and a dirty tree', () => {
  const nogit = mkdtempSync(join(tmpdir(), 'gbc-release-nogit-'));
  try {
    assert.throws(() => inspectRepo(nogit), (err) => err.exit === EXIT.precondition && /not a git repository/.test(err.message));
  } finally {
    rmSync(nogit, { recursive: true, force: true });
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'gbc-release-precond-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: sandbox, encoding: 'utf8' });
    execFileSync('git', ['config', 'user.email', 'devnull@example.com'], { cwd: sandbox });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: sandbox });
    writeFileSync(join(sandbox, 'README.md'), 'x\n');
    execFileSync('git', ['add', 'README.md'], { cwd: sandbox });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: sandbox, encoding: 'utf8' });
    const clean = inspectRepo(sandbox);
    assert.equal(clean.branch, 'main');
    assert.equal(clean.porcelain, '');
    writeFileSync(join(sandbox, 'dirty'), 'nope\n');
    const dirty = inspectRepo(sandbox);
    assert.throws(() => assertWorktree({ branch: dirty.branch, porcelain: dirty.porcelain, allowBranch: false }), (err) => {
      return err.exit === EXIT.precondition && /not clean/.test(err.message);
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
