// Retained planes after browsing a roll (#234, R1-025): ten frames made large
// (?largeImagePixels, so each settles at display resolution and only an
// export renders its full-resolution positive), opened one after another, three
// of them exported. The photo-session cache keeps the photos left in their
// display form (Tier B, forced: the form a real large roll's sessions take once
// they exceed the budget), so no full-resolution plane of a photo left belongs
// to any budget. After a forced GC, every live full-resolution ImageData must
// be held by the open photo (state and history) or by a budgeted photo cache
// (sessions, prefetch, presentation previews): the active tile's inputs, or
// anything else, must not keep one alive.
import { bootPhotoSession } from './photo-session-smoke.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
// All 900 x 600; the last repeats the first under another name.
const ROLL = [
  'negative-gradient-16.png', 'negative-plain.png', 'negative-textured.png', 'negative-vignetted.png', 'shot-a.png',
  'shot-b.png', 'shot-c.png', 'shot-dark.png', 'lightpad-blank.png', 'negative-gradient-16.png',
].map((fixture, index) => [fixture, `heap-roll-${String(index + 1).padStart(2, '0')}.png`]);
const FRAME_PIXELS = 900 * 600;
const EXPORTED = [2, 5, 8];

// Runs in the page on the array Runtime.queryObjects returns: the bytes of
// every live ImageData of at least `minPixels` (8-bit and 16-bit planes, each
// buffer once), and those no budget holds.
function retainedPlanes(minPixels) {
  const held = window.__ncMemory.held();
  const seen = new Set();
  const report = { images: 0, bytes: 0, unheldBytes: 0, unheld: [] };
  for (const image of this) {
    if (!(image.width * image.height >= minPixels)) continue;
    report.images++;
    for (const view of [image.data, image.__image16?.data]) {
      const buffer = view?.buffer;
      if (!buffer || seen.has(buffer)) continue;
      seen.add(buffer);
      report.bytes += buffer.byteLength;
      if (held.has(buffer)) continue;
      report.unheldBytes += buffer.byteLength;
      report.unheld.push({ width: image.width, height: image.height, bytes: buffer.byteLength, plane: view === image.data ? 8 : 16 });
    }
  }
  return report;
}

export async function runPhotoHeapSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 60000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const idle = async () => until('heap-roll worker/render idle', `${ready} && window.__photoSessionProbe.inFlight === 0 && performance.now() - window.__photoSessionProbe.lastActivity > 1800`, 120000);
  const open = async (index, name) => {
    await evaluate(`document.querySelector('.file-list-name[data-index="${index}"]').click()`);
    await until(`heap-roll photo ${name} open`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)} && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '${index}'`, 120000);
    await idle();
  };
  const exportPng = async () => {
    const index = await evaluate('window.__photoSessionProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until('heap-roll PNG captured', `!!window.__photoSessionProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120000);
    // Only the capture matters here; its data URL is not kept.
    await evaluate(`window.__photoSessionProbe.exports[${index}].data = 'captured'`);
  };
  // After a forced GC: every live ImageData through the heap, against the
  // buffers the app's budgets hold (window.__ncMemory.held, ?debug=1).
  const measure = async () => {
    for (let i = 0; i < 3; i++) await send('HeapProfiler.collectGarbage');
    const group = 'nc-photo-heap';
    try {
      const prototype = await send('Runtime.evaluate', { expression: 'ImageData.prototype', objectGroup: group });
      const found = await send('Runtime.queryObjects', { prototypeObjectId: prototype.result.result.objectId, objectGroup: group });
      const report = await send('Runtime.callFunctionOn', {
        objectId: found.result.objects.objectId, functionDeclaration: retainedPlanes.toString(),
        arguments: [{ value: FRAME_PIXELS }], returnByValue: true
      });
      expect(!report.result?.exceptionDetails, 'the retained-plane count threw: ' + JSON.stringify(report.result?.exceptionDetails));
      return report.result.result.value;
    } finally {
      await send('Runtime.releaseObjectGroup', { objectGroup: group });
    }
  };
  let failure;
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
    await bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port, query: '&debug=1&largeImagePixels=100000' });
    // B&W frames need no crop to be display sessions (displaySessionEligible).
    await evaluate(`document.querySelector('.film-type-btn[data-type="bw"]')?.click()`);
    await evaluate(`(async () => {
      const transfer = new DataTransfer();
      for (const [fixture, name] of ${JSON.stringify(ROLL)}) {
        const blob = await (await fetch('/test-fixtures/' + fixture)).blob();
        transfer.items.add(new File([blob], name, { type: 'image/png' }));
      }
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('heap-roll fixtures imported', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(ROLL[0][1])}`, 120000);
    await idle();
    await evaluate(`window.__ncDisplaySessions.force('B')`);
    for (let index = 1; index < ROLL.length; index++) {
      await open(index, ROLL[index][1]);
      if (EXPORTED.includes(index)) {
        await exportPng();
        await idle();
      }
    }
    const tiers = await evaluate(`${JSON.stringify(ROLL.slice(0, -1).map((_, index) => index))}.map(index => window.__ncDisplaySessions.tier(index))`);
    const sessions = await evaluate('window.__ncDisplaySessions.bytes()');
    const planes = await measure();
    console.log('photo heap after browsing a large roll:', JSON.stringify({ tiers, sessions, planes }));
    expect(tiers.filter(tier => tier === 'B').length >= EXPORTED.length,
      'the photos left were not kept as display sessions (Tier B): ' + JSON.stringify(tiers));
    expect(planes.images > 0 && planes.bytes > 0, 'no full-resolution plane was found at all: ' + JSON.stringify(planes));
    expect(sessions.sessions <= sessions.budget, 'the session cache exceeds its budget: ' + JSON.stringify(sessions));
    expect(planes.unheldBytes === 0,
      'full-resolution planes outside the session budget and the open photo stay alive: ' + JSON.stringify(planes));
    console.log(`ok: browsing ${ROLL.length} large frames and exporting ${EXPORTED.length} keeps no full-resolution plane outside the session budget and the open photo`);
  } catch (error) {
    failure = error;
  } finally {
    // Back to the layout smoke-test.mjs pins for every scenario (as the
    // display-session smoke does).
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await evaluate('window.__ncDisplaySessions?.force(null); window.__restorePhotoSessionProbe?.()').catch(() => {});
  }
  if (failure) fail(`photo heap smoke: ${failure.message}`);
}
