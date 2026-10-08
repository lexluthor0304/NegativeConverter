import assert from 'node:assert/strict';
import {
  describeWebglRenderer, isSoftwareRenderer, startsReduced, startsReducedReason,
  formatRenderEnvironmentLine, formatPreviewSessionLine
} from './renderEnvironment.js';

// A WebGL stand-in that answers the two renderer queries.
function fakeGl({ unmasked = null, renderer = 'WebKit WebGL', extension = true, throws = false } = {}) {
  const ext = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  return {
    RENDERER: 0x1f01,
    getExtension(name) {
      if (throws) throw new Error('lost');
      return name === 'WEBGL_debug_renderer_info' && extension ? ext : null;
    },
    getParameter(pname) {
      if (pname === ext.UNMASKED_RENDERER_WEBGL) return unmasked;
      if (pname === 0x1f01) return renderer;
      return null;
    }
  };
}

// ---- Renderer classification ----
const cases = [
  ['llvmpipe (LLVM 15.0.7, 256 bits)', true],
  ['Mesa/X.org softpipe', true],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', true],
  ['Google SwiftShader', true],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', true],
  ['Mesa swrast', true],
  ['Software Rasterizer', true],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', false],
  ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', false],
  ['ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)', false],
  ['', false],
];
for (const [renderer, software] of cases) {
  assert.equal(isSoftwareRenderer(renderer), software, `classifies ${JSON.stringify(renderer)}`);
  assert.deepEqual(describeWebglRenderer(fakeGl({ unmasked: renderer })), {
    renderer: renderer || 'WebKit WebGL', software
  }, `describes ${JSON.stringify(renderer)}`);
}

// A masked renderer (no debug extension, or an empty unmasked string) falls
// back to RENDERER and counts as hardware.
assert.deepEqual(describeWebglRenderer(fakeGl({ extension: false })), { renderer: 'WebKit WebGL', software: false });
assert.deepEqual(describeWebglRenderer(fakeGl({ extension: false, renderer: '' })), { renderer: '', software: false });
assert.deepEqual(describeWebglRenderer(fakeGl({ throws: true })), { renderer: '', software: false });
assert.deepEqual(describeWebglRenderer(null), { renderer: '', software: false });
assert.deepEqual(describeWebglRenderer(fakeGl({ unmasked: 'llvmpipe (LLVM 12.0.0, 256 bits)' })).software, true);

// ---- startsReduced ----
const env = (pairs) => [
  ['WEBKIT_DISABLE_DMABUF_RENDERER', null],
  ['WEBKIT_DMABUF_RENDERER_FORCE_SHM', null],
  ['WEBKIT_DISABLE_COMPOSITING_MODE', null],
].map(([name]) => [name, pairs[name] ?? null]);
const hardware = { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)', software: false };
const software = { renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)', software: true };

const legacyDefault = { os: 'linux', appimage: 'legacy', dmabuf: 'disabled:legacy-default', env: env({ WEBKIT_DISABLE_DMABUF_RENDERER: '1' }) };
assert.equal(startsReduced({ compositing: legacyDefault, renderer: hardware }), true, 'legacy default');
assert.equal(startsReducedReason({ compositing: legacyDefault, renderer: hardware }), 'software-compositing');

const userPreset = { os: 'linux', appimage: 'standard', dmabuf: 'kept:user-preset', env: env({ WEBKIT_DISABLE_DMABUF_RENDERER: '1' }) };
assert.equal(startsReduced({ compositing: userPreset, renderer: hardware }), true, 'user-set =1 recorded as kept:user-preset');

const compositingOff = { os: 'linux', appimage: null, dmabuf: null, env: env({ WEBKIT_DISABLE_COMPOSITING_MODE: '1' }) };
assert.equal(startsReduced({ compositing: compositingOff, renderer: hardware }), true, 'WEBKIT_DISABLE_COMPOSITING_MODE=1');
assert.equal(startsReducedReason({ compositing: compositingOff }), 'compositing-disabled');

const explicitZero = { os: 'linux', appimage: 'standard', dmabuf: 'kept:user-preset', env: env({ WEBKIT_DISABLE_DMABUF_RENDERER: '0', WEBKIT_DISABLE_COMPOSITING_MODE: '0' }) };
assert.equal(startsReduced({ compositing: explicitZero, renderer: hardware }), false, '=0 keeps acceleration');

const probeSupported = { os: 'linux', appimage: 'standard', dmabuf: 'kept:probe-supported', env: env({}) };
assert.equal(startsReduced({ compositing: probeSupported, renderer: hardware }), false, 'standard AppImage with a render node');
// SHM keeps accelerated compositing.
const shm = { os: 'linux', appimage: 'legacy', dmabuf: 'shm:legacy-default', env: env({ WEBKIT_DMABUF_RENDERER_FORCE_SHM: '1' }) };
assert.equal(startsReduced({ compositing: shm, renderer: hardware }), false, 'shm transport');

for (const os of ['macos', 'windows']) {
  const desktop = { os, appimage: null, dmabuf: null, env: [], webkitgtk: null, frameLog: false };
  assert.equal(startsReduced({ compositing: desktop, renderer: hardware }), false, `${os} with a hardware renderer`);
  assert.equal(startsReduced({ compositing: desktop, renderer: software }), true, `${os} with a software renderer`);
}
assert.equal(startsReduced({ compositing: null, renderer: null }), false, 'web page before WebGL');
assert.equal(startsReduced({ compositing: null, renderer: { renderer: '', software: false } }), false, 'masked renderer counts as hardware');
assert.equal(startsReducedReason({ renderer: software }), 'software-gl');
assert.equal(startsReduced(), false);
assert.equal(startsReduced({ compositing: { env: 'garbage' } }), false, 'malformed env is ignored');

// ---- Diagnostics lines ----
const line = formatRenderEnvironmentLine({
  renderer: { renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)', software: true },
  compositing: { ...legacyDefault, webkitgtk: '2.36.0' },
  startTier: 'reduced', startReason: 'software-compositing'
});
assert.equal(line, 'renderer="llvmpipe (LLVM 15.0.7, 256 bits)" software=true os=linux appimage=legacy '
  + 'dmabuf=disabled:legacy-default webkitgtk=2.36.0 env=WEBKIT_DISABLE_DMABUF_RENDERER=1 start=reduced(software-compositing)');
assert.equal(formatRenderEnvironmentLine({ renderer: null }), 'renderer=unavailable software=false start=normal');
assert.ok(!/\n/.test(formatRenderEnvironmentLine({ renderer: { renderer: 'a\nb', software: false } })), 'renderer string is quoted onto one line');

const session = formatPreviewSessionLine({
  kind: 'slider', reduced: true, startTier: 'normal', startReason: null, trigger: 'slow-frames', endReason: 'pointerup',
  intervals: 42, p50: 31.24, p95: 48, idleInterval: 16.7, backing: { width: 1224, height: 816 },
  maxBacking: { width: 2448, height: 1632 }, durationMs: 1500.4
});
assert.equal(session, 'session kind=slider tier=reduced start=normal trigger=slow-frames end=pointerup frames=42 '
  + 'p50=31.2ms p95=48ms idle=16.7ms backing=1224x816(1.00MP) maxBacking=2448x1632(4.00MP) durationMs=1500');
assert.equal(formatPreviewSessionLine(null), 'session none');

console.log('renderEnvironment tests passed');
