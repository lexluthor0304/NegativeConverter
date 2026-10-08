import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, defaultLockPath, LockHeldError, readLock, isProcessAlive } from './lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nc-perf-lock-'));
const path = join(dir, 'bench.lock');

try {
  // The default path is machine-wide: it ignores $TMPDIR / os.tmpdir().
  assert.equal(defaultLockPath({ platform: 'darwin', env: { TMPDIR: '/var/folders/aa/T/' } }), '/tmp/negativeconverter-bench.lock');
  assert.equal(defaultLockPath({ platform: 'darwin', env: { TMPDIR: '/private/tmp/claude-501/x' } }), '/tmp/negativeconverter-bench.lock');
  assert.equal(defaultLockPath({ platform: 'linux', env: {} }), '/tmp/negativeconverter-bench.lock');
  assert.equal(defaultLockPath({ platform: 'win32', env: { TEMP: 'C:\\Temp' } }), join('C:\\Temp', 'negativeconverter-bench.lock'));
  assert.equal(defaultLockPath({ env: { NC_PERF_LOCK: '/x/y.lock' } }), '/x/y.lock');

  // Acquire, then a second acquisition fails immediately and names the holder.
  const lock = acquireLock({ path, argv: ['bench', '--quick'] });
  assert.equal(readLock(path).pid, process.pid);
  assert.deepEqual(readLock(path).argv, ['bench', '--quick']);
  assert.throws(() => acquireLock({ path }), error => error instanceof LockHeldError
    && error.holder.pid === process.pid && error.message.includes(`PID ${process.pid}`));
  lock.release();
  assert.equal(existsSync(path), false, 'release removes the lock');
  lock.release();

  // A stale lock (dead PID) is reclaimed.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const deadPid = Number(dead.stdout.toString());
  assert.equal(isProcessAlive(deadPid), false);
  writeFileSync(path, JSON.stringify({ pid: deadPid, startedAt: '2026-09-23T00:00:00.000Z', argv: ['old'] }));
  const reclaimed = acquireLock({ path });
  assert.equal(reclaimed.reclaimed.pid, deadPid);
  assert.equal(readLock(path).pid, process.pid);

  // Release never deletes a lock another run has taken over.
  writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: 'someone else' }));
  reclaimed.release();
  assert.equal(existsSync(path), true);
  rmSync(path);

  // An unreadable lock is left alone while fresh, reclaimed once old.
  writeFileSync(path, '{');
  assert.throws(() => acquireLock({ path }), LockHeldError);
  const old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);
  acquireLock({ path }).release();

  // Force both contenders to observe the same stale owner before either
  // reclaims it. Exactly one may hold the machine lock afterward.
  writeFileSync(path, JSON.stringify({ pid: deadPid, startedAt: 'old', argv: [] }));
  const raceScript = `
    import { acquireLock, isProcessAlive } from ${JSON.stringify(join(here, 'lock.mjs'))};
    import { existsSync, writeFileSync } from 'node:fs';
    const barrier = ${JSON.stringify(join(dir, 'race-'))};
    const side = process.argv[1];
    let first = true;
    try {
      const lock = acquireLock({ path: ${JSON.stringify(path)}, isAlive: pid => {
        if (first && pid === ${deadPid}) {
          first = false; writeFileSync(barrier + side, 'ready');
          const end = Date.now() + 5000;
          while (!existsSync(barrier + (side === 'a' ? 'b' : 'a'))) {
            if (Date.now() > end) throw new Error('barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
        }
        return isProcessAlive(pid);
      } });
      process.stdout.write('holder\\n');
      process.stdin.once('data', () => { lock.release(); process.exit(0); });
    } catch (error) { process.stdout.write('refused\\n'); process.exit(error.code === 'NC_PERF_LOCKED' ? 3 : 1); }
  `;
  const contenders = ['a', 'b'].map(side => spawn(process.execPath, ['--input-type=module', '-e', raceScript, side]));
  const decisions = await Promise.all(contenders.map(child => new Promise(resolve => child.stdout.once('data', data => resolve(String(data).trim())))));
  assert.deepEqual(decisions.sort(), ['holder', 'refused']);
  for (const child of contenders) if (child.exitCode === null) child.stdin.end('done');
  await Promise.all(contenders.map(child => child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
  assert.equal(existsSync(path), false);

  // Two processes with different $TMPDIR values: the second exits within 1 s
  // and names the holder PID.
  const script = `
    import { acquireLock, releaseOnExit } from ${JSON.stringify(join(here, 'lock.mjs'))};
    try {
      releaseOnExit(acquireLock({ path: ${JSON.stringify(path)} }));
      process.stdout.write('acquired\\n');
      setTimeout(() => process.exit(0), Number(process.argv[1]));
    } catch (error) { process.stderr.write(error.message); process.exit(3); }
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', script, '4000'], { env: { ...process.env, TMPDIR: join(dir, 'a') } });
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', chunk => { if (String(chunk).includes('acquired')) resolve(); });
    holder.once('exit', code => reject(new Error(`holder exited early (${code})`)));
  });
  const started = Date.now();
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', script, '0'], { env: { ...process.env, TMPDIR: join(dir, 'b') }, timeout: 10_000 });
  const elapsed = Date.now() - started;
  assert.equal(second.status, 3, 'the second run refuses to start');
  assert.match(second.stderr.toString(), new RegExp(`PID ${holder.pid}`));
  assert.ok(elapsed < 1000 + 500, `the second run exits within about 1 s (took ${elapsed} ms, including Node startup)`);
  holder.kill('SIGTERM');
  await new Promise(resolve => holder.once('exit', resolve));
  assert.equal(existsSync(path), false, 'SIGTERM releases the lock');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('lock: machine-wide path, exclusive acquire, stale reclaim and concurrent-run tests passed');
