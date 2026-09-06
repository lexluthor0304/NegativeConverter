import assert from 'node:assert/strict';
import { createOpenCvLoader } from './opencvLoader.js';

const activeTimers = new Set();
let scripts = [], behavior;
globalThis.window = {
  setTimeout(callback, ms) {
    const timer = setTimeout(() => { activeTimers.delete(timer); callback(); }, ms);
    activeTimers.add(timer); return timer;
  },
  clearTimeout(timer) { clearTimeout(timer); activeTimers.delete(timer); },
};
class Script extends EventTarget {
  dataset = {};
  remove() { scripts = scripts.filter(script => script !== this); }
}
globalThis.document = {
  querySelectorAll: () => scripts,
  createElement: () => new Script(),
  head: { appendChild(script) { scripts.push(script); queueMicrotask(() => behavior(script)); } },
};
function loaded(script, cv) {
  window.cv = cv;
  script.onload?.(); script.dispatchEvent(new Event('load'));
}
const options = { scriptTimeoutMs: 15, runtimeTimeoutMs: 15 };

// ダウンロード停止から次の配信元へ移り、同時要求は同じ読込を共有する。
let appended = 0;
behavior = script => { appended++; if (script.src === 'good') loaded(script, Promise.resolve({ Mat: class {} })); };
const ensure = createOpenCvLoader(['stalled', 'good'], options);
assert.deepEqual(await Promise.all([ensure(), ensure()]), [true, true]);
assert.equal(appended, 2);
assert.equal(activeTimers.size, 0);
assert.ok(!scripts.some(script => script.src === 'stalled'));

// 全配信元失敗後、次の要求で読込をやり直せる。
scripts = []; window.cv = undefined; behavior = () => {};
const retry = createOpenCvLoader(['retry'], options);
assert.equal(await retry(), false);
behavior = script => loaded(script, { Mat: class {} });
assert.equal(await retry(), true);
assert.equal(activeTimers.size, 0);

// WASMのPromiseが停止した場合も期限内に失敗して次の配信元を使う。
scripts = []; window.cv = undefined;
behavior = script => loaded(script, script.src === 'runtime-stalled' ? new Promise(() => {}) : { Mat: class {} });
assert.equal(await createOpenCvLoader(['runtime-stalled', 'runtime-good'], options)(), true);
assert.equal(activeTimers.size, 0);
scripts = []; window.cv = undefined;
behavior = script => loaded(script, new Promise(() => {}));
const runtimeRetry = createOpenCvLoader(['same-runtime'], options);
assert.equal(await runtimeRetry(), false);
behavior = script => loaded(script, { Mat: class {} });
assert.equal(await runtimeRetry(), true);
assert.equal(activeTimers.size, 0);
console.log('opencvLoader tests passed');
