// Interactive preview tier (#263), forced by its test hook: ?previewTier=reduced
// starts every slider drag in the ~1 MP tier, ?previewTier=normal never
// leaves the normal one. The same trusted Exposure drag runs in both on a
// synthetic 3.8 MP negative at DPR 2 (a display preview above 1 MP):
// - reduced: every draw during the drag is <= 1 MP; after release one
//   normal-size preview conversion runs before any full-resolution one, and
//   the texture is back at the normal size;
// - the settled WebGL frame (full readPixels hash), the filmstrip tile and the
//   exported PNG8 and TIFF16 pixels are identical in both runs;
// - undo, or a photo switch, within 100 ms of release never leaves a reduced
//   frame as the settled or remembered view.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseTiff, TIFF_TAGS } from '../negative2positive/src/workers/tiffWriter.js';

const UPNG = createRequire(import.meta.url)('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const REDUCED_MAX_PIXELS = 1_000_000;

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
  };
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
        note('draw', { width, height, texture: probe.texture ? [...probe.texture] : null, hash });
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
    return original.post.call(this, message, ...args);
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
      duringConverts: during.filter(event => event.type === 'convert' && event.cache).map(px),
      afterConverts: after.filter(event => event.type === 'convert').map(event => ({ cache: event.cache, pixels: px(event), at: Math.round(event.time - up.time) })),
      afterDraws: after.filter(event => event.type === 'draw').map(event => ({ pixels: px(event), texture: event.texture, at: Math.round(event.time - up.time) })),
      longTasksDuring: during.filter(event => event.type === 'longtask').map(event => event.duration),
      lastSession: document.documentElement.dataset.previewTierLastSession || null,
    };
  })()`);

  const runs = {};
  for (const mode of ['normal', 'reduced']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    const before = await evaluate('performance.timeOrigin');
    // The tier is checked on the worker path: the GPU preview (#239) draws
    // SilverCore drags without converting them. WebGL2 still draws Step 3.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&previewTier=${mode}&gpuPreview=off` });
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
    const initial = await settledFrame();
    expect(initial.visible && initial.hash && initial.backing[0] * initial.backing[1] > REDUCED_MAX_PIXELS,
      `${mode}: the fixture must show a GPU preview above 1 MP: ` + JSON.stringify(initial));

    const { from, value } = await drag(0.72);
    await pause(1500);
    const seen = await dragWindow(from);
    await quiet(`${mode}: drag settled`);
    const settled = await settledFrame();
    const thumbnail = await tile();
    const png8 = decodePngPixels(await download('png', 8));
    const tiff16 = decodeTiffPixels(await download('tiff', 16));
    await quiet(`${mode}: exports idle`);
    runs[mode] = { value, seen, settled, thumbnail, png8, tiff16, initial };
    console.log(`preview tier ${mode}: ` + JSON.stringify({ value, seen, settled, png8, tiff16 }));

    expect(seen.pointer, `${mode}: the drag produced no pointerdown/pointerup`);
    expect(settled.hash, `${mode}: the settled frame could not be read back: ` + JSON.stringify(settled));
    if (mode === 'normal') {
      expect(seen.duringDraws.length > 0 && Math.max(...seen.duringDraws) > REDUCED_MAX_PIXELS
        && seen.duringConverts.length > 0 && Math.max(...seen.duringConverts) > REDUCED_MAX_PIXELS,
      'normal tier: the drag did not draw and convert above 1 MP, so the reduced run proves nothing: ' + JSON.stringify(seen));
      continue;
    }
    // ---- Reduced run: the drag, its release and its settle ----
    expect(seen.lastSession === 'reduced', 'the forced session did not run reduced: ' + JSON.stringify(seen));
    expect(seen.duringDraws.length > 0 && seen.duringDraws.every(pixels => pixels <= REDUCED_MAX_PIXELS),
      'a draw during the reduced drag exceeded 1 MP: ' + JSON.stringify(seen.duringDraws));
    expect(seen.duringConverts.length > 0 && seen.duringConverts.every(pixels => pixels <= REDUCED_MAX_PIXELS),
      'a preview conversion during the reduced drag exceeded 1 MP: ' + JSON.stringify(seen.duringConverts));
    const normalPreview = Math.max(...runs.normal.seen.duringConverts);
    const settleTick = seen.afterConverts.findIndex(convert => convert.cache && convert.pixels === normalPreview);
    const fullRender = seen.afterConverts.findIndex(convert => !convert.cache);
    expect(settleTick >= 0 && (fullRender < 0 || settleTick < fullRender)
      && seen.afterConverts.filter(convert => convert.cache).length === 1,
    'release did not convert exactly once at the normal size before any full-resolution render: ' + JSON.stringify(seen.afterConverts));
    // The drawing buffer follows the texture (#233): the first draw after
    // release is no longer capped below it.
    const firstDraw = seen.afterDraws[0];
    expect(firstDraw && firstDraw.texture && firstDraw.pixels === firstDraw.texture[0] * firstDraw.texture[1],
      'the first draw after release was still capped below its texture: ' + JSON.stringify(seen.afterDraws.slice(0, 3)));
    const restored = seen.afterDraws.find(draw => draw.texture && draw.texture[0] * draw.texture[1] === normalPreview);
    expect(restored && restored.at < 1500 && restored.pixels === normalPreview,
      'texture and drawing buffer were not back at the normal size within 1.5 s of release: ' + JSON.stringify(seen.afterDraws));
  }

  // ---- Settled parity with the normal tier ----
  const normal = runs.normal, reduced = runs.reduced;
  expect(normal.value === reduced.value, 'the two drags ended on different values: ' + JSON.stringify([normal.value, reduced.value]));
  expect(JSON.stringify(normal.initial.hash) === JSON.stringify(reduced.initial.hash), 'the runs did not start from the same frame');
  expect(JSON.stringify(normal.settled.hash) === JSON.stringify(reduced.settled.hash)
    && JSON.stringify(normal.settled.backing) === JSON.stringify(reduced.settled.backing),
  'the settled WebGL frame differs from the normal tier: ' + JSON.stringify({ normal: normal.settled, reduced: reduced.settled }));
  expect(normal.thumbnail && normal.thumbnail === reduced.thumbnail, 'the settled filmstrip tile differs from the normal tier');
  expect(JSON.stringify(normal.png8) === JSON.stringify(reduced.png8), 'PNG8 export differs: ' + JSON.stringify([normal.png8, reduced.png8]));
  expect(JSON.stringify(normal.tiff16) === JSON.stringify(reduced.tiff16) && reduced.tiff16.bits === 16,
    'TIFF16 export differs: ' + JSON.stringify([normal.tiff16, reduced.tiff16]));
  console.log('ok: a reduced preview-tier drag draws <= 1 MP and settles identical to the normal tier (WebGL frame, tile, PNG8, TIFF16)');

  // ---- Undo within 100 ms of release (still the reduced run) ----
  const beforeUndo = reduced.settled;
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
