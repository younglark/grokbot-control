import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  EXIT,
  LIFECYCLE_SCRIPTS,
  parseArgs,
  tagName,
  versionTagName,
  parseSourceTag,
  assertCiSourceTag,
  stripLifecycleScripts,
  assertPreconditions,
  pushCommands,
  formatError,
  inspectRepo,
  assertWorktree,
} from '../scripts/release-github.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts/release-github.mjs');

test('parseArgs accepts known flags and rejects --push and unknown ones', () => {
  assert.deepEqual(parseArgs([]), {
    skipTests: false,
    allowBranch: false,
    dryRun: false,
    writeLocalTag: false,
    ci: false,
    help: false,
  });
  assert.equal(parseArgs(['--skip-tests', '--allow-branch', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--write-local-tag']).writeLocalTag, true);
  assert.equal(parseArgs(['--ci', '--skip-tests']).ci, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--force']), (err) => err.exit === EXIT.usage && /unknown flag/.test(err.message));
  assert.throws(() => parseArgs(['--skip']), (err) => err.exit === EXIT.usage);
  assert.throws(() => parseArgs(['--push']), (err) => err.exit === EXIT.usage && /Actions/.test(err.message));
  assert.throws(() => parseArgs(['--write-local-tag', '--dry-run']), (err) => err.exit === EXIT.usage);
  assert.throws(() => parseArgs(['--ci', '--dry-run']), (err) => err.exit === EXIT.usage);
  assert.throws(() => parseArgs(['--ci', '--write-local-tag']), (err) => err.exit === EXIT.usage);
  assert.throws(() => parseArgs(['--ci', '--allow-branch']), (err) => err.exit === EXIT.usage);
});

test('tagName formats npm-v and rejects junk', () => {
  assert.equal(tagName('0.2.0'), 'npm-v0.2.0');
  assert.equal(tagName('1.0.0-rc.1'), 'npm-v1.0.0-rc.1');
  assert.equal(versionTagName('0.2.0'), 'v0.2.0');
  assert.throws(() => tagName('latest'), (err) => err.exit === EXIT.usage);
});

test('parseSourceTag accepts v* refs and rejects npm-v*', () => {
  assert.deepEqual(parseSourceTag('refs/tags/v0.2.0'), { tag: 'v0.2.0', version: '0.2.0' });
  assert.deepEqual(parseSourceTag('v1.0.0-rc.1'), { tag: 'v1.0.0-rc.1', version: '1.0.0-rc.1' });
  assert.throws(() => parseSourceTag('refs/tags/npm-v0.2.0'), (err) => err.exit === EXIT.precondition && /not npm-v/.test(err.message) === false ? /must be v\*/.test(err.message) : true);
  assert.throws(() => parseSourceTag('npm-v0.2.0'), (err) => err.exit === EXIT.precondition);
  assert.throws(() => parseSourceTag('refs/tags/latest'), (err) => err.exit === EXIT.precondition);
  assert.throws(() => parseSourceTag(''), (err) => err.exit === EXIT.precondition);
  assert.deepEqual(assertCiSourceTag({ version: '0.2.0', ref: 'refs/tags/v0.2.0' }), { tag: 'v0.2.0', version: '0.2.0' });
  assert.throws(
    () => assertCiSourceTag({ version: '0.2.0', ref: 'refs/tags/v0.1.3' }),
    (err) => err.exit === EXIT.precondition && /does not match/.test(err.message),
  );
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
  assert.doesNotThrow(() => assertWorktree({ branch: '', porcelain: '', allowBranch: false, ci: true }));
  assert.throws(
    () => assertWorktree({ branch: '', porcelain: '', allowBranch: false, ci: false }),
    (err) => err.exit === EXIT.precondition && /detached HEAD/.test(err.message),
  );
  assert.throws(
    () => assertPreconditions({ branch: 'main', porcelain: '', allowBranch: false, tag: 'npm-v0.2.0', tagExists: true }),
    (err) => err.exit === EXIT.conflict,
  );
  assert.deepEqual(pushCommands({ branch: 'build/github-distribution', version: '0.2.0' }), {
    branch: 'git push -u origin build/github-distribution',
    main: 'git push origin main',
    version_tag: 'git push origin refs/tags/v0.2.0',
  });
  assert.equal(pushCommands({ branch: 'main', version: '0.2.0' }).branch, null);
  assert.equal(Object.prototype.hasOwnProperty.call(pushCommands({ branch: 'main', version: '0.2.0' }), 'tag'), false);
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

test('CLI --help writes usage to stdout and exits 0; unknown flags and --push exit 2 with JSON on stderr', () => {
  const help = spawn(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /EXIT CODES/);
  assert.match(help.stdout, /--allow-branch/);
  assert.match(help.stdout, /--ci/);
  assert.match(help.stdout, /Do not push npm-v/);
  const bad = spawn(['--limt']);
  assert.equal(bad.status, EXIT.usage);
  const payload = JSON.parse(bad.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'usage');
  assert.match(payload.hint, /--skip-tests/);
  assert.equal(bad.stdout, '');
  const push = spawn(['--push']);
  assert.equal(push.status, EXIT.usage);
  assert.match(JSON.parse(push.stderr).message, /Actions/);
  assert.equal(push.stdout, '');
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
