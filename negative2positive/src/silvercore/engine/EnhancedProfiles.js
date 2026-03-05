/**
 * EnhancedProfiles.js - 3D LUT loading and trilinear interpolation
 * Applies scanner color simulation (Frontier/Crystal/Natural/Pakon).
 * LUT color space: ProPhoto primaries + gamma 1.8
 */

import { convertSpace } from './ColorSpace.js'

export const PROFILES = ['none', 'frontier', 'crystal', 'natural', 'pakon']
export const LUT_SIZE = 32

const profileCache = new Map()
const PROFILE_URLS = {
  frontier: new URL('../resources/profiles/frontier.bin', import.meta.url).href,
  crystal: new URL('../resources/profiles/crystal.bin', import.meta.url).href,
  natural: new URL('../resources/profiles/natural.bin', import.meta.url).href,
  pakon: new URL('../resources/profiles/pakon.bin', import.meta.url).href,
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
  const profile = { name, data: new Uint16Array(buf), size: LUT_SIZE }
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
 * Apply 3D LUT to image data (CPU path).
 * Converts sRGB -> ProPhoto/g1.8 -> LUT -> ProPhoto/g1.8 -> sRGB.
 * @param {ImageData} imageData
 * @param {{data: Uint16Array, size: number}} lut
 * @param {number} strength - 0-200 (100 = full effect)
 */
export function applyLut3D(imageData, lut, strength) {
  if (!lut || strength === 0) return

  const { data } = imageData
  const str = strength / 100
  const inv255 = 1 / 255

  for (let i = 0; i < data.length; i += 4) {
    const sR = data[i] * inv255
    const sG = data[i + 1] * inv255
    const sB = data[i + 2] * inv255

    // sRGB -> ProPhoto gamma 1.8
    const [ppR, ppG, ppB] = convertSpace(sR, sG, sB, 'sRGBd50', 'ProPhoto')

    // Clamp to [0,1] for LUT lookup
    const cR = Math.max(0, Math.min(1, ppR))
    const cG = Math.max(0, Math.min(1, ppG))
    const cB = Math.max(0, Math.min(1, ppB))

    // 3D LUT trilinear interpolation (result in ProPhoto/g1.8)
    const [lutR, lutG, lutB] = sampleLut3D(lut.data, cR, cG, cB)

    // ProPhoto gamma 1.8 -> sRGB
    const [outR, outG, outB] = convertSpace(lutR, lutG, lutB, 'ProPhoto', 'sRGBd50')

    // Strength blending and write back
    data[i] = Math.max(0, Math.min(255, Math.round(sR * 255 * (1 - str) + outR * 255 * str)))
    data[i + 1] = Math.max(0, Math.min(255, Math.round(sG * 255 * (1 - str) + outG * 255 * str)))
    data[i + 2] = Math.max(0, Math.min(255, Math.round(sB * 255 * (1 - str) + outB * 255 * str)))
  }
}
