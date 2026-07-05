// Standalone Node test for zoomGeometry.js - run with:
// node negative2positive/src/app/zoomGeometry.test.mjs
import assert from 'node:assert/strict';
import { computeZoomGeometry, clampPanValues } from './zoomGeometry.js';

// 1. Zoom 1, wrapper exactly fills container: no pan allowed anywhere
{
  const g = computeZoomGeometry({ wrapperW: 800, wrapperH: 600, containerW: 800, containerH: 600, zoom: 1 });
  assert.equal(g.baseX, 0);
  assert.equal(g.baseY, 0);
  assert.equal(g.minPanX, g.maxPanX);
  assert.equal(g.minPanY, g.maxPanY);
  assert.ok(g.minPanX === 0);
}

// 2. Content smaller than container: the only legal pan re-centers it
{
  const g = computeZoomGeometry({ wrapperW: 400, wrapperH: 300, containerW: 800, containerH: 600, zoom: 1 });
  assert.equal(g.baseX, 200);
  assert.equal(g.minPanX, g.maxPanX);
  assert.ok(g.minPanX === 0); // centered position == base position (-0 counts)
  const clamped = clampPanValues(999, -999, g);
  assert.ok(clamped.panX === 0 && clamped.panY === 0);
}

// 3. Zoomed 2x from a filling wrapper: content overflows, pan range = overflow
{
  const g = computeZoomGeometry({ wrapperW: 800, wrapperH: 600, containerW: 800, containerH: 600, zoom: 2 });
  assert.equal(g.scaledW, 1600);
  assert.ok(g.maxPanX === 0);       // cannot reveal space left of content (-0 ok)
  assert.equal(g.minPanX, -800);    // can slide until right edge meets container edge
  assert.ok(g.maxPanY === 0);
  assert.equal(g.minPanY, -600);
}

// 4. Clamp keeps in-range values untouched
{
  const g = computeZoomGeometry({ wrapperW: 800, wrapperH: 600, containerW: 800, containerH: 600, zoom: 2 });
  assert.deepEqual(clampPanValues(-400, -300, g), { panX: -400, panY: -300 });
  const edge = clampPanValues(50, -700, g);
  assert.ok(edge.panX === 0 && edge.panY === -600);
}

// 5. Mixed axes: overflow on X only (wide panorama in a square container)
{
  const g = computeZoomGeometry({ wrapperW: 1000, wrapperH: 200, containerW: 500, containerH: 500, zoom: 1 });
  // X overflows: pan range is negative span
  assert.equal(g.minPanX, 500 - g.baseX - 1000);
  assert.equal(g.maxPanX, -g.baseX);
  // Y fits: single legal (centering) value
  assert.equal(g.minPanY, g.maxPanY);
}

console.log('zoomGeometry tests: all passed');
