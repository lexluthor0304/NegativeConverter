// Runs every *.test.mjs under negative2positive/src with plain node.
// Test files are standalone assert scripts (see e.g. imageDataOps.test.mjs).
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'negative2positive', 'src');

const tests = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.test.mjs')) tests.push(p);
  }
})(root);

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
