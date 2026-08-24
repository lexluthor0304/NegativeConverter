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

let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [t], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL ${t}`);
  } else {
    console.log(`PASS ${t}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
