// GLSL for the Studio display preview (#239): the only display implementation of the
// SilverCore apply stage and of Step 3 once WebGL2 is available.
//
// - applyProgram reads the prepared display-size negative (RGBA16UI, or RGBA8UI
//   promoted by 257 as fromImageData8 does) and runs the SilverCore per-tick stages in
//   the engine's order, storing every stage back to an integer the way the CPU stores
//   it (Math.round, truncating Uint16 stores, clamps), then 16 → 8 bits and Step 3.
//   It draws while SilverCore controls are ahead of the last exact worker frame.
// - step3Program reads the exact 8-bit worker frame (RGBA8) and runs Step 3. It draws
//   whenever that frame is current, which includes every Step-3 drag.
// - The WebGL1 program is the fallback where no WebGL2 context exists.
//
// The CPU engine stays the reference and the only producer of settled and exported
// pixels (Engine._applyLuts, pixelAdjustments.js). Constants below come from the JS
// stage modules so the copies cannot drift apart silently; the parity tests
// (previewShader.test.mjs, the in-browser self-test and gpu-preview-smoke) guard the
// arithmetic itself.

import { HUE_TABLE_SIZE, LUMA_R, LUMA_G, LUMA_B } from '../silvercore/engine/ImageProcessor.js';
import { LINEAR_STEPS } from '../silvercore/util/localExposure.js';
import { LUT_SIZE as PROFILE_LUT_SIZE } from '../silvercore/engine/EnhancedProfiles.js';
import { IMAGE16_MAX } from '../silvercore/util/image16.js';

// 65536-entry tables (tone curves, paper, the B&W grey table, the pre-saturation
// ramp) are 256 × 256 textures: entry v is texel (v & 255, v >> 8).
export const TABLE_TEXTURE_SIZE = 256;
// Long 1D tables (hue weights, the exposure LUT) are packed into rows of this many
// texels: a 4097 × 1 texture would exceed MAX_TEXTURE_SIZE 4096 (WebGL2 guarantees
// only 2048).
export const PACKED_ROW_TEXELS = 64;
export const STEP3_CURVE_SIZE = 256;

// Texture units. Every sampler has its own unit, so no unit is ever read through two
// sampler types, and every unit always holds a texture of its sampler's kind.
export const UNITS = Object.freeze({
  image: 0, // applyProgram: prepared negative (usampler2D); step3Program: exact frame (sampler2D)
  curve: 1,
  toneLut: 2,
  paperLut: 3,
  lut3d: 4,
  hueWeights: 5,
  stops: 6,
  linearLut: 7,
  preSatRamp: 8,
  satRamp: 9,
});

export const GLSL_CONSTANTS = Object.freeze({
  HUE_TABLE_SIZE, LUMA_R, LUMA_G, LUMA_B, LINEAR_STEPS, PROFILE_LUT_SIZE, IMAGE16_MAX,
  TABLE_TEXTURE_SIZE, PACKED_ROW_TEXELS, STEP3_CURVE_SIZE,
});

// A JS number as a GLSL float literal.
export function glslFloat(value) {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite GLSL float: ${value}`);
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

const f = glslFloat;

export const VERTEX_SHADER_300 = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // v_uv.y = 0 at the top of the viewport: rows are uploaded top-down as stored and
  // the shader flips instead of UNPACK_FLIP_Y_WEBGL (no flipped copy per upload).
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const PRECISION_300 = `precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
precision highp usampler3D;
`;

// The texel a fragment shows: the flipped texture coordinate scaled to the texture,
// so the drawing buffer and the texture may differ in size.
const TEXEL_OF_FRAGMENT = `
ivec2 texelOfFragment(ivec2 size) {
  return clamp(ivec2(v_uv * vec2(size)), ivec2(0), size - 1);
}
`;

// Step 3 (pixelAdjustments.js on the CPU): white-balance gains, vibrance, CMY and the
// 256-entry RGB curves. SilverCore bakes the legacy tone controls (exposure,
// contrast, highlights, shadows, temperature, tint, saturation) into the conversion,
// so they are not part of the display shader.
const STEP3_DECLARATIONS = `
uniform vec3 u_wb;
uniform float u_vib;
uniform vec3 u_cmy;
uniform sampler2D u_curve;
`;

// Shared by the HSL model stage (ImageProcessor.hue2rgb) and Step 3's vibrance.
const HUE2RGB = `
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
`;

const STEP3_FUNCTIONS = `
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
  ivec3 index = clamp(ivec3(floor(c * ${f(STEP3_CURVE_SIZE - 1)} + 0.5)), ivec3(0), ivec3(${STEP3_CURVE_SIZE - 1}));
  return vec3(texelFetch(u_curve, ivec2(index.r, 0), 0).r,
              texelFetch(u_curve, ivec2(index.g, 0), 0).g,
              texelFetch(u_curve, ivec2(index.b, 0), 0).b);
}

vec3 applyStep3(vec3 c) {
  c *= u_wb;
  c = clamp(c, 0.0, 1.0);
  if (u_vib != 0.0) {
    vec3 hsl = rgbToHsl(c);
    float s = hsl.y;
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
  return applyCurves(c);
}
`;

export const STEP3_FRAGMENT_SHADER = `#version 300 es
${PRECISION_300}
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
${STEP3_DECLARATIONS}
${HUE2RGB}
${STEP3_FUNCTIONS}
${TEXEL_OF_FRAGMENT}
void main() {
  vec3 c = texelFetch(u_image, texelOfFragment(textureSize(u_image, 0)), 0).rgb;
  outColor = vec4(applyStep3(c), 1.0);
}
`;

// The SilverCore stages, each with the CPU's quantisation (see the table in #239):
// 1 B&W mix (Math.round, & 0xFFFF), 2 pre-saturation (clamp, truncating store; exact
// greys from the CPU's ramp),
// 3 positive gain/WB (alpha 0 skipped, Math.round), 4 dodge-and-burn stops (0 stops
// untouched, Math.round), 5 tone LUT, 6 HSL colour model ((v + 0.5) | 0 with clamp),
// 7 3D profile ((v + 0.5) | 0 with clamp), 8 saturation (as 2), 9 paper,
// 10 >> 8. B&W runs 1, 2 (as the engine's pre-saturation ramp), 4 and then one fetch
// from the #238 grey → RGB table, which is stages 5–9 evaluated by the CPU engine.
export const APPLY_FRAGMENT_SHADER = `#version 300 es
${PRECISION_300}
in vec2 v_uv;
out vec4 outColor;

const float MAX16 = ${f(IMAGE16_MAX)};

uniform usampler2D u_prepared;
uniform int u_prepared8;
uniform int u_mode;
uniform vec3 u_mix;
uniform int u_preSatOn;
uniform float u_preSat;
uniform usampler2D u_preSatRamp;
uniform int u_positiveOn;
uniform float u_gain;
uniform vec3 u_posWb;
uniform int u_stopsOn;
uniform sampler2D u_stops;
uniform sampler2D u_linearLut;
uniform usampler2D u_toneLut;
uniform int u_hslOn;
uniform int u_hueSkip;
uniform ivec3 u_bandActive;
uniform vec3 u_hueShift;
uniform vec3 u_satFactor;
uniform sampler2D u_hueWeights;
uniform int u_lut3dOn;
uniform float u_lut3dStr;
uniform float u_lut3dInvStr;
uniform usampler3D u_lut3d;
uniform int u_satOn;
uniform float u_sat;
uniform usampler2D u_satRamp;
uniform int u_paperOn;
uniform usampler2D u_paperLut;
${STEP3_DECLARATIONS}
${HUE2RGB}
${STEP3_FUNCTIONS}
${TEXEL_OF_FRAGMENT}

ivec2 tableTexel(uint v) {
  return ivec2(int(v & ${TABLE_TEXTURE_SIZE - 1}u), int(v >> 8u));
}

ivec2 packedTexel(int i) {
  return ivec2(i & ${PACKED_ROW_TEXELS - 1}, i / ${PACKED_ROW_TEXELS});
}

uvec3 lookup3(usampler2D table, uvec3 v) {
  return uvec3(texelFetch(table, tableTexel(v.r), 0).r,
               texelFetch(table, tableTexel(v.g), 0).g,
               texelFetch(table, tableTexel(v.b), 0).b);
}

// adjustSaturation: luma blend, clamp, then the Uint16Array store truncates. On an
// exact grey the blend lands on an integer, where the truncation follows the sign of
// the luma's rounding error: those pixels read the CPU's own result from a ramp
// (the stage evaluated on the 65536 greys, Engine.saturationRamp).
uvec3 saturate16(uvec3 c, float factor, usampler2D ramp) {
  if (c.r == c.g && c.g == c.b) return uvec3(texelFetch(ramp, tableTexel(c.r), 0).r);
  vec3 v = vec3(c);
  float lum = ${f(LUMA_R)} * v.r + ${f(LUMA_G)} * v.g + ${f(LUMA_B)} * v.b;
  return uvec3(clamp(lum + factor * (v - lum), 0.0, MAX16));
}

// applyPositiveAnalysis on a pixel with alpha != 0.
uvec3 positiveStage(uvec3 c) {
  vec3 v = vec3(c) * u_posWb;
  float peak = max(max(v.r, v.g), v.b) / MAX16;
  float scale = u_gain / (1.0 + (u_gain - 1.0) * peak);
  return uvec3(clamp(floor(v * scale + 0.5), 0.0, MAX16));
}

// applyExposureStopsToImage16 for one channel value and a non-zero stop.
uint expose(uint value, float stops) {
  float gain = exp2(stops);
  float idx = (float(value) / MAX16) * ${f(LINEAR_STEPS)};
  float base = floor(idx);
  int i0 = int(base);
  float frac = idx - base;
  float lo = texelFetch(u_linearLut, packedTexel(i0), 0).r;
  float hi = texelFetch(u_linearLut, packedTexel(min(${LINEAR_STEPS}, i0 + 1)), 0).r;
  float linear = lo * (1.0 - frac) + hi * frac;
  float x = min(1.0, linear * gain);
  float o = x > 0.0 ? pow(x, 1.0 / 2.2) : 0.0;
  return uint(floor(o * MAX16 + 0.5));
}

// applyHSLAdjustments, including its exact strict-maximum skip.
uvec3 hslStage(uvec3 c) {
  if (u_hueSkip != 0) {
    bool moved = c.r > c.g && c.r > c.b ? u_bandActive.x != 0
      : c.g > c.r && c.g > c.b ? u_bandActive.y != 0
      : c.b > c.r && c.b > c.g ? u_bandActive.z != 0
      : false;
    if (!moved) return c;
  }
  float invMax = 1.0 / MAX16;
  float r = float(c.r) * invMax;
  float g = float(c.g) * invMax;
  float b = float(c.b) * invMax;
  float mx, mn;
  if (r > g) {
    mx = r > b ? r : b;
    mn = g < b ? g : b;
  } else {
    mx = g > b ? g : b;
    mn = r < b ? r : b;
  }
  float d = mx - mn;
  float l = (mx + mn) * 0.5;
  if (d < 1e-6) return c;
  float h;
  if (mx == r) h = ((g - b) / d + (g < b ? 6.0 : 0.0)) / 6.0;
  else if (mx == g) h = ((b - r) / d + 2.0) / 6.0;
  else h = ((r - g) / d + 4.0) / 6.0;
  float invD = 1.0 / (l > 0.5 ? 2.0 - mx - mn : mx + mn);
  float s = d * invD;
  int hIdx = clamp(int(h * ${f(HUE_TABLE_SIZE)}), 0, ${HUE_TABLE_SIZE - 1});
  vec4 w = texelFetch(u_hueWeights, packedTexel(hIdx), 0);
  h += w.r * u_hueShift.r + w.g * u_hueShift.g + w.b * u_hueShift.b;
  h = h - floor(h);
  float satAdj = w.r * u_satFactor.r + w.g * u_satFactor.g + w.b * u_satFactor.b;
  s = clamp(s * (1.0 + satAdj), 0.0, 1.0);
  vec3 o;
  if (s < 1e-6) {
    o = vec3(l);
  } else {
    float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
    float p = 2.0 * l - q;
    o = vec3(hue2rgb(p, q, h + 1.0 / 3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0 / 3.0));
  }
  return uvec3(clamp(o * MAX16 + 0.5, 0.0, MAX16));
}

vec3 profileTexel(ivec3 r) {
  // The baked table is r-major (b fastest), a 3D texture's fastest axis is x.
  return vec3(texelFetch(u_lut3d, ivec3(r.z, r.y, r.x), 0).rgb);
}

// applyLut3D: trilinear over the baked ${PROFILE_LUT_SIZE}^3 table, strength blend.
uvec3 lut3dStage(uvec3 c) {
  vec3 v = vec3(c);
  vec3 grid = v * (${f(PROFILE_LUT_SIZE - 1)} / MAX16);
  ivec3 i0 = min(ivec3(grid), ivec3(${PROFILE_LUT_SIZE - 2}));
  vec3 fr = grid - vec3(i0);
  vec3 fr1 = 1.0 - fr;
  vec3 x00 = profileTexel(i0) * fr1.z + profileTexel(i0 + ivec3(0, 0, 1)) * fr.z;
  vec3 x01 = profileTexel(i0 + ivec3(0, 1, 0)) * fr1.z + profileTexel(i0 + ivec3(0, 1, 1)) * fr.z;
  vec3 x10 = profileTexel(i0 + ivec3(1, 0, 0)) * fr1.z + profileTexel(i0 + ivec3(1, 0, 1)) * fr.z;
  vec3 x11 = profileTexel(i0 + ivec3(1, 1, 0)) * fr1.z + profileTexel(i0 + ivec3(1, 1, 1)) * fr.z;
  vec3 lut = (x00 * fr1.y + x01 * fr.y) * fr1.x + (x10 * fr1.y + x11 * fr.y) * fr.x;
  vec3 o = v * u_lut3dInvStr + lut * u_lut3dStr;
  return uvec3(clamp(floor(o + 0.5), 0.0, MAX16));
}

void main() {
  ivec2 p = texelOfFragment(textureSize(u_prepared, 0));
  uvec4 src = texelFetch(u_prepared, p, 0);
  if (u_prepared8 != 0) src *= 257u;
  uvec3 c = src.rgb;
  float stops = u_stopsOn != 0 ? texelFetch(u_stops, p, 0).r : 0.0;
  if (u_mode == 1) {
    float y = float(c.r) * u_mix.r + float(c.g) * u_mix.g + float(c.b) * u_mix.b;
    uint grey = uint(int(floor(y + 0.5)) & 0xFFFF);
    if (u_preSatOn != 0) grey = texelFetch(u_preSatRamp, tableTexel(grey), 0).r;
    if (stops != 0.0) grey = expose(grey, stops);
    c = texelFetch(u_toneLut, tableTexel(grey), 0).rgb;
  } else {
    if (u_preSatOn != 0) c = saturate16(c, u_preSat, u_preSatRamp);
    if (u_positiveOn != 0 && src.a != 0u) c = positiveStage(c);
    if (stops != 0.0) c = uvec3(expose(c.r, stops), expose(c.g, stops), expose(c.b, stops));
    c = lookup3(u_toneLut, c);
    if (u_hslOn != 0) c = hslStage(c);
    if (u_lut3dOn != 0) c = lut3dStage(c);
    if (u_satOn != 0) c = saturate16(c, u_sat, u_satRamp);
    if (u_paperOn != 0) c = lookup3(u_paperLut, c);
  }
  outColor = vec4(applyStep3(vec3(c >> 8u) / 255.0), 1.0);
}
`;

// ---- WebGL1 fallback (GLSL ES 1.00): Step 3 on the exact 8-bit frame ----

export const VERTEX_SHADER_100 = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Rows are uploaded top-down as stored. Flipping here instead of with
  // UNPACK_FLIP_Y_WEBGL spares the browser a flipped copy per upload;
  // the framebuffer keeps its bottom-up orientation.
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const STEP3_FRAGMENT_SHADER_100 = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_image;
uniform sampler2D u_curve;
uniform vec3 u_wb;
uniform float u_vib;
uniform vec3 u_cmy;
${HUE2RGB}
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
  c *= u_wb;
  c = clamp(c, 0.0, 1.0);
  if (u_vib != 0.0) {
    vec3 hsl = rgbToHsl(c);
    float s = hsl.y;
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
  gl_FragColor = vec4(applyCurves(c), 1.0);
}
`;
