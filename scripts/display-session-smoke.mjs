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
//    display target of the new size on the same level;
//  - colour film (an auto-framed 16-bit negative): the settled view opened
//    from RAM (Tier A, Tier B), the spill and the store (when it has a
//    budget) equals the same frame opened cold (GPU pixels, white balance,
//    saved settings), and a Tier A Undo across Confirm image area exports
//    (PNG16, TIFF16) what a cold reopen of the recipe exports.
// Tiers are forced through window.__ncDisplaySessions.force: the budget
// logic itself is covered by the Node tests (displaySessions.test.mjs).
import { createRequire } from 'node:module';
import { installPhotoSessionProbe, decodePng, decodeTiff, bootPhotoSession } from './photo-session-smoke.mjs';

const pako = createRequire(import.meta.url)('pako');
const { encodePng16Blob } = await import('../negative2positive/src/workers/imageEncoders.js');
const { displayProxyStoreBudget, DISPLAY_PROXY_STORE_DEFAULT_LIMIT_BYTES } = await import('../negative2positive/src/app/displayProxyStore.js');

// A 16-bit colour negative: an orange-masked scene inside a rebate of clear
// film base, which the import's frame detection crops away (a colour frame is
// a display session only with a crop). Every channel transmits less than the
// base inside the image.
async function colourNegative16(width = 1000, height = 700, border = 100) {
  const base = [59110, 41120, 23130];
  const rgba = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    rgba[i + 3] = 65535;
    const inside = x >= border && y >= border && x < width - border && y < height - border;
    const u = (x - border) / (width - 2 * border), v = (y - border) / (height - 2 * border);
    const scene = inside ? [0.2 + 0.6 * u, 0.25 + 0.4 * v + 0.15 * Math.sin(u * 9), 0.3 + 0.5 * (1 - u) * v] : null;
    if (scene && Math.hypot(u - 0.35, v - 0.5) < 0.15) scene[0] = 0.9;
    for (let c = 0; c < 3; c++) rgba[i + c] = scene ? Math.round(base[c] * (0.15 + 0.65 * (1 - scene[c]))) : base[c];
  }
  return Buffer.from(await encodePng16Blob(rgba, width, height, pako).arrayBuffer());
}

// Dotted paths of the values that differ between two plain JSON objects.
function differences(expected, actual, path = '') {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap(key => differences(expected[key], actual[key], path ? `${path}.${key}` : key));
  }
  return [`${path}: ${JSON.stringify(expected)?.slice(0, 160)} -> ${JSON.stringify(actual)?.slice(0, 160)}`];
}

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
  const exportPixels = async (depth, format = 'png') => {
    const index = await evaluate('window.__photoSessionProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${depth}-bit display-session ${format.toUpperCase()} captured`, `!!window.__photoSessionProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120000);
    const data = await evaluate(`window.__photoSessionProbe.exports[${index}].data`);
    return format === 'tiff' ? decodeTiff(data) : decodePng(data);
  };
  // Opens a photo from the strip and records whether the veil ever showed.
  // `before` runs first, in the same task as the click (a drop of the
  // photo's caches, so no lane prefetches it in between).
  const open = async (index, name, { before = '' } = {}) => {
    await evaluate(`(async () => {
      ${before};
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

    // ---- Colour film: settled-view parity with a cold open ----
    const X = 'display-colour-16.png', Y = 'display-colour-b.png';
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
    // Colour film, with the import's auto-crop: the frame is cropped to its image.
    await bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port, query: '&debug=1&largeImagePixels=100000', keepAutoCrop: true });
    const negative = (await colourNegative16()).toString('base64');
    await evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(negative)}), c => c.charCodeAt(0));
      const plain = await (await fetch('/test-fixtures/negative-plain.png')).blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], ${JSON.stringify(X)}, { type: 'image/png' }));
      transfer.items.add(new File([plain], ${JSON.stringify(Y)}, { type: 'image/png' }));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('colour fixtures imported', `${ready} && document.querySelectorAll('#fileListItems .file-list-name').length === 2 && !!document.getElementById('studioFilename').textContent`, 120000);
    await idle();
    if ((await evaluate(`document.getElementById('studioFilename').textContent`)) !== X) await open(0, X);
    const framed = await evaluate(`({ geometry: window.__ncGeometry.inspect(), recipe: window.__ncDisplaySessions.recipe() })`);
    expect(framed.geometry.cropRegion && framed.recipe.settings.autoFrameMeta?.imageArea && framed.recipe.settings.filmEdge?.checked
      && framed.recipe.settings.filmType === 'color',
    'the colour negative was not auto-framed with an image area and a read edge: ' + JSON.stringify({
      cropRegion: framed.geometry.cropRegion, autoFrameMeta: framed.recipe.settings.autoFrameMeta,
      filmEdge: framed.recipe.settings.filmEdge, filmType: framed.recipe.settings.filmType }));
    const view = async () => ({ gpu: (await snapshot()).gpu?.hash ?? null, ...(await evaluate('window.__ncDisplaySessions.recipe()')) });
    // The reference: the frame opened cold (its file read and decoded), as
    // after a restart, under the recipe it was left with.
    await open(1, Y);
    const beforeCold = await counts(X);
    await open(0, X, { before: 'await window.__ncDisplaySessions.drop(0)' });
    expect((await counts(X)).reads > beforeCold.reads, 'the cold open did not read the file');
    const cold = await view();
    expect(cold.gpu !== null && cold.wb.confidence, 'the cold open drew no GPU frame or estimated no white balance: ' + JSON.stringify({ gpu: cold.gpu, wb: cold.wb }));
    const sameView = (actual, label) => {
      expect(actual.gpu === cold.gpu, `${label}: GPU pixels differ from the cold open (${actual.gpu} vs ${cold.gpu})`);
      expect(JSON.stringify(actual.wb) === JSON.stringify(cold.wb), `${label}: white balance differs from the cold open: ` + JSON.stringify({ actual: actual.wb, cold: cold.wb }));
      const diff = differences(cold.settings, actual.settings);
      expect(!diff.length, `${label}: saved settings differ from the cold open:\n${diff.join('\n')}`);
    };
    for (const tier of ['A', 'B']) {
      await evaluate(`window.__ncDisplaySessions.force(${JSON.stringify(tier)})`);
      await open(1, Y);
      expect(await evaluate(`window.__ncDisplaySessions.tier(0)`) === tier, `the colour frame was not kept as Tier ${tier}: ` + JSON.stringify(await evaluate(`window.__ncDisplaySessions.tier(0)`)));
      const before = await counts(X);
      const veil = await open(0, X);
      const after = await counts(X);
      expect(!veil, `an in-RAM Tier ${tier} colour hit showed the veil`);
      expect(after.reads === before.reads && after.decodes === before.decodes, `an in-RAM Tier ${tier} colour hit read or decoded: ` + JSON.stringify({ before, after }));
      sameView(await view(), `RAM Tier ${tier}`);
    }
    await evaluate(`window.__ncDisplaySessions.force('spill')`);
    await open(1, Y);
    await evaluate('window.__ncDisplaySessions.settled()');
    expect(await evaluate(`window.__ncDisplaySessions.tier(0)`) === 'spill', 'the colour frame was not spilled');
    const spillHits = (await diagnostics()).spillHits;
    await open(0, X);
    expect((await diagnostics()).spillHits === spillHits + 1, 'the colour frame did not open from the spill');
    sameView(await view(), 'spill');
    // Left again, its proxy is stored; the session and the spill go. The
    // store has no budget at or below its free-space floor (10 GiB, #249
    // part 3): headless Chrome's temporary profile reports a quota of 10 GiB.
    await evaluate(`window.__ncDisplaySessions.force(null)`);
    await open(1, Y);
    await evaluate('window.__ncDisplaySessions.settled()');
    const storeFree = await evaluate(`navigator.storage.estimate().then(({ quota, usage }) => quota - (usage || 0))`);
    if (displayProxyStoreBudget(storeFree, DISPLAY_PROXY_STORE_DEFAULT_LIMIT_BYTES) >= 64 * 1024 ** 2) {
      const storeHits = (await diagnostics()).storeHits;
      await open(0, X, { before: 'await window.__ncDisplaySessions.drop(0, { keepStore: true })' });
      expect((await diagnostics()).storeHits === storeHits + 1, 'the colour frame did not open from the store: ' + JSON.stringify({ diagnostics: await diagnostics(), store: await evaluate('window.__ncDisplaySessions.store()') }));
      sameView(await view(), 'store');
    } else {
      console.log(`note: the display-proxy store has no budget with ${(storeFree / 1024 ** 3).toFixed(2)} GiB free (its floor is 10 GiB): the store hit is not checked here`);
      await open(0, X);
    }
    // A fill (a lane's or the roll pass's decode of a frame not on screen)
    // makes proxies only of frames whose display level is smaller than them
    // (k > 1, sources of about 16 MP and up), which this smoke does not
    // decode; displaySessions.test.mjs checks that a filled proxy's first
    // open converts what a cold open converts.
    console.log('ok: a colour frame opened from RAM (Tier A, Tier B) and the spill (and the store, when it has a budget) shows what a cold open shows, with the same white balance and saved settings');

    // ---- Colour film: a Tier A Undo across Confirm image area exports what
    // a cold reopen of the recipe exports (the colour-analysis sample of the
    // earlier area is kept with the session) ----
    await evaluate(`document.getElementById('studioConfirmAnalysis').click()`);
    await until('analysis area mode', `document.getElementById('canvasContainer').classList.contains('crop-mode') && !!document.getElementById('cropOverlay')?.getBoundingClientRect().width`, 60000);
    const corner = await evaluate(`(() => { const a = document.getElementById('cropOverlay').getBoundingClientRect(); return { x: a.left + 2, y: a.top + 2, tx: a.left + a.width * 0.2, ty: a.top + a.height * 0.2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.tx, y: corner.ty, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.tx, y: corner.ty, button: 'left', clickCount: 1 });
    await evaluate(`document.getElementById('applyCropBtn').click()`);
    await until('analysis area confirmed', `${ready} && !document.getElementById('canvasContainer').classList.contains('crop-mode')`, 120000);
    await idle();
    const confirmed = await evaluate('window.__ncDisplaySessions.recipe()');
    expect(JSON.stringify(confirmed.settings.autoFrameMeta?.imageArea) !== JSON.stringify(cold.settings.autoFrameMeta.imageArea),
      'Confirm image area did not move the analysis area');
    await evaluate(`window.__ncDisplaySessions.force('A')`);
    await open(1, Y);
    expect(await evaluate(`window.__ncDisplaySessions.tier(0)`) === 'A', 'the confirmed colour frame was not kept as Tier A');
    const misses = (await diagnostics()).sampleMisses;
    await open(0, X);
    const returned = await live();
    expect(!returned.base && returned.baseDescriptor, 'the colour frame did not come back as Tier A: ' + JSON.stringify(returned));
    await evaluate(`document.getElementById('undoBtn').click()`);
    await idle();
    const undone = await live();
    const undoneRecipe = await evaluate('window.__ncDisplaySessions.recipe()');
    expect(!undone.base && undone.baseDescriptor, 'the Undo decoded the original: Tier A lost the earlier area\'s sample: ' + JSON.stringify(undone));
    expect(JSON.stringify(undoneRecipe.settings.autoFrameMeta?.imageArea) === JSON.stringify(cold.settings.autoFrameMeta.imageArea),
      'the Undo did not restore the earlier analysis area');
    expect((await diagnostics()).sampleMisses === misses, 'a conversion after the Undo missed its colour-analysis sample');
    const tierAExports = { png: await exportPixels(16), tiff: await exportPixels(16, 'tiff') };
    expect(!(await live()).base, 'the Tier A export decoded the original although the sample was kept');
    await evaluate(`window.__ncDisplaySessions.force(null)`);
    await open(1, Y);
    await open(0, X, { before: 'await window.__ncDisplaySessions.drop(0)' });
    expect((await live()).base, 'the reopen was not cold');
    const coldExports = { png: await exportPixels(16), tiff: await exportPixels(16, 'tiff') };
    for (const format of ['png', 'tiff']) {
      expect(tierAExports[format].depth === 16 && tierAExports[format].sha256 === coldExports[format].sha256
        && tierAExports[format].width === coldExports[format].width && tierAExports[format].height === coldExports[format].height,
      `the Tier A ${format.toUpperCase()}16 export after the Undo differs from a cold reopen's: ` + JSON.stringify({ tierA: tierAExports[format], cold: coldExports[format] }));
    }
    console.log('ok: a Tier A Undo across Confirm image area keeps its colour-analysis sample; its PNG16 and TIFF16 exports equal a cold reopen\'s');
    await evaluate(`window.__ncDisplaySessions.force(null)`);
  } catch (error) {
    failure = error;
  } finally {
    // Back to the layout smoke-test.mjs pins for every scenario: clearing the
    // override would leave the fake camera's 1440 x 757 viewport to the steps
    // that follow.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await evaluate('window.__restorePhotoSessionProbe?.(); window.__displaySessionVeilObserver?.disconnect(); window.__ncDisplaySessions?.force(null)').catch(() => {});
  }
  if (failure) fail(`display-session smoke: ${failure.message}`);
}
