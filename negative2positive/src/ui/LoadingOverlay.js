/**
 * LoadingOverlay — spinning film reel + sprocket-strip progress bar.
 *
 * Pure DOM/CSS. Replaces the old Three.js scene, which shipped a ~725 kB
 * chunk at the moment conversion started and ran a WebGL render loop that
 * competed with the processing pipeline for the GPU and main thread. The
 * only animation here is one composited CSS rotation.
 */

const REEL_SVG = `
<svg class="loading-reel" viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="46" class="reel-rim"/>
  <circle cx="50" cy="50" r="38" class="reel-film"/>
  <circle cx="50" cy="50" r="11" class="reel-hub"/>
  <circle cx="50" cy="26.5" r="10" class="reel-cutout"/>
  <circle cx="70.4" cy="61.7" r="10" class="reel-cutout"/>
  <circle cx="29.6" cy="61.7" r="10" class="reel-cutout"/>
  <rect x="47.6" y="45" width="4.8" height="10" rx="1.6" class="reel-key"/>
</svg>`;

export class LoadingOverlay {
  constructor() {
    this._visible = false;
    this._percent = 0;
    this._cancelCallback = null;
    this._onCancelClick = null;

    this._overlay = null;
    this._fill = null;
    this._progressText = null;
    this._phaseText = null;
    this._cancelBtn = null;
  }

  _createDOM() {
    if (this._overlay) return;

    this._overlay = document.createElement('div');
    this._overlay.className = 'loading-overlay';

    const reelWrap = document.createElement('div');
    reelWrap.className = 'loading-reel-wrap';
    reelWrap.innerHTML = REEL_SVG;
    this._overlay.appendChild(reelWrap);

    const strip = document.createElement('div');
    strip.className = 'loading-film-strip';
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
   */
  async show(options = {}) {
    this._createDOM();

    const { title = '', cancelable = false, onCancel = null, cancelText = 'Cancel' } = options;

    this._percent = 0;
    this._progressText.textContent = '0%';
    this._phaseText.textContent = title;
    this._fill.style.width = '0%';

    this._cancelCallback = onCancel;
    this._cancelBtn.textContent = cancelText;
    this._cancelBtn.style.display = cancelable ? 'inline-block' : 'none';

    this._visible = true;
    this._overlay.classList.add('visible');
  }

  /** Hide the loading overlay. */
  hide() {
    this._visible = false;
    this._overlay?.classList.remove('visible');
  }

  /**
   * Update progress.
   * @param {number} percent - 0-100
   * @param {string} [phaseText] - Optional phase description
   */
  updateProgress(percent, phaseText) {
    this._percent = Math.max(0, Math.min(100, percent));
    this._progressText.textContent = `${Math.round(this._percent)}%`;
    if (this._fill) this._fill.style.width = `${this._percent}%`;
    if (phaseText !== undefined) {
      this._phaseText.textContent = phaseText;
    }
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
    this._overlay = null;
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
