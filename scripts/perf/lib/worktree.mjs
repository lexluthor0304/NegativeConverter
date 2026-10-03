// Detached worktree per ref under test, in a temp dir. The main checkout (and
// its negative2positive/dist) is never touched: parallel agents editing it
// cannot break a run, and a hot-reloading server is never involved.
//
// node_modules is a real directory of per-package symlinks into the invoking
// checkout's packages plus its own empty .vite, so concurrent worktrees never
// share Vite's cache. When the ref's package-lock.json differs, `npm ci` runs
// in the worktree instead. Only this worktree's own path is removed on exit
// (`git worktree remove --force`), never a global `git worktree prune`.

import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { registerWorktree, registerProcess } from './resources.mjs';

const run = promisify(execFile);

export async function git(cwd, args, options = {}) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  return stdout.trim();
}

export async function resolveCommit(repo, ref) {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

export async function repoRootOf(path) {
  return git(path, ['rev-parse', '--show-toplevel']);
}

/**
 * The state of a worktree including uncommitted tracked changes, as a commit
 * (`git stash create` snapshots without touching the working tree; untracked
 * files are not included). Returns { sha, dirty, base }.
 */
export async function snapshotWorktree(path) {
  const base = await git(path, ['rev-parse', 'HEAD']);
  const stash = await git(path, ['stash', 'create']);
  return stash ? { sha: stash, dirty: true, base } : { sha: base, dirty: false, base };
}

export async function isDirty(path) {
  return (await git(path, ['status', '--porcelain', '--untracked-files=no'])) !== '';
}

/** Per-package symlinks from `source` (a node_modules dir) into `target`. */
export function linkNodeModules(source, target) {
  mkdirSync(target, { recursive: true });
  const real = realpathSync(source);
  for (const name of readdirSync(real)) {
    if (name === '.vite' || name === '.cache' || name === '.package-lock.json') continue;
    const link = join(target, name);
    if (existsSync(link) || isSymlink(link)) continue;
    symlinkSync(join(real, name), link);
  }
  mkdirSync(join(target, '.vite'), { recursive: true });
}

function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function sameFile(a, b) {
  try { return readFileSync(a, 'utf8') === readFileSync(b, 'utf8'); } catch { return false; }
}

function runNpmCi(cwd, log) {
  return new Promise((resolvePromise, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['ci', '--no-audit', '--no-fund'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const unregister = registerProcess(child, { detached: false });
    child.once('exit', unregister);
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.once('exit', code => (code === 0 ? resolvePromise() : reject(new Error(`npm ci failed in ${cwd}: ${output}`))));
    log('package-lock.json differs from the invoking checkout: running npm ci in the worktree');
  });
}

/**
 * Create a detached worktree for `sha` under `tmpRoot`.
 * Returns { path, sha, cleanup }.
 */
export async function createRefWorktree({ repo, sha, tmpRoot, invokingRoot, log = () => {}, npmCi = runNpmCi }) {
  const path = resolve(tmpRoot, `wt-${sha.slice(0, 12)}-${process.pid}-${Date.now().toString(36)}`);
  await git(repo, ['worktree', 'add', '--detach', '--quiet', path, sha]);
  const unregister = registerWorktree(repo, path);
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    if (!existsSync(path)) { unregister(); return; }
    try {
      await git(repo, ['worktree', 'remove', '--force', path]);
      unregister();
    } catch (error) {
      log(`git worktree remove failed (${error.message.split('\n')[0]}); deleting ${path}`);
      rmSync(path, { recursive: true, force: true });
    }
  };
  try {
    const lock = join(path, 'package-lock.json');
    const invokingLock = join(invokingRoot, 'package-lock.json');
    if (existsSync(join(invokingRoot, 'node_modules')) && sameFile(lock, invokingLock)) {
      linkNodeModules(join(invokingRoot, 'node_modules'), join(path, 'node_modules'));
    } else {
      await npmCi(path, log);
      mkdirSync(join(path, 'node_modules', '.vite'), { recursive: true });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { path, sha, cleanup };
}
