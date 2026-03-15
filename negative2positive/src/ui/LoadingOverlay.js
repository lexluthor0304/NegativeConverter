/**
 * LoadingOverlay — Three.js cyberpunk loading animation.
 * Lazy-initializes Three.js on first show() to avoid startup cost.
 */

let THREE = null;

async function loadThree() {
  if (THREE) return THREE;
  THREE = await import('three');
  return THREE;
}

const ACCENT_COLOR = 0x4a9eff;

export class LoadingOverlay {
  constructor() {
    this._initialized = false;
    this._visible = false;
    this._animationId = null;
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._mesh = null;
    this._particles = null;
    this._grid = null;
    this._clock = null;
    this._percent = 0;
    this._targetPercent = 0;
    this._cancelCallback = null;

    // DOM elements
    this._overlay = null;
    this._threeContainer = null;
    this._progressText = null;
    this._phaseText = null;
    this._cancelBtn = null;
  }

  _createDOM() {
    if (this._overlay) return;

    this._overlay = document.createElement('div');
    this._overlay.className = 'loading-overlay';

    this._threeContainer = document.createElement('div');
    this._threeContainer.style.cssText = 'width: 280px; height: 280px; position: relative;';
    this._overlay.appendChild(this._threeContainer);

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
    this._cancelBtn.addEventListener('click', () => {
      if (this._cancelCallback) this._cancelCallback();
    });
    this._overlay.appendChild(this._cancelBtn);

    document.body.appendChild(this._overlay);
  }

  async _initThree() {
    if (this._initialized) return;
    this._initialized = true;

    const T = await loadThree();
    this._clock = new T.Clock();

    // Scene
    this._scene = new T.Scene();

    // Camera
    this._camera = new T.PerspectiveCamera(45, 1, 0.1, 100);
    this._camera.position.set(0, 8, 24);
    this._camera.lookAt(0, 0, 0);

    // Renderer
    this._renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
    this._renderer.setSize(280, 280);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setClearColor(0x000000, 0);
    this._threeContainer.appendChild(this._renderer.domElement);

    // Torus knot wireframe
    const torusGeo = new T.TorusKnotGeometry(6, 2, 80, 12);
    const wireGeo = new T.WireframeGeometry(torusGeo);
    const wireMat = new T.LineBasicMaterial({ color: ACCENT_COLOR, transparent: true, opacity: 0.7 });
    this._mesh = new T.LineSegments(wireGeo, wireMat);
    this._scene.add(this._mesh);

    // Particle ring
    const particleCount = 200;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2;
      const radius = 10 + Math.random() * 3;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 4;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const particleGeo = new T.BufferGeometry();
    particleGeo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    const particleMat = new T.PointsMaterial({
      color: ACCENT_COLOR,
      size: 0.3,
      transparent: true,
      opacity: 0.6,
      sizeAttenuation: true
    });
    this._particles = new T.Points(particleGeo, particleMat);
    this._scene.add(this._particles);

    // Grid
    this._grid = new T.GridHelper(40, 20, ACCENT_COLOR, 0x1a3a5c);
    this._grid.position.y = -8;
    this._grid.material.transparent = true;
    this._grid.material.opacity = 0.3;
    this._scene.add(this._grid);

    torusGeo.dispose();
  }

  _animate() {
    if (!this._visible) return;

    this._animationId = requestAnimationFrame(() => this._animate());

    const dt = this._clock.getDelta();
    const elapsed = this._clock.getElapsedTime();

    // Smooth percent interpolation
    this._percent += (this._targetPercent - this._percent) * Math.min(1, dt * 4);

    // Rotation speed boost on progress updates
    const speedMult = 1 + (this._targetPercent - this._percent) * 0.02;
    const rotSpeed = 0.5 * speedMult;

    if (this._mesh) {
      this._mesh.rotation.y += dt * rotSpeed;
      this._mesh.rotation.z += dt * rotSpeed * 0.3;
      // Pulsing scale
      const pulse = 0.9 + 0.1 * Math.sin(elapsed * 2);
      this._mesh.scale.setScalar(pulse);

      // Increase opacity with progress
      this._mesh.material.opacity = 0.4 + (this._percent / 100) * 0.6;
    }

    if (this._particles) {
      this._particles.rotation.y -= dt * 0.3;
      // Particles become brighter with progress
      this._particles.material.opacity = 0.3 + (this._percent / 100) * 0.5;
      this._particles.material.size = 0.2 + (this._percent / 100) * 0.3;
    }

    this._renderer.render(this._scene, this._camera);
  }

  /**
   * Show the loading overlay.
   * @param {object} [options]
   * @param {string} [options.title] - Phase text to display
   * @param {boolean} [options.cancelable] - Whether to show cancel button
   * @param {function} [options.onCancel] - Cancel callback
   */
  async show(options = {}) {
    this._createDOM();
    await this._initThree();

    const { title = '', cancelable = false, onCancel = null } = options;

    this._targetPercent = 0;
    this._percent = 0;
    this._progressText.textContent = '0%';
    this._phaseText.textContent = title;

    this._cancelCallback = onCancel;
    this._cancelBtn.style.display = cancelable ? 'inline-block' : 'none';

    this._visible = true;
    this._overlay.classList.add('visible');
    this._clock.start();
    this._animate();
  }

  /**
   * Hide the loading overlay and stop animation.
   */
  hide() {
    this._visible = false;
    this._overlay?.classList.remove('visible');

    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }
  }

  /**
   * Update progress.
   * @param {number} percent - 0-100
   * @param {string} [phaseText] - Optional phase description
   */
  updateProgress(percent, phaseText) {
    this._targetPercent = Math.max(0, Math.min(100, percent));
    this._progressText.textContent = `${Math.round(this._targetPercent)}%`;
    if (phaseText !== undefined) {
      this._phaseText.textContent = phaseText;
    }
  }

  /**
   * Dispose of all Three.js resources.
   */
  destroy() {
    this.hide();

    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    if (this._scene) {
      this._scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
      this._scene = null;
    }
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
    this._initialized = false;
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
