import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRefWorktree, snapshotWorktree, resolveCommit, isDirty, git } from './worktree.mjs';
import { buildArgs, previewArgs } from './build.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-perf-wt-')));
const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
try {
  // A tiny repository standing in for the invoking checkout.
  const repo = join(root, 'repo');
  mkdirSync(repo);
  sh(repo, 'init', '-q');
  sh(repo, 'config', 'user.email', 'bench@example.invalid');
  sh(repo, 'config', 'user.name', 'bench');
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(repo, 'app.js'), 'export const v = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'one');
  mkdirSync(join(repo, 'node_modules', 'vite'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '@scope', 'pkg'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '.vite', 'deps'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });

  const sha = await resolveCommit(repo, 'HEAD');
  const tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const worktree = await createRefWorktree({ repo, sha, tmpRoot: tmp, invokingRoot: repo });
  assert.ok(existsSync(join(worktree.path, 'app.js')), 'the ref is checked out');
  assert.equal(sh(worktree.path, 'rev-parse', 'HEAD'), sha);
  assert.equal(sh(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
  assert.ok(lstatSync(join(worktree.path, 'node_modules')).isDirectory(), 'node_modules is a real directory');
  assert.ok(lstatSync(join(worktree.path, 'node_modules', 'vite')).isSymbolicLink(), 'packages are symlinks');
  assert.equal(readlinkSync(join(worktree.path, 'node_modules', '@scope')), join(repo, 'node_modules', '@scope'));
  assert.ok(lstatSync(join(worktree.path, 'node_modules', '.bin')).isSymbolicLink());
  const vite = lstatSync(join(worktree.path, 'node_modules', '.vite'));
  assert.ok(vite.isDirectory() && !vite.isSymbolicLink(), 'its own, empty Vite cache');
  assert.equal(existsSync(join(worktree.path, 'node_modules', '.vite', 'deps')), false);
  assert.equal(await isDirty(worktree.path), false, 'symlinked node_modules is ignored by git');
  await worktree.cleanup();
  assert.equal(existsSync(worktree.path), false, 'the worktree is removed');
  assert.equal(sh(repo, 'worktree', 'list').split('\n').length, 1, 'and unregistered');

  // A different lockfile runs npm ci instead of linking.
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  sh(repo, 'commit', '-qam', 'two');
  const sha2 = await resolveCommit(repo, 'HEAD');
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  let ciRan = null;
  const other = await createRefWorktree({ repo, sha: sha2, tmpRoot: tmp, invokingRoot: repo, npmCi: async cwd => { ciRan = cwd; } });
  assert.equal(ciRan, other.path);
  assert.ok(existsSync(join(other.path, 'node_modules', '.vite')));
  await other.cleanup();
  sh(repo, 'checkout', '-q', 'package-lock.json');

  // --head WORKTREE: uncommitted tracked changes are snapshotted without
  // touching the working tree; untracked files are not included.
  assert.deepEqual(await snapshotWorktree(repo), { sha: sha2, dirty: false, base: sha2 });
  writeFileSync(join(repo, 'app.js'), 'export const v = 2;\n');
  writeFileSync(join(repo, 'untracked.js'), 'x');
  const snapshot = await snapshotWorktree(repo);
  assert.equal(snapshot.dirty, true);
  assert.notEqual(snapshot.sha, sha2);
  assert.equal(readFileSync(join(repo, 'app.js'), 'utf8'), 'export const v = 2;\n', 'the working tree is untouched');
  assert.equal(sh(repo, 'stash', 'list'), '', 'nothing is pushed onto the stash list');
  const dirtyTree = await createRefWorktree({ repo, sha: snapshot.sha, tmpRoot: tmp, invokingRoot: repo });
  assert.equal(readFileSync(join(dirtyTree.path, 'app.js'), 'utf8'), 'export const v = 2;\n');
  assert.equal(existsSync(join(dirtyTree.path, 'untracked.js')), false);
  await dirtyTree.cleanup();
  assert.deepEqual((await git(repo, ['status', '--porcelain'])).split('\n').map(line => line.trim()).sort(), ['?? untracked.js', 'M app.js'],
    'the invoking checkout keeps its uncommitted state');
} finally {
  rmSync(root, { recursive: true, force: true });
}

assert.deepEqual(buildArgs({ outDir: '/tmp/x/dist-abc' }), ['build', '--config', 'negative2positive/vite.config.js', '--sourcemap', '--outDir', '/tmp/x/dist-abc', '--emptyOutDir']);
assert.deepEqual(previewArgs({ harnessConfig: '/h/scripts/perf/vite.preview.config.js', outDir: '/tmp/d', port: 5297 }),
  ['preview', '--configLoader', 'native', '--config', '/h/scripts/perf/vite.preview.config.js', '--outDir', '/tmp/d', '--port', '5297', '--strictPort', '--host', '127.0.0.1']);

console.log('worktree: detached worktree, symlinked node_modules, own .vite, npm ci fallback, stash snapshot and removal tests passed');
