// Display-resolution photo sessions (#249) in the real Studio, on small
// fixtures made "large" (?largeImagePixels) in a small window, so each
// photo's settled view is the preview conversion of its display proxy (its
// display level, #248; these fixtures are their own level, k = 1):
//  - Tier A (the conversion source without the base): A -> B -> A restores
//    with no file read, no decode and no veil, the same GPU pixels, the same
//    undo depth, and a 16-bit export byte-identical to the one before;
//  - a geometry edit on it waits for the original ("Preparing original…")
//    and decodes once;
//  - Tier B (display planes only): the same, and its export decodes the
//    original first (ensureSource) and matches the export before leaving;
//  - the spill: a photo written to the per-tab spill opens without a read or
//    decode and shows the same GPU pixels;
//  - another window size is served by the proxy: no read, no decode, a
//    display target of the new size on the same level.
// Tiers are forced through window.__ncDisplaySessions.force: the budget
// logic itself is covered by the Node tests (displaySessions.test.mjs).
import { installPhotoSessionProbe, decodePng, bootPhotoSession } from './photo-session-smoke.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

export async function runDisplaySessionSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 60000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const idle = async () => until('display-session worker/render idle', `${ready} && window.__photoSessionProbe.inFlight === 0 && performance.now() - window.__photoSessionProbe.lastActivity > 1800`);
  const diagnostics = () => evaluate('JSON.parse(JSON.stringify(window.__ncDisplaySessions.diagnostics))');
  const live = () => evaluate('window.__ncDisplaySessions.live()');
  const snapshot = () => evaluate('window.__photoSessionProbe.snapshot()');
  const counts = name => evaluate(`({ reads: window.__photoSessionProbe.reads.filter(file => file === ${JSON.stringify(name)}).length,
    decodes: window.__photoSessionProbe.requests.filter(request => request.kind === 'decode' || request.kind === 'raw').length })`);
  const exportPixels = async depth => {
    const index = await evaluate('window.__photoSessionProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${depth}-bit display-session PNG captured`, `!!window.__photoSessionProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120000);
    return decodePng(await evaluate(`window.__photoSessionProbe.exports[${index}].data`));
  };
  // Opens a photo from the strip and records whether the veil ever showed.
  const open = async (index, name) => {
    await evaluate(`(() => {
      window.__displaySessionVeil = false;
      const observer = new MutationObserver(() => { if (document.body.dataset.photoSwitching === 'true') window.__displaySessionVeil = true; });
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-photo-switching'] });
      window.__displaySessionVeilObserver?.disconnect();
      window.__displaySessionVeilObserver = observer;
      document.querySelector('.file-list-name[data-index="${index}"]').click();
      if (document.body.dataset.photoSwitching === 'true') window.__displaySessionVeil = true;
    })()`);
    await until(`photo ${name} open`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)} && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '${index}'`, 120000);
    await idle();
    return evaluate('window.__displaySessionVeil');
  };
  // After an export the frame on screen is resampled from the full-resolution
  // plane; a return from a display proxy converts the proxy instead. Nudge an
  // engine control there and back so the settled frame is the preview
  // conversion again, under the exported recipe.
  const settlePreviewFrame = async () => {
    await evaluate(`(async () => {
      const input = document.getElementById('coreExposure');
      const value = Number(input.value);
      for (const next of [value + 1, value]) {
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    })()`);
    await idle();
  };
  const A = 'display-a-16.png', B = 'display-b.png', C = 'display-c.png';
  let failure;
  try {
    // A window small enough that a 900 x 600 frame gets a separate display preview.
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
    await bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port, query: '&debug=1&largeImagePixels=100000' });
    // B&W frames read no border pixels for Step 2's mode, so they are exact
    // display sessions without a crop.
    await evaluate(`document.querySelector('.film-type-btn[data-type="bw"]')?.click()`);
    await evaluate(`(async () => {
      const transfer = new DataTransfer();
      for (const [fixture, name] of ${JSON.stringify([['negative-gradient-16.png', A], ['negative-plain.png', B], ['negative-textured.png', C]])}) {
        const blob = await (await fetch('/test-fixtures/' + fixture)).blob();
        transfer.items.add(new File([blob], name, { type: 'image/png' }));
      }
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('display-session fixtures imported', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(A)}`, 120000);
    await idle();
    // Photo A gets a geometry (a quarter turn): its base is then not its
    // working frame, so Tier A has something to drop.
    await evaluate(`document.getElementById('studioTab-composition')?.click(); document.getElementById('rotateRightBtn').click()`);
    await until('A rotated and converted', `${ready} && !window.__ncGeometry.pending()`, 120000);
    await idle();
    let before = await live();
    expect(before.base && before.source, 'photo A is a normal session before the tiers: ' + JSON.stringify(before));

    // ---- Tier A ----
    await evaluate(`window.__ncDisplaySessions.force('A')`);
    const exportA = await exportPixels(16);
    await idle();
    const gpuA = (await snapshot()).gpu;
    const undoA = await evaluate(`document.getElementById('undoBtn').disabled`);
    await open(1, B);
    expect(await evaluate(`window.__ncDisplaySessions.tier(0)`) === 'A', 'A was not kept as Tier A: ' + JSON.stringify(await evaluate(`window.__ncDisplaySessions.tier(0)`)));
    const beforeA = await counts(A);
    const veilA = await open(0, A);
    const afterA = await counts(A);
    const tierA = await live();
    expect(!veilA, 'a Tier A hit showed the veil');
    expect(afterA.reads === beforeA.reads && afterA.decodes === beforeA.decodes, 'a Tier A hit read or decoded: ' + JSON.stringify({ beforeA, afterA }));
    expect(!tierA.base && tierA.baseDescriptor && tierA.source, 'Tier A restored the wrong planes: ' + JSON.stringify(tierA));
    expect((await snapshot()).gpu?.hash === gpuA?.hash, 'Tier A GPU pixels differ from before the switch');
    expect(await evaluate(`document.getElementById('undoBtn').disabled`) === undoA, 'Tier A lost its undo history');
    const exportA2 = await exportPixels(16);
    expect(exportA2.sha256 === exportA.sha256, 'a Tier A export differs from the one before the switch');
    expect((await counts(A)).reads === beforeA.reads, 'a Tier A export read the original');
    console.log('ok: Tier A restores without a read, decode or veil, with the same pixels, undo and 16-bit export');

    // A geometry edit waits for the original, visibly, then decodes once.
    await evaluate(`(() => {
      window.__displaySessionPreparing = false;
      const observer = new MutationObserver(() => { if (document.body.dataset.studioPreparing === 'original') window.__displaySessionPreparing = true; });
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-studio-preparing'] });
      document.getElementById('rotateRightBtn').click();
      if (document.body.dataset.studioPreparing === 'original') window.__displaySessionPreparing = true;
    })()`);
    await until('A rotated from its decoded original', `${ready} && !window.__ncGeometry.pending() && !document.body.dataset.studioPreparing`, 120000);
    await idle();
    expect(await evaluate('window.__displaySessionPreparing'), 'the rotation did not show "Preparing original…"');
    const edited = await live();
    expect(edited.base && !edited.baseDescriptor, 'the original was not installed: ' + JSON.stringify(edited));
    expect((await counts(A)).reads === beforeA.reads + 1, 'the original was not read exactly once');
    const inspected = await evaluate('window.__ncGeometry.inspect({ chain: true })');
    expect(inspected.hash16 === inspected.chainHash16, 'the rebuilt planes differ from the export chain');
    console.log('ok: a geometry edit on Tier A waits for the original and builds the exact chain');

    // ---- Tier B ----
    await evaluate(`window.__ncDisplaySessions.force('B')`);
    const exportB = await exportPixels(16);
    await idle();
    await settlePreviewFrame();
    const gpuB = (await snapshot()).gpu;
    await open(1, B);
    expect(await evaluate(`window.__ncDisplaySessions.tier(0)`) === 'B', 'A was not kept as Tier B');
    const beforeB = await counts(A);
    const veilB = await open(0, A);
    const tierB = await live();
    expect(!veilB, 'an in-RAM Tier B hit showed the veil');
    expect((await counts(A)).reads === beforeB.reads, 'a Tier B hit read the original');
    expect(!tierB.base && !tierB.source && tierB.sourcePending && tierB.proxyMatches, 'Tier B restored the wrong planes: ' + JSON.stringify(tierB));
    expect((await snapshot()).gpu?.hash === gpuB?.hash, 'Tier B GPU pixels differ from before the switch');
    const exportB2 = await exportPixels(16);
    expect(exportB2.sha256 === exportB.sha256, 'a Tier B export differs from the one before the switch');
    expect((await counts(A)).reads === beforeB.reads + 1, 'the Tier B export did not rebuild its source from one read');
    expect((await diagnostics()).selfCheckMismatches === 0, 'a display proxy failed its self-check');
    console.log('ok: Tier B restores from display planes only; its export rebuilds the source and matches');

    // ---- The spill ----
    await evaluate(`window.__ncDisplaySessions.force('spill')`);
    await settlePreviewFrame();
    const gpuS = (await snapshot()).gpu;
    await open(1, B);
    await evaluate('window.__ncDisplaySessions.settled()');
    const spill = await evaluate('window.__ncDisplaySessions.spill()');
    expect(spill.writes >= 1 && await evaluate(`window.__ncDisplaySessions.tier(0)`) === 'spill', 'A was not spilled: ' + JSON.stringify(spill));
    const beforeS = await counts(A);
    await open(0, A);
    const spilled = await diagnostics();
    expect(spilled.spillHits >= 1, 'A did not open from the spill: ' + JSON.stringify(spilled));
    expect((await counts(A)).reads === beforeS.reads && (await counts(A)).decodes === beforeS.decodes, 'a spilled hit read or decoded');
    expect((await snapshot()).gpu?.hash === gpuS?.hash, 'the spilled proxy converted to other pixels');
    console.log('ok: a spilled photo opens without a read or decode, with the same pixels');

    // ---- Another window size is served by the proxy (#248's level) ----
    const shownBefore = (await live()).target;
    await open(1, B);
    await evaluate('window.__ncDisplaySessions.settled()');
    // Smaller, so the new target stays below the source on any layout.
    await send('Emulation.setDeviceMetricsOverride', { width: 820, height: 600, deviceScaleFactor: 1, mobile: false });
    const beforeM = await counts(A);
    const provisional = (await diagnostics()).provisional;
    await open(0, A);
    const resized = await live();
    expect((await diagnostics()).provisional === provisional, 'a window-size change missed the proxy');
    expect((await counts(A)).reads === beforeM.reads && (await counts(A)).decodes === beforeM.decodes, 'a window-size change read or decoded the original');
    expect(resized.sourcePending && resized.proxyMatches && resized.target?.onLevel, 'the level did not serve the new window: ' + JSON.stringify(resized));
    expect(resized.target.width < shownBefore.width, 'the display target did not follow the window: ' + JSON.stringify({ shownBefore, resized }));
    console.log('ok: a window-size change is served by the display level, without a read or decode');
    await evaluate(`window.__ncDisplaySessions.force(null)`);
  } catch (error) {
    failure = error;
  } finally {
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await evaluate('window.__restorePhotoSessionProbe?.(); window.__displaySessionVeilObserver?.disconnect(); window.__ncDisplaySessions?.force(null)').catch(() => {});
  }
  if (failure) fail(`display-session smoke: ${failure.message}`);
}
