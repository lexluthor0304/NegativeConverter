// Machine-wide benchmark lock: one heavy run at a time on this machine.
//
// The path is fixed, not os.tmpdir(): macOS gives every user (and sandboxed
// agent sessions) its own $TMPDIR, and isolated worktrees each have their own
// output/, so neither would stop two runs from overlapping. The file is
// created with O_EXCL and holds the owner's PID, start time and argv. A lock
// whose PID is dead is reclaimed.

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { cleanupResources } from './resources.mjs';
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
  const staleRecord = () => {
    const holder = readLock(path);
    let age = 0;
    if (!holder) { try { age = now().getTime() - statSync(path).mtimeMs; } catch { age = Infinity; } }
    return { holder, stale: holder ? !isAlive(holder.pid) : age > 60_000 };
  };
  let reclaimed = null;
  const held = () => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = readLock(path);
      if (current && current.pid === pid && current.startedAt === record.startedAt) {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    };
    return { path, record, release, reclaimed };
  };
  try {
    tryCreate(path, record);
    return held();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const { holder, stale } = staleRecord();
  if (!stale) throw new LockHeldError(path, holder);
  // Serialize reclaimers, then re-read and replace while holding the mutex.
  // A crashed reclaim mutex fails closed instead of risking two heavy runs.
  const reclaimPath = `${path}.reclaim`;
  try { tryCreate(reclaimPath, record); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new LockHeldError(path, readLock(path));
  }
  try {
    const current = staleRecord();
    if (!current.stale) throw new LockHeldError(path, current.holder);
    reclaimed = current.holder;
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // An ordinary creator may win the empty-path window. Never unlink again.
    try { tryCreate(path, record); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new LockHeldError(path, readLock(path));
    }
    return held();
  } finally { unlinkSync(reclaimPath); }
}

/** Release on every way out of the process, including Ctrl-C. */
export function releaseOnExit(lock, { cleanup = cleanupResources } = {}) {
  const handlers = new Map();
  const onExit = () => { try { cleanup(); } finally { lock.release(); } };
  const release = () => {
    process.removeListener('exit', onExit);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    lock.release();
  };
  process.once('exit', onExit);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const handler = () => { try { cleanup(); } finally { release(); process.exit(code); } };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { ...lock, release };
}
