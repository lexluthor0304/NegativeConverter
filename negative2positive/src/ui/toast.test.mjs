import assert from 'node:assert/strict';

// Minimal DOM: only what showToast touches.
function element(tag) {
  const listeners = new Map();
  const classes = new Set();
  return {
    tag, children: [], dataset: {}, textContent: '', removed: false,
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
    get className() { return [...classes].join(' '); },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) || []), handler]); },
    dispatch(type) { const handlers = listeners.get(type) || []; listeners.delete(type); handlers.forEach(handler => handler()); },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    remove() { this.removed = true; }
  };
}
const container = element('div');
const timers = [];
globalThis.document = { getElementById: id => id === 'toastContainer' ? container : null, createElement: element };
globalThis.requestAnimationFrame = callback => callback();
globalThis.setTimeout = (callback, delay) => { timers.push({ callback, delay, cleared: false }); return timers.length - 1; };
globalThis.clearTimeout = id => { if (timers[id]) timers[id].cleared = true; };
const { showToast } = await import('./toast.js');

const plain = showToast('Saved', 3000);
assert.equal(plain.element.textContent, 'Saved');
assert.equal(plain.element.children.length, 0, 'plain toasts have no button');
assert.ok(plain.element.classList.contains('toast-visible'));
assert.equal(timers.at(-1).delay, 3000);
timers.at(-1).callback();
assert.equal(plain.element.classList.contains('toast-visible'), false);
plain.element.dispatch('transitionend');
assert.ok(plain.element.removed);

let clicks = 0;
const actionable = showToast('12 photos treated as B&W negatives.', 12000, { action: { id: 'rollPositives', label: 'These are positives', onClick: () => clicks++ } });
const [button] = actionable.element.children;
assert.ok(actionable.element.classList.contains('toast-with-action'));
assert.equal(button.textContent, 'These are positives');
assert.equal(button.dataset.toastAction, 'rollPositives');
assert.equal(button.type, 'button');
button.dispatch('click');
button.dispatch('click');
assert.equal(clicks, 1, 'the action runs once');
assert.equal(actionable.element.classList.contains('toast-visible'), false, 'running the action closes the toast');
assert.ok(timers.at(-1).cleared, 'and cancels its timer');
assert.equal(showToast('x', 1, { action: { label: 'no handler' } }).element.children.length, 0);

// #229 review R1-018: a hidden page runs no frames (requestAnimationFrame is
// paused) while its timers still fire. A roll toast made at the end of a long
// import in a background window is shown when the page is seen again and
// stays for its whole duration from then; its action still works. 5f23eb0
// started the duration at once: the toast closed unseen and its fade-in's
// transitionend removed it about 0.25 s after the page came back.
{
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  const before = timers.length;
  let corrections = 0;
  const roll = showToast('5 photos treated as B&W negatives.', 12000, { action: { id: 'rollPositives', label: 'These are positives', onClick: () => corrections++ } });
  const plainHidden = showToast('Roll analysis: 5 of 5 frames locked', 3200);
  // Minutes pass in the hidden page: every timer it set fires.
  for (const timer of timers.slice(before)) if (!timer.cleared) timer.callback();
  assert.equal(timers.length, before, 'no duration runs before the toast is shown');
  assert.ok(!roll.element.removed && !plainHidden.element.removed, 'both wait for the page to be seen');
  // The page is visible again: its first frame shows them.
  for (const frame of frames.splice(0)) frame();
  assert.ok(roll.element.classList.contains('toast-visible'));
  assert.deepEqual(timers.slice(before).map(timer => timer.delay), [12000, 3200], 'each duration starts when shown');
  roll.element.dispatch('transitionend');
  assert.ok(!roll.element.removed && roll.element.classList.contains('toast-visible'), 'the fade-in ends with the toast on screen');
  roll.element.children[0].dispatch('click');
  assert.equal(corrections, 1, 'the correction is still offered');
  roll.element.dispatch('transitionend');
  assert.ok(roll.element.removed);
  timers.at(-1).callback();
  plainHidden.element.dispatch('transitionend');
  assert.ok(plainHidden.element.removed, 'a plain toast closes after its full duration');

  // Dismissed before it was ever shown: removed at once, never shown later.
  const early = showToast('Settings saved', 2000);
  early.dismiss();
  assert.ok(early.element.removed, 'nothing to fade out');
  for (const frame of frames.splice(0)) frame();
  assert.ok(!early.element.classList.contains('toast-visible'));
  assert.equal(timers.at(-1).delay, 3200, 'and no duration was started for it');
}
globalThis.document = { getElementById: () => null, createElement: element };
assert.equal(showToast('nowhere'), null);
console.log('toast: plain and action toasts, and toasts made in a hidden page, passed');
