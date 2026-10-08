// The response headers live in two places on purpose.
//
// .vercel/project.json records rootDirectory "negative2positive", so Vercel
// reads negative2positive/vercel.json and the repo-root file is inert — but the
// same project.json also records outputDirectory "negative2positive/dist",
// which only makes sense relative to the repo root. Rather than guess which
// half is stale and risk shipping without the security headers, both files
// carry them. That only stays safe while they agree, so this checks it.
//
//
// The catch-all rule also carries the cross-origin isolation pair (#264):
// every response needs it, because dedicated worker scripts under /assets/
// need COEP on their own responses.
//
//   node scripts/check-vercel-config.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CROSS_ORIGIN_ISOLATION_HEADERS } from './cross-origin-isolation.mjs';

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

  const catchAll = (appConfig.headers || []).find((entry) => entry.source === '/(.*)');
  if (!catchAll) {
    problems.push('no "/(.*)" header rule to carry the cross-origin isolation headers');
  } else {
    for (const [key, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
      const found = (catchAll.headers || []).find((h) => h.key === key);
      if (!found) problems.push(`"/(.*)" rule is missing ${key}: ${value}`);
      else if (found.value !== value) problems.push(`"/(.*)" rule sends ${key}: ${found.value}, expected ${value}`);
    }
  }
}

if (problems.length) {
  console.error(`Vercel config check: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Vercel config check: header rules present and in sync');
