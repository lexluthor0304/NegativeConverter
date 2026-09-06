// The response headers live in two places on purpose.
//
// .vercel/project.json records rootDirectory "negative2positive", so Vercel
// reads negative2positive/vercel.json and the repo-root file is inert — but the
// same project.json also records outputDirectory "negative2positive/dist",
// which only makes sense relative to the repo root. Rather than guess which
// half is stale and risk shipping without the security headers, both files
// carry them. That only stays safe while they agree, so this checks it.
//
//   node scripts/check-vercel-config.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootConfigPath = join(repoRoot, 'vercel.json');
const appConfigPath = join(repoRoot, 'negative2positive', 'vercel.json');

const problems = [];
const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push(`${path}: ${err.message}`);
    return null;
  }
};

const rootConfig = read(rootConfigPath);
const appConfig = read(appConfigPath);

if (rootConfig && appConfig) {
  const rootHeaders = JSON.stringify(rootConfig.headers ?? null);
  const appHeaders = JSON.stringify(appConfig.headers ?? null);
  if (rootHeaders === 'null') problems.push('vercel.json defines no headers');
  if (appHeaders === 'null') problems.push('negative2positive/vercel.json defines no headers');
  if (rootHeaders !== appHeaders) {
    problems.push(
      'headers drift between vercel.json and negative2positive/vercel.json — '
      + 'whichever file Vercel reads must carry the same rules'
    );
  }

  // The rules the site is expected to send. Losing one is silent in a build log.
  const required = [
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
    'Cache-Control',
  ];
  const declared = new Set(
    (appConfig.headers || []).flatMap((entry) => (entry.headers || []).map((h) => h.key))
  );
  for (const key of required) {
    if (!declared.has(key)) problems.push(`missing ${key} header rule`);
  }
}

if (problems.length) {
  console.error(`Vercel config check: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Vercel config check: header rules present and in sync');
