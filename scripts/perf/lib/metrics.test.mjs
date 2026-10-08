import assert from 'node:assert/strict';
import {
  pictures, dragMetrics, dragInputs, settledAt, importMetrics, switchMetrics, zoomStepMetrics, panMetrics,
  rafGapSummary, busyFromTimerTicks, timerGapSummary, eventTimingP95, overlayHiddenAt, nextOverlayHidden,
  longTaskSummary, flattenMetrics, newestInputIndex, loafAttribution, workerTimingSummary
} from './metrics.mjs';

const sortT = events => events.sort((a, b) => a.t - b.t);

// ---- Step-3 style drag: uniform-only pictures, every frame drawn ----
{
  const events = [];
  for (let i = 0; i < 10; i++) {
    const t = 1000 + i * 16.7;
    events.push({ k: 'input', type: 'mousemove', t, b: 1, id: 'cyan', x: i, y: 0 });
    events.push({ k: 'input', type: 'input', t: t + 0.3, id: 'cyan', v: String(i) });
    events.push({ k: 'gl.draw', t: t + 12, c: 'glCanvas', sig: `s${i}`, ut: t + 1 });
  }
  // A redraw of the same state is not a picture; the release draws nothing new.
  events.push({ k: 'gl.draw', t: 1200, c: 'glCanvas', sig: 's9', ut: 1151.3 });
  const release = 1000 + 9 * 16.7 + 20;
  const m = dragMetrics(sortT(events), { targetId: 'cyan', window: { start: 1000, release, end: 1300 }, initialValue: '-1' });
  assert.equal(m.inputs, 10);
  assert.equal(m.pictures, 10);
  assert.equal(m.framesCoveredPct, 100);
  assert.equal(m.inputToDrawP50Ms, 12);
  assert.equal(m.inputToDrawP95Ms, 12);
  assert.equal(m.finalValueAfterReleaseMs, 12 - 20, 'the final value can be drawn before release (negative)');
  assert.equal(m.lastChangeAfterReleaseMs, null, 'nothing new after release');
  assert.equal(m.updatesPerSecond, Math.round((10 / ((release - 1000) / 1000)) * 10) / 10);
}

// ---- inputs that do not change the value are not value changes ----
{
  const events = sortT([
    { k: 'input', type: 'input', t: 1, id: 'wbR', v: '1.00' },
    { k: 'input', type: 'input', t: 2, id: 'wbR', v: '1.00' },
    { k: 'input', type: 'input', t: 3, id: 'wbR', v: '1.01' },
    { k: 'input', type: 'input', t: 4, id: 'other', v: '5' },
    { k: 'input', type: 'input', t: 5, id: 'wbR', v: '1.02', tr: false }
  ]);
  assert.deepEqual(dragInputs(events, { targetId: 'wbR', initialValue: '1.00' }).map(i => i.value), ['1.01']);
  assert.equal(newestInputIndex([{ t: 1 }, { t: 5 }], 4), 0);
  assert.equal(newestInputIndex([{ t: 1 }, { t: 5 }], 0), -1);
}

// ---- curve drag: pointer mode, LUT uploads; late picture after release ----
{
  const events = [];
  for (let i = 0; i < 6; i++) {
    const t = 2000 + i * 16.7;
    events.push({ k: 'input', type: 'mousemove', t, b: 1, id: 'curveCanvas', x: 100, y: 200 - i });
    if (i % 2 === 0) {
      events.push({ k: 'gl.upload', t: t + 3, c: 'glCanvas', w: 256, h: 1, hash: `lut${i}` });
      events.push({ k: 'gl.draw', t: t + 13, c: 'glCanvas', sig: `c${i}` });
    }
  }
  events.push({ k: 'gl.draw', t: 2400, c: 'glCanvas', sig: 'full-res swap' });
  const m = dragMetrics(sortT(events), { targetId: 'curveCanvas', mode: 'pointer', window: { start: 2000, release: 2100, end: 2600 } });
  assert.equal(m.inputs, 6);
  assert.equal(m.framesCoveredPct, 50);
  assert.equal(m.inputToDrawP50Ms, 13);
  assert.equal(m.lastChangeAfterReleaseMs, 300, 'the idle full-resolution swap after release is the last change');
}

// ---- CPU display path: 2D pictures, conversion results by hash ----
{
  const events = sortT([
    { k: 'req', t: 10, cls: 'convert', wid: 1, id: 1 },
    { k: 'res', t: 40, cls: 'convert', wid: 1, id: 1, rt: 10, hash: 'aa', cache: true },
    { k: 'c2d', t: 45, c: 'canvas', fn: 'putImageData', w: 900, h: 600, hash: 'aa' },
    { k: 'c2d', t: 46, c: 'canvas', fn: 'putImageData', w: 900, h: 600, hash: 'aa' },
    { k: 'c2d', t: 60, c: 'canvas', fn: 'drawImage', w: 900, h: 600, sig: 'x' },
    { k: 'c2d', t: 70, c: 'canvas', fn: 'drawImage', w: 900, h: 600, sig: 'y', src: 'aa' }
  ]);
  const pics = pictures(events, 'canvas');
  assert.equal(pics.length, 3);
  assert.equal(pics[0].positive, true);
  assert.equal(pics[0].causeT, 10);
  assert.equal(pics[1].positive, false);
  assert.equal(pics[2].positive, true, 'a result drawn through a scratch canvas is a positive');
  assert.equal(pics[2].causeT, 10);
}

// ---- The crop view (#245): every draw on #cropCanvas is a picture ----
{
  const events = sortT([
    { k: 'c2d', t: 10, c: 'cropCanvas', fn: 'drawImage', w: 9536, h: 6336, cw: 1809, ch: 1202, sig: 'same' },
    { k: 'c2d', t: 50, c: 'cropCanvas', fn: 'drawImage', w: 9536, h: 6336, cw: 1822, ch: 1236, sig: 'same' }
  ]);
  const pics = pictures(events, 'cropCanvas');
  assert.equal(pics.length, 2, 'an angle change redraws the same proxy: still a new picture');
  assert.deepEqual([pics[0].canvasW, pics[0].canvasH], [1809, 1202]);
  assert.equal(pics[1].positive, false);
}

// ---- GL positives: resized results match by order; uniform redraws are not new content ----
{
  const events = sortT([
    { k: 'req', t: 10, cls: 'convert', wid: 1, id: 1 },
    { k: 'res', t: 40, cls: 'convert', wid: 1, id: 1, rt: 10, hash: 'full-size' },
    { k: 'gl.upload', t: 45, c: 'glCanvas', w: 1809, h: 1202, hash: 'resized-for-display' },
    { k: 'gl.draw', t: 46, c: 'glCanvas', sig: 'a' },
    { k: 'gl.draw', t: 60, c: 'glCanvas', sig: 'b', ut: 55 },
    { k: 'gl.upload', t: 70, c: 'glCanvas', w: 256, h: 1, hash: 'lut' },
    { k: 'gl.draw', t: 71, c: 'glCanvas', sig: 'c' }
  ]);
  const pics = pictures(events, 'glCanvas');
  assert.deepEqual(pics.map(pic => [pic.positive, pic.matchedBy, pic.causeT, pic.contentT]), [
    [true, 'order', 10, 45], [false, null, 55, null], [false, null, 70, null]
  ]);
}

// ---- settled: in-flight requests keep the page busy ----
{
  const events = sortT([
    { k: 'req', t: 100, wid: 1, cls: 'libraw', fn: 'imageData' },
    { k: 'res', t: 5600, wid: 1, cls: 'libraw', fn: 'imageData', rt: 100 },
    { k: 'req', t: 5700, wid: 2, cls: 'suppress' },
    { k: 'res', t: 8900, wid: 2, cls: 'suppress', rt: 5700 },
    { k: 'req', t: 9000, wid: 3, cls: 'semantic' }
  ]);
  assert.equal(settledAt(events, 0), 9000, 'a 5.5 s decode is not quiet time');
  assert.equal(settledAt(events, 0, { until: 10_000 }), null, 'not settled until 2.5 s have passed');
  assert.equal(settledAt(events, 0, { until: 11_600 }), 9000);
  assert.equal(settledAt([], 50), 50);
}

// ---- S1 import timeline ----
{
  const events = sortT([
    { k: 'input', type: 'change', t: 1000, id: 'fileInput', files: 1 },
    { k: 'vis', t: 1005, ov: true, ready: false, busy: true },
    { k: 'req', t: 1180, wid: 1, cls: 'libraw', fn: 'open' },
    { k: 'res', t: 1300, wid: 1, cls: 'libraw', fn: 'open', rt: 1180 },
    { k: 'req', t: 1310, wid: 1, cls: 'libraw', fn: 'imageData' },
    { k: 'res', t: 9000, wid: 1, cls: 'libraw', fn: 'imageData', rt: 1310 },
    { k: 'req', t: 9050, wid: 3, cls: 'suppress' },
    { k: 'res', t: 10050, wid: 3, cls: 'suppress', rt: 9050 },
    { k: 'req', t: 10100, wid: 4, cls: 'analyze-frame', id: 1 },
    { k: 'res', t: 13200, wid: 4, cls: 'analyze-frame', id: 1, rt: 10100 },
    { k: 'c2d', t: 10074, c: 'canvas', fn: 'putImageData', w: 9536, h: 6336, hash: 'neg' },
    { k: 'vis', t: 13300, ov: true, ready: false, busy: true, op: 0.3 },
    { k: 'req', t: 14200, wid: 2, cls: 'convert', id: 5 },
    { k: 'res', t: 14280, wid: 2, cls: 'convert', id: 5, rt: 14200, hash: 'pos' },
    { k: 'gl.upload', t: 14300, c: 'glCanvas', w: 1809, h: 1202, hash: 'pos' },
    { k: 'gl.draw', t: 14310, c: 'glCanvas', sig: 'p1' },
    { k: 'vis', t: 14320, ov: false, ready: true, busy: false },
    { k: 'um', t: 1100, n: 'nc:prepareStudioPhoto', s: 1100, d: 13000, detail: { stages: [] } },
    { k: 'lt', t: 10050, s: 10050, d: 347 }
  ]);
  const m = importMetrics(events, { changeT: 1000 });
  assert.equal(m.firstPixelsDrawnMs, 9074);
  assert.equal(m.firstPhotoVisibleMs, 12300, 'the negative becomes visible when the overlay fades');
  assert.equal(m.firstPositiveVisibleMs, 13310);
  assert.equal(m.readyMs, 13320);
  assert.equal(m.settledMs, 13280);
  assert.equal(m.librawDecodes, 1);
  assert.equal(m.changeToLibrawOpenMs, 180);
  assert.deepEqual(m.longTasks, { n: 1, totalMs: 347, maxMs: 347 });
  assert.equal(m.measures[0].name, 'nc:prepareStudioPhoto');
  assert.ok(m.stages.some(stage => stage.cls === 'convert' && stage.ms === 80));
  assert.equal(overlayHiddenAt(events, 1010), false);
  assert.equal(nextOverlayHidden(events, 10074), 13300);
}

// ---- S7 switch ----
{
  const events = sortT([
    { k: 'input', type: 'keydown', t: 500, key: 'Enter' },
    { k: 'mut', t: 520, what: 'filename', v: 'L1000618.DNG' },
    { k: 'vis', t: 530, ov: false, ready: false, busy: true },
    { k: 'req', t: 700, wid: 4, cls: 'libraw', fn: 'open' },
    { k: 'req', t: 9900, wid: 5, cls: 'convert', id: 9 },
    { k: 'res', t: 9950, wid: 5, cls: 'convert', id: 9, rt: 9900, hash: 'z' },
    { k: 'gl.upload', t: 9960, c: 'glCanvas', w: 1809, h: 1202, hash: 'z' },
    { k: 'gl.draw', t: 9970, c: 'glCanvas', sig: 'q' },
    { k: 'vis', t: 9990, ov: false, ready: true, busy: false },
    { k: 'res', t: 12000, wid: 6, cls: 'suppress', rt: 400 }
  ]);
  const m = switchMetrics(events, { keyT: 500, target: 'L1000618.DNG', displaySize: { w: 1809, h: 1202 }, until: 13000 });
  assert.equal(m.firstPixelsMs, 9470);
  assert.equal(m.firstDisplayPositiveMs, 9470);
  assert.equal(m.readyMs, 9490);
  assert.equal(m.librawDecodes, 1);
  assert.equal(m.staleResultsAfterShown, 1, 'a result requested before the switch arriving after it counts as stale');
}

// ---- S7 warm switch: cached pixels, no new conversion ----
{
  const events = sortT([
    { k: 'req', t: 100, cls: 'convert', wid: 1, id: 1 },
    { k: 'res', t: 120, cls: 'convert', wid: 1, id: 1, rt: 100, hash: 'old' },
    { k: 'gl.upload', t: 121, c: 'glCanvas', w: 1809, h: 1202, hash: 'old' },
    { k: 'gl.draw', t: 122, c: 'glCanvas', sig: 'o' },
    { k: 'input', type: 'keydown', t: 1000, key: 'Enter' },
    { k: 'gl.draw', t: 1005, c: 'glCanvas', sig: 'o2', ut: 1003 },
    { k: 'mut', t: 1010, what: 'filename', v: 'B.DNG' },
    { k: 'gl.upload', t: 1070, c: 'glCanvas', w: 1809, h: 1202, hash: 'cached-b' },
    { k: 'gl.draw', t: 1077, c: 'glCanvas', sig: 'b' },
    { k: 'vis', t: 1100, ov: false, ready: true, busy: false }
  ]);
  const m = switchMetrics(events, { keyT: 1000, target: 'B.DNG', displaySize: { w: 1809, h: 1202 }, until: 3000 });
  assert.equal(m.firstPixelsMs, 77, 'a redraw of the old texture is not the target');
  assert.equal(m.firstDisplayPositiveMs, 77, 'restored pixels count without a new conversion');
  assert.equal(m.librawDecodes, 0);
}

// ---- S4 zoom step and pan ----
{
  const events = sortT([
    { k: 'gl.upload', t: 10, c: 'glCanvas', w: 1809, h: 1202, hash: 'a' },
    { k: 'input', type: 'dblclick', t: 100 },
    { k: 'mut', t: 111, what: 'transform', v: 'matrix(2, 0, 0, 2, 0, 0)' },
    { k: 'lt', t: 300, s: 300, d: 283 },
    { k: 'gl.upload', t: 576, c: 'glCanvas', w: 2453, h: 1630, hash: 'b' }
  ]);
  const m = zoomStepMetrics(events, { inputT: 100, until: 2000, sourceWidth: 9536, displayedCssWidth: 1803.5, dpr: 2 });
  assert.equal(m.transformAppliedMs, 11);
  assert.equal(m.textureRefinedAtMs, 476);
  assert.equal(m.longTaskDuringRefineMs, 283);
  assert.equal(m.backingPx, '2453×1630');
  assert.equal(m.backingOverNeeded, 0.68);
  const capped = zoomStepMetrics(events, { inputT: 1000, until: 2000, sourceWidth: 2000, displayedCssWidth: 3000, dpr: 2 });
  assert.equal(capped.textureRefinedAtMs, null);
  assert.equal(capped.backingOverNeeded, 1.23, 'needed is capped at the source width');
}
{
  const events = [];
  const frames = [];
  for (let i = 0; i < 120; i++) {
    const t = 5000 + i * 16.7;
    frames.push(t + 2);
    events.push({ k: 'input', type: 'mousemove', t, b: 1 });
    events.push({ k: 'mut', t: t + 8, what: 'transform', v: `m${i}` });
  }
  const m = panMetrics(sortT(events), { start: 5000, end: 5000 + 120 * 16.7, frameTimes: frames });
  assert.equal(m.moveToFrameP50Ms, 8);
  assert.ok(m.transformFramesPerSecond > 59 && m.transformFramesPerSecond < 61);
}

// ---- windows: rAF gaps, timer ticks, Event Timing, long tasks ----
assert.deepEqual(rafGapSummary([0, 16, 33, 150, 166]), { frames: 5, fps: 24.1, gapsOver: 1, maxGapMs: 117, over25: 1 });
assert.equal(busyFromTimerTicks([0, 5, 10, 60, 65], { start: 0, end: 65 }), 69.2, 'a 50 ms tick gap is 45 ms of blocking');
assert.deepEqual(timerGapSummary([0, 5, 10, 60, 65]), { n: 0, totalMs: 0, maxMs: 50 });
assert.deepEqual(timerGapSummary([0, 5, 90]), { n: 1, totalMs: 85, maxMs: 85 });
assert.equal(eventTimingP95([{ k: 'et', n: 'mousemove', s: 1, d: 24 }], { start: 0, end: 10, inputCount: 100 }), 0, 'below the reporting threshold is 0');
assert.equal(eventTimingP95(Array.from({ length: 10 }, (_, i) => ({ k: 'et', n: 'mousemove', s: i, d: 32 })), { start: 0, end: 20, inputCount: 20 }), 32);
assert.deepEqual(longTaskSummary([{ k: 'lt', s: 10, d: 60 }, { k: 'lt', s: 500, d: 70 }], 0, 100), { n: 1, totalMs: 60, maxMs: 60 });

assert.deepEqual(flattenMetrics('s1', { a: 1, b: { c: 'x', d: null, e: [1] } }), { 's1.a': 1, 's1.b.c': 'x' });

// LoAF attribution through the source mapper; worker-side timing per class.
{
  const mapper = { mapCharPosition: (url, pos) => (pos === 10 ? { source: 'src/app/studioSettings.js', line: 25 } : null) };
  const top = loafAttribution([
    { k: 'loaf', t: 0, scripts: [{ u: 'http://x/assets/main.js', fn: 'createStudioThumbnail', cp: 10, d: 60, fsl: 5 }, { u: 'http://x/assets/main.js', cp: 99, d: 5 }] },
    { k: 'loaf', t: 50, scripts: [{ u: 'http://x/assets/main.js', fn: 'createStudioThumbnail', cp: 10, d: 40 }] }
  ], mapper);
  assert.deepEqual(top[0], { label: 'createStudioThumbnail src/app/studioSettings.js:25', ms: 100, count: 2, forcedLayoutMs: 5 });
  const summary = workerTimingSummary([
    { k: 'req', t: 100, cls: 'convert', id: 3 },
    { k: 'req', t: 200, cls: 'suppress', id: 1 }
  ], [
    { ph: 'start', id: 3, t: 10_000 + 104, session: 'w1' }, { ph: 'reply', id: 3, t: 10_000 + 130, session: 'w1' },
    { ph: 'start', id: 1, t: 10_000 + 201, session: 'w2' }
  ], 10_000);
  assert.deepEqual(summary.convert, { n: 1, queueP50Ms: 4, handleP50Ms: 26, handleMaxMs: 26 });
  assert.equal(summary.suppress.n, 1);
  assert.equal(workerTimingSummary([], [], null), null);
}

console.log('metrics: pictures, drags, import, switch, zoom, pan, windows tests passed');

// #239: a LUT upload on every SilverCore tick is a uniform-like change,
// even though 256² met the old source-texture threshold. Integer sensor
// textures must not inherit an earlier conversion's request time either.
for (const upload of [{ w: 256, h: 256, format: 0x1908, type: 0x1401 }, { w: 1800, h: 1200, format: 0x8D99, type: 0x1403 }]) {
  const events = [{ k: 'res', cls: 'convert', t: 10, rt: 0, hash: 'initial', w: 1800, h: 1200 }];
  for (let i = 0; i < 180; i++) {
    const t = 1000 + i * 1000 / 60;
    events.push({ k: 'input', type: 'input', id: 'coreExposure', t, tr: true, v: String(i + 1) },
      { k: 'gl.upload', c: 'glCanvas', t: t + 1, hash: `table${i}`, ...upload },
      { k: 'gl.draw', c: 'glCanvas', t: t + 6, sig: `tick${i}` });
  }
  const m = dragMetrics(events, { targetId: 'coreExposure', initialValue: 0, window: { start: 1000, release: 4000, end: 4500 } });
  assert.equal(m.updatesPerSecond, 60);
  assert.equal(m.framesCoveredPct, 100);
  assert.equal(m.inputToDrawP95Ms, 6);
}
