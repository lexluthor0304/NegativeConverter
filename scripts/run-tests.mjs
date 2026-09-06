// Runs every *.test.mjs under negative2positive/src and negative2positive/api
// with plain node. Test files are standalone assert scripts.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [
  join(repoRoot, 'negative2positive', 'src'),
  join(repoRoot, 'negative2positive', 'api'),
].filter(existsSync);

const tests = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.mjs')) tests.push(p);
  }
}
roots.forEach(walk);

// Repo-wide consistency checks count as part of the suite
const scriptsDir = dirname(fileURLToPath(import.meta.url));
tests.push(join(scriptsDir, 'check-seo-heads.mjs'));
tests.push(join(scriptsDir, 'check-pinned-versions.mjs'));
tests.push(join(scriptsDir, 'check-vercel-config.mjs'));
tests.push(join(scriptsDir, 'check-appstore-screenshots.mjs'));

// A test that leaves an open handle would otherwise hang the whole suite.
const TIMEOUT_MS = 120_000;

let failed = 0;
let timedOut = 0;
for (const t of tests) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [t], {
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const ms = Date.now() - started;
  if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGKILL')) {
    failed += 1;
    timedOut += 1;
    console.error(`TIMEOUT ${t} (killed after ${TIMEOUT_MS / 1000}s)`);
  } else if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL ${t} (${ms}ms)`);
  } else {
    console.log(`PASS ${t} (${ms}ms)`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test files passed`
  + (timedOut ? ` (${timedOut} timed out)` : ''));
process.exit(failed ? 1 : 0);
