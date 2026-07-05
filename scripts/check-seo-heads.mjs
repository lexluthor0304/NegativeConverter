// Consistency checker for the hand-maintained SEO page <head>s.
// The nine static pages duplicate their head boilerplate by hand; this script
// catches drift (missing tags, canonical/og mismatches, stale theme-color)
// without imposing a templating system on the authoring flow.
//
//   node scripts/check-seo-heads.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://negative-converter.tokugai.com';
const PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'negative2positive');

const pages = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.html'));
const problems = [];
const seenTitles = new Map();
const seenDescriptions = new Map();
const themeColors = new Map();

const attr = (html, re) => {
  const m = html.match(re);
  return m ? m[1].trim() : null;
};

for (const page of pages) {
  const html = readFileSync(join(PAGES_DIR, page), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const flag = (msg) => problems.push(`${page}: ${msg}`);

  if (!/<html\s+lang="[a-z-]+"/i.test(html)) flag('missing <html lang>');
  if (!/<meta\s+name="viewport"/i.test(head)) flag('missing viewport meta');

  const title = attr(head, /<title>([^<]*)<\/title>/i);
  if (!title) flag('missing <title>');
  else if (seenTitles.has(title)) flag(`duplicate <title> (also in ${seenTitles.get(title)})`);
  else seenTitles.set(title, page);

  const desc = attr(head, /<meta\s+name="description"\s+content="([^"]*)"/i);
  if (!desc) flag('missing meta description');
  else {
    if (desc.length < 50 || desc.length > 170) {
      flag(`meta description length ${desc.length} (want 50-170)`);
    }
    if (seenDescriptions.has(desc)) flag(`duplicate description (also in ${seenDescriptions.get(desc)})`);
    else seenDescriptions.set(desc, page);
  }

  const canonical = attr(head, /<link\s+rel="canonical"\s+href="([^"]*)"/i);
  if (!canonical) flag('missing canonical link');
  else if (!canonical.startsWith(SITE)) flag(`canonical not on ${SITE}: ${canonical}`);

  const ogUrl = attr(head, /<meta\s+property="og:url"\s+content="([^"]*)"/i);
  if (!ogUrl) flag('missing og:url');
  else if (canonical && ogUrl !== canonical) flag(`og:url (${ogUrl}) != canonical (${canonical})`);

  for (const required of ['og:title', 'og:description', 'og:image']) {
    if (!head.includes(`property="${required}"`)) flag(`missing ${required}`);
  }
  if (!head.includes('name="twitter:card"')) flag('missing twitter:card');

  if (!/hreflang="x-default"/.test(head)) flag('missing hreflang x-default');

  const theme = attr(head, /<meta\s+name="theme-color"\s+content="([^"]*)"/i);
  if (!theme) flag('missing theme-color');
  else themeColors.set(page, theme);
}

// All pages must agree on one theme-color (catches redesign drift)
const distinctThemes = [...new Set(themeColors.values())];
if (distinctThemes.length > 1) {
  const byTheme = {};
  for (const [page, theme] of themeColors) (byTheme[theme] ||= []).push(page);
  problems.push(`theme-color drift: ${JSON.stringify(byTheme)}`);
}

if (problems.length) {
  console.error(`SEO head check: ${problems.length} problem(s) in ${pages.length} pages`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`SEO head check: ${pages.length} pages OK`);
