// WebGL preview draw path (#233), on a synthetic negative whose top-left
// corner is marked. The GPU preview must be upright and match the CPU preview;
// the draw path may check getError only when it allocates a texture; a zoom
// gesture must stay a compositor transform until the display preview settles
// (GPU and CPU display modes); and window resize, DPR change and WebGL context
// loss/restore must redraw without leaving a resized, undrawn (black) canvas.
// #239: the same checks hold for the WebGL2 context, where applyProgram frames of a
// SilverCore drag must be upright too.
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

function installWebglProbe() {
  // WebGL2 (#239) and the WebGL1 fallback have separate prototypes.
  const glProtos = [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)
    .map(proto => ({ proto, draw: proto.drawArrays, getError: proto.getError, allocate: proto.texImage2D,
      update: proto.texSubImage2D, storage: proto.texStorage2D }));
  const original = {
    put: CanvasRenderingContext2D.prototype.putImageData,
    drawImage: CanvasRenderingContext2D.prototype.drawImage,
    toDataURL: HTMLCanvasElement.prototype.toDataURL,
    post: Worker.prototype.postMessage,
    terminate: Worker.prototype.terminate,
  };
  const workers = new Map();
  const probe = window.__webglProbe = {
    events: [], draws: 0, applyDraws: 0, lastApply: null, getErrors: 0, allocations: 0, updates: 0, cpuDraws: 0, thumbnails: 0,
    inFlight: 0, lastActivity: performance.now(), last: null, texture: null, resizes: 0, undrawnResizes: 0,
  };
  const note = (type, detail = {}) => {
    probe.events.push({ type, time: performance.now(), ...detail });
    probe.lastActivity = performance.now();
  };
  const onPreviewCanvas = context => context?.canvas?.id === 'glCanvas';
  const luminance = pixels => {
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    return Math.round(sum / (pixels.length / 4));
  };
  // Sample points in screen space: the marked corner and three symmetric
  // points of the unmarked image area.
  const points = { tl: [0.18, 0.2], tr: [0.82, 0.2], bl: [0.18, 0.8], br: [0.82, 0.8] };
  const glPatches = gl => {
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(8 * 8 * 4);
    const out = { width, height };
    for (const [name, [sx, sy]] of Object.entries(points)) {
      // Screen rows run top-down, framebuffer rows bottom-up.
      const x = Math.max(0, Math.min(width - 8, Math.floor(width * sx) - 4));
      const y = Math.max(0, Math.min(height - 8, Math.floor(height * (1 - sy)) - 4));
      gl.readPixels(x, y, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      out[name] = luminance(pixels);
    }
    return out;
  };
  probe.cpuPatches = () => {
    const canvas = document.getElementById('canvas');
    const context = canvas.getContext('2d');
    const out = { width: canvas.width, height: canvas.height };
    for (const [name, [sx, sy]] of Object.entries(points)) {
      const x = Math.max(0, Math.min(canvas.width - 8, Math.floor(canvas.width * sx) - 4));
      const y = Math.max(0, Math.min(canvas.height - 8, Math.floor(canvas.height * sy) - 4));
      out[name] = luminance(context.getImageData(x, y, 8, 8).data);
    }
    return out;
  };
  const isApply = new WeakMap();
  // The exact 8-bit frame; the GPU preview's integer textures are not frames.
  const exactFrame = (gl, args) => args[6] === gl.RGBA && args[7] === gl.UNSIGNED_BYTE;
  for (const gl of glProtos) {
    gl.proto.drawArrays = function(...args) {
      const result = gl.draw.apply(this, args);
      // The GPU preview's self-test draws into its own framebuffer.
      if (onPreviewCanvas(this) && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
        probe.draws++;
        probe.last = glPatches(this);
        const program = this.getParameter(this.CURRENT_PROGRAM);
        let apply = program ? isApply.get(program) : false;
        if (program && apply === undefined) {
          apply = this.getUniformLocation(program, 'u_prepared') !== null;
          isApply.set(program, apply);
        }
        if (apply) { probe.applyDraws++; probe.lastApply = probe.last; }
        note('draw', { width: probe.last.width, height: probe.last.height, apply });
      }
      return result;
    };
    gl.proto.getError = function(...args) {
      if (onPreviewCanvas(this)) { probe.getErrors++; note('getError'); }
      return gl.getError.apply(this, args);
    };
    gl.proto.texImage2D = function(...args) {
      if (onPreviewCanvas(this) && args[3] > 256 && ArrayBuffer.isView(args[8])) {
        probe.allocations++;
        if (exactFrame(this, args)) probe.texture = [args[3], args[4]];
        note('upload', { allocate: true, width: args[3], height: args[4] });
      }
      return gl.allocate.apply(this, args);
    };
    gl.proto.texSubImage2D = function(...args) {
      if (onPreviewCanvas(this) && args[4] > 256 && ArrayBuffer.isView(args[8])) {
        if (exactFrame(this, args)) probe.updates++;
        note('upload', { allocate: false, width: args[4], height: args[5] });
      }
      return gl.update.apply(this, args);
    };
    if (gl.storage) {
      gl.proto.texStorage2D = function(...args) {
        if (onPreviewCanvas(this) && args[3] > 256) {
          probe.allocations++;
          note('upload', { allocate: true, width: args[3], height: args[4] });
        }
        return gl.storage.apply(this, args);
      };
    }
  }
  CanvasRenderingContext2D.prototype.putImageData = function(...args) {
    if (this.canvas?.id === 'canvas') { probe.cpuDraws++; note('cpu'); }
    return original.put.apply(this, args);
  };
  CanvasRenderingContext2D.prototype.drawImage = function(...args) {
    if (this.canvas?.id === 'canvas') { probe.cpuDraws++; note('cpu'); }
    return original.drawImage.apply(this, args);
  };
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    probe.thumbnails++;
    note('thumbnail');
    return original.toDataURL.apply(this, args);
  };
  Worker.prototype.postMessage = function(message, ...args) {
    if (message?.type === 'convert') {
      let record = workers.get(this);
      if (!record) {
        record = { pending: new Set() };
        record.receive = event => {
          if (record.pending.delete(event.data?.id)) { probe.inFlight--; note('reply'); }
        };
        this.addEventListener('message', record.receive);
        workers.set(this, record);
      }
      record.pending.add(message.id);
      probe.inFlight++;
      note('convert', { preview: !!message.cacheInput });
    }
    return original.post.call(this, message, ...args);
  };
  // A terminated worker never answers what it still owed.
  Worker.prototype.terminate = function(...args) {
    const record = workers.get(this);
    if (record) { probe.inFlight -= record.pending.size; record.pending.clear(); note('terminate'); }
    return original.terminate.apply(this, args);
  };
  const glCanvas = document.getElementById('glCanvas');
  for (const name of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
    Object.defineProperty(glCanvas, name, {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        const before = descriptor.get.call(this);
        descriptor.set.call(this, value);
        if (descriptor.get.call(this) === before) return;
        // A resize clears the drawing buffer; the same task must draw again.
        probe.resizes++;
        note('resize', { name, from: before, to: value });
        const draws = probe.draws;
        queueMicrotask(() => {
          if (probe.draws === draws) { probe.undrawnResizes++; note('undrawn-resize', { name }); }
        });
      },
    });
  }
  const onWheel = () => note('wheel');
  document.getElementById('canvasContainer').addEventListener('wheel', onWheel, { capture: true, passive: true });
  // Everything between the first wheel event and the settle must be free of
  // redraws, uploads, error checks, CPU passes, thumbnails, conversions and
  // drawing-buffer resizes. The settle is the display preview's conversion,
  // or 100 ms after the last wheel event when the size does not change.
  probe.zoomWindow = from => {
    const events = probe.events.filter(event => event.time >= from);
    const wheels = events.filter(event => event.type === 'wheel');
    if (!wheels.length) return { wheels: 0 };
    const first = wheels[0].time, lastWheel = wheels.at(-1).time;
    const settle = events.find(event => event.type === 'convert' && event.preview && event.time > first);
    const settleAt = settle ? settle.time : lastWheel + 100;
    const busy = events.filter(event => event.time >= first && event.time < settleAt
      && ['draw', 'upload', 'getError', 'cpu', 'thumbnail', 'convert', 'resize', 'undrawn-resize'].includes(event.type));
    const resizes = events.filter(event => event.type === 'resize' && event.time >= first);
    const allocations = events.filter(event => event.type === 'upload' && event.allocate && event.time >= settleAt);
    const resizeWithoutTexture = resizes.filter(resize => !allocations.some(upload => upload.time <= resize.time && resize.time - upload.time < 50));
    return { wheels: wheels.length, gesture: Math.round(lastWheel - first), settled: !!settle,
      busy: busy.map(event => event.type), resizeWithoutTexture: resizeWithoutTexture.length };
  };
  probe.restore = () => {
    for (const gl of glProtos) {
      Object.assign(gl.proto, { drawArrays: gl.draw, getError: gl.getError, texImage2D: gl.allocate, texSubImage2D: gl.update });
      if (gl.storage) gl.proto.texStorage2D = gl.storage;
    }
    CanvasRenderingContext2D.prototype.putImageData = original.put;
    CanvasRenderingContext2D.prototype.drawImage = original.drawImage;
    HTMLCanvasElement.prototype.toDataURL = original.toDataURL;
    Worker.prototype.postMessage = original.post;
    Worker.prototype.terminate = original.terminate;
    delete glCanvas.width; delete glCanvas.height;
    document.getElementById('canvasContainer').removeEventListener('wheel', onWheel, { capture: true });
    for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    delete window.__webglProbe;
  };
}

export async function runWebglPreviewSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) fail(message); };
  const until = async (description, expression, timeout = 90_000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  // Longer than the 2.5 s idle full-resolution timer, so a background render
  // cannot land inside a measured window. Every call follows an action whose
  // work may only start after a timer (a full request's 70 ms, a display
  // resize's 100 ms), so the call itself counts as activity: otherwise a quiet
  // page before the action lets it return before that work has begun.
  const quiet = async description => {
    await evaluate('window.__webglProbe.lastActivity = Math.max(window.__webglProbe.lastActivity, performance.now())');
    await until(description, `${ready} && window.__webglProbe.inFlight === 0 && performance.now() - window.__webglProbe.lastActivity > 3500`);
  };
  const marked = patches => {
    if (!patches) return false;
    const others = [patches.tr, patches.bl, patches.br];
    const mean = others.reduce((sum, value) => sum + value, 0) / others.length;
    return Math.abs(patches.tl - mean) > 30 && Math.max(...others) - Math.min(...others) < 20;
  };
  const setWebGL = on => evaluate(`(() => {
    const input = document.getElementById('coreUseWebGL');
    if (input.checked !== ${on}) input.click();
    return input.checked;
  })()`);
  const glVisible = `getComputedStyle(document.getElementById('glCanvas')).display !== 'none'`;
  const now = () => evaluate('performance.now()');
  const wheelGesture = async () => {
    const center = await evaluate(`(() => {
      const rect = document.getElementById('canvasContainer').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    for (let step = 0; step < 6; step++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -40 });
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  };
  const zoomCheck = async label => {
    const from = await now();
    const before = await evaluate(`[document.getElementById('glCanvas').width, document.getElementById('glCanvas').height]`);
    await wheelGesture();
    const during = await evaluate(`({ zoom: document.getElementById('zoomIndicator').textContent,
      backing: [document.getElementById('glCanvas').width, document.getElementById('glCanvas').height] })`);
    await quiet(`${label} zoom settled`);
    const window = await evaluate(`window.__webglProbe.zoomWindow(${from})`);
    expect(window.wheels >= 3 && during.zoom !== '100%', `${label} zoom gesture did not reach the app: ` + JSON.stringify({ window, during }));
    expect(window.busy.length === 0, `${label} zoom did more than move the transform before the settle: ` + JSON.stringify(window));
    expect(window.resizeWithoutTexture === 0, `${label} zoom resized the drawing buffer without a new texture: ` + JSON.stringify(window));
    console.log(`ok: ${label} zoom is compositor-only until settle ` + JSON.stringify({ ...window, before, during }));
    return window;
  };
  const resetZoom = async label => {
    await evaluate(`document.getElementById('zoomResetBtn').click()`);
    await quiet(`${label} zoom reset`);
  };

  const origin = await evaluate('performance.timeOrigin');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await until('fresh WebGL preview workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await evaluate(`(${installWebglProbe.toString()})()`);
  await evaluate(`(async () => {
    for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
      const input = document.getElementById(id); if (input?.checked) input.click();
    }
    document.querySelector('.film-type-btn[data-type="color"]').click();
    // Film base rebate, a mid-density image area and a dense (bright in the
    // print) block in the top-left corner only.
    const surface = document.createElement('canvas');
    surface.width = 1800; surface.height = 1200;
    const context = surface.getContext('2d');
    context.fillStyle = 'rgb(215,150,100)'; context.fillRect(0, 0, 1800, 1200);
    context.fillStyle = 'rgb(170,115,72)'; context.fillRect(90, 90, 1620, 1020);
    context.fillStyle = 'rgb(70,45,28)'; context.fillRect(90, 90, 540, 420);
    const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'webgl-orientation.png', { type: 'image/png' }));
    const input = document.getElementById('fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until('marked negative converted', `${ready} && document.getElementById('studioFilename').textContent === 'webgl-orientation.png'`, 120_000);
  await evaluate(`(() => {
    document.getElementById('studioTab-edit').click();
    document.getElementById('studioMore').open = true;
  })()`);
  await setWebGL(true);
  await quiet('initial GPU preview idle');

  // ---- Orientation: GPU preview upright and equal to the CPU preview ----
  const gpu = await evaluate(`({ visible: ${glVisible}, last: window.__webglProbe.last,
    backing: [document.getElementById('glCanvas').width, document.getElementById('glCanvas').height],
    texture: window.__webglProbe.texture })`);
  expect(gpu.visible && marked(gpu.last), 'GPU preview is not upright (marked corner not top-left): ' + JSON.stringify(gpu));
  expect(gpu.backing[0] === gpu.texture?.[0] && gpu.backing[1] === gpu.texture?.[1], 'GPU drawing buffer does not match its texture: ' + JSON.stringify(gpu));
  await setWebGL(false);
  await quiet('CPU preview idle');
  const cpu = await evaluate(`({ visible: !(${glVisible}), patches: window.__webglProbe.cpuPatches() })`);
  expect(cpu.visible && marked(cpu.patches), 'CPU preview is not upright: ' + JSON.stringify(cpu));
  expect(Math.abs(cpu.patches.tl - gpu.last.tl) < 25 && Math.abs(cpu.patches.br - gpu.last.br) < 25,
    'GPU and CPU previews disagree: ' + JSON.stringify({ gpu: gpu.last, cpu: cpu.patches }));
  console.log('ok: GPU preview upright and matching the CPU preview ' + JSON.stringify({ gpu: gpu.last, cpu: cpu.patches }));
  await setWebGL(true);
  await quiet('GPU preview restored');

  // ---- Steady-state draws: no getError without an allocation ----
  const counters = `(({ draws, getErrors, allocations, updates }) => ({ draws, getErrors, allocations, updates }))(window.__webglProbe)`;
  const steadyBefore = await evaluate(counters);
  await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    const drive = async (id, values) => {
      const slider = document.getElementById(id);
      for (const value of values) {
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await frame(); await frame();
      }
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await drive('cyan', [4, 8, 12, 8, 4, 0]);
    await drive('coreExposure', [10, 20, 30, 20, 10, 0]);
  })()`);
  await quiet('steady-state drag idle');
  const steady = await evaluate(counters);
  const allocations = steady.allocations - steadyBefore.allocations;
  expect(steady.draws - steadyBefore.draws >= 6 && steady.updates > steadyBefore.updates,
    'steady-state drag did not redraw and re-upload: ' + JSON.stringify({ steadyBefore, steady }));
  expect(steady.getErrors - steadyBefore.getErrors <= allocations,
    'getError ran on frames that allocated nothing: ' + JSON.stringify({ steadyBefore, steady }));
  console.log('ok: steady-state draws check getError only on allocation ' + JSON.stringify({
    draws: steady.draws - steadyBefore.draws, updates: steady.updates - steadyBefore.updates,
    allocations, getErrors: steady.getErrors - steadyBefore.getErrors }));
  // #239: where the SilverCore drag was drawn by applyProgram, its frames are upright too.
  const applied = await evaluate(`({ draws: window.__webglProbe.applyDraws, last: window.__webglProbe.lastApply })`);
  if (applied.draws > 0) {
    expect(marked(applied.last), 'applyProgram frame is not upright (marked corner not top-left): ' + JSON.stringify(applied));
    console.log('ok: applyProgram frames upright ' + JSON.stringify(applied));
  }

  // ---- Zoom: compositor transform in GPU and CPU display modes ----
  await zoomCheck('GPU');
  const settled = await evaluate(`(() => {
    const probe = window.__webglProbe, gl = document.getElementById('glCanvas');
    return { last: probe.last, backing: [gl.width, gl.height], texture: probe.texture, undrawn: probe.undrawnResizes };
  })()`);
  expect(settled.backing[0] === settled.texture?.[0] && settled.backing[1] === settled.texture?.[1]
    && settled.last?.width === settled.backing[0] && marked(settled.last) && settled.undrawn === 0,
  'settled GPU zoom does not show its texture upright: ' + JSON.stringify(settled));
  // A same-value adjustment input redraws the texture on screen. (A resize no
  // longer draws at all unless the drawing buffer must change, #261.)
  const fresh = await evaluate(`new Promise(resolve => {
    const probe = window.__webglProbe, draws = probe.draws, start = performance.now();
    document.getElementById('cyan').dispatchEvent(new Event('input', { bubbles: true }));
    const check = () => {
      if (probe.draws > draws) resolve({ redrawn: true, last: probe.last });
      else if (performance.now() - start > 3000) resolve({ redrawn: false, last: probe.last });
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  })`);
  expect(fresh.redrawn && JSON.stringify(fresh.last) === JSON.stringify(settled.last),
    'settled GPU zoom differs from a fresh render at the same zoom: ' + JSON.stringify({ settled: settled.last, fresh }));
  await resetZoom('GPU');

  await setWebGL(false);
  await quiet('CPU display mode idle');
  await zoomCheck('CPU (WebGL off)');
  const cpuSettled = await evaluate('window.__webglProbe.cpuPatches()');
  await evaluate(`(() => {
    const slider = document.getElementById('cyan');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await quiet('fresh CPU render');
  const cpuFresh = await evaluate('window.__webglProbe.cpuPatches()');
  expect(marked(cpuSettled) && ['tl', 'tr', 'bl', 'br'].every(key => Math.abs(cpuSettled[key] - cpuFresh[key]) <= 6),
    'settled CPU zoom differs from a fresh render at the same zoom: ' + JSON.stringify({ cpuSettled, cpuFresh }));
  await resetZoom('CPU');
  await setWebGL(true);
  await quiet('GPU preview after CPU zoom');

  const border = await evaluate(`(() => {
    const button = document.getElementById('sprocketPreviewBtn');
    if (!button || button.disabled) return false;
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    return button.getAttribute('aria-pressed') === 'true';
  })()`);
  expect(border, 'border preview (a CPU display mode) could not be enabled');
  await quiet('border preview idle');
  await zoomCheck('CPU (border preview)');
  await resetZoom('border preview');
  await evaluate(`(() => {
    const button = document.getElementById('sprocketPreviewBtn');
    if (button.getAttribute('aria-pressed') === 'true') button.click();
  })()`);
  await quiet('border preview closed');

  // ---- Resize and DPR change redraw without an undrawn resized buffer ----
  // The display preview keeps serving a size within 15 % larger or 5 %
  // smaller (#248), so the window shrinks well beyond that band here.
  const drawsBeforeResize = await evaluate('window.__webglProbe.draws');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  await until('window resize redrew the GPU preview', `window.__webglProbe.draws > ${drawsBeforeResize}`);
  await quiet('window resize settled');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await quiet('DPR change settled');
  const dpr = await evaluate(`(() => {
    const probe = window.__webglProbe, gl = document.getElementById('glCanvas');
    return { dpr: devicePixelRatio, visible: ${glVisible}, backing: [gl.width, gl.height], texture: probe.texture,
      last: probe.last, undrawn: probe.undrawnResizes, resizes: probe.resizes };
  })()`);
  expect(dpr.dpr === 2 && dpr.visible && marked(dpr.last) && dpr.undrawn === 0
    && dpr.backing[0] === dpr.texture?.[0] && dpr.last?.width === dpr.backing[0],
  'resize/DPR change left a stale or black GPU preview: ' + JSON.stringify(dpr));
  console.log('ok: window resize and DPR change redraw the GPU preview ' + JSON.stringify(dpr));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await quiet('DPR restored');

  // ---- Context loss falls back to the CPU preview; restore recovers ----
  const cpuDrawsBeforeLoss = await evaluate(`(() => {
    const canvas = document.getElementById('glCanvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    window.__webglLoseContext = context.getExtension('WEBGL_lose_context');
    const draws = window.__webglProbe.cpuDraws;
    window.__webglLoseContext.loseContext();
    return draws;
  })()`);
  await until('CPU preview after context loss', `!(${glVisible}) && window.__webglProbe.cpuDraws > ${cpuDrawsBeforeLoss}`);
  const lost = await evaluate('window.__webglProbe.cpuPatches()');
  expect(marked(lost), 'CPU fallback after context loss is not upright: ' + JSON.stringify(lost));
  const drawsBeforeRestore = await evaluate(`(() => {
    const draws = window.__webglProbe.draws;
    window.__webglLoseContext.restoreContext();
    return draws;
  })()`);
  await until('GPU preview after context restore', `${glVisible} && window.__webglProbe.draws > ${drawsBeforeRestore}`);
  await quiet('restored GPU preview idle');
  const restored = await evaluate(`({ last: window.__webglProbe.last, undrawn: window.__webglProbe.undrawnResizes })`);
  expect(marked(restored.last) && restored.undrawn === 0, 'restored GPU preview is wrong: ' + JSON.stringify(restored));
  console.log('ok: context loss falls back to the CPU preview and restore recovers the GPU preview');

  await evaluate(`(() => { delete window.__webglLoseContext; window.__webglProbe.restore(); })()`);
}
