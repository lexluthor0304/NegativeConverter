import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RELEASE_BASE_URL,
  honoursReleaseBaseOverride,
  normalizeBaseUrl,
  releaseManifestBases,
  releaseManifestUrl
} from './downloadCandidates.js';

const ATTACKER = 'https://attacker.example';
const withParam = (page, name, value) => `${page}${page.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;

// The site, and every host that is neither loopback nor a Vercel preview,
// reads the release bucket only, whatever the link says (R2-050).
const ignoring = [
  'https://negative-converter.tokugai.com/download.html',
  'https://negative-converter.tokugai.com/download.html?lang=ja&from=desktop-update',
  'https://NEGATIVE-CONVERTER.tokugai.com/download.html',
  'http://negative-converter.tokugai.com/download.html',
  'https://www.negative-converter.tokugai.com/download.html',
  'https://localhost.attacker.example/download.html',
  'https://127.0.0.1.attacker.example/download.html',
  'https://vercel.app.attacker.example/download.html',
  'https://preview.vercel.app.attacker.example/download.html',
  'https://attacker-vercel.app/download.html',
  'https://attacker.example/download.html?host=x.vercel.app',
  'https://attacker.example/x.vercel.app/download.html',
  'tauri://localhost/download.html',
  'http://tauri.localhost/download.html',
  'file:///Users/someone/download.html',
  'not a url'
];
for (const page of ignoring) {
  assert.equal(honoursReleaseBaseOverride(page), false, page);
  assert.deepEqual(releaseManifestBases(page), [RELEASE_BASE_URL], page);
  for (const name of ['r2_base', 'r2Base']) {
    for (const value of [ATTACKER, `${ATTACKER}/`, 'http://127.0.0.1:8080']) {
      assert.deepEqual(releaseManifestBases(withParam(page, name, value)), [RELEASE_BASE_URL], `${page} ${name}=${value}`);
    }
  }
}

// A loopback host or a Vercel preview tries the override first, then the bucket.
const honouring = [
  'http://localhost:4173/download.html',
  'http://127.0.0.1:5411/download.html?lang=zh',
  'http://[::1]:4173/download.html',
  'https://negative-converter-git-fix-lexluthor0304s-projects.vercel.app/download.html',
  'https://negative-converter-abc123def.vercel.app/download.html?lang=en'
];
for (const page of honouring) {
  assert.equal(honoursReleaseBaseOverride(page), true, page);
  assert.deepEqual(releaseManifestBases(page), [RELEASE_BASE_URL], page);
  assert.deepEqual(releaseManifestBases(withParam(page, 'r2_base', ATTACKER)), [ATTACKER, RELEASE_BASE_URL], page);
  assert.deepEqual(releaseManifestBases(withParam(page, 'r2Base', 'https://staging.example/')), ['https://staging.example', RELEASE_BASE_URL]);
  assert.deepEqual(releaseManifestBases(withParam(page, 'r2_base', ' https://staging.example/bucket// ')), ['https://staging.example/bucket', RELEASE_BASE_URL]);
  // r2_base wins over r2Base, as before.
  assert.deepEqual(releaseManifestBases(withParam(withParam(page, 'r2Base', 'https://b.example'), 'r2_base', 'https://a.example')), ['https://a.example', RELEASE_BASE_URL]);
  // The bucket itself is not tried twice.
  assert.deepEqual(releaseManifestBases(withParam(page, 'r2_base', `${RELEASE_BASE_URL}/`)), [RELEASE_BASE_URL]);
  // Only an http(s) base can become a download link.
  for (const value of ['javascript:alert(1)', 'data:text/plain,x', 'ftp://staging.example', 'staging.example', '']) {
    assert.deepEqual(releaseManifestBases(withParam(page, 'r2_base', value)), [RELEASE_BASE_URL], `${page} r2_base=${value}`);
  }
}

// The site never offers itself as a manifest host: it has no copy (R2-048).
for (const page of [...ignoring, ...honouring]) {
  assert.ok(!releaseManifestBases(page).includes('https://negative-converter.tokugai.com'), page);
}

assert.equal(releaseManifestUrl(RELEASE_BASE_URL), 'https://download.neoanaloglab.com/negative-converter/release/latest.json');
assert.equal(releaseManifestUrl('https://staging.example//'), 'https://staging.example/negative-converter/release/latest.json');
assert.equal(normalizeBaseUrl('  https://staging.example/ '), 'https://staging.example');
assert.equal(normalizeBaseUrl(null), '');

// download.html takes its bases from this module and reads no override itself.
const page = readFileSync(new URL('../../download.html', import.meta.url), 'utf8');
assert.match(page, /<script type="module">\s*import \{[^}]*\breleaseManifestBases\b[^}]*\} from '\.\/src\/app\/downloadCandidates\.js';/,
  'download.html: its page script must be a module importing releaseManifestBases from ./src/app/downloadCandidates.js');
assert.match(page, /releaseManifestBases\(window\.location\.href\)/, 'download.html: bases must come from releaseManifestBases(window.location.href)');
assert.match(page, /releaseManifestUrl\(base\)/, 'download.html: manifest URLs must come from releaseManifestUrl(base)');
assert.doesNotMatch(page, /['"`]r2(?:_base|Base)['"`]/, 'download.html reads ?r2_base= itself');
assert.doesNotMatch(page, /negative-converter\/release\/latest\.json/, 'download.html builds a manifest URL itself');

console.log('download candidates: the release bucket only on the site; ?r2_base= on loopback and preview hosts, http(s) only; download.html wired');
