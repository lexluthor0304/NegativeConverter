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
globalThis.document = { getElementById: () => null, createElement: element };
assert.equal(showToast('nowhere'), null);
console.log('toast: plain and action toasts passed');
