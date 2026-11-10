#!/usr/bin/env node
/**
 * Pack packages/grokbot-control into a parentless commit whose tree is the
 * installable package (for npx github:...#npm-v<version>).
 *
 * Default is a local preview: checks, pack, and an orphan commit. It does not
 * create or push the official npm-v<version> tag. Official tags are minted by
 * .github/workflows/release-github.yml after a v* tag is pushed.
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

const HELP = `release-github — pack grokbot-control into a parentless GitHub-install tree

USAGE:
  npm run release:github -- [flags]
  node scripts/release-github.mjs [flags]

FLAGS:
  --skip-tests        Skip generate:check, build, and npm test
  --allow-branch      Allow a branch other than main (worktree must still be clean)
  --dry-run           Run checks and pack; do not create a commit or tag
  --write-local-tag   Also create a local npm-v<version> tag for verification
  --ci                Actions mode: require GITHUB_REF=refs/tags/v*, mint and
                      push npm-v<version> (never force-pushes)
  --help              Show this help

EXAMPLES:
  npm run release:github --
  npm run release:github -- --dry-run
  npm run release:github -- --allow-branch --skip-tests

EXIT CODES:
  0  success
  2  usage (unknown or invalid flag)
  3  precondition (dirty worktree, not on main, not a git repo, missing CI ref)
  6  conflict (npm-v tag already exists locally or on origin)
  1  command failed (generate, build, test, pack, git)

stdout is a JSON result object. Progress, warnings, and errors go to stderr.

Default is preview only: an orphan commit is created, but the official
npm-v<version> tag is NOT written or pushed. Official release is:

  git push origin main
  git tag -a v<version> <main-commit>
  git push origin refs/tags/v<version>

Then GitHub Actions mints and pushes npm-v<version>. Do not push npm-v*
from a laptop. Do not push v* until Actions can run.
`;

export function tagName(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw Object.assign(new Error(`invalid package version: ${version}`), { code: 'usage', exit: EXIT.usage });
  }
  return `npm-v${version}`;
}

export function versionTagName(version) {
  return `v${version}`;
}

export function parseSourceTag(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw Object.assign(new Error('missing source tag ref'), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: '--ci requires GITHUB_REF to be refs/tags/v<version>',
    });
  }
  const name = ref.replace(/^refs\/tags\//, '');
  if (name.startsWith('npm-v')) {
    throw Object.assign(new Error(`source tag must be v*, not ${name}`), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'this workflow must run only on v* tags; npm-v* is the output tag',
    });
  }
  const match = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(name);
  if (!match) {
    throw Object.assign(new Error(`invalid source tag: ${ref}`), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'expected refs/tags/vMAJOR.MINOR.PATCH',
    });
  }
  return { tag: name, version: match[1] };
}

export function assertCiSourceTag({ version, ref }) {
  const parsed = parseSourceTag(ref);
  if (parsed.version !== version) {
    throw Object.assign(new Error(`source tag ${parsed.tag} does not match package version ${version}`), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'the v* tag and packages/grokbot-control package.json version must be the same',
    });
  }
  return parsed;
}

export function parseArgs(argv) {
  const opts = {
    skipTests: false,
    allowBranch: false,
    dryRun: false,
    writeLocalTag: false,
    ci: false,
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
      case '--write-local-tag':
        opts.writeLocalTag = true;
        break;
      case '--ci':
        opts.ci = true;
        break;
      case '--push':
        throw Object.assign(new Error('--push is not supported; official npm-v tags are minted by GitHub Actions after a v* tag is pushed'), {
          code: 'usage',
          exit: EXIT.usage,
          hint: 'run a local preview without --push; push main, then push v<version> once Actions can run',
        });
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw Object.assign(new Error(`unknown flag: ${arg}`), {
          code: 'usage',
          exit: EXIT.usage,
          hint: 'valid flags: --skip-tests --allow-branch --dry-run --write-local-tag --ci --help',
        });
    }
  }
  if (opts.writeLocalTag && opts.dryRun) {
    throw Object.assign(new Error('--write-local-tag cannot be combined with --dry-run'), {
      code: 'usage',
      exit: EXIT.usage,
      hint: 'rerun without --dry-run if you need a local verification tag',
    });
  }
  if (opts.ci && opts.dryRun) {
    throw Object.assign(new Error('--ci cannot be combined with --dry-run'), {
      code: 'usage',
      exit: EXIT.usage,
    });
  }
  if (opts.ci && opts.writeLocalTag) {
    throw Object.assign(new Error('--ci cannot be combined with --write-local-tag'), {
      code: 'usage',
      exit: EXIT.usage,
      hint: '--ci already mints and pushes the official npm-v tag',
    });
  }
  if (opts.ci && opts.allowBranch) {
    throw Object.assign(new Error('--ci cannot be combined with --allow-branch'), {
      code: 'usage',
      exit: EXIT.usage,
    });
  }
  return opts;
}

export function stripLifecycleScripts(pkg) {
  const next = { ...pkg, scripts: { ...(pkg.scripts || {}) } };
  for (const name of LIFECYCLE_SCRIPTS) delete next.scripts[name];
  return next;
}

export function pushCommands({ branch, version }) {
  const sourceTag = versionTagName(version);
  return {
    branch: branch && branch !== 'main' ? `git push -u origin ${branch}` : null,
    main: 'git push origin main',
    version_tag: `git push origin refs/tags/${sourceTag}`,
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

export function assertWorktree({ branch, porcelain, allowBranch, ci = false }) {
  if (porcelain) {
    throw Object.assign(new Error('worktree is not clean'), {
      code: 'precondition',
      exit: EXIT.precondition,
      hint: 'commit or stash local changes, then rerun',
    });
  }
  if (ci) return;
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
      hint: 'merge to main first, or pass --allow-branch for a local preview from this branch',
    });
  }
}

export function assertTagAvailable({ tag, tagExists, remote = false }) {
  if (tagExists) {
    throw Object.assign(new Error(remote ? `tag ${tag} already exists on origin` : `tag ${tag} already exists`), {
      code: 'conflict',
      exit: EXIT.conflict,
      hint: 'do not overwrite an existing release tag; choose a new version. never force-push npm-v tags',
    });
  }
}

export function assertPreconditions(opts) {
  assertWorktree(opts);
  if ('tagExists' in opts) assertTagAvailable(opts);
}

function localTagExists(repo, tag) {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

export function remoteTagExists(repo, tag, remote = 'origin') {
  try {
    const out = run('git', ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`], {
      cwd: repo,
      timeout: 60_000,
    }).trim();
    return out.length > 0;
  } catch (err) {
    if (err.status === 2) return false;
    throw Object.assign(new Error(`failed to query ${remote} for tag ${tag}`), {
      code: 'failed',
      exit: EXIT.failed,
      hint: 'check git remotes and credentials; the job must fail closed if the tag cannot be queried',
      stderr: err.stderr,
    });
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

export async function releaseGithub(repo, opts, env = process.env) {
  const inspect = inspectRepo(repo);
  assertWorktree({
    branch: inspect.branch,
    porcelain: inspect.porcelain,
    allowBranch: opts.allowBranch,
    ci: opts.ci,
  });
  const controlPkg = JSON.parse(readFileSync(join(repo, 'packages/grokbot-control/package.json'), 'utf8'));
  const version = controlPkg.version;
  const tag = tagName(version);
  const sourceTag = versionTagName(version);

  if (opts.ci) {
    assertCiSourceTag({ version, ref: env.GITHUB_REF || env.GITHUB_REF_NAME });
  }

  const shouldWriteTag = Boolean(opts.ci || opts.writeLocalTag);
  if (shouldWriteTag) {
    assertTagAvailable({ tag, tagExists: localTagExists(repo, tag) });
  }
  if (opts.ci) {
    assertTagAvailable({ tag, tagExists: remoteTagExists(repo, tag), remote: true });
  }

  if (!opts.ci && inspect.branch && inspect.branch !== 'main') {
    log(`warning: preview from branch ${inspect.branch} because --allow-branch was set`);
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
    const commands = pushCommands({ branch: inspect.branch, version });
    if (opts.dryRun) {
      const files = packed.files?.length ?? null;
      return {
        ok: true,
        dry_run: true,
        version,
        tag,
        source_tag: sourceTag,
        commit: null,
        source_branch: inspect.branch || null,
        tests_run: !opts.skipTests,
        tagged: false,
        pushed: false,
        files,
        push_commands: commands,
        hint: `dry run only; official ${tag} is minted by GitHub Actions after pushing ${sourceTag}. Do not push ${tag} from this machine.`,
      };
    }

    const { commit } = createOrphanCommit({
      repo,
      gitDir: inspect.gitDir,
      workTree,
      message,
    });

    let tagged = false;
    let pushed = false;
    if (shouldWriteTag) {
      assertTagAvailable({ tag, tagExists: localTagExists(repo, tag) });
      run('git', ['tag', '-a', tag, commit, '-m', message], { cwd: repo });
      tagged = true;
      if (opts.ci) {
        assertTagAvailable({ tag, tagExists: remoteTagExists(repo, tag), remote: true });
        log(`pushing ${tag} to origin (never force, never pushes main)`);
        run('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: repo });
        pushed = true;
      } else {
        log(`wrote local verification tag ${tag} -> ${commit}; do not push this tag`);
      }
    } else {
      log(`preview orphan commit ${commit} for ${tag}; official tag is minted by Actions after pushing ${sourceTag}`);
    }

    const files = countTrackedFiles(repo, inspect.gitDir, commit);
    const after = inspectRepo(repo);
    if (after.porcelain || after.branch !== inspect.branch) {
      throw Object.assign(new Error('release mutated the worktree or HEAD; aborting'), {
        code: 'failed',
        exit: EXIT.failed,
        hint: 'the source branch should stay clean and unchanged; inspect git status',
      });
    }

    log(`orphan commit ${commit} (${files.length} files). Push commands (do not push ${tag}):`);
    if (commands.branch) log(`  ${commands.branch}`);
    log(`  ${commands.main}`);
    log(`  ${commands.version_tag}   # only after Actions can run`);

    let hint;
    if (pushed) {
      hint = `official tag ${tag} was pushed from ${sourceTag}`;
    } else if (tagged) {
      hint = `local tag ${tag} is for verification only; do not push it. Official release is push main, then push ${sourceTag} once Actions can run.`;
    } else {
      hint = `preview only: created orphan commit ${commit}. Official ${tag} is minted by GitHub Actions after pushing ${sourceTag}. Do not push ${tag} from this machine.`;
    }

    return {
      ok: true,
      dry_run: false,
      version,
      tag,
      source_tag: sourceTag,
      commit,
      source_branch: inspect.branch || null,
      tests_run: !opts.skipTests,
      tagged,
      pushed,
      files: files.length,
      paths: files,
      push_commands: commands,
      hint,
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
