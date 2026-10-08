/**
 * LoadingOverlay — spinning film reel + sprocket-strip progress bar.
 *
 * Pure DOM/CSS. Replaces the old Three.js scene, which shipped a ~725 kB
 * chunk at the moment conversion started and ran a WebGL render loop that
 * competed with the processing pipeline for the GPU and main thread. The
 * only animation here is one composited CSS rotation.
 */

const REEL_SVG = `
<svg class="loading-reel" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">
  <path d="M10 2h12v2h4v4h4v4h1v8h-1v4h-4v4h-4v2H10v-2H6v-4H2v-4H1v-8h1V8h4V4h4Z" class="reel-rim"/>
  <path d="M10 6h12v4h4v12h-4v4H10v-4H6V10h4Z" class="reel-film"/>
  <rect x="12" y="12" width="8" height="8" class="reel-hub"/>
  <path d="M14 6h4v4h-4ZM6 14h4v4H6Zm16 0h4v4h-4Zm-8 8h4v4h-4Z" class="reel-cutout"/>
  <rect x="15" y="14" width="2" height="4" class="reel-key"/>
</svg>`;

export class LoadingOverlay {
  constructor() {
    this._visible = false;
    this._percent = 0;
    this._cancelCallback = null;
    this._onCancelClick = null;

    this._overlay = null;
    this._strip = null;
    this._fill = null;
    this._progressText = null;
    this._phaseText = null;
    this._cancelBtn = null;
    this._status = null;
  }

  _createDOM() {
    if (this._overlay) return;

    this._overlay = document.createElement('div');
    this._overlay.className = 'loading-overlay';
    // Not a dialog: it takes no input beyond the optional Cancel button, so
    // trapping focus in it would strand the user when it hides itself.
    this._overlay.setAttribute('aria-busy', 'true');

    // The phase is announced from a visually hidden status region outside the
    // overlay. The hidden overlay is visibility: hidden (studio.css), which
    // takes it out of the accessibility tree, and a live region that appears
    // together with its text is not reliably announced.
    this._status = document.createElement('div');
    this._status.className = 'sr-only loading-status';
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    document.body.appendChild(this._status);

    const reelWrap = document.createElement('div');
    reelWrap.className = 'loading-reel-wrap';
    reelWrap.innerHTML = REEL_SVG;
    this._overlay.appendChild(reelWrap);

    const strip = document.createElement('div');
    strip.className = 'loading-film-strip';
    strip.setAttribute('role', 'progressbar');
    strip.setAttribute('aria-valuemin', '0');
    strip.setAttribute('aria-valuemax', '100');
    strip.setAttribute('aria-valuenow', '0');
    this._strip = strip;
    this._fill = document.createElement('div');
    this._fill.className = 'loading-film-fill';
    strip.appendChild(this._fill);
    this._overlay.appendChild(strip);

    this._progressText = document.createElement('div');
    this._progressText.className = 'loading-progress-text';
    this._progressText.textContent = '0%';
    this._overlay.appendChild(this._progressText);

    this._phaseText = document.createElement('div');
    this._phaseText.className = 'loading-phase-text';
    this._phaseText.textContent = '';
    this._overlay.appendChild(this._phaseText);

    this._cancelBtn = document.createElement('button');
    this._cancelBtn.type = 'button';
    this._cancelBtn.className = 'loading-cancel-btn';
    this._cancelBtn.style.display = 'none';
    this._cancelBtn.textContent = 'Cancel';
    this._onCancelClick = () => {
      if (this._cancelCallback) this._cancelCallback();
    };
    this._cancelBtn.addEventListener('click', this._onCancelClick);
    this._overlay.appendChild(this._cancelBtn);

    document.body.appendChild(this._overlay);
  }

  /**
   * Show the loading overlay.
   * @param {object} [options]
   * @param {string} [options.title] - Phase text to display
   * @param {boolean} [options.cancelable] - Whether to show cancel button
   * @param {function} [options.onCancel] - Cancel callback
   * @param {string} [options.cancelText] - Cancel button label
   * @param {boolean} [options.immediate] - Skip the fade-in: the first frame
   *   painted after this call shows the overlay fully opaque. For work that
   *   blocks the main thread right after the paint, where a fade (Studio's
   *   steps() timing, which WebKit cannot run off the main thread) would
   *   still be at opacity 0. Cleared by hide(), so the fade-out still runs.
   */
  async show(options = {}) {
    this._createDOM();

    const { title = '', cancelable = false, onCancel = null, cancelText = 'Cancel', immediate = false } = options;

    this._percent = 0;
    this._progressText.textContent = '0%';
    this._phaseText.textContent = title;
    this._fill.style.width = '0%';
    this._strip.setAttribute('aria-valuenow', '0');
    this._strip.setAttribute('aria-label', title || 'Processing');
    this._overlay.setAttribute('aria-busy', 'true');

    this._cancelCallback = onCancel;
    this._cancelBtn.textContent = cancelText;
    this._cancelBtn.style.display = cancelable ? 'inline-block' : 'none';

    this._visible = true;
    if (immediate) this._overlay.classList.add('loading-overlay-immediate');
    this._overlay.classList.add('visible');
    this._overlay.classList.remove('indeterminate');
    this._announce(title);
    if (options.indeterminate) this.updateIndeterminate(title);
  }

  /**
   * Show or hide the Cancel button while the overlay is up (an export
   * becomes cancellable once its encode or write starts).
   * @param {boolean} cancelable
   * @param {{onCancel?: function, cancelText?: string}} [options]
   */
  setCancelable(cancelable, { onCancel = null, cancelText } = {}) {
    this._createDOM();
    this._cancelCallback = cancelable ? onCancel : null;
    if (cancelText !== undefined) this._cancelBtn.textContent = cancelText;
    this._cancelBtn.style.display = cancelable ? 'inline-block' : 'none';
  }

  /**
   * Hide the loading overlay. Its animations pause and it leaves rendering
   * once the fade ends (studio.css); apart from the immediate class, the
   * classes stay as they are so the fade itself does not jump.
   */
  hide() {
    this._visible = false;
    this._overlay?.setAttribute('aria-busy', 'false');
    this._overlay?.classList.remove('visible', 'loading-overlay-immediate');
    this._announce('');
  }

  _announce(text) {
    const value = text || '';
    if (this._status && this._status.textContent !== value) this._status.textContent = value;
  }

  /**
   * Update progress.
   * @param {number} percent - 0-100
   * @param {string} [phaseText] - Optional phase description
   */
  updateProgress(percent, phaseText) {
    this._overlay?.classList.remove('indeterminate');
    this._percent = Math.max(0, Math.min(100, percent));
    this._progressText.textContent = `${Math.round(this._percent)}%`;
    if (this._fill) this._fill.style.width = `${this._percent}%`;
    if (this._strip) this._strip.setAttribute('aria-valuenow', String(Math.round(this._percent)));
    if (phaseText !== undefined) {
      this._phaseText.textContent = phaseText;
      if (this._strip) this._strip.setAttribute('aria-label', phaseText || 'Processing');
      this._announce(phaseText);
    }
  }

  updateIndeterminate(phaseText) {
    this._createDOM();
    this._overlay.classList.add('indeterminate');
    this._strip.removeAttribute('aria-valuenow');
    this._strip.setAttribute('aria-label', phaseText || 'Processing');
    this._progressText.textContent = '';
    this._phaseText.textContent = phaseText || '';
    this._fill.style.width = '35%';
    if (this._visible) this._announce(phaseText);
  }

  /** Remove the overlay from the DOM. */
  destroy() {
    this.hide();
    if (this._cancelBtn && this._onCancelClick) {
      this._cancelBtn.removeEventListener('click', this._onCancelClick);
      this._onCancelClick = null;
    }
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._status?.remove();
    this._status = null;
    this._overlay = null;
    this._strip = null;
    this._fill = null;
    this._progressText = null;
    this._phaseText = null;
    this._cancelBtn = null;
  }

  get isVisible() {
    return this._visible;
  }
}

// Singleton instance
let _instance = null;

export function getLoadingOverlay() {
  if (!_instance) {
    _instance = new LoadingOverlay();
  }
  return _instance;
}
