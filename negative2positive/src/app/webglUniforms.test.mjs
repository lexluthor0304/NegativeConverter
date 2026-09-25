import assert from 'node:assert/strict';
import { mainFunctions, state } from '../../test-fixtures/mainSettingsHarness.mjs';

// webglSetUniforms reads its seven scalars directly instead of sanitising the
// whole settings object per draw. Every uniform value must stay identical to
// the implementation at 1703835, kept below as the reference. #239 dropped the
// legacy tone uniforms (exposure, contrast, highlights, shadows, temperature,
// tint, saturation), which SilverCore always held at identity: the display
// shaders no longer have them, and the remaining three uniforms are unchanged.
const calls = [];
const recorder = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
const locations = Object.fromEntries(['uWb', 'uVib', 'uCmy'].map(name => [name, name]));
const webglState = { gl: recorder, locations };
const app = mainFunctions(['getEffectiveFilmType', 'usesSilverCoreConversion', 'webglStep3Values', 'webglSetUniforms'], { webglState });

function referenceUniforms() {
  const gl = webglState.gl;
  const safe = app.sanitizeSettings(state, { fallbackSettings: state, includeCurvePoints: false, includeCurves: false });
  const useLegacyTone = !app.usesSilverCoreConversion(safe);
  // Every film type is a SilverCore type, so the legacy uniforms were identity.
  assert.equal(useLegacyTone, false);
  gl.uniform3f(locations.uWb, safe.wbR, safe.wbG, safe.wbB);
  gl.uniform1f(locations.uVib, safe.vibrance / 100);
  gl.uniform3f(locations.uCmy, safe.cyan / 100, safe.magenta / 100, safe.yellow / 100);
}

const odd = [undefined, null, NaN, Infinity, -Infinity, '', '12.5', 'abc', true, -0, 0, 250, -250, 0.25, 1.7, 3, -3, 99.99];
const keys = ['vibrance', 'wbR', 'wbG', 'wbB', 'cyan', 'magenta', 'yellow', 'exposure', 'contrast', 'highlights',
  'shadows', 'temperature', 'tint', 'saturation'];
let seed = 99;
const pick = () => odd[(seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % odd.length];
let cases = 0;
for (const filmType of ['color', 'bw', 'positive', 'legacy', undefined]) {
  for (let i = 0; i < 400; i++) {
    state.filmType = filmType;
    for (const key of keys) state[key] = i === 0 ? undefined : pick();
    calls.length = 0; referenceUniforms(); const expected = calls.splice(0);
    app.webglSetUniforms(); const actual = calls.splice(0);
    assert.equal(actual.length, expected.length);
    actual.forEach((call, index) => {
      assert.equal(call.length, expected[index].length);
      call.forEach((value, j) => assert.ok(Object.is(value, expected[index][j]),
        `${filmType} case ${i}: ${call[0]}(${call[1]}) arg ${j}: ${value} vs ${expected[index][j]}`));
    });
    cases++;
  }
}
console.log(`webglUniforms: ${cases} states give uniform values identical to the full sanitizer path`);
