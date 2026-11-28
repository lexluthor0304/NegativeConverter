/**
 * dynamicRangeGpu.js - the dynamic range compression's exposure stage on the GPU
 *
 * The per-pixel part of the compression (pipeline/dynamicRange.js,
 * docs/dynamic-range-compression.md): for each pixel of the plane entering the
 * engine's exposure stage, the joint bilateral lookup of the map (guided by
 * the pixel's own linear luminance), the Shadows and Highlights shares, the
 * dodge-and-burn strokes' stops added, the exposure in linear light, and the
 * saturation protection's weight. exposeDrcReference is the same arithmetic
 * in JavaScript: the tests run it in Node, the smoke compares the two in the
 * browser (at most one least significant bit apart), and it runs wherever
 * this stage cannot (no WebGL2, a lost context, a failure).
 *
 * WebGL2 without extensions: the plane goes up as RGBA16UI bands of whole
 * rows straight from its array, the arithmetic is float32 inside, and two
 * integer targets come back (RGBA16UI pixels, R8UI weights) through
 * pixel-pack buffers into the same places. A pixel's result depends on
 * nothing but the pixel and the map, so bands need no halo and their size
 * never changes a result. Different GPUs may round the last bit differently,
 * as focus recovery's may (docs/focus-recovery.md).
 */

import { LINEAR_LUT, LINEAR_STEPS } from '../silvercore/util/localExposure.js';
import { DRC_EPSILON, DRC_LUMA, DRC_MAX_LOG_GAIN, DRC_PROTECT_STOPS, DRC_LIMIT_SOFT, DRC_LIMIT_MARGIN, drcLimitsOf, drcRangeTable, exposeDrcReference, buildDrcStage, solveDrcMap, sampleDrcInput, drcMethodParams } from '../pipeline/dynamicRange.js';

// Bands of whole rows of at most this many pixels: a band is contiguous in
// the plane, so it goes up in one texSubImage2D and comes back through a
// pixel-pack buffer in one getBufferSubData (readPixels into a strided
// window of a large array was five to nine times slower in Chrome).
export const DRC_GPU_BAND_PIXELS = 2048 * 2048;
// Kept for the smoke's tile-border case: a frame wider than this crosses bands.
export const DRC_GPU_TILE = 2048;
const PACKED = 64; // texels per row of the 1D tables

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

function fragment() {
  const f = (v) => { const t = String(v); return /[.eE]/.test(t) ? t : `${t}.0`; };
  return `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;
uniform usampler2D u_src;
uniform sampler2D u_map;
uniform sampler2D u_lut;
uniform sampler2D u_range;
uniform sampler2D u_strokes;
uniform int u_strokesOn;
uniform int u_weightsOn;
uniform ivec2 u_origin;
uniform vec4 u_frame;
uniform ivec2 u_grid;
uniform vec3 u_shares;
uniform vec4 u_limits;
uniform float u_rangeScale;
uniform int u_rangeSize;
layout(location = 0) out uvec4 outPixel;
layout(location = 1) out uvec4 outWeight;

ivec2 packed(int i) { return ivec2(i & ${PACKED - 1}, i / ${PACKED}); }

float linearOf(uint v) {
  float idx = float(v) * ${f(LINEAR_STEPS / 65535)};
  int k = int(idx);
  float frac = idx - float(k);
  float lo = texelFetch(u_lut, packed(k), 0).r;
  float hi = texelFetch(u_lut, packed(min(${LINEAR_STEPS}, k + 1)), 0).r;
  return lo + (hi - lo) * frac;
}

float rangeWeight(float d) {
  float pos = d * u_rangeScale;
  if (pos >= float(u_rangeSize)) return texelFetch(u_range, packed(u_rangeSize), 0).r;
  int i = int(pos);
  float lo = texelFetch(u_range, packed(i), 0).r;
  float hi = texelFetch(u_range, packed(i + 1), 0).r;
  return lo + (hi - lo) * (pos - float(i));
}

uint encode(float lin, float gain) {
  float v = min(1.0, lin * gain);
  return uint(floor((v > 0.0 ? pow(v, ${f(1 / 2.2)}) : 0.0) * 65535.0 + 0.5));
}

// drcLimitGain (pipeline/dynamicRange.js): the gain held inside the frame
// (u_limits: low extreme, middle, high extreme, on).
float limitGain(float g, float h) {
  if (u_limits.w < 0.5) return g;
  if (g > 0.0) {
    float c = min(u_limits.y, u_limits.z - ${f(DRC_LIMIT_MARGIN)});
    float w = (u_limits.z - c) * ${f(DRC_LIMIT_SOFT)};
    float t = h + g;
    if (t <= c) return g;
    if (w <= 1e-6) return h >= c ? 0.0 : c - h;
    float ft = c + w * (1.0 - exp(-(t - c) / w));
    float fh = h <= c ? h : c + w * (1.0 - exp(-(h - c) / w));
    return ft - fh;
  }
  if (g < 0.0) {
    float c = max(u_limits.y, u_limits.x + ${f(DRC_LIMIT_MARGIN)});
    float w = (c - u_limits.x) * ${f(DRC_LIMIT_SOFT)};
    float t = h + g;
    if (t >= c) return g;
    if (w <= 1e-6) return h <= c ? 0.0 : c - h;
    float ft = c - w * (1.0 - exp(-(c - t) / w));
    float fh = h >= c ? h : c - w * (1.0 - exp(-(c - h) / w));
    return ft - fh;
  }
  return g;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 src = texelFetch(u_src, p, 0);
  float lr = linearOf(src.r), lg = linearOf(src.g), lb = linearOf(src.b);
  float L = ${f(DRC_LUMA[0])} * lr + ${f(DRC_LUMA[1])} * lg + ${f(DRC_LUMA[2])} * lb;
  float h = log(clamp(L, 0.0, 1.0) + ${f(DRC_EPSILON)});
  vec2 at = vec2(u_origin + p) + u_frame.xy + 0.5;
  float fx = clamp(at.x / u_frame.z * float(u_grid.x) - 0.5, 0.0, float(u_grid.x - 1));
  float fy = clamp(at.y / u_frame.w * float(u_grid.y) - 0.5, 0.0, float(u_grid.y - 1));
  int x0 = int(fx), y0 = int(fy);
  int x1 = min(x0 + 1, u_grid.x - 1), y1 = min(y0 + 1, u_grid.y - 1);
  float wx = fx - float(x0), wy = fy - float(y0);
  vec2 m00 = texelFetch(u_map, ivec2(x0, y0), 0).rg;
  vec2 m01 = texelFetch(u_map, ivec2(x1, y0), 0).rg;
  vec2 m10 = texelFetch(u_map, ivec2(x0, y1), 0).rg;
  vec2 m11 = texelFetch(u_map, ivec2(x1, y1), 0).rg;
  float w00 = (1.0 - wx) * (1.0 - wy) * rangeWeight(abs(h - m00.g));
  float w01 = wx * (1.0 - wy) * rangeWeight(abs(h - m01.g));
  float w10 = (1.0 - wx) * wy * rangeWeight(abs(h - m10.g));
  float w11 = wx * wy * rangeWeight(abs(h - m11.g));
  float sum = w00 + w01 + w10 + w11;
  float g = sum > 1e-9
    ? (w00 * m00.r + w01 * m01.r + w10 * m10.r + w11 * m11.r) / sum
    : (1.0 - wy) * ((1.0 - wx) * m00.r + wx * m01.r) + wy * ((1.0 - wx) * m10.r + wx * m11.r);
  bool inverted = u_shares.z > 0.5;
  bool brightens = inverted ? g < 0.0 : g > 0.0;
  g *= brightens ? u_shares.x : u_shares.y;
  g = clamp(g, ${f(-DRC_MAX_LOG_GAIN)}, ${f(DRC_MAX_LOG_GAIN)});
  g = limitGain(g, h);
  float drcStops = g * ${f(Math.LOG2E)};
  uint weight = 0u;
  if (u_weightsOn != 0) {
    float darkening = inverted ? drcStops : -drcStops;
    if (darkening > 0.0) weight = uint(floor(min(darkening / ${f(DRC_PROTECT_STOPS)}, 1.0) * 255.0 + 0.5));
  }
  float s = drcStops + (u_strokesOn != 0 ? texelFetch(u_strokes, p, 0).r : 0.0);
  uvec4 o = src;
  if (s != 0.0) {
    float gain = exp2(s);
    o = uvec4(encode(lr, gain), encode(lg, gain), encode(lb, gain), src.a);
  }
  outPixel = o;
  outWeight = uvec4(weight, 0u, 0u, 0u);
}
`;
}

function packRows(values) {
  const rows = Math.ceil(values.length / PACKED);
  const out = new Float32Array(rows * PACKED);
  out.set(values);
  return { data: out, rows };
}

/**
 * @param {object} [options]
 * @param {HTMLCanvasElement|OffscreenCanvas} [options.canvas]
 * @returns {{ supported: boolean, expose: Function, lost: () => boolean, dispose: Function, info?: object }}
 */
export function createDrcExposer({ canvas = null } = {}) {
  const surface = canvas || (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1)
    : typeof document !== 'undefined' ? document.createElement('canvas') : null);
  const gl = surface ? surface.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) : null;
  const unsupported = (reason) => ({ supported: false, reason, expose() { throw new Error(`Dynamic range GPU stage: ${reason}`); }, lost: () => false, dispose() {} });
  if (!gl) return unsupported('no WebGL2');
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (maxTexture < 4096 || gl.getParameter(gl.MAX_DRAW_BUFFERS) < 2) return unsupported('textures or draw buffers too small');

  let program;
  try {
    program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment()]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, 'p');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (error) {
    return unsupported(`shader: ${error.message}`);
  }
  const u = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const name = gl.getActiveUniform(program, i).name;
    u[name] = gl.getUniformLocation(program, name);
  }
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const framebuffer = gl.createFramebuffer();
  // R8UI is read back as RED_INTEGER bytes where the implementation offers
  // that, else as RGBA_INTEGER words (the combination WebGL2 guarantees).
  let weightRead = null;

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
  const uploadFloats = (t, width, height, format, data) => {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, gl.FLOAT, data);
  };
  // The 1D tables, once.
  const lutRows = packRows(LINEAR_LUT);
  const lutTexture = texture(gl.R32F, PACKED, lutRows.rows);
  uploadFloats(lutTexture, PACKED, lutRows.rows, gl.RED, lutRows.data);
  const range = drcRangeTable();
  const rangeRows = packRows(Float32Array.from(range.table));
  const rangeTexture = texture(gl.R32F, PACKED, rangeRows.rows);
  uploadFloats(rangeTexture, PACKED, rangeRows.rows, gl.RED, rangeRows.data);
  const noStrokes = texture(gl.R32F, 1, 1);
  uploadFloats(noStrokes, 1, 1, gl.RED, new Float32Array(1));
  let failures = 0;
  let lastError = '';
  let mapTexture = null;
  let mapKey = null;
  let disposed = false;
  let bandWidth = 0; let bandRows = 0;
  let srcTexture = null; let pixelTarget = null; let weightTarget = null; let strokesTexture = null;
  const pixelBuffer = gl.createBuffer();
  const weightBuffer = gl.createBuffer();

  const ensureBands = (width) => {
    if (bandWidth === width) return;
    for (const t of [srcTexture, pixelTarget, weightTarget, strokesTexture]) if (t) gl.deleteTexture(t);
    bandWidth = width;
    bandRows = Math.max(1, Math.min(maxTexture, Math.floor(DRC_GPU_BAND_PIXELS / width)));
    srcTexture = texture(gl.RGBA16UI, width, bandRows);
    pixelTarget = texture(gl.RGBA16UI, width, bandRows);
    weightTarget = texture(gl.R8UI, width, bandRows);
    strokesTexture = texture(gl.R32F, width, bandRows);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixelBuffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * bandRows * 8, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, weightBuffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, width * bandRows * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  };
  const uploadMap = (map) => {
    if (mapKey === map.key && mapTexture && map.key) return;
    if (mapTexture) gl.deleteTexture(mapTexture);
    mapTexture = texture(gl.RG32F, map.width, map.height);
    const rg = new Float32Array(map.width * map.height * 2);
    for (let i = 0; i < map.logGain.length; i++) { rg[i * 2] = map.logGain[i]; rg[i * 2 + 1] = map.guide[i]; }
    uploadFloats(mapTexture, map.width, map.height, gl.RG, rg);
    mapKey = map.key || null;
  };

  function strokesTile(strokes, planeWidth, x0, y0, w, h, scratch) {
    if (strokes.tiled === true && Array.isArray(strokes.tiles)) {
      const { tileSize: ts, columns, tiles } = strokes;
      let any = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const fx = x0 + x; const fy = y0 + y;
          const tile = tiles[((fy / ts) | 0) * columns + ((fx / ts) | 0)];
          const v = tile ? tile[(fy % ts) * ts + (fx % ts)] : 0;
          scratch[y * w + x] = v;
          if (v !== 0) any = true;
        }
      }
      return any;
    }
    let any = false;
    for (let y = 0; y < h; y++) {
      const row = strokes.subarray((y0 + y) * planeWidth + x0, (y0 + y) * planeWidth + x0 + w);
      scratch.set(row, y * w);
      if (!any) for (let k = 0; k < row.length; k++) if (row[k] !== 0) { any = true; break; }
    }
    return any;
  }

  /**
   * Exposes `image16` in place (the plane entering the engine's exposure
   * stage), writing `options.weights` (one byte per pixel) when given.
   */
  function expose(image16, map, method, { inverted = false, strokes = null, frame = null, weights = null } = {}) {
    if (disposed) throw new Error('Dynamic range GPU stage was disposed');
    const { width, height, data } = image16;
    const f = frame || { x: 0, y: 0, frameWidth: width, frameHeight: height };
    if (width > maxTexture) throw new Error('frame wider than the GPU allows');
    ensureBands(width);
    uploadMap(map);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pixelTarget, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, weightTarget, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    if (weights && !weightRead) {
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
      const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
      weightRead = format === gl.RED_INTEGER && type === gl.UNSIGNED_BYTE ? 'bytes' : 'words';
    }
    const bind = (unit, t, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u[name], unit); };
    bind(0, srcTexture, 'u_src');
    bind(1, mapTexture, 'u_map');
    bind(2, lutTexture, 'u_lut');
    bind(3, rangeTexture, 'u_range');
    gl.uniform4f(u.u_frame, f.x, f.y, f.frameWidth, f.frameHeight);
    gl.uniform2i(u.u_grid, map.width, map.height);
    gl.uniform3f(u.u_shares, method.shadowShare, method.highlightShare, inverted ? 1 : 0);
    const limits = drcLimitsOf(map);
    gl.uniform4f(u.u_limits, limits ? limits[0] : 0, limits ? limits[1] : 0, limits ? limits[2] : 0, limits ? 1 : 0);
    gl.uniform1f(u.u_rangeScale, range.scale);
    gl.uniform1i(u.u_rangeSize, range.size);
    gl.uniform1i(u.u_weightsOn, weights ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const scratch = strokes ? new Float32Array(width * bandRows) : null;
    // WebGL takes no views of shared memory: a shared plane (the band pool's,
    // an isolated page's) goes up and comes back through a private band.
    const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer;
    const privateBand = shared ? new Uint16Array(width * bandRows * 4) : null;
    const bands = [];
    for (let y0 = 0; y0 < height; y0 += bandRows) bands.push(y0);
    let doneBands = 0;
    try {
      for (const y0 of bands) {
        const h = Math.min(bandRows, height - y0);
        const n = width * h;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTexture);
        const rowsOf = data.subarray(y0 * width * 4, (y0 + h) * width * 4);
        let upload = rowsOf;
        if (privateBand) { upload = privateBand.subarray(0, n * 4); upload.set(rowsOf); }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, h, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, upload);
        const withStrokes = scratch ? strokesTile(strokes, width, 0, y0, width, h, scratch) : false;
        if (withStrokes) {
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, strokesTexture);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, h, gl.RED, gl.FLOAT, scratch.subarray(0, n));
          gl.uniform1i(u.u_strokes, 4);
        } else {
          bind(4, noStrokes, 'u_strokes');
        }
        gl.uniform1i(u.u_strokesOn, withStrokes ? 1 : 0);
        gl.uniform2i(u.u_origin, 0, y0);
        gl.viewport(0, 0, width, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pixelBuffer);
        gl.readPixels(0, 0, width, h, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, 0);
        if (privateBand) {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, privateBand, 0, n * 4);
          rowsOf.set(privateBand.subarray(0, n * 4));
        } else {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data, y0 * width * 4, n * 4);
        }
        if (weights) {
          gl.readBuffer(gl.COLOR_ATTACHMENT1);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, weightBuffer);
          if (weightRead === 'bytes') {
            gl.readPixels(0, 0, width, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 0);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, weights, y0 * width, n);
          } else {
            const words = new Uint32Array(n * 4);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            gl.readPixels(0, 0, width, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, words);
            for (let k = 0; k < n; k++) weights[y0 * width + k] = words[k * 4];
          }
        }
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        if (gl.isContextLost()) throw new Error('lost its WebGL context');
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`);
        doneBands++;
      }
    } catch (error) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      // The bands already written are exposed; the rest are exposed by the
      // reference, so the plane is never exposed twice or left half done.
      const stage = buildDrcStage(map);
      for (const y0 of bands.slice(doneBands)) {
        exposeDrcReference(image16, stage, method, { inverted, strokes, frame, weights,
          rect: { x: 0, y: y0, width, height: Math.min(bandRows, height - y0) } });
      }
      failures++;
      lastError = String(error?.message || error);
      return { gpuTiles: doneBands, referenceTiles: bands.length - doneBands };
    }
    return { gpuTiles: doneBands, referenceTiles: 0 };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const t of [srcTexture, pixelTarget, weightTarget, strokesTexture, lutTexture, rangeTexture, noStrokes, mapTexture]) if (t) gl.deleteTexture(t);
    gl.deleteBuffer(pixelBuffer);
    gl.deleteBuffer(weightBuffer);
    gl.deleteProgram(program);
    gl.deleteBuffer(quad);
    gl.deleteFramebuffer(framebuffer);
  }

  return {
    supported: true,
    expose,
    lost: () => gl.isContextLost(),
    dispose,
    get failures() { return failures; },
    get lastError() { return lastError; },
    info: { renderer: (() => { try { return gl.getParameter(gl.RENDERER); } catch { return ''; } })() }
  };
}

/**
 * The GPU stage against the reference on a synthetic frame of more rows than
 * one band (for support and the WebKit check: it runs in whatever context
 * calls it). Returns the largest difference in 16-bit codes and in weights.
 */
export function drcGpuParity({ width = DRC_GPU_TILE + 300, height = Math.floor(DRC_GPU_BAND_PIXELS / (DRC_GPU_TILE + 300)) + 211, canvas = null } = {}) {
  const exposer = createDrcExposer({ canvas });
  if (!exposer.supported) return { supported: false, reason: exposer.reason || exposer.lastError || 'no WebGL2' };
  let seed = 11;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const plane = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const zone = x < width / 3 ? 0.9 : x < 2 * width / 3 ? 0.35 : 0.04;
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, zone * [1, 0.8, 0.6][c] * (1 + 0.2 * Math.sin(x / 7 + c) * Math.sin(y / 9)) + (random() - 0.5) * 0.02);
      plane[(y * width + x) * 4 + c] = Math.round(Math.max(0, v) ** (1 / 2.2) * 65535);
    }
    plane[(y * width + x) * 4 + 3] = 65535;
  }
  const settings = { drcAmount: 70, drcShadows: 60, drcHighlights: 45 };
  const cases = [];
  try {
    for (const inverted of [true, false]) {
      const map = solveDrcMap(sampleDrcInput(plane, width, height), settings, { inverted });
      map.key = `parity:${inverted}`;
      const method = drcMethodParams(settings);
      const a = { width, height, data: new Uint16Array(plane) };
      const b = { width, height, data: new Uint16Array(plane) };
      const wa = new Uint8Array(width * height);
      const wb = new Uint8Array(width * height);
      const t0 = performance.now();
      const outcome = exposer.expose(a, map, method, { inverted, weights: wa });
      const gpuMs = performance.now() - t0;
      const t1 = performance.now();
      exposeDrcReference(b, buildDrcStage(map), method, { inverted, weights: wb });
      const referenceMs = performance.now() - t1;
      let max = 0; let differ = 0; let weightMax = 0;
      for (let i = 0; i < a.data.length; i++) { const d = Math.abs(a.data[i] - b.data[i]); if (d > max) max = d; if (d) differ++; }
      for (let i = 0; i < wa.length; i++) weightMax = Math.max(weightMax, Math.abs(wa[i] - wb[i]));
      cases.push({ inverted, max, differPct: +(100 * differ / a.data.length).toFixed(3), weightMax, gpuBands: outcome.gpuTiles, referenceBands: outcome.referenceTiles, gpuMs: Math.round(gpuMs), referenceMs: Math.round(referenceMs) });
    }
  } finally {
    exposer.dispose();
  }
  return { supported: true, renderer: exposer.info.renderer, width, height, cases };
}
