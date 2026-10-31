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
const { showToast, readingTimeMs, TOAST_MIN_MS, TOAST_MAX_READING_MS } = await import('./toast.js');

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
  const plainHidden = showToast('Roll analysis: 5 of 5 frames locked', 4000);
  // Minutes pass in the hidden page: every timer it set fires.
  for (const timer of timers.slice(before)) if (!timer.cleared) timer.callback();
  assert.equal(timers.length, before, 'no duration runs before the toast is shown');
  assert.ok(!roll.element.removed && !plainHidden.element.removed, 'both wait for the page to be seen');
  // The page is visible again: its first frame shows them.
  for (const frame of frames.splice(0)) frame();
  assert.ok(roll.element.classList.contains('toast-visible'));
  assert.deepEqual(timers.slice(before).map(timer => timer.delay), [12000, 4000], 'each duration starts when shown');
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
  assert.equal(timers.at(-1).delay, 4000, 'and no duration was started for it');
}
// #313: "the tips that pop up in the boxes disappear too quickly". A toast
// stays as long as its text takes to read, whatever shorter duration its
// caller asked for; a longer one is kept.
{
  globalThis.requestAnimationFrame = callback => callback();
  assert.equal(readingTimeMs('Nothing to undo'), TOAST_MIN_MS, 'a few words still get the floor');
  const english = 'Monochrome: treated as a B&W negative. If this is a print or slide, choose Positive in Conversion.';
  const chinese = '黑白影像：已按黑白负片处理。如果是照片或反转片，请在转换面板选择正片。';
  assert.equal(readingTimeMs(english), 1500 + english.length * 60);
  assert.equal(readingTimeMs(chinese), 1500 + chinese.length * 160, 'Han and full-width punctuation read slower than Latin');
  assert.ok(readingTimeMs(chinese) > 6500 && readingTimeMs(english) > 6500, 'both outlast the 6.5 s the film-type toast had');
  assert.equal(readingTimeMs('x'.repeat(1000)), TOAST_MAX_READING_MS, 'the text alone never keeps a toast past the cap');
  showToast('Nothing to undo');
  assert.equal(timers.at(-1).delay, TOAST_MIN_MS, 'the default duration is the reading time');
  showToast(english, 2000);
  assert.equal(timers.at(-1).delay, readingTimeMs(english), 'a short caller duration is lengthened');
  showToast('Saved', 15000);
  assert.equal(timers.at(-1).delay, 15000, 'a longer caller duration is kept');
  showToast('Brush repair failed', 'error');
  assert.equal(timers.at(-1).delay, readingTimeMs('Brush repair failed'), 'a duration that is not a number falls back to the reading time');
}

// The mouse resting on a toast, or focus inside it, keeps it; it goes a
// moment after they leave. A touch holds nothing: there is no hover.
{
  const listeners = new Map();
  const doc = {
    activeElement: null,
    getElementById: id => id === 'toastContainer' ? container : null,
    createElement: tag => Object.assign(element(tag), {
      getBoundingClientRect: () => ({ left: 100, right: 300, top: 500, bottom: 540 }),
      contains(node) { return node === this || this.children.includes(node); }
    }),
    addEventListener(type, handler, options) { listeners.set(type, [...(listeners.get(type) || []), { handler, options }]); }
  };
  globalThis.document = doc;
  const pointerEvent = (type, x, y, pointerType = 'mouse', relatedTarget = null) => {
    for (const { handler } of listeners.get(type) || []) handler({ clientX: x, clientY: y, pointerType, relatedTarget });
  };
  const hovered = showToast('Recipe applied.');
  assert.ok(listeners.has('pointermove') && listeners.get('pointermove')[0].options.passive, 'the document reports where the mouse is, passively');
  pointerEvent('pointermove', 150, 520);
  timers.at(-1).callback();
  assert.ok(hovered.element.classList.contains('toast-visible'), 'held while the mouse is on it');
  assert.equal(timers.at(-1).delay, 400, 'and it checks again shortly');
  timers.at(-1).callback();
  assert.ok(hovered.element.classList.contains('toast-visible'));
  pointerEvent('pointermove', 600, 200);
  timers.at(-1).callback();
  assert.ok(hovered.element.classList.contains('toast-visible'), 'the mouse just left: it lingers');
  assert.equal(timers.at(-1).delay, 1500);
  timers.at(-1).callback();
  assert.equal(hovered.element.classList.contains('toast-visible'), false, 'then it goes');

  // A toast that pops up under a cursor parked there goes as usual; the
  // mouse moving on it then holds it.
  pointerEvent('pointermove', 150, 520);
  const parked = showToast('Look applied to 3 photo(s)');
  timers.at(-1).callback();
  assert.equal(parked.element.classList.contains('toast-visible'), false, 'a parked cursor holds nothing');
  const moved = showToast('Recipe applied.');
  pointerEvent('pointermove', 151, 521);
  timers.at(-1).callback();
  assert.ok(moved.element.classList.contains('toast-visible'), 'a cursor that moved on it holds it');
  pointerEvent('pointermove', 600, 200);
  timers.at(-1).callback();
  timers.at(-1).callback();
  assert.equal(moved.element.classList.contains('toast-visible'), false);

  const touched = showToast('Look cleared.');
  pointerEvent('pointerdown', 150, 520, 'touch');
  timers.at(-1).callback();
  assert.equal(touched.element.classList.contains('toast-visible'), false, 'a touch on it does not hold it');

  pointerEvent('pointermove', 150, 520);
  pointerEvent('pointerout', 150, 520, 'mouse', null);
  const outside = showToast('Recipe copied');
  timers.at(-1).callback();
  assert.equal(outside.element.classList.contains('toast-visible'), false, 'a mouse that left the window holds nothing');

  const focused = showToast('3 photos treated as B&W negatives.', 12000, { action: { id: 'rollPositives', label: 'These are positives', onClick() {} } });
  doc.activeElement = focused.element.children[0];
  timers.at(-1).callback();
  assert.ok(focused.element.classList.contains('toast-visible'), 'focus on its button holds it');
  doc.activeElement = null;
  timers.at(-1).callback();
  timers.at(-1).callback();
  assert.equal(focused.element.classList.contains('toast-visible'), false, 'and it goes after focus leaves');
}

globalThis.document = { getElementById: () => null, createElement: element };
assert.equal(showToast('nowhere'), null);
console.log('toast: plain and action toasts, toasts made in a hidden page, reading time and hold, passed');
