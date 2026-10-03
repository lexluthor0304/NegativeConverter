// Only resources created by this harness are registered here. Kill process
// groups before removing worktrees, and before releasing the machine lock.
import { execFileSync } from 'node:child_process';

const processes = new Set();
const worktrees = new Set();

export function registerProcess(child, { detached = process.platform !== 'win32' } = {}) {
  const entry = { child, detached };
  processes.add(entry);
  return () => processes.delete(entry);
}

export function registerWorktree(repo, path) {
  const entry = { repo, path };
  worktrees.add(entry);
  return () => worktrees.delete(entry);
}

export function killProcess(child, { detached = process.platform !== 'win32' } = {}) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(detached ? -child.pid : child.pid, 'SIGKILL');
  } catch { /* the group may already be gone */ }
}

export function cleanupResources({ removeWorktrees = true } = {}) {
  for (const { child, detached } of processes) killProcess(child, { detached });
  processes.clear();
  const errors = [];
  for (const entry of worktrees) {
    if (removeWorktrees) {
      // Synchronous as well as idempotent: this also runs in the exit hook.
      try { execFileSync('git', ['-C', entry.repo, 'worktree', 'remove', '--force', entry.path], { stdio: 'ignore' }); }
      catch (error) { errors.push(error); continue; }
    }
    worktrees.delete(entry);
  }
  if (errors.length) throw new AggregateError(errors, 'failed to remove harness worktrees');
}
