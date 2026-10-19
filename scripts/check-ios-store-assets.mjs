import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const UPNG = createRequire(import.meta.url)('upng-js');
const root = new URL('../fastlane/ios/', import.meta.url);
const limits = { 'description.txt': 4000, 'keywords.txt': 100, 'release_notes.txt': 4000 };
for (const [name, limit] of Object.entries(limits)) {
  const value = readFileSync(new URL(`metadata/en-US/${name}`, root), 'utf8').trim();
  assert.ok(value.length > 0 && [...value].length <= limit, `Invalid ${name} length`);
}
for (const name of ['support_url.txt', 'marketing_url.txt']) {
  const value = readFileSync(new URL(`metadata/en-US/${name}`, root), 'utf8').trim();
  assert.equal(new URL(value).protocol, 'https:', name);
}
const folder = new URL('screenshots/en-US/', root);
assert.ok(existsSync(folder), 'Native iPhone/iPad store captures are missing; see fastlane/ios/screenshots/README.md');
const groups = { 'iphone-medium': ['1179x2556', '1206x2622'], 'ipad13': ['2064x2752', '2048x2732'] };
const counts = Object.fromEntries(Object.keys(groups).map(k => [k, 0]));
const names = readdirSync(folder).filter(n => !n.startsWith('.'));
for (const name of names) {
  const group = Object.keys(groups).find(k => name.startsWith(`${k}-`) && name.endsWith('.png'));
  assert.ok(group, `Unexpected iOS screenshot: ${name}`);
  const png = UPNG.decode(readFileSync(new URL(name, folder)));
  const size = [png.width, png.height].sort((a, b) => a - b).join('x');
  assert.ok(groups[group].includes(size), `${name}: wrong device dimensions`);
  assert.equal(png.depth, 8, name);
  assert.equal(png.ctype, 2, `${name}: opaque RGB PNG required`);
  const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
  assert.equal(rgba.length, png.width * png.height * 4, `${name}: incomplete decode`);
  let low = 255, high = 0;
  for (let i = 0; i < rgba.length; i += 4) { low = Math.min(low, rgba[i]); high = Math.max(high, rgba[i]); }
  assert.ok(high - low > 100, `${name}: blank screenshot`);
  counts[group]++;
}
for (const [group, count] of Object.entries(counts)) assert.ok(count >= 1 && count <= 10, `${group}: 1..10 native captures required`);
console.log('iOS metadata and native screenshot sets passed');
