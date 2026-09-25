// Machine-wide benchmark lock: one heavy run at a time on this machine.
//
// The path is fixed, not os.tmpdir(): macOS gives every user (and sandboxed
// agent sessions) its own $TMPDIR, and isolated worktrees each have their own
// output/, so neither would stop two runs from overlapping. The file is
// created with O_EXCL and holds the owner's PID, start time and argv. A lock
// whose PID is dead is reclaimed.

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export function defaultLockPath({ platform = process.platform, env = process.env } = {}) {
  if (env.NC_PERF_LOCK) return env.NC_PERF_LOCK;
  if (platform === 'win32') return join(env.TEMP || env.TMP || 'C:\\Windows\\Temp', 'negativeconverter-bench.lock');
  return '/tmp/negativeconverter-bench.lock';
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

export class LockHeldError extends Error {
  constructor(path, holder) {
    const who = holder
      ? `PID ${holder.pid} (started ${holder.startedAt}${holder.argv ? `: ${holder.argv.join(' ')}` : ''})`
      : 'an unreadable lock file';
    super(`Another benchmark run holds ${path}: ${who}. Wait for it to finish; only one heavy run may use this machine at a time.`);
    this.name = 'LockHeldError';
    this.code = 'NC_PERF_LOCKED';
    this.holder = holder;
    this.path = path;
  }
}

export function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function tryCreate(path, record) {
  const fd = openSync(path, 'wx', 0o644);
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
}

/**
 * Acquire the lock or throw LockHeldError immediately (no waiting).
 * Returns { path, record, release, reclaimed }.
 */
export function acquireLock({
  path = defaultLockPath(),
  pid = process.pid,
  argv = process.argv.slice(1),
  now = () => new Date(),
  isAlive = isProcessAlive
} = {}) {
  const record = { pid, startedAt: now().toISOString(), argv, host: hostname() };
  let reclaimed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      tryCreate(path, record);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // Never delete a lock that another run has since taken over.
        const current = readLock(path);
        if (current && current.pid === pid && current.startedAt === record.startedAt) {
          try { unlinkSync(path); } catch { /* already gone */ }
        }
      };
      return { path, record, release, reclaimed };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLock(path);
      // An unreadable file older than a minute is a crash mid-write.
      let unreadableAgeMs = 0;
      if (!holder) { try { unreadableAgeMs = now().getTime() - statSync(path).mtimeMs; } catch { unreadableAgeMs = Infinity; } }
      const stale = holder ? !isAlive(holder.pid) : unreadableAgeMs > 60_000;
      if (!stale || attempt > 0) throw new LockHeldError(path, holder);
      reclaimed = holder;
      try { unlinkSync(path); } catch { /* a concurrent reclaimer removed it */ }
    }
  }
  throw new LockHeldError(path, readLock(path));
}

/** Release on every way out of the process, including Ctrl-C. */
export function releaseOnExit(lock) {
  const release = () => lock.release();
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { release(); process.exit(130); });
  }
  return lock;
}
