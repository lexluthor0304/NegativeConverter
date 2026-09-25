import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #236 part 3: the first photo, geometry edits and single export wait on no
// fixed timers, every overlay hide on the import path belongs to the current
// load, and the minimum display time lives in CSS.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}

for (const name of ['loadFile', 'prepareStudioPhoto', 'processNegative', 'exportSingle']) {
  const body = functionSource(name);
  for (const match of body.matchAll(/setTimeout\(\s*\w+\s*,\s*(\d+)\s*\)/g)) {
    assert.ok(Number(match[1]) < 100, `${name} still awaits a ${match[1]} ms timer`);
  }
}

// Every hide of the shared overlay on the import path checks the load.
for (const name of ['loadFile', 'prepareStudioPhoto', 'processNegative']) {
  const lines = functionSource(name).split('\n');
  const hides = lines.map((line, index) => [line, index]).filter(([line]) => /overlay\.hide\(\)/.test(line));
  assert.ok(hides.length, `${name} hides its overlay`);
  const indent = line => line.match(/^\s*/)[0].length;
  for (const [line, index] of hides) {
    // The hide itself is conditional on the load, the line before returns
    // for a stale load, or the enclosing block is entered only for it.
    let opener = index - 1;
    while (opener > 0 && indent(lines[opener]) >= indent(line)) opener--;
    const guarded = /isCurrentLoad\(generation\)/.test(line)
      || /if \(!isCurrentLoad\(generation\)\) return/.test(lines[index - 1])
      || /if \(isCurrentLoad\(generation\)[^{]*\{\s*$/.test(lines[opener]);
    assert.ok(guarded, `${name}: unguarded hide: ${line.trim()}`);
  }
}
// loadFile keeps its overlay up for the conversion when it converts itself.
assert.match(functionSource('loadFile'), /if \(!autoConvert && isCurrentLoad\(generation\)\) overlay\.hide\(\);/);

const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
const studioCss = readFileSync(new URL('../styles/studio.css', import.meta.url), 'utf8');
const rule = (selector, source = css) => {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  return source.slice(start, source.indexOf('}', start));
};
assert.match(rule('.loading-overlay.visible'), /transition-delay:\s*150ms/, 'conversions under 150 ms never raise the overlay');
// One hidden-state rule (studio.css, #261) sets the short fade and the
// visibility step at its end, whatever order the two stylesheets load in.
const hidden = rule('.loading-overlay:not(.visible)', studioCss);
assert.match(hidden, /--loading-overlay-hide:\s*90ms/);
assert.match(hidden, /transition-duration:\s*var\(--loading-overlay-hide, \.3s\), 0s/);
assert.match(hidden, /transition-delay:\s*0s, var\(--loading-overlay-hide, \.3s\)/);
assert.equal((css + studioCss).split('.loading-overlay:not(.visible) {').length - 1, 1, 'keep one hidden-state overlay rule');
console.log('import dwells: no fixed waits, guarded overlay hides, CSS minimum display time');
