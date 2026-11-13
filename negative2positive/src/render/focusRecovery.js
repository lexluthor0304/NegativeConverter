/**
 * focusRecovery.js - takes back part of a slight defocus
 *
 * A frame shot a little out of focus is the sharp picture spread by a small
 * blur. Unsharp masking raises contrast across that blur; deconvolution
 * undoes it: Richardson-Lucy iterations with a Gaussian of the frame's own
 * excess blur, on the luminance only, damped so that differences the size of
 * the grain are left alone (the grain was never blurred: it lies on the film).
 *
 *   1. estimateFocus: how wide the frame's sharpest edges are, from their
 *      gradient at two scales, and how strong its fine grain is.
 *   2. focusPlan: the Gaussian to undo. A frame is never sharper than its
 *      film, lens and scan allow, so only the blur beyond that baseline
 *      counts, and the strength (0-1) takes a share of it: defocus changes
 *      with depth, and one blur for the whole frame over-sharpens what was in
 *      focus (ringing) when taken whole.
 *   3. The iterations run on the GPU (WebGL2, R32F targets), in tiles of
 *      2048 px with a halo, the same tiles on every device: 60 MP takes about
 *      two seconds where one CPU thread takes a hundred. There is no CPU
 *      path in the app; recoverFocusReference is the same arithmetic in
 *      JavaScript for tests and the page's self-check.
 *
 * The result scales R, G and B by the luminance's gain, so colour stays.
 * See docs/focus-recovery.md.
 */

export const FOCUS_TILE = 2048;          // px of a tile's own area: the same on every device, so the tiling never changes a result
export const FOCUS_HALO = 64;            // px around a tile the iterations read
export const FOCUS_ITERATIONS = 20;
export const FOCUS_MAX_SIGMA = 5;        // px: past this the grain turns into clumps whatever the damping
export const FOCUS_MIN_SIGMA = 0.6;      // px: a narrower blur is not worth undoing
export const FOCUS_BASE_SHARE = 0.00042; // the blur of a sharp frame, as a share of the short side (2.6 px at 60 MP on 35 mm)
export const FOCUS_BASE_MIN = 1.0;       // ...and in px, at least
export const FOCUS_DAMP_GRAINS = 3;      // differences up to this many grains are grain
export const FOCUS_DAMP_MIN = 6 / 255;
export const FOCUS_DAMP_MAX = 20 / 255;
export const FOCUS_DEFAULT_STRENGTH = 0.6;
const MAX_TAPS = 33;                     // 2 * ceil(3 * FOCUS_MAX_SIGMA) + 1, odd
const FLOOR = 1 / 255;                   // keeps the ratio finite in black
const LUMA = [0.299, 0.587, 0.114];
const EDGE_SHARE = 0.003;                // the strongest edges the estimate reads
const SCALE_FINE = 1.5, SCALE_COARSE = 3;
const PATCH = 384, PATCH_COLUMNS = 4, PATCH_ROWS = 3;

/** The Gaussian's taps for a blur of `sigma` px: odd, at most 33, summing to one. */
export function focusKernel(sigma) {
  const radius = Math.min((MAX_TAPS - 1) >> 1, Math.max(1, Math.ceil(sigma * 3)));
  const taps = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += taps[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  return taps;
}

// ─── The estimate ────────────────────────────────────────────────────────────

function separableBlur(src, width, height, taps, tmp, dst) {
  const radius = taps.length >> 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const xx = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
        sum += src[row + xx] * taps[i + radius];
      }
      tmp[row + x] = sum;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const yy = y + i < 0 ? 0 : y + i >= height ? height - 1 : y + i;
        sum += tmp[yy * width + x] * taps[i + radius];
      }
      dst[y * width + x] = sum;
    }
  }
  return dst;
}

// Luminance of a window of the frame, 0-1 (8-bit data, or the 16-bit plane when the frame has one).
function luminanceWindow(frame, x0, y0, width, height, out) {
  const plane = frame.__image16 && frame.__image16.data instanceof Uint16Array ? frame.__image16.data : null;
  const data = plane || frame.data, scale = plane ? 1 / 65535 : 1 / 255, stride = frame.width * 4;
  for (let y = 0; y < height; y++) {
    let i = (y0 + y) * stride + x0 * 4;
    for (let x = 0; x < width; x++, i += 4) {
      out[y * width + x] = (data[i] * LUMA[0] + data[i + 1] * LUMA[1] + data[i + 2] * LUMA[2]) * scale;
    }
  }
  return out;
}

/**
 * How soft the frame is. `sigma`: the blur of its sharpest edges as a
 * Gaussian's sigma in px. At an edge blurred by sigma, the gradient of the
 * frame smoothed at scale s falls as 1 / sqrt(sigma² + s²), so the ratio R of
 * the gradients at two scales gives sigma² = (s2² − R² s1²) / (R² − 1). Read
 * on patches of the frame's interior: an uncropped scan's film border is the
 * sharpest edge in it and says nothing about the focus. `grain`: the spread
 * of the fine detail (the frame less itself smoothed at 2 px) where the
 * patches are calmest, 0-1. Null when the frame is too small to say.
 */
export function estimateFocus(frame) {
  const { width, height } = frame;
  const side = Math.min(PATCH, Math.floor(width * 0.7), Math.floor(height * 0.7));
  if (side < 64) return null;
  const columns = Math.max(1, Math.min(PATCH_COLUMNS, Math.floor(width * 0.7 / side)));
  const rows = Math.max(1, Math.min(PATCH_ROWS, Math.floor(height * 0.7 / side)));
  const n = side * side;
  const lum = new Float32Array(n), tmp = new Float32Array(n), fine = new Float32Array(n), coarse = new Float32Array(n), soft = new Float32Array(n);
  const tapsFine = focusKernel(SCALE_FINE), tapsCoarse = focusKernel(SCALE_COARSE), tapsGrain = focusKernel(2);
  const coarseAll = [], fineAll = [], grains = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x0 = Math.round(width * 0.15 + (width * 0.7 - side) * (columns > 1 ? c / (columns - 1) : 0.5));
      const y0 = Math.round(height * 0.15 + (height * 0.7 - side) * (rows > 1 ? r / (rows - 1) : 0.5));
      luminanceWindow(frame, x0, y0, side, side, lum);
      separableBlur(lum, side, side, tapsFine, tmp, fine);
      separableBlur(lum, side, side, tapsCoarse, tmp, coarse);
      separableBlur(lum, side, side, tapsGrain, tmp, soft);
      const margin = 10;
      let sum = 0, sumSq = 0, count = 0;
      for (let y = margin; y < side - margin; y++) {
        for (let x = margin; x < side - margin; x++) {
          const i = y * side + x;
          const gc = Math.hypot(coarse[i + 1] - coarse[i - 1], coarse[i + side] - coarse[i - side]);
          const gf = Math.hypot(fine[i + 1] - fine[i - 1], fine[i + side] - fine[i - side]);
          coarseAll.push(gc);
          fineAll.push(gf);
          const d = lum[i] - soft[i];
          sum += d; sumSq += d * d; count++;
        }
      }
      grains.push(Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2)));
    }
  }
  const order = Float32Array.from(coarseAll).sort();
  const threshold = order[Math.min(order.length - 1, Math.floor(order.length * (1 - EDGE_SHARE)))];
  if (!(threshold > 1e-4)) return null;   // no edge to read: a flat frame
  const ratios = [];
  for (let i = 0; i < coarseAll.length; i++) if (coarseAll[i] >= threshold) ratios.push(fineAll[i] / coarseAll[i]);
  ratios.sort((a, b) => a - b);
  const ratio = Math.max(1.0001, ratios[ratios.length >> 1]);
  const variance = (SCALE_COARSE ** 2 - ratio * ratio * SCALE_FINE ** 2) / (ratio * ratio - 1);
  grains.sort((a, b) => a - b);
  return { sigma: Math.sqrt(Math.max(0, variance)), grain: grains[grains.length >> 2] };
}

/**
 * What to undo, or null when there is nothing worth undoing: { sigma (px of
 * the Gaussian), damp (0-1), iterations, base (the blur a sharp frame of
 * this size has), excess (this frame's blur beyond it) }.
 */
export function focusPlan(width, height, estimate, strength) {
  const share = Math.min(1, Math.max(0, Number(strength) || 0));
  if (!estimate || !(share > 0)) return null;
  const base = Math.max(FOCUS_BASE_MIN, Math.min(width, height) * FOCUS_BASE_SHARE);
  const excess = Math.sqrt(Math.max(0, estimate.sigma ** 2 - base ** 2));
  const sigma = Math.min(FOCUS_MAX_SIGMA, excess * share);
  if (sigma < FOCUS_MIN_SIGMA) return null;
  const damp = Math.min(FOCUS_DAMP_MAX, Math.max(FOCUS_DAMP_MIN, FOCUS_DAMP_GRAINS * (estimate.grain || 0)));
  // Rounded so that the same photo gives the same plan on every machine.
  return { sigma: Math.round(sigma * 100) / 100, damp: Math.round(damp * 10000) / 10000, iterations: FOCUS_ITERATIONS,
    base: Math.round(base * 100) / 100, excess: Math.round(excess * 100) / 100 };
}

// ─── The reference: the shaders' arithmetic in JavaScript ───────────────────

function emptyLike(frame) {
  const out = { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data.length) };
  if (frame.__image16 && frame.__image16.data instanceof Uint16Array) {
    out.__image16 = { width: frame.width, height: frame.height, data: new Uint16Array(frame.__image16.data.length) };
  }
  return typeof ImageData === 'function' && frame instanceof ImageData
    ? Object.assign(new ImageData(out.data, frame.width, frame.height), out.__image16 ? { __image16: out.__image16 } : {})
    : out;
}

/**
 * The recovered frame, computed on the whole frame in Float32: what the GPU
 * tiles compute, less their halos' truncation. For tests and the self-check.
 */
export function recoverFocusReference(frame, plan) {
  const { width, height } = frame, n = width * height;
  const out = emptyLike(frame);
  const plane = frame.__image16 && frame.__image16.data instanceof Uint16Array ? frame.__image16.data : null;
  if (!plan) {
    out.data.set(frame.data);
    if (plane) out.__image16.data.set(plane);
    return out;
  }
  const taps = focusKernel(plan.sigma);
  const y = new Float32Array(n), x = new Float32Array(n), est = new Float32Array(n), ratio = new Float32Array(n), tmp = new Float32Array(n);
  luminanceWindow(frame, 0, 0, width, height, y);
  for (let i = 0; i < n; i++) x[i] = y[i] = Math.fround(y[i] + FLOOR);
  for (let it = 0; it < plan.iterations; it++) {
    separableBlur(x, width, height, taps, tmp, est);
    for (let i = 0; i < n; i++) {
      const e = est[i] > 1e-4 ? est[i] : 1e-4;
      const w = Math.min(Math.abs(y[i] - e) / plan.damp, 1);
      ratio[i] = 1 + (y[i] / e - 1) * w * w;
    }
    separableBlur(ratio, width, height, taps, tmp, est);
    for (let i = 0; i < n; i++) x[i] *= est[i];
  }
  const source = plane || frame.data, target = plane ? out.__image16.data : out.data, max = plane ? 65535 : 255;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const gain = x[i] / y[i];
    for (let c = 0; c < 3; c++) target[p + c] = Math.min(max, Math.max(0, Math.floor(source[p + c] * gain + 0.5)));
    target[p + 3] = source[p + 3];
  }
  if (plane) for (let i = 0; i < out.data.length; i++) out.data[i] = target[i] >>> 8;
  return out;
}

// ─── The GPU ─────────────────────────────────────────────────────────────────

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0., 1.); }`;

const LUMINANCE = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D src; uniform float scale;
out vec4 o;
void main() {
  vec3 rgb = vec3(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb);
  o = vec4(dot(rgb, vec3(${LUMA.join(', ')})) * scale + ${FLOOR.toFixed(10)}, 0., 0., 1.);
}`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D src; uniform ivec2 dir; uniform int radius; uniform float taps[${MAX_TAPS}];
out vec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy), last = textureSize(src, 0) - 1;
  float sum = 0.;
  for (int i = -radius; i <= radius; i++) sum += texelFetch(src, clamp(at + dir * i, ivec2(0), last), 0).r * taps[i + radius];
  o = vec4(sum, 0., 0., 1.);
}`;

const RATIO = `#version 300 es
precision highp float;
uniform sampler2D seen; uniform sampler2D est; uniform float damp;
out vec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  float y = texelFetch(seen, at, 0).r, e = max(texelFetch(est, at, 0).r, 1e-4);
  float w = min(abs(y - e) / damp, 1.);
  o = vec4(1. + (y / e - 1.) * w * w, 0., 0., 1.);
}`;

const MULTIPLY = `#version 300 es
precision highp float;
uniform sampler2D a; uniform sampler2D b;
out vec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  o = vec4(texelFetch(a, at, 0).r * texelFetch(b, at, 0).r, 0., 0., 1.);
}`;

const APPLY = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D src; uniform sampler2D seen; uniform sampler2D found; uniform float top;
out uvec4 o;
void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  uvec4 texel = texelFetch(src, at, 0);
  float gain = texelFetch(found, at, 0).r / texelFetch(seen, at, 0).r;
  o = uvec4(uvec3(clamp(floor(vec3(texel.rgb) * gain + 0.5), 0., top)), texel.a);
}`;

/** Tiles of a frame: each { x, y, width, height } with its halo, and the part of it that is the tile's own. */
export function focusTiles(width, height, tile = FOCUS_TILE, halo = FOCUS_HALO) {
  const tiles = [];
  for (let ty = 0; ty < height; ty += tile) {
    for (let tx = 0; tx < width; tx += tile) {
      const own = { x: tx, y: ty, width: Math.min(tile, width - tx), height: Math.min(tile, height - ty) };
      const x = Math.max(0, tx - halo), y = Math.max(0, ty - halo);
      tiles.push({ x, y, width: Math.min(width, own.x + own.width + halo) - x, height: Math.min(height, own.y + own.height + halo) - y, own });
    }
  }
  return tiles;
}

/**
 * A recoverer on its own WebGL2 context: `supported` (R32F render targets
 * and textures of a tile's size), `recover(frame, plan, { yieldBetweenTiles,
 * isCurrent })` resolving to a new frame (the input is not modified; null
 * plan: null), and `dispose()`. A lost context makes recover throw; the
 * caller creates another recoverer.
 */
export function createFocusRecoverer({ canvas = null } = {}) {
  const surface = canvas || (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1)
    : typeof document !== 'undefined' ? document.createElement('canvas') : null);
  const gl = surface ? surface.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) : null;
  const side = FOCUS_TILE + 2 * FOCUS_HALO;
  const supported = Boolean(gl && gl.getExtension('EXT_color_buffer_float') && gl.getParameter(gl.MAX_TEXTURE_SIZE) >= side);
  if (!supported) return { supported: false, recover: async () => { throw new Error('Focus recovery needs WebGL2 with float render targets'); }, dispose() {} };

  const compile = (fragment) => {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Focus recovery shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, 'p');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Focus recovery program: ${gl.getProgramInfoLog(program)}`);
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  };
  // Compiled at the first recovery: asking whether the device can do it costs a context, not five shaders.
  let programs = null;
  const ready = () => (programs ||= { luminance: compile(LUMINANCE), blur: compile(BLUR), ratio: compile(RATIO), multiply: compile(MULTIPLY), apply: compile(APPLY) });
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const framebuffer = gl.createFramebuffer();
  let disposed = false;

  const texture = (internal, width, height) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const draw = ({ program, uniforms }, target, textures, set) => {
    gl.useProgram(program);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(uniforms[name], unit++);
    }
    if (set) set(uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // One tile: its window of `source` up, the iterations, its own part down into `target`.
  const recoverTile = (source, target, frameWidth, tile, plan, sixteen) => {
    const { width, height } = tile;
    const integer = sixteen ? gl.RGBA16UI : gl.RGBA8UI, type = sixteen ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE;
    const made = [];
    const make = (internal) => { const t = texture(internal, width, height); made.push(t); return t; };
    try {
      const src = make(integer);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, frameWidth);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, tile.x);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, tile.y);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA_INTEGER, type, source);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      const seen = make(gl.R32F), est = make(gl.R32F), tmp = make(gl.R32F), ratio = make(gl.R32F), out = make(integer);
      let current = make(gl.R32F), next = make(gl.R32F);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
      draw(programs.luminance, seen, { src }, (u) => gl.uniform1f(u.scale, sixteen ? 1 / 65535 : 1 / 255));
      draw(programs.luminance, current, { src }, (u) => gl.uniform1f(u.scale, sixteen ? 1 / 65535 : 1 / 255));
      const taps = new Float32Array(MAX_TAPS);
      const kernel = focusKernel(plan.sigma);
      taps.set(kernel);
      const blur = (from, to) => {
        const set = (dx, dy) => (u) => { gl.uniform2i(u.dir, dx, dy); gl.uniform1i(u.radius, kernel.length >> 1); gl.uniform1fv(u.taps, taps); };
        draw(programs.blur, tmp, { src: from }, set(1, 0));
        draw(programs.blur, to, { src: tmp }, set(0, 1));
      };
      for (let it = 0; it < plan.iterations; it++) {
        blur(current, est);
        draw(programs.ratio, ratio, { seen, est }, (u) => gl.uniform1f(u.damp, plan.damp));
        blur(ratio, est);
        draw(programs.multiply, next, { a: current, b: est });
        [current, next] = [next, current];
      }
      draw(programs.apply, out, { src, seen, found: current }, (u) => gl.uniform1f(u.top, sixteen ? 65535 : 255));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Focus recovery framebuffer is incomplete');
      const { own } = tile;
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.PACK_ROW_LENGTH, frameWidth);
      gl.readPixels(own.x - tile.x, own.y - tile.y, own.width, own.height, gl.RGBA_INTEGER, type, target, (own.y * frameWidth + own.x) * 4);
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
    if (gl.isContextLost()) throw new Error('Focus recovery lost its WebGL context');
  };

  async function recover(frame, plan, { yieldBetweenTiles = null, isCurrent = null } = {}) {
    if (disposed) throw new Error('Focus recovery was disposed');
    if (!plan) return null;
    const { width, height } = frame;
    const out = emptyLike(frame);
    const sixteen = Boolean(out.__image16);
    const source = sixteen ? frame.__image16.data : new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    const target = sixteen ? out.__image16.data : new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
    const tiles = focusTiles(width, height);
    ready();
    for (let i = 0; i < tiles.length; i++) {
      if (i && yieldBetweenTiles) await yieldBetweenTiles();
      if (isCurrent && !isCurrent()) throw new DOMException('Focus recovery superseded', 'AbortError');
      recoverTile(source, target, width, tiles[i], plan, sixteen);
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Focus recovery WebGL error ${error}`);
    if (sixteen) {
      const data = out.data, plane = out.__image16.data;
      for (let i = 0; i < data.length; i++) data[i] = plane[i] >>> 8;
    }
    return out;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const { program } of Object.values(programs || {})) gl.deleteProgram(program);
    gl.deleteBuffer(quad);
    gl.deleteFramebuffer(framebuffer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { supported: true, recover, dispose, get lost() { return gl.isContextLost(); } };
}
