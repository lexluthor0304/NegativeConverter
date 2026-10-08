// Toast notifications. Renders into #toastContainer (see index.html).
// An optional action adds one button; that toast accepts pointer input and
// closes when the action runs or its duration ends. The duration counts from
// the frame that shows the toast: a hidden page runs no frames, so a toast
// made there (the end of a long import in a background window) is shown, for
// its whole duration, when the page is seen again (#229 review R1-018).

export function showToast(message, durationMs = 2000, { action = null } = {}) {
  const container = document.getElementById('toastContainer');
  if (!container) return null;
  const el = document.createElement('div');
  el.className = 'toast-message';
  el.textContent = message;
  let timer = null;
  let dismissed = false;
  let shown = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    // Never shown: there is no fade-out to wait for.
    if (!shown) { el.remove(); return; }
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
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
    timer = setTimeout(dismiss, durationMs);
  });
  return { element: el, dismiss };
}
