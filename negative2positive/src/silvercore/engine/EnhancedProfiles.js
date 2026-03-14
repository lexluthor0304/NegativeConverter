/**
 * EnhancedProfiles.js - 3D LUT loading and trilinear interpolation
 * Applies scanner color simulation (Frontier/Crystal/Natural/Pakon).
 * LUT color space: ProPhoto primaries + gamma 1.8
 */

import { convertSpace } from './ColorSpace.js'

export const PROFILES = ['none', 'frontier', 'crystal', 'natural', 'pakon', 'noritsu']
export const LUT_SIZE = 32

const profileCache = new Map()
const PROFILE_URLS = {
  frontier: new URL('../resources/profiles/frontier.bin', import.meta.url).href,
  crystal: new URL('../resources/profiles/crystal.bin', import.meta.url).href,
  natural: new URL('../resources/profiles/natural.bin', import.meta.url).href,
  pakon: new URL('../resources/profiles/pakon.bin', import.meta.url).href,
  noritsu: new URL('../resources/profiles/noritsu.bin', import.meta.url).href,
}

/**
 * Load a 3D LUT profile from binary file.
 * @param {string} name - Profile name (e.g., 'frontier')
 * @returns {Promise<{name: string, data: Uint16Array, size: number}|null>}
 */
export async function loadProfile(name) {
  if (name === 'none') return null
  if (profileCache.has(name)) return profileCache.get(name)

  const url = PROFILE_URLS[name]
  if (!url) throw new Error(`Unknown profile: ${name}`)
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to load profile: ${name}`)
  const buf = await resp.arrayBuffer()
  const rawData = new Uint16Array(buf)
  const profile = { name, data: rawData, size: LUT_SIZE, bakedData: bakeLutToSRGB(rawData, LUT_SIZE) }
  profileCache.set(name, profile)
  return profile
}

/**
 * Sample 3D LUT with trilinear interpolation.
 * @param {Uint16Array} data - LUT data (32^3 x 3 uint16)
 * @param {number} r - Red [0,1]
 * @param {number} g - Green [0,1]
 * @param {number} b - Blue [0,1]
 * @returns {number[]} [r, g, b] in [0,1]
 */
function sampleLut3D(data, r, g, b) {
  const max = LUT_SIZE - 1
  const rs = Math.max(0, Math.min(max, r * max))
  const gs = Math.max(0, Math.min(max, g * max))
  const bs = Math.max(0, Math.min(max, b * max))

  const ri = Math.min(Math.floor(rs), max - 1)
  const gi = Math.min(Math.floor(gs), max - 1)
  const bi = Math.min(Math.floor(bs), max - 1)

  const rf = rs - ri
  const gf = gs - gi
  const bf = bs - bi

  // LUT[r][g][b][c] -> flat index (R outer, G middle, B inner, 3 channels)
  const idx = (r, g, b) => ((r * LUT_SIZE + g) * LUT_SIZE + b) * 3
  const inv = 1 / 65535

  const i000 = idx(ri, gi, bi)
  const i001 = idx(ri, gi, bi + 1)
  const i010 = idx(ri, gi + 1, bi)
  const i011 = idx(ri, gi + 1, bi + 1)
  const i100 = idx(ri + 1, gi, bi)
  const i101 = idx(ri + 1, gi, bi + 1)
  const i110 = idx(ri + 1, gi + 1, bi)
  const i111 = idx(ri + 1, gi + 1, bi + 1)

  const out = new Array(3)
  for (let c = 0; c < 3; c++) {
    const c000 = data[i000 + c] * inv
    const c001 = data[i001 + c] * inv
    const c010 = data[i010 + c] * inv
    const c011 = data[i011 + c] * inv
    const c100 = data[i100 + c] * inv
    const c101 = data[i101 + c] * inv
    const c110 = data[i110 + c] * inv
    const c111 = data[i111 + c] * inv

    // Trilinear interpolation
    const c00 = c000 * (1 - bf) + c001 * bf
    const c01 = c010 * (1 - bf) + c011 * bf
    const c10 = c100 * (1 - bf) + c101 * bf
    const c11 = c110 * (1 - bf) + c111 * bf

    const c0 = c00 * (1 - gf) + c01 * gf
    const c1 = c10 * (1 - gf) + c11 * gf

    out[c] = c0 * (1 - rf) + c1 * rf
  }

  return out
}

/**
 * Pre-bake the 3D LUT into sRGB space during profile load.
 * Combines sRGB→ProPhoto/g1.8→LUT→ProPhoto/g1.8→sRGB into a single sRGB→sRGB 3D LUT.
 * Runs once per profile (~32^3 = 32768 iterations), eliminates all Math.pow from per-pixel loop.
 */
function bakeLutToSRGB(data, size) {
  const total = size * size * size
  const baked = new Uint8Array(total * 3)
  const max = size - 1

  for (let ri = 0; ri < size; ri++) {
    const sR = ri / max
    for (let gi = 0; gi < size; gi++) {
      const sG = gi / max
      for (let bi = 0; bi < size; bi++) {
        const sB = bi / max

        // sRGB → ProPhoto gamma 1.8
        const [ppR, ppG, ppB] = convertSpace(sR, sG, sB, 'sRGBd50', 'ProPhoto')

        // Clamp for LUT lookup
        const cR = Math.max(0, Math.min(1, ppR))
        const cG = Math.max(0, Math.min(1, ppG))
        const cB = Math.max(0, Math.min(1, ppB))

        // 3D LUT trilinear interpolation in ProPhoto space
        const [lutR, lutG, lutB] = sampleLut3D(data, cR, cG, cB)

        // ProPhoto gamma 1.8 → sRGB
        const [outR, outG, outB] = convertSpace(lutR, lutG, lutB, 'ProPhoto', 'sRGBd50')

        const idx = ((ri * size + gi) * size + bi) * 3
        baked[idx] = Math.max(0, Math.min(255, Math.round(outR * 255)))
        baked[idx + 1] = Math.max(0, Math.min(255, Math.round(outG * 255)))
        baked[idx + 2] = Math.max(0, Math.min(255, Math.round(outB * 255)))
      }
    }
  }

  return baked
}

/**
 * Apply 3D LUT to image data (CPU path).
 * Uses pre-baked sRGB→sRGB LUT for pure trilinear interpolation (no Math.pow).
 * @param {ImageData} imageData
 * @param {{data: Uint16Array, size: number, bakedData: Uint8Array}} lut
 * @param {number} strength - 0-200 (100 = full effect)
 */
export function applyLut3D(imageData, lut, strength) {
  if (!lut || strength === 0 || !lut.bakedData) return

  const { data } = imageData
  const str = strength / 100
  const invStr = 1 - str
  const baked = lut.bakedData
  const size = lut.size
  const max = size - 1
  const scale = max / 255
  const size3 = size * 3
  const sizeSize3 = size * size3

  for (let i = 0; i < data.length; i += 4) {
    const sR = data[i]
    const sG = data[i + 1]
    const sB = data[i + 2]

    // Scale to grid coordinates
    const rs = sR * scale
    const gs = sG * scale
    const bs = sB * scale

    const ri = rs | 0
    const gi = gs | 0
    const bi = bs | 0

    // Clamp to valid range for interpolation
    const ri0 = ri < max ? ri : max - 1
    const gi0 = gi < max ? gi : max - 1
    const bi0 = bi < max ? bi : max - 1

    const rf = rs - ri0
    const gf = gs - gi0
    const bf = bs - bi0
    const bf1 = 1 - bf
    const gf1 = 1 - gf
    const rf1 = 1 - rf

    // Base index for corner (ri0, gi0, bi0)
    const base = ri0 * sizeSize3 + gi0 * size3 + bi0 * 3

    // Trilinear interpolation - fully unrolled per channel
    // Red
    const r00 = baked[base] * bf1 + baked[base + 3] * bf
    const r01 = baked[base + size3] * bf1 + baked[base + size3 + 3] * bf
    const r10 = baked[base + sizeSize3] * bf1 + baked[base + sizeSize3 + 3] * bf
    const r11 = baked[base + sizeSize3 + size3] * bf1 + baked[base + sizeSize3 + size3 + 3] * bf
    const lutR = (r00 * gf1 + r01 * gf) * rf1 + (r10 * gf1 + r11 * gf) * rf

    // Green
    const g00 = baked[base + 1] * bf1 + baked[base + 4] * bf
    const g01 = baked[base + size3 + 1] * bf1 + baked[base + size3 + 4] * bf
    const g10 = baked[base + sizeSize3 + 1] * bf1 + baked[base + sizeSize3 + 4] * bf
    const g11 = baked[base + sizeSize3 + size3 + 1] * bf1 + baked[base + sizeSize3 + size3 + 4] * bf
    const lutG = (g00 * gf1 + g01 * gf) * rf1 + (g10 * gf1 + g11 * gf) * rf

    // Blue
    const b00 = baked[base + 2] * bf1 + baked[base + 5] * bf
    const b01 = baked[base + size3 + 2] * bf1 + baked[base + size3 + 5] * bf
    const b10 = baked[base + sizeSize3 + 2] * bf1 + baked[base + sizeSize3 + 5] * bf
    const b11 = baked[base + sizeSize3 + size3 + 2] * bf1 + baked[base + sizeSize3 + size3 + 5] * bf
    const lutB = (b00 * gf1 + b01 * gf) * rf1 + (b10 * gf1 + b11 * gf) * rf

    // Strength blending and write back
    let vr = sR * invStr + lutR * str
    let vg = sG * invStr + lutG * str
    let vb = sB * invStr + lutB * str
    data[i] = vr < 0 ? 0 : vr > 255 ? 255 : (vr + 0.5) | 0
    data[i + 1] = vg < 0 ? 0 : vg > 255 ? 255 : (vg + 0.5) | 0
    data[i + 2] = vb < 0 ? 0 : vb > 255 ? 255 : (vb + 0.5) | 0
  }
}
