// Toast notifications. Renders into #toastContainer (see index.html).
// An optional action adds one button; that toast accepts pointer input and
// closes when the action runs or its duration ends. The duration counts from
// the frame that shows the toast: a hidden page runs no frames, so a toast
// made there (the end of a long import in a background window) is shown, for
// its whole duration, when the page is seen again (#229 review R1-018).
//
// A toast stays at least as long as its text takes to read (#313: the tips
// disappeared too quickly); a caller's duration can only lengthen that. While
// the mouse rests on a toast, or focus is inside it, it stays, and it goes a
// moment after they leave. The mouse holds it only once it has moved since
// the toast appeared, so a toast that pops up under a parked cursor still
// goes. The container takes no pointer input, so a plain toast never blocks
// a click on what lies under it: where the mouse is comes from the
// document's pointer events instead.

// A second and a half to notice it, then about 16 Latin or 6 CJK characters a
// second; never under 3 s and, for the text alone, never over 12 s.
const NOTICE_MS = 1500;
const NARROW_CHAR_MS = 60;
const WIDE_CHAR_MS = 160;
export const TOAST_MIN_MS = 3000;
export const TOAST_MAX_READING_MS = 12000;
// How often a held toast checks whether it is still held, and how long it
// stays once the mouse or focus has left it.
const HOLD_CHECK_MS = 400;
const LINGER_MS = 1500;

// Hangul, CJK punctuation, kana, Han and full-width forms.
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export function readingTimeMs(text) {
  let ms = NOTICE_MS;
  for (const char of String(text ?? '')) ms += WIDE_CHAR.test(char) ? WIDE_CHAR_MS : NARROW_CHAR_MS;
  return Math.min(TOAST_MAX_READING_MS, Math.max(TOAST_MIN_MS, ms));
}

// The mouse or pen position on the page; null after a touch, or once the
// pointer has left the window. `pointerMoves` counts the pointer events.
let pointer = null;
let pointerMoves = 0;
let tracking = false;

function trackPointer() {
  if (tracking || typeof document.addEventListener !== 'function') return;
  tracking = true;
  const note = (event) => {
    pointerMoves++;
    pointer = event.pointerType === 'touch' ? null : { x: event.clientX, y: event.clientY };
  };
  const options = { capture: true, passive: true };
  document.addEventListener('pointermove', note, options);
  document.addEventListener('pointerdown', note, options);
  document.addEventListener('pointerout', (event) => { if (!event.relatedTarget) pointer = null; }, options);
}

function isHeld(el, movesWhenShown) {
  const active = document.activeElement;
  if (active && typeof el.contains === 'function' && el.contains(active)) return true;
  if (!pointer || pointerMoves === movesWhenShown || typeof el.getBoundingClientRect !== 'function') return false;
  const box = el.getBoundingClientRect();
  return pointer.x >= box.left && pointer.x <= box.right && pointer.y >= box.top && pointer.y <= box.bottom;
}

export function showToast(message, durationMs = 0, { action = null } = {}) {
  const container = document.getElementById('toastContainer');
  if (!container) return null;
  const el = document.createElement('div');
  el.className = 'toast-message';
  el.textContent = message;
  const duration = Math.max(Number.isFinite(durationMs) ? durationMs : 0, readingTimeMs(message));
  let timer = null;
  let dismissed = false;
  let shown = false;
  let held = false;
  let movesWhenShown = 0;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    // Never shown: there is no fade-out to wait for.
    if (!shown) { el.remove(); return; }
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  };
  const expire = () => {
    if (dismissed) return;
    if (isHeld(el, movesWhenShown)) {
      held = true;
      timer = setTimeout(expire, HOLD_CHECK_MS);
    } else if (held) {
      held = false;
      timer = setTimeout(expire, LINGER_MS);
    } else {
      dismiss();
    }
  };
  if (action?.label && typeof action.onClick === 'function') {
    el.classList.add('toast-with-action');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    if (action.id) button.dataset.toastAction = action.id;
    button.textContent = action.label;
    button.addEventListener('click', () => { dismiss(); action.onClick(); }, { once: true });
    el.append(button);
  }
  container.appendChild(el);
  requestAnimationFrame(() => {
    if (dismissed) return;
    shown = true;
    el.classList.add('toast-visible');
    trackPointer();
    movesWhenShown = pointerMoves;
    timer = setTimeout(expire, duration);
  });
  return { element: el, dismiss };
}
