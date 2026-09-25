// #239 in Chrome: the WebGL2 preview of SilverCore controls.
//
// 1. Offscreen, independent of the app: the renderer's self-test and GPU-vs-CPU
//    parity for every film preset, the extreme settings of the acceptance list, every
//    B&W mix, every paper toning, the positive gain/WB and a stroke map (at most 1
//    per channel, at least 99.9 % identical pixels); step3Program against the
//    1703835 WebGL1 Step-3 shader on the same 8-bit input (at most 1).
// 2. In the app (?gpuPreview=force, so a software rasteriser on CI is tested too):
//    each applyProgram frame of a drag against the exact worker frame that settles
//    it, read back in the draw's own task; a GPU drag converts nothing, encodes no
//    tile and leaves the tile alone until the exact frame; an export started right
//    after release writes the released value; context loss and restore.
// 3. Fallbacks: WebGL1 forced, a failed self-test, WebGL off, the border preview,
//    the active dodge-and-burn tool and frame repairs keep today's worker frames.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const PARITY_MIN_IDENTICAL = 0.999;

// ---- page side ----

function installGpuProbe() {
  const protos = [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean);
  const originals = protos.map(proto => ({ proto, draw: proto.drawArrays }));
  const probe = window.__gpuProbe = {
    applyDraws: 0, step3Draws: 0, glDraws: 0, lastApply: null, captureApply: false, captureResults: false,
    posts: [], results: [], analyzePending: 0, lastAnalyzed: 0, encodes: 0, tileChanges: 0,
    exports: [], lastActivity: performance.now(),
  };
  const isApply = new WeakMap();
  for (const original of originals) {
    original.proto.drawArrays = function (...args) {
      const result = original.draw.apply(this, args);
      // The renderer's self-test draws into its own framebuffer: not the display.
      if (this.canvas?.id === 'glCanvas' && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
        probe.glDraws++;
        const program = this.getParameter(this.CURRENT_PROGRAM);
        let apply = program ? isApply.get(program) : false;
        if (program && apply === undefined) {
          apply = this.getUniformLocation(program, 'u_prepared') !== null;
          isApply.set(program, apply);
        }
        if (apply) {
          probe.applyDraws++;
          if (probe.captureApply) {
            // preserveDrawingBuffer is false: read in the draw's own task.
            const width = this.drawingBufferWidth, height = this.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            this.readPixels(0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels);
            probe.lastApply = { width, height, pixels, time: performance.now() };
          }
        } else {
          probe.step3Draws++;
        }
        probe.lastActivity = performance.now();
      }
      return result;
    };
  }
  const post = Worker.prototype.postMessage;
  const listened = new WeakSet();
  Worker.prototype.postMessage = function (message, ...args) {
    const preview = message?.cacheInput && ['convert', 'prepare', 'analyze'].includes(message.type);
    const full = message?.type === 'convert' && !message.cacheInput;
    if (preview || full) {
      probe.posts.push({ type: full ? 'full' : message.type, id: message.id, exposure: message.settings?.exposure, time: performance.now() });
      if (message.type === 'analyze') probe.analyzePending++;
      probe.lastActivity = performance.now();
      if (!listened.has(this)) {
        listened.add(this);
        this.addEventListener('message', event => {
          const reply = event.data;
          if (reply?.type === 'analyzed') { probe.analyzePending = Math.max(0, probe.analyzePending - 1); probe.lastAnalyzed = performance.now(); }
          if (reply?.type === 'error' && probe.posts.some(p => p.id === reply.id && p.type === 'analyze')) probe.analyzePending = Math.max(0, probe.analyzePending - 1);
          if (reply?.type === 'result' && reply.rgba) {
            const request = probe.posts.find(p => p.id === reply.id);
            probe.results.push({ id: reply.id, type: request?.type, exposure: request?.exposure, width: reply.width, height: reply.height,
              rgba: probe.captureResults && request?.type === 'convert' ? new Uint8Array(reply.rgba).slice() : null, time: performance.now() });
          }
          probe.lastActivity = performance.now();
        });
      }
    }
    return post.call(this, message, ...args);
  };
  const encode = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) { probe.encodes++; return encode.apply(this, args); };
  const tileSrc = () => document.querySelector('.file-list-name[aria-current="true"] img.file-list-thumbnail')?.getAttribute('src') || null;
  let lastSrc = tileSrc();
  new MutationObserver(() => {
    const src = tileSrc();
    if (src !== lastSrc) { lastSrc = src; probe.tileChanges++; }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  // Exports are captured as data URLs instead of downloads.
  window.showSaveFilePicker = undefined;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (!this.download?.endsWith('.png') || !this.href.startsWith('blob:')) return click.apply(this, args);
    const capture = { name: this.download };
    probe.exports.push(capture);
    fetch(this.href).then(response => response.blob()).then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })).then(data => { capture.data = data; }, error => { capture.error = String(error); });
  };
}

// A synthetic colour negative: film base rebate, a graded image area with colour
// patches, and a dense block in the top-left corner (upright check).
async function importSyntheticNegative(name) {
  for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
    const input = document.getElementById(id); if (input?.checked) input.click();
  }
  document.querySelector('.film-type-btn[data-type="color"]').click();
  const surface = document.createElement('canvas');
  surface.width = 1500; surface.height = 1000;
  const context = surface.getContext('2d');
  context.fillStyle = 'rgb(215,150,100)'; context.fillRect(0, 0, 1500, 1000);
  const gradient = context.createLinearGradient(80, 80, 1420, 920);
  gradient.addColorStop(0, 'rgb(190,125,80)'); gradient.addColorStop(0.5, 'rgb(150,95,70)'); gradient.addColorStop(1, 'rgb(95,70,55)');
  context.fillStyle = gradient; context.fillRect(80, 80, 1340, 840);
  const patches = ['rgb(120,110,60)', 'rgb(180,80,70)', 'rgb(90,120,95)', 'rgb(160,140,110)', 'rgb(70,60,40)', 'rgb(200,160,120)'];
  patches.forEach((color, i) => { context.fillStyle = color; context.fillRect(620 + (i % 3) * 230, 520 + Math.floor(i / 3) * 180, 190, 150); });
  context.fillStyle = 'rgb(60,40,25)'; context.fillRect(80, 80, 420, 320);
  const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], name, { type: 'image/png' }));
  const input = document.getElementById('fileInput'); input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---- offscreen GPU checks ----

async function offscreenChecks() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
  if (!gl) return { skipped: 'no WebGL2' };
  const { createGpuPreviewRenderer, webgl2PrecisionOk } = await import('/src/render/gpuPreviewRenderer.js');
  const { buildSelfTestCases, buildPreviewCase, parityFrame, parityStops } = await import('/src/render/gpuPreviewSelfTest.js');
  const { filmPresets } = await import('/src/silvercore/engine/FilmPresets.js');
  const { loadProfile } = await import('/src/silvercore/engine/EnhancedProfiles.js');
  const { bwMixWeights } = await import('/src/silvercore/engine/Presets.js');
  const { paperTonings } = await import('/src/silvercore/engine/PaperProfiles.js');
  const renderer = createGpuPreviewRenderer(gl);
  renderer.startApplyCompile();
  for (let i = 0; i < 600 && renderer.applyStatus() === 'pending'; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  if (renderer.applyStatus() !== 'linked') return { failed: 'applyProgram did not link: ' + renderer.applyError() };
  const report = { precision: webgl2PrecisionOk(gl), selfTest: renderer.selfTest(buildSelfTestCases()), batches: [] };
  if (!report.selfTest.ok) return { ...report, failed: 'self-test' };

  const W = 96, H = 64;
  const specs = [];
  for (const [id, preset] of Object.entries(filmPresets)) {
    specs.push({ name: `preset ${id}`, mode: preset.category, settings: { filmType: preset.category, filmPreset: id, colorModel: 'standard', temperature: 8, contrast: 12 } });
  }
  for (const exposure of [-300, 300]) specs.push({ name: `exposure ${exposure}`, mode: 'color', settings: { colorModel: 'standard', exposure } });
  for (const saturation of [0, 200]) specs.push({ name: `saturation ${saturation}`, mode: 'color', settings: { colorModel: 'frontier', saturation } });
  for (const profileStrength of [0, 100, 200]) specs.push({ name: `profile ${profileStrength}`, mode: 'color', settings: { colorModel: 'standard', enhancedProfile: 'noritsu', profileStrength } });
  for (const preSaturation of [0, 200]) {
    specs.push({ name: `pre-saturation ${preSaturation}`, mode: 'color', settings: { colorModel: 'standard', preSaturation } });
    specs.push({ name: `B&W pre-saturation ${preSaturation}`, mode: 'bw', settings: { preSaturation } });
  }
  for (const bwMix of Object.keys(bwMixWeights)) specs.push({ name: `B&W mix ${bwMix}`, mode: 'bw', settings: { bwMix, contrast: 20 } });
  for (const toning of Object.keys(paperTonings)) specs.push({ name: `toning ${toning}`, mode: 'bw', settings: { paper: 'multigrade-fb-warmtone', paperToning: toning, paperToningStrength: 80 } });
  specs.push({ name: 'RA-4 paper', mode: 'color', settings: { colorModel: 'noritsu', paper: 'endura', saturation: 140 } });
  specs.push({ name: 'positive gain and WB', mode: 'positive', settings: { colorModel: 'basic', whites: 20 }, positive: { gain: 2.4, wb: [0.9, 1, 0.82] } });
  specs.push({ name: 'dodge and burn', mode: 'color', settings: { colorModel: 'standard', preSaturation: 130 }, stops: true });
  specs.push({ name: 'B&W dodge and burn', mode: 'bw', settings: { bwMix: 'green', preSaturation: 70 }, stops: true });
  specs.push({ name: 'positive dodge and burn', mode: 'positive', settings: { colorModel: 'none' }, stops: true, positive: { gain: 1.6, wb: [1, 1, 1] } });

  const cases = [];
  for (const spec of specs) {
    const preset = spec.settings.filmPreset ? filmPresets[spec.settings.filmPreset].settings : {};
    const profileName = spec.settings.enhancedProfile || preset.enhancedProfile || 'none';
    cases.push(buildPreviewCase({
      name: spec.name, mode: spec.mode, settings: spec.settings, image: parityFrame(spec.mode, W, H),
      stops: spec.stops ? parityStops(W, H) : null, positive: spec.positive || null, filmPresets,
      profile: profileName !== 'none' ? await loadProfile(profileName) : null,
    }));
  }
  const failures = [];
  for (let i = 0; i < cases.length; i += 8) {
    const batch = cases.slice(i, i + 8);
    const result = renderer.selfTest(batch);
    report.batches.push(result.maxDiff);
    for (const item of result.cases) {
      if (item.maxDiff > 1 || item.identical < 0.999) failures.push(item);
    }
  }
  report.cases = cases.length;
  report.worst = failures.length ? failures : null;

  // step3Program against the 1703835 WebGL1 Step-3 shader (legacy uniforms at
  // identity), same RGBA8 input, non-identity WB, vibrance, CMY and curve.
  const size = 64;
  const input = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    input[i * 4] = (i * 37) & 255; input[i * 4 + 1] = (i * 11 + 40) & 255; input[i * 4 + 2] = (i * 5 + 90) & 255; input[i * 4 + 3] = 255;
  }
  const curve = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };
  for (let v = 0; v < 256; v++) { curve.r[v] = Math.round(255 * Math.pow(v / 255, 0.8)); curve.g[v] = v; curve.b[v] = Math.round(255 * Math.pow(v / 255, 1.2)); }
  const uniforms = { wb: [1.08, 0.97, 0.9], vib: 0.35, cmy: [0.04, -0.03, 0.02] };
  const newCanvas = document.createElement('canvas'); newCanvas.width = size; newCanvas.height = size;
  const gl2 = newCanvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  const step3Renderer = createGpuPreviewRenderer(gl2);
  step3Renderer.uploadExact({ width: size, height: size, data: input }, true);
  step3Renderer.uploadCurves(curve);
  step3Renderer.drawStep3(uniforms, size, size);
  const newPixels = new Uint8Array(size * size * 4);
  gl2.readPixels(0, 0, size, size, gl2.RGBA, gl2.UNSIGNED_BYTE, newPixels);
  const oldCanvas = document.createElement('canvas'); oldCanvas.width = size; oldCanvas.height = size;
  const gl1 = oldCanvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
  const oldPixels = window.__drawOldStep3(gl1, input, size, curve, uniforms);
  let step3Max = 0;
  for (let i = 0; i < newPixels.length; i++) if (i % 4 !== 3) step3Max = Math.max(step3Max, Math.abs(newPixels[i] - oldPixels[i]));
  report.step3MaxDiff = step3Max;
  // Upright: at identity, step3Program reproduces the input with its first row at
  // the top of the drawing buffer (the last row readPixels returns).
  const identityCurve = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) };
  for (let v = 0; v < 256; v++) identityCurve.r[v] = identityCurve.g[v] = identityCurve.b[v] = v;
  step3Renderer.uploadCurves(identityCurve);
  step3Renderer.drawStep3({ wb: [1, 1, 1], vib: 0, cmy: [0, 0, 0] }, size, size);
  gl2.readPixels(0, 0, size, size, gl2.RGBA, gl2.UNSIGNED_BYTE, newPixels);
  let uprightMax = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 3; c++) {
        uprightMax = Math.max(uprightMax, Math.abs(newPixels[((size - 1 - y) * size + x) * 4 + c] - input[(y * size + x) * 4 + c]));
      }
    }
  }
  report.step3Upright = uprightMax === 0;
  return report;
}

// The 1703835 WebGL1 Step-3 program, frozen here as the reference for step3Program.
function installOldStep3() {
  const vs = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;
  const fs = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 v_uv;
    uniform sampler2D u_image;
    uniform sampler2D u_curve;
    uniform vec3 u_wb;
    uniform float u_exposure;
    uniform float u_contrast;
    uniform float u_highlights;
    uniform float u_shadows;
    uniform float u_temp;
    uniform float u_tint;
    uniform float u_sat;
    uniform float u_vib;
    uniform vec3 u_cmy;
    float hue2rgb(float p, float q, float t) {
      if (t < 0.0) t += 1.0;
      if (t > 1.0) t -= 1.0;
      if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
      if (t < 1.0 / 2.0) return q;
      if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
      return p;
    }
    vec3 rgbToHsl(vec3 c) {
      float r = c.r, g = c.g, b = c.b;
      float maxc = max(r, max(g, b));
      float minc = min(r, min(g, b));
      float h = 0.0;
      float s = 0.0;
      float l = (maxc + minc) * 0.5;
      if (maxc != minc) {
        float d = maxc - minc;
        s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);
        if (maxc == r) {
          h = (g - b) / d + (g < b ? 6.0 : 0.0);
        } else if (maxc == g) {
          h = (b - r) / d + 2.0;
        } else {
          h = (r - g) / d + 4.0;
        }
        h /= 6.0;
      }
      return vec3(h, s, l);
    }
    vec3 hslToRgb(float h, float s, float l) {
      float r, g, b;
      if (s == 0.0) {
        r = g = b = l;
      } else {
        float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
        float p = 2.0 * l - q;
        r = hue2rgb(p, q, h + 1.0 / 3.0);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1.0 / 3.0);
      }
      return vec3(r, g, b);
    }
    vec3 applyCurves(vec3 c) {
      float rIdx = floor(c.r * 255.0 + 0.5);
      float gIdx = floor(c.g * 255.0 + 0.5);
      float bIdx = floor(c.b * 255.0 + 0.5);
      vec4 cr = texture2D(u_curve, vec2((rIdx + 0.5) / 256.0, 0.5));
      vec4 cg = texture2D(u_curve, vec2((gIdx + 0.5) / 256.0, 0.5));
      vec4 cb = texture2D(u_curve, vec2((bIdx + 0.5) / 256.0, 0.5));
      return vec3(cr.r, cg.g, cb.b);
    }
    void main() {
      vec3 c = texture2D(u_image, v_uv).rgb;
      float exposureMult = pow(2.0, u_exposure);
      c *= u_wb * exposureMult;
      c = (c - 0.5) * u_contrast + 0.5;
      float luma = dot(c, vec3(0.299, 0.587, 0.114));
      if (u_highlights != 0.0 && luma > 0.5) {
        float mult = 1.0 + u_highlights * (luma - 0.5) * 2.0;
        c *= mult;
      }
      if (u_shadows != 0.0 && luma < 0.5) {
        float mult = 1.0 + u_shadows * (0.5 - luma) * 2.0;
        c *= mult;
      }
      c.r *= (1.0 + u_temp * 0.3);
      c.b *= (1.0 - u_temp * 0.3);
      c.g *= (1.0 + u_tint * 0.3);
      c = clamp(c, 0.0, 1.0);
      if (u_sat != 1.0 || u_vib != 0.0) {
        vec3 hsl = rgbToHsl(c);
        float s = hsl.y * u_sat;
        if (u_vib >= 0.0) {
          s += (1.0 - s) * u_vib;
        } else {
          s *= (1.0 + u_vib);
        }
        hsl.y = clamp(s, 0.0, 1.0);
        c = hslToRgb(hsl.x, hsl.y, hsl.z);
      }
      vec3 cmy = vec3(1.0) - c;
      cmy = clamp(cmy + u_cmy, 0.0, 1.0);
      c = vec3(1.0) - cmy;
      c = applyCurves(c);
      gl_FragColor = vec4(c, 1.0);
    }`;
  window.__drawOldStep3 = (gl, input, size, curve, uniforms) => {
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const texture = (unit, width, height, data, filter) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      for (const [key, value] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    };
    texture(0, size, size, input, gl.LINEAR);
    const curveBytes = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) curveBytes.set([curve.r[i], curve.g[i], curve.b[i], 255], i * 4);
    texture(1, 256, 1, curveBytes, gl.NEAREST);
    const at = name => gl.getUniformLocation(program, name);
    gl.uniform1i(at('u_image'), 0); gl.uniform1i(at('u_curve'), 1);
    gl.uniform3f(at('u_wb'), ...uniforms.wb);
    gl.uniform1f(at('u_exposure'), 0); gl.uniform1f(at('u_contrast'), 1); gl.uniform1f(at('u_highlights'), 0);
    gl.uniform1f(at('u_shadows'), 0); gl.uniform1f(at('u_temp'), 0); gl.uniform1f(at('u_tint'), 0); gl.uniform1f(at('u_sat'), 1);
    gl.uniform1f(at('u_vib'), uniforms.vib);
    gl.uniform3f(at('u_cmy'), ...uniforms.cmy);
    gl.viewport(0, 0, size, size);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
}

// ---- node side ----

function decodePngSha(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return createHash('sha256').update(Buffer.from(UPNG.toRGBA8(png)[0])).digest('hex');
}

export async function runGpuPreviewSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) fail(message); };
  const until = async (description, expression, timeout = 60_000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const quiet = async (description, ms = 1500) => {
    await evaluate('window.__gpuProbe.lastActivity = Math.max(window.__gpuProbe.lastActivity, performance.now())');
    await until(description, `${ready} && performance.now() - window.__gpuProbe.lastActivity > ${ms}`);
  };
  const open = async (query, name) => {
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en${query}` });
    await until('fresh GPU preview workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await evaluate(`(${installGpuProbe.toString()})()`);
    await evaluate(`(${importSyntheticNegative.toString()})(${JSON.stringify(name)})`);
    await until(`${name} converted`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`, 120_000);
    await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      const more = document.getElementById('studioMore'); if (more) more.open = true;
    })()`);
  };
  // Sets a control and fires `input` (and `change` with commit) like a user would.
  const setControl = (id, value, { commit = false } = {}) => evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = String(${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (${commit}) el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  // Nudges the GPU path until applyProgram draws (the warm-up is idle work).
  const gpuDrawing = async (label, timeout = 30_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const before = await evaluate('window.__gpuProbe.applyDraws');
      await evaluate(`(() => { const el = document.getElementById('coreBrightness'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(120);
      if (await evaluate(`window.__gpuProbe.applyDraws > ${before}`)) {
        await quiet(`${label} settled`);
        return true;
      }
      await sleep(400);
    }
    return false;
  };
  // A drag in the page: `values` one per frame; returns what it posted and drew.
  const drag = (id, values) => evaluate(`(async () => {
    const probe = window.__gpuProbe, el = document.getElementById(${JSON.stringify(id)});
    const start = performance.now(), posts = probe.posts.length, applyDraws = probe.applyDraws, glDraws = probe.glDraws;
    for (const value of ${JSON.stringify(values)}) {
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 4)));
    }
    const during = { converts: probe.posts.slice(posts).filter(p => p.type === 'convert' || p.type === 'full').length,
      applyDraws: probe.applyDraws - applyDraws, glDraws: probe.glDraws - glDraws };
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ...during, ms: Math.round(performance.now() - start) };
  })()`);
  // GPU frame vs the exact frame that settles it, for the current value of `id`.
  const parity = async (label, id, value) => {
    await evaluate(`(() => { const p = window.__gpuProbe; p.captureApply = true; p.captureResults = true; p.lastApply = null; p.results = []; })()`);
    await setControl(id, value);
    // Keep the same value coming until an analysis it needs has landed and been drawn.
    for (let i = 0; i < 60; i++) {
      await sleep(60);
      const state = await evaluate(`(() => { const p = window.__gpuProbe; return { drawn: !!p.lastApply, pending: p.analyzePending,
        fresh: !!p.lastApply && p.lastApply.time > p.lastAnalyzed }; })()`);
      if (state.drawn && state.pending === 0 && state.fresh) break;
      await setControl(id, value);
    }
    await evaluate(`(() => { const p = window.__gpuProbe; p.settleFrom = performance.now(); })()`);
    await evaluate(`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change', { bubbles: true }))`);
    await until(`${label} exact frame`, `window.__gpuProbe.results.some(r => r.rgba && r.time > window.__gpuProbe.settleFrom)`, 30_000);
    const result = await evaluate(`(() => {
      const p = window.__gpuProbe, a = p.lastApply, r = p.results.filter(item => item.rgba).at(-1);
      p.captureApply = false; p.captureResults = false;
      if (!a) return { error: 'no applyProgram frame' };
      if (a.width !== r.width || a.height !== r.height) return { error: 'size', apply: [a.width, a.height], exact: [r.width, r.height] };
      let maxDiff = 0, differing = 0;
      for (let y = 0; y < a.height; y++) {
        const src = (a.height - 1 - y) * a.width * 4, dst = y * r.width * 4;
        for (let x = 0; x < a.width; x++) {
          let d = 0;
          for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.pixels[src + x * 4 + c] - r.rgba[dst + x * 4 + c]));
          if (d) differing++;
          if (d > maxDiff) maxDiff = d;
        }
      }
      return { size: [a.width, a.height], maxDiff, identical: 1 - differing / (a.width * a.height) };
    })()`);
    expect(!result.error && result.maxDiff <= 1 && result.identical >= PARITY_MIN_IDENTICAL,
      `GPU frame differs from its exact frame (${label}): ` + JSON.stringify(result));
    await quiet(`${label} idle`, 800);
    return result;
  };
  const exportPixels = async () => {
    const index = await evaluate('window.__gpuProbe.exports.length');
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    await until('PNG export', `!!window.__gpuProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 90_000);
    return decodePngSha(await evaluate(`window.__gpuProbe.exports[${index}].data`));
  };

  // ---- 1. Offscreen: self-test, parity sweep, step3Program vs WebGL1 ----
  await open('&gpuPreview=force', 'gpu-preview.png');
  await evaluate(`(${installOldStep3.toString()})()`);
  const offscreen = await evaluate(`(${offscreenChecks.toString()})()`);
  if (offscreen.skipped) {
    console.log(`SKIP gpu-preview: ${offscreen.skipped}`);
    return;
  }
  expect(!offscreen.failed && !offscreen.worst, 'GPU preview parity failed offscreen: ' + JSON.stringify(offscreen).slice(0, 4000));
  expect(offscreen.step3MaxDiff <= 1 && offscreen.step3Upright, 'step3Program differs from the WebGL1 Step 3 by more than 1: ' + JSON.stringify({ step3: offscreen.step3MaxDiff, upright: offscreen.step3Upright }));
  console.log('ok: GPU preview self-test, ' + offscreen.cases + ' parity cases within 1 and step3Program vs WebGL1 ' + JSON.stringify({ selfTest: offscreen.selfTest.maxDiff, step3: offscreen.step3MaxDiff, precision: offscreen.precision }));

  // ---- 2. In the app ----
  await setControl('wbR', '1', { commit: true });
  await setControl('wbG', '1', { commit: true });
  await setControl('wbB', '1', { commit: true });
  await quiet('Step 3 at identity');
  expect(await gpuDrawing('initial'), 'applyProgram never drew a SilverCore change (warm-up, prepare or analysis missing)');

  // Display-only: a GPU drag converts nothing, encodes no tile and leaves the tile.
  const before = await evaluate(`(() => { const p = window.__gpuProbe; return { encodes: p.encodes, tiles: p.tileChanges }; })()`);
  const gpuDrag = await drag('coreExposure', Array.from({ length: 24 }, (_, i) => -60 + i * 5));
  const duringTiles = await evaluate(`(() => { const p = window.__gpuProbe; return { encodes: p.encodes, tiles: p.tileChanges }; })()`);
  expect(gpuDrag.converts === 0 && gpuDrag.applyDraws >= 12, 'a GPU drag converted frames or drew too few: ' + JSON.stringify(gpuDrag));
  expect(duringTiles.encodes === before.encodes && duringTiles.tiles === before.tiles, 'a GPU frame reached the active tile: ' + JSON.stringify({ before, duringTiles }));
  await until('the release settles the drag', `window.__gpuProbe.posts.filter(p => p.type === 'convert').at(-1)?.exposure === 55`, 10_000);
  await until('the tile follows the exact frame', `window.__gpuProbe.tileChanges > ${duringTiles.tiles}`, 10_000);
  await quiet('GPU drag settled');
  console.log('ok: a GPU drag draws every frame, converts only the release and keeps GPU frames out of the tile ' + JSON.stringify(gpuDrag));

  // Parity in the app: the prepared negative, analysis, profile and paper paths.
  const results = [];
  results.push(await parity('exposure 120', 'coreExposure', 120));
  results.push(await parity('exposure -200', 'coreExposure', -200));
  await setControl('coreExposure', 0, { commit: true });
  results.push(await parity('contrast 40', 'coreContrast', 40));
  results.push(await parity('temperature -30', 'coreTemperature', -30));
  results.push(await parity('saturation 180', 'coreSaturation', 180));
  results.push(await parity('saturation 0', 'coreSaturation', 0));
  await setControl('coreSaturation', 100, { commit: true });
  results.push(await parity('pre-saturation 160', 'corePreSaturation', 160));
  results.push(await parity('border buffer 25', 'coreBorderBuffer', 25));
  await evaluate(`(() => { const el = document.getElementById('filmPreset'); el.value = 'frontier-lab'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await quiet('3D-profile preset applied', 2500);
  expect(await gpuDrawing('profile preset'), 'applyProgram did not draw with the preset profile');
  results.push(await parity('profile strength 200', 'coreProfileStrength', 200));
  results.push(await parity('profile strength 0', 'coreProfileStrength', 0));
  results.push(await parity('frontier exposure 40', 'coreExposure', 40));
  console.log('ok: in-app GPU frames match their exact frames ' + JSON.stringify(results.map(r => [r.maxDiff, Math.round(r.identical * 10000) / 10000])));

  // An export right after release writes the released value.
  await evaluate(`(() => {
    document.querySelector('.format-btn[data-format="png"]').click();
    document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
  })()`);
  await setControl('coreExposure', 0, { commit: true });
  await quiet('exposure reset');
  const baseline = await exportPixels();
  await drag('coreExposure', [10, 20, 30, 45, 60]);
  const immediate = await exportPixels();
  await quiet('export after release settled');
  const later = await exportPixels();
  expect(immediate === later && immediate !== baseline, 'an export right after a GPU drag did not write the released value: ' + JSON.stringify({ baseline, immediate, later }));
  console.log('ok: an export started at release waits for the exact frame');

  // B&W with paper and toning, then a positive.
  await evaluate(`document.querySelector('.film-type-btn[data-type="bw"]').click()`);
  await quiet('B&W converted', 2500);
  await until('B&W papers offered', `[...document.getElementById('corePaper').options].some(option => option.value === 'multigrade-fb-warmtone')`, 10_000);
  const toned = await evaluate(`(() => {
    const paper = document.getElementById('corePaper'); paper.value = 'multigrade-fb-warmtone'; paper.dispatchEvent(new Event('change', { bubbles: true }));
    const toning = document.getElementById('corePaperToning'); toning.value = 'sepia'; toning.dispatchEvent(new Event('change', { bubbles: true }));
    return [paper.value, toning.value];
  })()`);
  expect(toned[0] === 'multigrade-fb-warmtone' && toned[1] === 'sepia', 'B&W paper and toning could not be selected: ' + JSON.stringify(toned));
  await quiet('paper and toning', 2500);
  expect(await gpuDrawing('B&W'), 'applyProgram did not draw in B&W');
  const bw = [await parity('toning strength 50', 'corePaperToningStrength', 50), await parity('B&W exposure 60', 'coreExposure', 60)];
  await evaluate(`document.querySelector('.film-type-btn[data-type="positive"]').click()`);
  await quiet('positive converted', 2500);
  expect(await gpuDrawing('positive'), 'applyProgram did not draw for a positive');
  const positive = [await parity('positive exposure 30', 'coreExposure', 30), await parity('positive contrast -20', 'coreContrast', -20)];
  console.log('ok: B&W paper/toning and positive GPU frames match ' + JSON.stringify([...bw, ...positive].map(r => r.maxDiff)));
  await evaluate(`document.querySelector('.film-type-btn[data-type="color"]').click()`);
  await quiet('colour converted', 2500);

  // Fallback modes keep per-tick worker frames and draw no applyProgram.
  const workerDrag = async (label) => {
    const result = await drag('coreExposure', [5, 10, 15, 20, 25, 30]);
    expect(result.applyDraws === 0 && result.converts >= 2, `${label}: expected worker frames, not GPU frames: ` + JSON.stringify(result));
    await quiet(`${label} settled`);
    await setControl('coreExposure', 0, { commit: true });
    await quiet(`${label} reset`);
    return result;
  };
  const border = await evaluate(`(() => {
    const button = document.getElementById('sprocketPreviewBtn');
    if (!button || button.disabled) return false;
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    return button.getAttribute('aria-pressed') === 'true';
  })()`);
  expect(border, 'border preview could not be enabled');
  await quiet('border preview on');
  await workerDrag('border preview');
  await evaluate(`document.getElementById('sprocketPreviewBtn').click()`);
  await quiet('border preview off');
  await evaluate(`(() => { document.getElementById('studioTab-repair')?.click(); const d = document.getElementById('studioDodgeBurn'); if (d) d.open = true;
    const el = document.getElementById('dodgeBurnEnabled'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until('dodge and burn active', `document.body.classList.contains('dodge-burn-active')`, 5_000);
  await workerDrag('dodge-and-burn tool');
  await evaluate(`(() => { const el = document.getElementById('dodgeBurnEnabled'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('studioTab-edit').click(); })()`);
  await quiet('dodge and burn off');
  await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (input.checked) input.click(); })()`);
  await quiet('WebGL off');
  const cpu = await workerDrag('WebGL off');
  expect(cpu.glDraws === 0, 'WebGL off still drew with WebGL: ' + JSON.stringify(cpu));
  await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (!input.checked) input.click(); })()`);
  await quiet('WebGL on');
  expect(await gpuDrawing('WebGL on again'), 'the GPU path did not return with WebGL on');

  // Context loss drops to the worker path; restore brings the GPU path back.
  await evaluate(`(() => {
    const canvas = document.getElementById('glCanvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    window.__gpuLoseContext = context.getExtension('WEBGL_lose_context');
    window.__gpuLoseContext.loseContext();
  })()`);
  await quiet('context lost');
  await workerDrag('lost context');
  await evaluate('window.__gpuLoseContext.restoreContext()');
  await quiet('context restored', 2500);
  expect(await gpuDrawing('restored context'), 'the GPU path did not return after the context was restored');
  const restored = await parity('restored exposure 50', 'coreExposure', 50);
  console.log('ok: border preview, dodge-and-burn tool, WebGL off and a lost context use worker frames; restore returns to the GPU ' + JSON.stringify(restored));

  // Frame repairs (dust removal) convert at full resolution, never on the GPU.
  await setControl('coreExposure', 0, { commit: true });
  await quiet('before repairs');
  await evaluate(`document.getElementById('dustRemovalEnabled').click()`);
  await quiet('dust removal on', 3000);
  const repairs = await drag('coreExposure', [8, 16, 24]);
  expect(repairs.applyDraws === 0, 'frame repairs drew GPU frames: ' + JSON.stringify(repairs));
  await quiet('repairs settled', 3000);
  await evaluate(`document.getElementById('dustRemovalEnabled').click()`);
  await quiet('dust removal off', 3000);

  // ---- 3. Forced fallbacks at start-up ----
  for (const mode of ['webgl1', 'selftest-fail']) {
    await open(`&gpuPreview=${mode}`, `gpu-preview-${mode}.png`);
    await quiet(`${mode} idle`, 3000);
    const context = await evaluate(`(() => { const canvas = document.getElementById('glCanvas');
      return { webgl2: !!canvas.getContext('webgl2'), webgl: !!canvas.getContext('webgl') }; })()`);
    expect(mode === 'webgl1' ? !context.webgl2 && context.webgl : context.webgl2, `${mode}: unexpected context ` + JSON.stringify(context));
    const result = await drag('coreExposure', [5, 10, 15, 20, 25, 30]);
    expect(result.applyDraws === 0 && result.converts >= 2 && result.glDraws > 0, `${mode}: expected worker frames drawn by Step 3: ` + JSON.stringify(result));
    await quiet(`${mode} settled`);
    console.log(`ok: ?gpuPreview=${mode} keeps the worker path ` + JSON.stringify(result));
  }
}
