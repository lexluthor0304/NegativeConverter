// Interactive preview tier (#263), forced by its test hook: ?previewTier=reduced
// starts every slider drag in the ~1 MP tier, ?previewTier=normal never
// leaves the normal one. The same trusted Exposure drag, then a click on the
// track, run on a synthetic 3.84 MP negative at DPR 2 (a display preview above
// 1 MP) three times: the normal tier and the reduced tier on the worker path
// (?gpuPreview=off), and the reduced tier with #239's GPU preview drawing the
// drag (?gpuPreview=force, #229 review R1-145). Every run routes the fixture as
// a photo above 16 MP (?largeImagePixels=3000000): no full-resolution render
// follows a release, so the settled view is the normal-size settle tick (in
// the normal run the last drag tick), as on a 60 MP DNG (#229 review R1-121).
// - reduced: every draw during the drag is <= 1 MP (and, on the worker path,
//   every conversion); after release exactly one normal-size preview
//   conversion runs, and the texture and drawing buffer are back at the normal
//   size;
// - a click on the track whose tick the worker answers only after the release
//   (the probe holds it): a reduced run converts once more at the normal size
//   and settles on that frame (#229 review R1-119);
// - the settled WebGL frame (full readPixels hash, with no full-resolution
//   conversion since the drag or click), the filmstrip tile and, after the
//   drag, the exported PNG8 and TIFF16 pixels are identical in all runs;
// - undo, or a photo switch, within 100 ms of release never leaves a reduced
//   frame as the settled or remembered view (the reduced worker run).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseTiff, TIFF_TAGS } from '../negative2positive/src/workers/tiffWriter.js';

const UPNG = createRequire(import.meta.url)('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const REDUCED_MAX_PIXELS = 1_000_000;
// Below the fixture's 3.84 MP: the app routes it as a large photo.
const LARGE_IMAGE_PIXELS = 3_000_000;
const RUNS = [
  { name: 'normal', tier: 'normal', gpu: 'off' },
  { name: 'reduced-gpu', tier: 'reduced', gpu: 'force' },
  // Last: the undo and photo-switch checks run on its page.
  { name: 'reduced', tier: 'reduced', gpu: 'off' },
];

function installTierProbe() {
  // WebGL2 (#239) and the WebGL1 fallback have separate prototypes.
  const glProtos = [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)
    .map(proto => ({ proto, draw: proto.drawArrays, allocate: proto.texImage2D, update: proto.texSubImage2D }));
  const original = {
    post: Worker.prototype.postMessage, terminate: Worker.prototype.terminate,
    click: HTMLAnchorElement.prototype.click, revoke: URL.revokeObjectURL, picker: window.showSaveFilePicker,
  };
  const workers = new Map(), heldUrls = new Set();
  const probe = window.__tierProbe = {
    events: [], inFlight: 0, lastActivity: performance.now(), texture: null, hashDraws: false, lastHash: null, downloads: [],
    // A slow worker on demand: while `holding`, a preview conversion and every
    // later message to its worker wait, in order, for release().
    holding: false, held: [],
  };
  const heldWorkers = new Set();
  // #239's applyProgram (a GPU preview frame) reads the prepared negative.
  const applyPrograms = new WeakMap();
  const note = (type, detail = {}) => {
    probe.events.push({ type, time: performance.now(), ...detail });
    probe.lastActivity = performance.now();
  };
  const onPreview = context => context?.canvas?.id === 'glCanvas';
  // Only the exact 8-bit frame counts: the GPU preview's integer textures are
  // not frames on screen.
  const exactFrame = (gl, args) => args[6] === gl.RGBA && args[7] === gl.UNSIGNED_BYTE;
  for (const gl of glProtos) {
    gl.proto.drawArrays = function (...args) {
      const result = gl.draw.apply(this, args);
      // The GPU preview's self-test draws into its own framebuffer.
      if (onPreview(this) && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
        const width = this.drawingBufferWidth, height = this.drawingBufferHeight;
        let hash = null;
        if (probe.hashDraws) {
          // The whole settled frame, read in the draw task.
          const pixels = new Uint8Array(width * height * 4);
          this.readPixels(0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels);
          let value = 2166136261;
          for (let i = 0; i < pixels.length; i++) value = Math.imul(value ^ pixels[i], 16777619);
          hash = value >>> 0;
          probe.lastHash = { width, height, hash };
        }
        const program = this.getParameter(this.CURRENT_PROGRAM);
        let apply = program ? applyPrograms.get(program) : false;
        if (program && apply === undefined) {
          apply = this.getUniformLocation(program, 'u_prepared') !== null;
          applyPrograms.set(program, apply);
        }
        note('draw', { width, height, texture: probe.texture ? [...probe.texture] : null, hash, apply: Boolean(apply) });
      }
      return result;
    };
    gl.proto.texImage2D = function (...args) {
      if (onPreview(this) && args[3] > 256 && ArrayBuffer.isView(args[8]) && exactFrame(this, args)) {
        probe.texture = [args[3], args[4]];
        note('upload', { width: args[3], height: args[4] });
      }
      return gl.allocate.apply(this, args);
    };
    gl.proto.texSubImage2D = function (...args) {
      if (onPreview(this) && args[4] > 256 && ArrayBuffer.isView(args[8]) && exactFrame(this, args)) note('upload', { width: args[4], height: args[5] });
      return gl.update.apply(this, args);
    };
  }
  Worker.prototype.postMessage = function (message, ...args) {
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
      // A display target (#248) sends the level and the size it converts at.
      const size = message.display?.target || message;
      note('convert', { cache: !!message.cacheInput, width: size.width, height: size.height });
    }
    if (probe.holding && (heldWorkers.has(this) || (message?.type === 'convert' && message.cacheInput))) {
      heldWorkers.add(this);
      probe.held.push({ worker: this, message, args });
      return undefined;
    }
    return original.post.call(this, message, ...args);
  };
  probe.release = () => {
    probe.holding = false;
    heldWorkers.clear();
    const held = probe.held.splice(0);
    for (const entry of held) original.post.call(entry.worker, entry.message, ...entry.args);
    return held.length;
  };
  Worker.prototype.terminate = function (...args) {
    const record = workers.get(this);
    if (record) { probe.inFlight -= record.pending.size; record.pending.clear(); note('terminate'); }
    return original.terminate.apply(this, args);
  };
  // Stamped when the event was created: the app's own capture listener,
  // registered before this one, ends the session and posts its settle tick
  // in the same dispatch.
  const onPointer = event => note(event.type, { time: event.timeStamp });
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('pointerup', onPointer, true);
  // Long tasks are logged, not asserted: timings belong to #230's harness.
  let longTasks = null;
  try {
    longTasks = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) note('longtask', { duration: Math.round(entry.duration) });
    });
    longTasks.observe({ type: 'longtask' });
  } catch { longTasks = null; }
  window.showSaveFilePicker = undefined;
  URL.revokeObjectURL = function (url) { if (!heldUrls.has(url)) original.revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function (...args) {
    if (!this.download || !this.href.startsWith('blob:')) return original.click.apply(this, args);
    const href = this.href, capture = { name: this.download };
    heldUrls.add(href); probe.downloads.push(capture);
    fetch(href).then(response => response.blob()).then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })).then(data => { capture.data = data; }, error => { capture.error = String(error); })
      .finally(() => { heldUrls.delete(href); original.revoke.call(URL, href); });
  };
  probe.restore = () => {
    probe.release();
    for (const gl of glProtos) Object.assign(gl.proto, { drawArrays: gl.draw, texImage2D: gl.allocate, texSubImage2D: gl.update });
    Worker.prototype.postMessage = original.post; Worker.prototype.terminate = original.terminate;
    HTMLAnchorElement.prototype.click = original.click; URL.revokeObjectURL = original.revoke;
    window.showSaveFilePicker = original.picker;
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('pointerup', onPointer, true);
    longTasks?.disconnect();
    for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    delete window.__tierProbe;
  };
}

function decodePngPixels(bytes) {
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const pixels = png.depth === 16 ? Buffer.from(png.data) : Buffer.from(UPNG.toRGBA8(png)[0]);
  return { width: png.width, height: png.height, depth: png.depth, sha256: createHash('sha256').update(pixels).digest('hex') };
}

// The sample strips only: tags such as DateTime may differ between runs.
function decodeTiffPixels(bytes) {
  const { ifd0 } = parseTiff(bytes);
  const offsets = ifd0[TIFF_TAGS.StripOffsets].values, counts = ifd0[TIFF_TAGS.StripByteCounts].values;
  const hash = createHash('sha256');
  offsets.forEach((offset, index) => hash.update(bytes.subarray(offset, offset + counts[index])));
  return { width: ifd0[TIFF_TAGS.ImageWidth].values[0], height: ifd0[TIFF_TAGS.ImageLength].values[0],
    bits: ifd0[TIFF_TAGS.BitsPerSample].values[0], sha256: hash.digest('hex') };
}

export async function runPreviewTierSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) fail(message); };
  const until = async (description, expression, timeout = 90_000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Longer than the 2.5 s idle full-resolution timer.
  const quiet = async description => {
    await evaluate('window.__tierProbe.lastActivity = Math.max(window.__tierProbe.lastActivity, performance.now())');
    await until(description, `${ready} && window.__tierProbe.inFlight === 0 && performance.now() - window.__tierProbe.lastActivity > 3500`);
  };
  // A same-value adjustment input redraws the texture on screen, and that
  // draw is hashed. (A window resize no longer draws at all unless the
  // drawing buffer must change, #261.)
  const settledFrame = async () => evaluate(`new Promise(resolve => {
    const probe = window.__tierProbe, start = performance.now();
    probe.hashDraws = true; probe.lastHash = null;
    document.getElementById('cyan').dispatchEvent(new Event('input', { bubbles: true }));
    const check = () => {
      if (!probe.lastHash && performance.now() - start < 3000) { requestAnimationFrame(check); return; }
      probe.hashDraws = false;
      const gl = document.getElementById('glCanvas');
      resolve({ hash: probe.lastHash, backing: [gl.width, gl.height], texture: probe.texture,
        visible: getComputedStyle(gl).display !== 'none' });
    };
    requestAnimationFrame(check);
  })`);
  const tile = () => evaluate(`document.querySelector('.file-list-name[data-index="0"] img.file-list-thumbnail')?.getAttribute('src') || null`);
  const download = async (format, depth) => {
    const index = await evaluate('window.__tierProbe.downloads.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${format}${depth} export captured`, `!!window.__tierProbe.downloads[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120_000);
    const data = await evaluate(`window.__tierProbe.downloads[${index}].data`);
    return new Uint8Array(Buffer.from(data.split(',')[1], 'base64'));
  };
  const sliderTrack = () => evaluate(`(() => {
    const slider = document.getElementById('coreExposure');
    slider.scrollIntoView({ block: 'center' });
    const rect = slider.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width,
      min: Number(slider.min), max: Number(slider.max), value: Number(slider.value) };
  })()`);
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  // A trusted drag from the thumb to `fraction` of the track; `afterRelease`
  // runs right after the release reaches the page.
  const drag = async (fraction, afterRelease = null) => {
    const track = await sliderTrack();
    expect(track.width > 40, 'exposure slider is not visible: ' + JSON.stringify(track));
    const thumb = 12;
    const startX = track.x + thumb / 2 + (track.value - track.min) / (track.max - track.min) * (track.width - thumb);
    const endX = track.x + track.width * fraction;
    const from = await evaluate('performance.now()');
    await mouse('mousePressed', startX, track.y);
    await pause(80);
    for (let step = 1; step <= 12; step++) {
      await mouse('mouseMoved', startX + (endX - startX) * step / 12, track.y);
      await pause(60);
    }
    await mouse('mouseReleased', endX, track.y);
    if (afterRelease) await afterRelease();
    return { from, value: await evaluate(`Number(document.getElementById('coreExposure').value)`) };
  };
  // A trusted click on the track at `fraction`, released before the worker
  // answers the press's tick: the probe holds that conversion until the
  // release has reached the page. A GPU frame (#239) converts nothing at the
  // press; the release's settle conversion is held and posted the same way.
  const click = async (fraction, { tickHeld }) => {
    const track = await sliderTrack();
    const x = track.x + track.width * fraction;
    const from = await evaluate('performance.now()');
    await evaluate('window.__tierProbe.holding = true');
    await mouse('mousePressed', x, track.y);
    // Well inside the session watchdog (1 s), so the release ends the session.
    const held = await evaluate(`new Promise(resolve => {
      const start = performance.now();
      const check = () => {
        if (window.__tierProbe.held.length || performance.now() - start > ${tickHeld ? 600 : 80}) resolve(window.__tierProbe.held.length);
        else setTimeout(check, 4);
      };
      check();
    })`);
    await mouse('mouseReleased', x, track.y);
    const posted = await evaluate('window.__tierProbe.release()');
    return { from, held, posted, value: await evaluate(`Number(document.getElementById('coreExposure').value)`) };
  };
  // Full-resolution conversions since `from`: none may precede a settled hash
  // that stands for the settle tick.
  const fullConversionsSince = from => evaluate(`window.__tierProbe.events
    .filter(event => event.type === 'convert' && !event.cache && event.time >= ${from}).length`);
  const applyDraws = () => evaluate(`window.__tierProbe.events.filter(event => event.type === 'draw' && event.apply).length`);
  // Nudges a SilverCore control (same value) until applyProgram draws: the GPU
  // preview prepares its inputs at idle.
  const gpuDrawing = async (label, timeout = 30_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const before = await applyDraws();
      await evaluate(`document.getElementById('coreBrightness').dispatchEvent(new Event('input', { bubbles: true }))`);
      await pause(120);
      if (await applyDraws() > before) {
        await quiet(`${label}: GPU preview drawing`);
        return true;
      }
      await pause(400);
    }
    return false;
  };
  // What the drag and its settle drew and converted, from the probe's events.
  const dragWindow = from => evaluate(`(() => {
    const events = window.__tierProbe.events.filter(event => event.time >= ${from});
    const down = events.find(event => event.type === 'pointerdown');
    const up = events.find(event => event.type === 'pointerup' && down && event.time >= down.time);
    const during = events.filter(event => down && up && event.time > down.time && event.time <= up.time);
    const after = up ? events.filter(event => event.time > up.time) : [];
    const px = event => event.width * event.height;
    return {
      pointer: !!(down && up),
      duringDraws: during.filter(event => event.type === 'draw').map(px),
      duringApplyDraws: during.filter(event => event.type === 'draw' && event.apply).length,
      duringConverts: during.filter(event => event.type === 'convert' && event.cache).map(px),
      afterConverts: after.filter(event => event.type === 'convert').map(event => ({ cache: event.cache, pixels: px(event), at: Math.round(event.time - up.time) })),
      afterDraws: after.filter(event => event.type === 'draw').map(event => ({ pixels: px(event), texture: event.texture, at: Math.round(event.time - up.time) })),
      longTasksDuring: during.filter(event => event.type === 'longtask').map(event => event.duration),
      lastSession: document.documentElement.dataset.previewTierLastSession || null,
    };
  })()`);

  const runs = {};
  for (const run of RUNS) {
    const mode = run.name;
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    const before = await evaluate('performance.timeOrigin');
    // The worker runs convert every tick; the GPU run's drag converts nothing
    // (#239). WebGL2 draws Step 3 in all of them.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&previewTier=${run.tier}&gpuPreview=${run.gpu}&largeImagePixels=${LARGE_IMAGE_PIXELS}` });
    await until(`${mode} tier workspace`, `performance.timeOrigin !== ${before} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await evaluate(`(${installTierProbe.toString()})()`);
    // Exports teach defaults: start both runs from none.
    await until('learned-default reset control mounted', `!!document.getElementById('resetLearnedDefaults')`);
    await evaluate(`(() => {
      window.__tierLearnedReset = false;
      const label = document.getElementById('learnedDefaultsCount');
      const observer = new MutationObserver(() => {
        if (label.textContent.trim() === 'Learned defaults: 0 stocks' && !document.querySelector('[data-app-dialog-confirm]')) {
          window.__tierLearnedReset = true; observer.disconnect();
        }
      });
      observer.observe(label, { childList: true, subtree: true, characterData: true });
      document.getElementById('resetLearnedDefaults').click();
    })()`);
    await until('learned defaults reset', `window.__tierLearnedReset && document.getElementById('learnedDefaultsCount').textContent.trim() === 'Learned defaults: 0 stocks'`);
    await evaluate(`(async () => {
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      document.querySelector('.film-type-btn[data-type="color"]').click();
      const negative = async (name, marked) => {
        const surface = document.createElement('canvas');
        surface.width = 2400; surface.height = 1600;
        const context = surface.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, 2400, 1600);
        gradient.addColorStop(0, 'rgb(190,128,84)'); gradient.addColorStop(1, 'rgb(120,78,46)');
        context.fillStyle = 'rgb(215,150,100)'; context.fillRect(0, 0, 2400, 1600);
        context.fillStyle = gradient; context.fillRect(120, 120, 2160, 1360);
        if (marked) { context.fillStyle = 'rgb(70,45,28)'; context.fillRect(120, 120, 700, 520); }
        const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
        return new File([blob], name, { type: 'image/png' });
      };
      const transfer = new DataTransfer();
      transfer.items.add(await negative('tier-a.png', true));
      transfer.items.add(await negative('tier-b.png', false));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(`${mode}: both negatives converted`, `${ready} && document.getElementById('studioFilename').textContent === 'tier-a.png' && document.querySelectorAll('.file-list-name[data-preview-state="ready"] img.file-list-thumbnail').length === 2`, 120_000);
    await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      document.getElementById('studioMore').open = true;
      const gl = document.getElementById('coreUseWebGL'); if (!gl.checked) gl.click();
    })()`);
    await quiet(`${mode}: initial preview idle`);
    if (run.gpu !== 'off') {
      if (!(await evaluate('!!window.WebGL2RenderingContext'))) {
        console.log(`SKIP preview tier ${mode}: no WebGL2`);
        continue;
      }
      expect(await gpuDrawing(mode), `${mode}: applyProgram never drew a SilverCore change, so the GPU run proves nothing`);
    }
    const initial = await settledFrame();
    expect(initial.visible && initial.hash && initial.backing[0] * initial.backing[1] > REDUCED_MAX_PIXELS,
      `${mode}: the fixture must show a GPU preview above 1 MP: ` + JSON.stringify(initial));

    const { from, value } = await drag(0.72);
    await pause(1500);
    const seen = await dragWindow(from);
    await quiet(`${mode}: drag settled`);
    const settled = await settledFrame();
    const fullBeforeHash = await fullConversionsSince(from);
    const thumbnail = await tile();
    const png8 = decodePngPixels(await download('png', 8));
    const tiff16 = decodeTiffPixels(await download('tiff', 16));
    await quiet(`${mode}: exports idle`);
    // ---- A click on the track, released before its tick is answered ----
    const clicked = await click(0.4, { tickHeld: run.gpu === 'off' });
    await quiet(`${mode}: click settled`);
    const clickSettled = await settledFrame();
    const clickFull = await fullConversionsSince(clicked.from);
    const clickSeen = await dragWindow(clicked.from);
    const clickTile = await tile();
    runs[mode] = { run, value, seen, settled, thumbnail, png8, tiff16, initial,
      click: { ...clicked, seen: clickSeen, settled: clickSettled, thumbnail: clickTile } };
    console.log(`preview tier ${mode}: ` + JSON.stringify({ value, seen, settled, png8, tiff16 }));
    console.log(`preview tier ${mode} click: ` + JSON.stringify({ ...clicked, seen: clickSeen, settled: clickSettled }));

    expect(seen.pointer, `${mode}: the drag produced no pointerdown/pointerup`);
    expect(settled.hash, `${mode}: the settled frame could not be read back: ` + JSON.stringify(settled));
    expect(fullBeforeHash === 0 && clickFull === 0,
      `${mode}: a full-resolution conversion ran before the settled hash, which then is not the settle tick's: ` + JSON.stringify({ fullBeforeHash, clickFull }));
    expect(clickSeen.pointer && clicked.value !== value, `${mode}: the click on the track changed nothing: ` + JSON.stringify(clicked));
    expect(clickSettled.hash, `${mode}: the frame settled after the click could not be read back`);
    if (mode === 'normal') {
      expect(seen.duringDraws.length > 0 && Math.max(...seen.duringDraws) > REDUCED_MAX_PIXELS
        && seen.duringConverts.length > 0 && Math.max(...seen.duringConverts) > REDUCED_MAX_PIXELS,
      'normal tier: the drag did not draw and convert above 1 MP, so the reduced run proves nothing: ' + JSON.stringify(seen));
      expect(clicked.held === 1 && clickSeen.duringConverts.length === 1 && clickSeen.duringConverts[0] > REDUCED_MAX_PIXELS
        && clickSeen.afterConverts.filter(convert => convert.cache).length === 0,
      'normal tier: the click did not convert its value once, before its release: ' + JSON.stringify({ clicked, clickSeen }));
      continue;
    }
    // ---- Reduced runs: the drag, its release and its settle ----
    expect(seen.lastSession === 'reduced', 'the forced session did not run reduced: ' + JSON.stringify(seen));
    expect(seen.duringDraws.length > 0 && seen.duringDraws.every(pixels => pixels <= REDUCED_MAX_PIXELS),
      `${mode}: a draw during the reduced drag exceeded 1 MP: ` + JSON.stringify(seen.duringDraws));
    if (run.gpu === 'off') {
      expect(seen.duringConverts.length > 0 && seen.duringConverts.every(pixels => pixels <= REDUCED_MAX_PIXELS),
        'a preview conversion during the reduced drag exceeded 1 MP: ' + JSON.stringify(seen.duringConverts));
    } else {
      // A GPU drag converts nothing (#239): its frames are the draws above.
      expect(seen.duringApplyDraws > 0, `${mode}: the GPU preview drew none of the reduced drag: ` + JSON.stringify(seen));
    }
    const normalPreview = Math.max(...runs.normal.seen.duringConverts);
    const settleTick = seen.afterConverts.findIndex(convert => convert.cache && convert.pixels === normalPreview);
    const fullRender = seen.afterConverts.findIndex(convert => !convert.cache);
    expect(settleTick >= 0 && (fullRender < 0 || settleTick < fullRender)
      && seen.afterConverts.filter(convert => convert.cache).length === 1,
    `${mode}: release did not convert exactly once at the normal size before any full-resolution render: ` + JSON.stringify(seen.afterConverts));
    // The drawing buffer follows the texture (#233): the first draw after
    // release is no longer capped below it.
    const firstDraw = seen.afterDraws[0];
    expect(firstDraw && firstDraw.texture && firstDraw.pixels === firstDraw.texture[0] * firstDraw.texture[1],
      `${mode}: the first draw after release was still capped below its texture: ` + JSON.stringify(seen.afterDraws.slice(0, 3)));
    const restored = seen.afterDraws.find(draw => draw.texture && draw.texture[0] * draw.texture[1] === normalPreview);
    expect(restored && restored.at < 1500 && restored.pixels === normalPreview,
      `${mode}: texture and drawing buffer were not back at the normal size within 1.5 s of release: ` + JSON.stringify(seen.afterDraws));
    // The click: its reduced tick lands after the session end, which converts
    // once more at the normal size (#229 review R1-119).
    if (run.gpu === 'off') {
      expect(clicked.held === 1 && clickSeen.duringConverts.length === 1 && clickSeen.duringConverts[0] <= REDUCED_MAX_PIXELS,
        `${mode}: the click's tick was not a reduced conversion held past the release: ` + JSON.stringify({ clicked, clickSeen }));
    }
    const clickConverts = clickSeen.afterConverts.filter(convert => convert.cache);
    expect(clickConverts.length === 1 && clickConverts[0].pixels === normalPreview,
      `${mode}: the click's release did not convert once at the normal size: ` + JSON.stringify({ clicked, clickSeen }));
  }

  // ---- Settled parity with the normal tier ----
  const normal = runs.normal, reduced = runs.reduced;
  for (const name of ['reduced-gpu', 'reduced']) {
    const other = runs[name];
    if (!other) continue;
    expect(normal.value === other.value && normal.click.value === other.click.value,
      `${name}: the runs ended on different values: ` + JSON.stringify([normal.value, other.value, normal.click.value, other.click.value]));
    expect(JSON.stringify(normal.initial.hash) === JSON.stringify(other.initial.hash), `${name}: the runs did not start from the same frame`);
    for (const [label, a, b] of [['drag', normal.settled, other.settled], ['click', normal.click.settled, other.click.settled]]) {
      expect(JSON.stringify(a.hash) === JSON.stringify(b.hash) && JSON.stringify(a.backing) === JSON.stringify(b.backing),
        `${name}: the WebGL frame settled after the ${label} differs from the normal tier: ` + JSON.stringify({ normal: a, [name]: b }));
    }
    expect(normal.thumbnail && normal.thumbnail === other.thumbnail, `${name}: the settled filmstrip tile differs from the normal tier`);
    expect(normal.click.thumbnail && normal.click.thumbnail === other.click.thumbnail,
      `${name}: the filmstrip tile settled after the click differs from the normal tier`);
    expect(JSON.stringify(normal.png8) === JSON.stringify(other.png8), `${name}: PNG8 export differs: ` + JSON.stringify([normal.png8, other.png8]));
    expect(JSON.stringify(normal.tiff16) === JSON.stringify(other.tiff16) && other.tiff16.bits === 16,
      `${name}: TIFF16 export differs: ` + JSON.stringify([normal.tiff16, other.tiff16]));
    console.log(`ok: ${name}: a reduced preview-tier drag draws <= 1 MP and settles identical to the normal tier (WebGL frame, tile, PNG8, TIFF16); so does a click released before its tick lands`);
  }

  // ---- Undo within 100 ms of release (still the reduced run) ----
  const beforeUndo = reduced.click.settled;
  await drag(0.3, () => evaluate(`document.getElementById('undoBtn').click()`));
  await quiet('undo right after release settled');
  const undone = await settledFrame();
  expect(undone.hash && JSON.stringify(undone.hash) === JSON.stringify(beforeUndo.hash) && undone.backing[0] * undone.backing[1] > REDUCED_MAX_PIXELS,
    'undo right after a reduced drag left a different or reduced view: ' + JSON.stringify({ beforeUndo, undone }));
  console.log('ok: undo within 100 ms of a reduced release restores the normal settled view');

  // ---- Photo switch within 100 ms of release ----
  await drag(0.55, () => evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`));
  await until('switched to photo B', `${ready} && document.getElementById('studioFilename').textContent === 'tier-b.png'`, 120_000);
  await quiet('photo B idle');
  const back = await evaluate('performance.now()');
  await evaluate(`document.querySelector('.file-list-name[data-index="0"]').click()`);
  await until('back on photo A', `${ready} && document.getElementById('studioFilename').textContent === 'tier-a.png'`, 120_000);
  await quiet('photo A idle');
  const revisit = await evaluate(`window.__tierProbe.events.filter(event => event.type === 'draw' && event.time > ${back})
    .map(event => ({ pixels: event.width * event.height, texture: event.texture }))`);
  const revisited = await settledFrame();
  expect(revisit.length > 0 && revisit.every(draw => draw.texture && draw.texture[0] * draw.texture[1] > REDUCED_MAX_PIXELS),
    'returning to a photo switched away from right after a reduced drag showed a reduced frame: ' + JSON.stringify(revisit));
  expect(revisited.hash && revisited.backing[0] * revisited.backing[1] > REDUCED_MAX_PIXELS, 'the revisited photo settled reduced: ' + JSON.stringify(revisited));
  console.log('ok: a photo switch within 100 ms of a reduced release remembers no reduced view');

  await evaluate('window.__tierProbe.restore()');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
}
