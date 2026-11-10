#!/usr/bin/env node
/**
 * Pack packages/grokbot-control and create a parentless local tag npm-v<version>
 * whose tree is the installable package (for npx github:...#npm-v<version>).
 * Does not push unless --push is passed; --push sends only the tag, never main.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  precondition: 3,
  conflict: 6,
});

export const LIFECYCLE_SCRIPTS = Object.freeze([
  'prepack',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'postpack',
  'preinstall',
  'install',
  'postinstall',
  'build',
]);

const HELP = `release-github — pack grokbot-control and tag a parentless GitHub-install tree

USAGE:
  npm run release:github -- [flags]
  node scripts/release-github.mjs [flags]

FLAGS:
  --skip-tests      Skip generate:check, build, and npm test
  --allow-branch    Allow a branch other than main (worktree must still be clean)
  --dry-run         Run checks and pack; do not create a commit or tag
  --push            After tagging, push only the tag to origin (never pushes main)
  --help            Show this help

EXAMPLES:
  npm run release:github --
  npm run release:github -- --dry-run
  npm run release:github -- --allow-branch

EXIT CODES:
  0  success
  2  usage (unknown or invalid flag)
  3  precondition (dirty worktree, not on main, not a git repo)
  6  conflict (tag already exists)
  1  command failed (generate, build, test, pack, git)

stdout is a JSON result object. Progress, warnings, and errors go to stderr.
--push is opt-in and only runs git push origin refs/tags/npm-v<version>.
Push main or the source branch as a separate, explicit command after review.
`;

export function tagName(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw Object.assign(new Error(`invalid package version: ${version}`), { code: 'usage', exit: EXIT.usage });
  }
  return `npm-v${version}`;
}

export function parseArgs(argv) {
  const opts = {
    skipTests: false,
    allowBranch: false,
    dryRun: false,
    push: false,
    help: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '--skip-tests':
        opts.skipTests = true;
        break;
      case '--allow-branch':
        opts.allowBranch = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--push':
        opts.push = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw Object.assign(new Error(`unknown flag: ${arg}`), {
          code: 'usage',
          exit: EXIT.usage,
          hint: 'valid flags: --skip-tests --allow-branch --dry-run --push --help',
        });
    }
  }
  if (opts.push && opts.dryRun) {
    throw Object.assign(new Error('--push cannot be combined with --dry-run'), {
      code: 'usage',
      exit: EXIT.usage,
      hint: 'run a local tag first, then rerun without --dry-run; add --push only after review',
    });
  }
  return opts;
}

export function stripLifecycleScripts(pkg) {
  const next = { ...pkg, scripts: { ...(pkg.scripts || {}) } };
  for (const name of LIFECYCLE_SCRIPTS) delete next.scripts[name];
  return next;
}

export function pushCommands({ branch, tag }) {
  return {
    branch: branch && branch !== 'main' ? `git push -u origin ${branch}` : null,
    main: 'git push origin main',
    tag: `git push origin refs/tags/${tag}`,
  };
}

export function formatError(err) {
  return {
    ok: false,
    code: err.code || 'failed',
    message: err.message,
    hint: err.hint || undefined,
  };
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function run(cmd, args, opts = {}) {
  const { cwd, env, timeout = 600_000 } = opts;
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(repo, args, env = process.env) {
  return run('git', args, { cwd: repo, env }).trim();
}

export function inspectRepo(repo) {
  let inside;
  try {
    inside = git(repo, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw Object.assign(new Error(`not a git repository: ${repo}`), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'run this script from the grokbot-control-workspace checkout',
    });
  }
  if (inside !== 'true') {
    throw Object.assign(new Error(`not a git work tree: ${repo}`), {
      code: 'precondition',
      exit: EXIT.precondition,
    });
  }
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  const branch = git(repo, ['branch', '--show-current']);
  const porcelain = git(repo, ['status', '--porcelain']);
  return { gitDir, branch, porcelain };
}

export function assertWorktree({ branch, porcelain, allowBranch }) {
  if (porcelain) {
    throw Object.assign(new Error('worktree is not clean'), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'commit or stash local changes, then rerun',
    });
  }
  if (!branch) {
    throw Object.assign(new Error('detached HEAD is not allowed'), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'check out main (or pass --allow-branch on a named branch)',
    });
  }
  if (branch !== 'main' && !allowBranch) {
    throw Object.assign(new Error(`must run on main (current branch: ${branch})`), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'merge to main first, or pass --allow-branch for a local-only tag from this branch',
    });
  }
}

export function assertTagAvailable({ tag, tagExists }) {
  if (tagExists) {
    throw Object.assign(new Error(`tag ${tag} already exists`), {
      code: 'conflict',
      exit: EXIT.conflict,
      hint: 'do not overwrite an existing release tag; choose a new version or delete the tag only with explicit approval',
    });
  }
}

export function assertPreconditions(opts) {
  assertWorktree(opts);
  if ('tagExists' in opts) assertTagAvailable(opts);
}

function tagExists(repo, tag) {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function npmEnv() {
  return { ...process.env, UC_SKIP_OFFICIAL: '1' };
}

function runNpm(repo, args, timeout = 600_000) {
  const npm = process.env.npm_execpath;
  const argv = npm ? [npm, ...args] : null;
  if (argv) return run(process.execPath, argv, { cwd: repo, env: npmEnv(), timeout });
  return run('npm', args, { cwd: repo, env: npmEnv(), timeout });
}

function extractTarball(tarball, dest) {
  run('tar', ['-xzf', tarball, '-C', dest], { timeout: 60_000 });
}

function writeReleaseManifest(dir) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const stripped = stripLifecycleScripts(pkg);
  writeFileSync(pkgPath, `${JSON.stringify(stripped, null, 2)}\n`);
  if (!stripped.bin?.gbc || !stripped.bin?.['gbc-mcp']) {
    throw Object.assign(new Error('packed package.json is missing gbc / gbc-mcp bins'), {
      code: 'failed',
      exit: EXIT.failed,
    });
  }
  if (!existsSync(join(dir, 'dist/cli/main.js')) || !existsSync(join(dir, 'dist/mcp/main.js'))) {
    throw Object.assign(new Error('packed tree is missing dist/cli/main.js or dist/mcp/main.js'), {
      code: 'failed',
      exit: EXIT.failed,
    });
  }
  return stripped;
}

function createOrphanCommit({ repo, gitDir, workTree, message }) {
  const index = join(workTree, '..', 'git-index');
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: index,
    GIT_CEILING_DIRECTORIES: resolve(workTree, '..'),
  };
  run('git', ['add', '-A'], { cwd: workTree, env });
  const tree = run('git', ['write-tree'], { cwd: repo, env }).trim();
  const commit = run('git', ['commit-tree', tree, '-m', message], { cwd: repo, env }).trim();
  return { tree, commit };
}

function countTrackedFiles(repo, gitDir, commit) {
  const out = run('git', ['--git-dir', gitDir, 'ls-tree', '-r', '--name-only', commit], { cwd: repo });
  return out.trim() ? out.trim().split('\n') : [];
}

export async function releaseGithub(repo, opts) {
  const inspect = inspectRepo(repo);
  assertWorktree({
    branch: inspect.branch,
    porcelain: inspect.porcelain,
    allowBranch: opts.allowBranch,
  });
  const controlPkg = JSON.parse(readFileSync(join(repo, 'packages/grokbot-control/package.json'), 'utf8'));
  const version = controlPkg.version;
  const tag = tagName(version);
  assertTagAvailable({ tag, tagExists: tagExists(repo, tag) });

  if (inspect.branch !== 'main') {
    log(`warning: tagging from branch ${inspect.branch} because --allow-branch was set`);
  }

  if (!opts.skipTests) {
    log('running generate:check, build, and npm test (UC_SKIP_OFFICIAL=1)');
    runNpm(repo, ['run', 'generate:check']);
    runNpm(repo, ['run', 'build']);
    runNpm(repo, ['test']);
  } else {
    log('skipping generate:check, build, and npm test (--skip-tests)');
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'gbc-release-github-'));
  try {
    log(`packing grokbot-control@${version}`);
    const packed = JSON.parse(runNpm(repo, ['pack', '-w', 'grokbot-control', '--json', '--pack-destination', sandbox], 180_000))[0];
    const tarball = join(sandbox, packed.filename);
    extractTarball(tarball, sandbox);
    const workTree = join(sandbox, 'package');
    const manifest = writeReleaseManifest(workTree);
    if (manifest.version !== version) {
      throw Object.assign(new Error(`packed version ${manifest.version} != source version ${version}`), {
        code: 'failed',
        exit: EXIT.failed,
      });
    }

    const message = `release: grokbot-control ${version} (GitHub install tree)`;
    if (opts.dryRun) {
      const files = packed.files?.length ?? null;
      return {
        ok: true,
        dry_run: true,
        version,
        tag,
        commit: null,
        source_branch: inspect.branch,
        tests_run: !opts.skipTests,
        pushed: false,
        files,
        push_commands: pushCommands({ branch: inspect.branch, tag }),
        hint: `dry run only; rerun without --dry-run to create local tag ${tag}`,
      };
    }

    const { commit } = createOrphanCommit({
      repo,
      gitDir: inspect.gitDir,
      workTree,
      message,
    });
    run('git', ['tag', '-a', tag, commit, '-m', message], { cwd: repo });
    const files = countTrackedFiles(repo, inspect.gitDir, commit);
    const after = inspectRepo(repo);
    if (after.porcelain || after.branch !== inspect.branch) {
      throw Object.assign(new Error('release mutated the worktree or HEAD; aborting'), {
        code: 'failed',
        exit: EXIT.failed,
        hint: 'the source branch should stay clean and unchanged; inspect git status',
      });
    }

    let pushed = false;
    if (opts.push) {
      log(`pushing ${tag} to origin (main is not pushed)`);
      run('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: repo });
      pushed = true;
    }

    const commands = pushCommands({ branch: inspect.branch, tag });
    log(`local tag ${tag} -> ${commit} (${files.length} files). Push commands:`);
    if (commands.branch) log(`  ${commands.branch}`);
    log(`  ${commands.main}`);
    log(`  ${commands.tag}`);

    return {
      ok: true,
      dry_run: false,
      version,
      tag,
      commit,
      source_branch: inspect.branch,
      tests_run: !opts.skipTests,
      pushed,
      files: files.length,
      paths: files,
      push_commands: commands,
      hint: pushed
        ? `tag ${tag} was pushed; push main or the source branch as a separate command after review`
        : `tag ${tag} is local only; push the branch/main and the tag as separate commands after review`,
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${JSON.stringify(formatError(err), null, 2)}\n`);
    process.exitCode = err.exit || EXIT.usage;
    return;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const result = await releaseGithub(repo, opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    const exit = err.exit || EXIT.failed;
    const payload = formatError(err);
    if (err.stderr) payload.detail = String(err.stderr).trim().slice(-4000);
    else if (err.stdout) payload.detail = String(err.stdout).trim().slice(-4000);
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = exit;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
