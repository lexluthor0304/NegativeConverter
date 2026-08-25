// Consistency checker for version numbers that live in two places at once.
//
// main.js pins @neoanaloglabkk/lensfun-wasm into a jsDelivr URL, so the copy the
// browser fetches at runtime is a separate source of truth from the npm range the
// bundle is built against. A dependency bump that only touches package.json would
// silently leave the runtime on the old dist, so this catches that drift.
//
// Ranges are compared on their declared version (the caret is stripped), which is
// what an automated bump rewrites.
//
//   node scripts/check-pinned-versions.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const pins = [
  {
    dependency: '@neoanaloglabkk/lensfun-wasm',
    constant: 'LENSFUN_PACKAGE_VERSION',
    file: join('negative2positive', 'src', 'app', 'main.js'),
  },
];

const problems = [];

for (const { dependency, constant, file } of pins) {
  const range = pkg.dependencies?.[dependency] ?? pkg.devDependencies?.[dependency];
  if (!range) {
    problems.push(`${dependency} is pinned in ${file} but missing from package.json`);
    continue;
  }
  const declared = range.replace(/^[\^~>=<\s]+/, '');
  const source = readFileSync(join(repoRoot, file), 'utf8');
  const match = source.match(new RegExp(`const\\s+${constant}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`));
  if (!match) {
    problems.push(`${constant} not found in ${file}`);
    continue;
  }
  if (match[1] !== declared) {
    problems.push(
      `${file}: ${constant} is '${match[1]}' but package.json declares ${dependency}@${declared}`
    );
  }
}

if (problems.length) {
  console.error(`Pinned version check: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Pinned version check: ${pins.length} pin(s) OK`);
