#!/usr/bin/env node
/**
 * derive-noritsu-lut.mjs — Derive Noritsu LUT from Frontier LUT
 *
 * Noritsu scanners produce more neutral/cooler colors compared to Frontier's
 * warmer rendering. This script applies three transforms in ProPhoto gamma 1.8
 * space to approximate the Noritsu look:
 *
 * 1. Blend 18% toward identity (more neutral rendering)
 * 2. Shadow cooling: low-luminance R↓ B↑ (cooler shadows)
 * 3. Green channel cleanup: reduce yellow cast in green-dominant regions
 *
 * Input:  frontier.bin (32³×3×uint16, R-outer layout)
 * Output: noritsu.bin (same format)
 *
 * Usage:
 *   node scripts/derive-noritsu-lut.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LUT_SIZE = 32;
const TOTAL = LUT_SIZE * LUT_SIZE * LUT_SIZE * 3;
const PROFILES_DIR = resolve(__dirname, '../negative2positive/src/silvercore/resources/profiles');

/**
 * Compute identity value for a given grid index
 * Identity value: i * 65535 / (N-1), rounded
 */
function identityValue(i) {
  return Math.floor((i * 65535 + (LUT_SIZE >> 1)) / (LUT_SIZE - 1));
}

/**
 * Compute luminance (approximate) from normalized RGB [0,1]
 * Using ProPhoto-like weights
 */
function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// --- Main ---

console.log('=== Deriving Noritsu LUT from Frontier ===\n');

// Load frontier.bin
const frontierPath = resolve(PROFILES_DIR, 'frontier.bin');
const frontierBuf = readFileSync(frontierPath);
const frontier = new Uint16Array(frontierBuf.buffer, frontierBuf.byteOffset, frontierBuf.byteLength / 2);

console.log(`  Loaded frontier.bin: ${frontierBuf.length} bytes (${frontier.length} uint16 values)`);

if (frontier.length !== TOTAL) {
  throw new Error(`Expected ${TOTAL} values, got ${frontier.length}`);
}

// Build identity LUT
const identity = new Uint16Array(TOTAL);
for (let ri = 0; ri < LUT_SIZE; ri++) {
  const rId = identityValue(ri);
  for (let gi = 0; gi < LUT_SIZE; gi++) {
    const gId = identityValue(gi);
    for (let bi = 0; bi < LUT_SIZE; bi++) {
      const bId = identityValue(bi);
      const off = ((ri * LUT_SIZE + gi) * LUT_SIZE + bi) * 3;
      identity[off + 0] = rId;
      identity[off + 1] = gId;
      identity[off + 2] = bId;
    }
  }
}

// Derive noritsu LUT
const noritsu = new Uint16Array(TOTAL);
const inv = 1 / 65535;

// Blend factor toward identity
const IDENTITY_BLEND = 0.18;
const FRONTIER_BLEND = 1.0 - IDENTITY_BLEND;

for (let ri = 0; ri < LUT_SIZE; ri++) {
  for (let gi = 0; gi < LUT_SIZE; gi++) {
    for (let bi = 0; bi < LUT_SIZE; bi++) {
      const off = ((ri * LUT_SIZE + gi) * LUT_SIZE + bi) * 3;

      // Step 1: Blend toward identity
      let r = frontier[off + 0] * FRONTIER_BLEND + identity[off + 0] * IDENTITY_BLEND;
      let g = frontier[off + 1] * FRONTIER_BLEND + identity[off + 1] * IDENTITY_BLEND;
      let b = frontier[off + 2] * FRONTIER_BLEND + identity[off + 2] * IDENTITY_BLEND;

      // Normalize to [0,1] for luminance calculation
      const rNorm = r * inv;
      const gNorm = g * inv;
      const bNorm = b * inv;
      const lum = luminance(rNorm, gNorm, bNorm);

      // Step 2: Shadow cooling (luminance < 0.3)
      if (lum < 0.3) {
        // Smooth transition: full effect at lum=0, zero at lum=0.3
        const shadowStrength = 1.0 - (lum / 0.3);

        // Compute deltas from identity
        const rDelta = r - identity[off + 0];
        const bDelta = b - identity[off + 2];

        // Scale R delta down (cooler), B delta up (bluer)
        const rScale = 1.0 - 0.03 * shadowStrength; // 0.97 at darkest
        const bScale = 1.0 + 0.02 * shadowStrength; // 1.02 at darkest

        r = identity[off + 0] + rDelta * rScale;
        b = identity[off + 2] + bDelta * bScale;
      }

      // Step 3: Green channel cleanup - reduce yellow cast in green-dominant areas
      if (gNorm > rNorm && gNorm > bNorm) {
        // Green-dominant node: slightly reduce R to clean up yellow cast
        const greenDominance = Math.min(1.0, (gNorm - Math.max(rNorm, bNorm)) * 5);
        const rReduction = 1.0 - 0.015 * greenDominance; // up to 1.5% R reduction
        const rDelta = r - identity[off + 0];
        r = identity[off + 0] + rDelta * rReduction;
      }

      // Clamp and write
      noritsu[off + 0] = Math.max(0, Math.min(65535, Math.round(r)));
      noritsu[off + 1] = Math.max(0, Math.min(65535, Math.round(g)));
      noritsu[off + 2] = Math.max(0, Math.min(65535, Math.round(b)));
    }
  }
}

// Validate: diagonal (R=G=B → near-gray output)
console.log('\n  Diagonal validation (R=G=B input → output):');
console.log('  %-8s %-28s %-28s', 'Input', 'Frontier', 'Noritsu');
const steps = [0, 8, 16, 24, 31];
for (const i of steps) {
  const off = ((i * LUT_SIZE + i) * LUT_SIZE + i) * 3;
  const input = (i / (LUT_SIZE - 1)).toFixed(3);
  const fR = (frontier[off] * inv).toFixed(4);
  const fG = (frontier[off + 1] * inv).toFixed(4);
  const fB = (frontier[off + 2] * inv).toFixed(4);
  const nR = (noritsu[off] * inv).toFixed(4);
  const nG = (noritsu[off + 1] * inv).toFixed(4);
  const nB = (noritsu[off + 2] * inv).toFixed(4);
  console.log(`  ${input}    F=[${fR}, ${fG}, ${fB}]  N=[${nR}, ${nG}, ${nB}]`);
}

// Write noritsu.bin
const outPath = resolve(PROFILES_DIR, 'noritsu.bin');
const outBuf = Buffer.from(noritsu.buffer, noritsu.byteOffset, noritsu.byteLength);
writeFileSync(outPath, outBuf);
console.log(`\n  Written: ${outPath}`);
console.log(`  Size: ${outBuf.length} bytes (expected ${LUT_SIZE ** 3 * 3 * 2})`);
