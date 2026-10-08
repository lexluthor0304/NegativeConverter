import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Import intent warms the first photo's pipeline at most once per 30 s, and
// only the triggers call it: nothing runs at page load (#236 part 6).
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}

let now = 1000;
const calls = [];
const context = vm.createContext({
  IMPORT_WARM_UP_INTERVAL_MS: 30_000, importWarmUpAt: -Infinity,
  state: { autoFrame: { enabled: true } },
  getPerfNow: () => now,
  warmUpAutoFrameWorker: () => { calls.push('autoFrame'); return Promise.resolve(true); },
  convertPreviewFrameInWorker: { warmUp: () => { calls.push('conversion'); return Promise.resolve(true); } },
});
vm.runInContext(functionSource('warmImportPipeline'), context);
context.warmImportPipeline();
assert.deepEqual(calls, ['autoFrame', 'conversion']);
now += 29_000;
context.warmImportPipeline();
assert.deepEqual(calls, ['autoFrame', 'conversion'], 'debounced for 30 s');
now += 1_000;
context.state.autoFrame.enabled = false;
context.warmImportPipeline();
assert.deepEqual(calls, ['autoFrame', 'conversion', 'conversion'], 'no OpenCV warm-up when auto-frame is off');

// Every call site is an intent handler: the picker labels (pointer and
// keyboard), the add-files action, a file drag and the watch-folder start.
const callSites = [...source.matchAll(/(?<!function )warmImportPipeline\(\)|'pointerdown', warmImportPipeline/g)].length;
assert.equal(callSites, 5, 'warm-up call sites changed; keep them to import intent');
assert.match(source, /addEventListener\('dragenter', \(event\) => \{\n\s+if \(Array\.from\(event\.dataTransfer\?\.types \|\| \[\]\)\.includes\('Files'\)\) warmImportPipeline\(\);/);
console.log('import warm-up: debounced, intent-only, OpenCV only with auto-frame');
