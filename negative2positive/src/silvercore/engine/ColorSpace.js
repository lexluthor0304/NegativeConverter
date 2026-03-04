/**
 * ColorSpace.js - Color space conversion engine
 * Color space conversion engine
 * All matrices use D50 white point (ICC PCS standard)
 */

// --- Transfer functions ---

function sRGB_toLinear(v) {
  return v <= 0.04045
    ? v / 12.92
    : Math.pow((v + 0.055) / 1.055, 2.4);
}

function sRGB_toGamma(v) {
  return v <= 0.0031308
    ? 12.92 * v
    : 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055;
}

function gamma18_toLinear(v) {
  return v <= 0 ? 0 : Math.pow(v, 1.8);
}

function gamma18_toGamma(v) {
  return v <= 0 ? 0 : Math.pow(v, 1.0 / 1.8);
}

function gamma1801_toLinear(v) {
  return v <= 0 ? 0 : Math.pow(v, 1.801);
}

function gamma1801_toGamma(v) {
  return v <= 0 ? 0 : Math.pow(v, 1.0 / 1.801);
}

// --- Color Space definitions ---
// Matrices are row-major 3x3 (flat array of 9)

const colorSpaces = {
  sRGBd50: {
    toXYZ: [
      0.4360747, 0.3850649, 0.1430804,
      0.2225045, 0.7168786, 0.0606169,
      0.0139322, 0.0971045, 0.7141733
    ],
    fromXYZ: [
       3.1338561, -1.6168667, -0.4906146,
      -0.9787684,  1.9161415,  0.033454,
       0.0719453, -0.2289914,  1.4052427
    ],
    toLinear: sRGB_toLinear,
    toGamma: sRGB_toGamma,
  },
  ProPhoto: {
    toXYZ: [
      0.7976749, 0.1351917, 0.0313534,
      0.2880402, 0.7118741, 0.0000857,
      0.0,       0.0,       0.82521
    ],
    fromXYZ: [
       1.3459433, -0.2556075, -0.0511118,
      -0.5445989,  1.5081673,  0.0205351,
       0.0,        0.0,        1.2118128
    ],
    toLinear: gamma18_toLinear,
    toGamma: gamma18_toGamma,
  },
  ProPhotoCalc: {
    toXYZ: [
      0.7980403, 0.1349972, 0.0309624,
      0.2880146, 0.7119854, 0.0,
      0.0,       0.0,       0.824
    ],
    fromXYZ: [
       1.345115,  -0.2550429, -0.0505437,
      -0.5441301,  1.5076938,  0.0204461,
       0.0,        0.0,        1.2135922
    ],
    toLinear: gamma18_toLinear,
    toGamma: gamma18_toGamma,
  },
  displayP3: {
    toXYZ: [
      0.5151, 0.292,  0.1571,
      0.2412, 0.6922, 0.0666,
     -0.0011, 0.0419, 0.7841
    ],
    fromXYZ: null,
    toLinear: sRGB_toLinear,
    toGamma: sRGB_toGamma,
  },
  // MelissaRGB = Lightroom internal, same primaries as ProPhoto but sRGB TRC
  MelissaRGB: {
    toXYZ: [
      0.7976749, 0.1351917, 0.0313534,
      0.2880402, 0.7118741, 0.0000857,
      0.0,       0.0,       0.82521
    ],
    fromXYZ: [
       1.3459433, -0.2556075, -0.0511118,
      -0.5445989,  1.5081673,  0.0205351,
       0.0,        0.0,        1.2118128
    ],
    toLinear: sRGB_toLinear,
    toGamma: sRGB_toGamma,
  },
  genericRGB: {
    toXYZ: [
      0.3770584, 0.3583388, 0.2146028,
      0.2009871, 0.6841936, 0.1148193,
      0.0124579, 0.0923763, 0.9841658
    ],
    fromXYZ: null,
    toLinear: gamma1801_toLinear,
    toGamma: gamma1801_toGamma,
  },
  ColorMatch: {
    toXYZ: [
      0.509,  0.321,  0.134,
      0.275,  0.658,  0.067,
      0.024,  0.109,  0.692
    ],
    fromXYZ: [
       2.6451479, -1.2252155, -0.3935844,
      -1.1140212,  2.0605365,  0.016218,
       0.0837352, -0.2820713,  1.4561825
    ],
    toLinear: gamma18_toLinear,
    toGamma: gamma18_toGamma,
  },
};

// --- Matrix multiply helper ---
function mat3x3_mulVec(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

// --- Core conversion ---

/**
 * Convert color between color spaces via XYZ D50
 * @param {number} r - Red [0,1]
 * @param {number} g - Green [0,1]
 * @param {number} b - Blue [0,1]
 * @param {string} inputSpace
 * @param {string} outputSpace
 * @returns {number[]} [r, g, b] in [0,1]
 */
export function convertSpace(r, g, b, inputSpace, outputSpace) {
  if (inputSpace === outputSpace) return [r, g, b];

  const inp = colorSpaces[inputSpace];
  const out = colorSpaces[outputSpace];

  // Linearize
  const rLin = inp.toLinear(r);
  const gLin = inp.toLinear(g);
  const bLin = inp.toLinear(b);

  // To XYZ
  const [X, Y, Z] = mat3x3_mulVec(inp.toXYZ, rLin, gLin, bLin);

  // From XYZ
  const [rOut, gOut, bOut] = mat3x3_mulVec(out.fromXYZ, X, Y, Z);

  // Gamma encode
  return [out.toGamma(rOut), out.toGamma(gOut), out.toGamma(bOut)];
}

// --- Color utility functions ---

export function newColor(r = 0, g = 0, b = 0) {
  return { r, g, b };
}

export function from255(r, g, b) {
  return newColor(r / 255, g / 255, b / 255);
}

export function colorAvg(color) {
  return (color.r + color.g + color.b) / 3;
}

export function rgbToHSV(r, g, b) {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  const v = max;
  const delta = max - min;

  if (max === 0) return [0, 0, v];

  const s = delta / max;
  let h;

  if (delta === 0) {
    h = 0;
  } else if (r === max) {
    h = (g - b) / delta;
  } else if (g === max) {
    h = 2 + (b - r) / delta;
  } else {
    h = 4 + (r - g) / delta;
  }

  h *= 60;
  if (h < 0) h += 360;
  return [h, s, v];
}

export function hsvToRGB(h, s, v) {
  if (s === 0) return [v, v, v];
  if (h >= 360) h -= 360;

  const sector = Math.floor(h / 60);
  const frac = h / 60 - sector;
  const p = v * (1 - s);
  const q = v * (1 - s * frac);
  const t = v * (1 - s * (1 - frac));

  switch (sector) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    case 5: return [v, p, q];
    default: return [v, t, p];
  }
}

/**
 * Compute per-channel linear offsets to balance color to average
 * @param {Object} color - {r, g, b} in [0,1]
 * @param {string|null} channel - if set, balance to this channel instead of average
 * @returns {number[]} [rOffset, gOffset, bOffset] in 0-255 scale
 */
export function linearBalance(color, channel = null) {
  let ref;
  if (channel == null) {
    ref = colorAvg(color) * 255;
  } else {
    ref = color[channel] * 255;
  }

  if (color.r === 0 && color.g === 0 && color.b === 0) {
    return [0, 0, 0];
  }

  return [
    ref - color.r * 255,
    ref - color.g * 255,
    ref - color.b * 255,
  ];
}

/**
 * Compute per-channel gamma exponents for white balance
 * Uses log_base formula: log(value)/log(base)
 * @param {Object} color - {r, g, b} in [0,1]
 * @param {string|null} channel - if set, balance to this channel
 * @returns {number[]} [rGamma, gGamma, bGamma]
 */
export function gammaBalance(color, channel = null) {
  let ref;
  if (channel == null) {
    ref = colorAvg(color);
  } else {
    ref = color[channel];
  }

  if (color.r === 0 && color.g === 0 && color.b === 0) {
    return [1, 1, 1];
  }

  const logb = (base, val) => Math.log(val) / Math.log(base);

  return [
    color.r > 0 ? 1 / logb(ref, color.r) : 1,
    color.g > 0 ? 1 / logb(ref, color.g) : 1,
    color.b > 0 ? 1 / logb(ref, color.b) : 1,
  ];
}

export function fromHex(hex) {
  let str = hex.replace('#', '');
  let r, g, b;
  if (str.length === 3) {
    r = parseInt(str[0], 16) * 17 / 255;
    g = parseInt(str[1], 16) * 17 / 255;
    b = parseInt(str[2], 16) * 17 / 255;
  } else {
    r = parseInt(str.substring(0, 2), 16) / 255;
    g = parseInt(str.substring(2, 4), 16) / 255;
    b = parseInt(str.substring(4, 6), 16) / 255;
  }
  return newColor(r, g, b);
}

// Gamma presets from GammaUtility.lua
export const gammaPresets = {
  auto_gamma: { input: 'auto', output: 'auto' },
  linear:     { input: 1.0, output: 2.2 },
  flextight:  { input: 1.8, output: 2.2 },
  epsonScan:  { input: 1.8, output: 2.2 },
  pakonPPRC:  { input: 1.0, output: 2.2 },
  custom:     { input: 1.0, output: 2.2 },
};

export { colorSpaces };
