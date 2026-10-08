import { statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseAst } from 'vite';

// Re-run the same UI probe with the frozen production function bodies.
// Keep Vite's import rewrites and response isolation headers. No runtime
// measurement, router, replay or worker is replaced by a test estimate.
export async function installFrozenHistoryControl({ send, onCdpEvent, root, fail }) {
  const head = process.env.NC229_HISTORY_BEFORE_HEAD;
  if (head && !/^[a-f0-9]{40}$/.test(head)) fail('Invalid immutable history control head');
  const source = head ? execFileSync('git', ['show', `${head}:negative2positive/src/app/main.js`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : '';
  const names = ['maybeAutoWhiteBalance', 'provisionalWhiteBalanceMeasurement', 'processNegative',
    'startCropDetection', 'restoreSnapshot', 'rebaseProvisionalHistory'];
  const functions = text => {
    const found = new Map();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration' && node.id) found.set(node.id.name, node);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    };
    walk(parseAst(text));
    return found;
  };
  const original = functions(source);
  const unsubscribe = onCdpEvent(message => {
    if (message.method !== 'Fetch.requestPaused' || message.sessionId) return;
    // Another step's interception (the isolation smoke's document rewrite)
    // pauses requests through the same event; only main.js is this one's.
    if (!/\/src\/app\/main\.js(?:[?#]|$)/.test(message.params?.request?.url || '')) return;
    void (async () => {
      const request = message.params;
      const response = await send('Fetch.getResponseBody', { requestId: request.requestId });
      let text = response.result.base64Encoded ? Buffer.from(response.result.body, 'base64').toString() : response.result.body;
      const compiled = functions(text), replacements = [];
      for (const name of head ? names : []) {
        const current = compiled.get(name), old = original.get(name);
        if (!current || !old) throw new Error(`Frozen history function absent: ${name}; url=${request.request.url}; status=${request.responseStatusCode}; bytes=${text.length}; start=${text.slice(0, 120)}`);
        replacements.push({ start: current.start, end: current.end, body: source.slice(old.start, old.end) });
      }
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.body + text.slice(replacement.end);
      // Controlled input leaves for fields without a direct edit control.
      // Production capture, processing, measurement, history and encoding stay
      // intact. This hook exists only in the intercepted development response.
      const anchor = functions(text).get('processNegative');
      if (!anchor) throw new Error('History input probe scope missing');
      const hook = `window.__ncHistoryInputs = {
        exportState: async () => {
          const image = state.processedImageData;
          const summary = { step: state.currentStep, pendingSpatial: Boolean(expiredSpatialRun),
            spatialCurrent: Boolean(expiredSpatialRun && expiredSpatialRun.generation === loadGeneration && expiredSpatialRun.key === expiredSourceKey()),
            analysis: structuredClone(state.expiredAnalysis),
            coreExposure: state.coreExposure, filmType: state.filmType, wb: [state.wbR, state.wbG, state.wbB],
            preview: Boolean(state.processedImageDataIsPreview), fullPending: Boolean(state.fullResolutionPending),
            historyPending: Boolean(state.fullBaseHistoryPending), converting: Boolean(processNegativeInFlight) };
          const hash = async data => data ? [...new Uint8Array(await crypto.subtle.digest('SHA-256',
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()))].map(v => v.toString(16).padStart(2, '0')).join('') : null;
          summary.processed = image && { width: image.width, height: image.height,
            rgba8: await hash(image.data), rgba16: await hash(image.__image16?.data) };
          return summary;
        },
        restoration: () => ({ step: state.currentStep, geometryPending: Boolean(state.geometryPending),
          historyPending: Boolean(state.fullBaseHistoryPending), converting: Boolean(processNegativeInFlight),
          reprocessPending: Boolean(coreReprocessTimer || _coreReprocessFullInFlight || _coreReprocessPreviewInFlight || _coreReprocessPending),
          measuredRescue: Boolean(state.expiredAnalysis),
          entries: undoStack.slice(-3).map(entry => ({ label: entry.label, step: entry.settings?.currentStep,
            cold: Boolean(entry.refs?.cold), measuredRescue: Boolean(entry.settings?.expiredAnalysis),
            cropHit: Boolean(entry.settings?.cropDetectionToken?.hit), automatic: entry.settings?.fullBaseFrameEdit?.automatic })) }),
        edit: (key, value) => {
          if (!['semanticMap', 'rollFrame'].includes(key) || !state.loadedBaseImageData) throw new Error('Invalid bounded history input');
          const next = key === 'semanticMap' ? sanitizeSemanticMap(value) : sanitizeRollFrameForSettings(value);
          if (!next) throw new Error('Invalid history input recipe');
          pushUndo(key); state[key] = next; markCurrentFileDirty();
          scheduleSilverSourceRefresh({ immediate: true });
        },
        seedRoll: async () => {
          const sample = downsampleImageDataForMaxDim(state.loadedBaseImageData, 256);
          const histogramSettings = { ...buildCoreConversionSettings(state), borderBuffer: 15 };
          const channelData = await analyzeSilverCoreFrame(sample, histogramSettings, resolveConversionMode(state));
          const brighter = new ImageData(Uint8ClampedArray.from(sample.data, (v, i) => i % 4 === 3 ? v
            : Math.round(v * Math.pow([1.75, 2.1, 1.6][i % 4], 1 / 2.2))), sample.width, sample.height);
          const otherChannels = await analyzeSilverCoreFrame(brighter, histogramSettings, resolveConversionMode(state));
          const roll = aggregateRollAnalysis([sample, brighter, brighter].map((image, id) => ({ id,
            filmBase: state.filmBase, channelData: id ? otherChannels : channelData, negativeMean: measureNegativeMean(image, 0) })));
          state.rollFrame = sanitizeRollFrameForSettings({ rollId: 'history-measured-roll', channelData: roll.channelData,
            ...roll.frames[0], locked: true, equalize: true });
          markCurrentFileDirty(); await processNegative({ automatic: false });
          return structuredClone(state.rollFrame);
        },
        wbDiagnostic: () => {
          const sample = autoWbSampleFor(autoWbSampleKey()) || state.processedImageData;
          return estimateAutoWhiteBalance(sample, analysisRegionSample(sample, resolveAnalysisRegion(extractCurrentSettings(), baseSizeSource())));
        }
      };\n`;
      text = text.slice(0, anchor.start) + hook + text.slice(anchor.start);
      await send('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
        responseHeaders: request.responseHeaders.filter(header => !/^(content-length|etag)$/i.test(header.name)),
        body: Buffer.from(text).toString('base64') });
    })().catch(error => fail('Frozen history response: ' + error.stack));
  });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/src/app/main.js*', requestStage: 'Response' }] });
  if (head) console.log('interpretation history frozen browser control:', JSON.stringify({ head, functions: names,
    original_main_sha256: createHash('sha256').update(source).digest('hex') }));
  console.log('history input probe: controlled semantic/roll leaves; actual caller/history/PNG8/TIFF16; roll histogram sample <=256px');
  // The complete smoke run goes on to other steps: the interception, its
  // listener and the disabled cache end with the step that installed them.
  return async () => {
    unsubscribe();
    await send('Fetch.disable');
    await send('Network.setCacheDisabled', { cacheDisabled: false });
  };
}

export async function runInterpretationHistoryCropSmoke(ctx) {
  const { send, evaluate, waitFor, fail, boot, dir, file, seedRecipe, one, two, ready, status, exact,
    exportFormats, exportAllFormats, same, sameExports, formats } = ctx;
  const filename = basename(file);
  const setSlider = (id, value) => evaluate(`(() => {
    const el = document.getElementById('${id}'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.value = '${value}'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const open = async (query, recipe, staged = false) => {
    await boot(query, { holdSemantic: true });
    await evaluate(`(() => { const error = console.error; window.__historyErrors = [];
      console.error = (...args) => { window.__historyErrors.push(args.map(arg => String(arg?.stack || arg)).join(' ')); error(...args); }; })()`);
    await evaluate(`(() => { for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
      const el = document.getElementById(id); if (el.checked) el.click(); } })()`);
    if (staged) await evaluate('window.__ncTwoStage.holdFullDecodes()');
    const text = await evaluate(`(async () => {
      const { buildRollProject, serializeRollProject } = await import('/src/app/rollProject.js');
      return serializeRollProject(buildRollProject({ files: [{ name: ${JSON.stringify(filename)}, size: ${statSync(file).size}, selected: true,
        settings: ${JSON.stringify(recipe)} }] }));
    })()`);
    const project = join(dir, 'crop-interpretation-history.ncroll.json'); writeFileSync(project, text);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#projectInput' });
    await send('DOM.setFileInputFiles', { files: [project, file], nodeId: input.result.nodeId });
    if (!await waitFor('crop interpretation source', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(filename)}
      && ${staged ? `${status}.pending && !${status}.swapped` : exact}`, 150_000, { soft: true })) {
      console.log('crop history source diagnostic:', await evaluate(`JSON.stringify({ errors: window.__historyErrors, body: document.body.className,
        busy: document.body.dataset.studioBusy, detecting: document.body.dataset.studioDetecting,
        status: ${status}, converting: window.__ncAnalysis.converting() })`));
      fail('crop interpretation reference source did not settle');
    }
    same('crop history original identity', await evaluate('window.__ncTwoStage.queuedRecipes().map(item => item.name)'), [filename]);
  };
  const cases = [
    ['warm-middle-type-off', false, false, 'automatic', ['bw', 'correct'], ['positive', 'correct'], ['color', 'correct']],
    ['full-middle-type-off', true, false, 'automatic', ['bw', 'correct'], ['positive', 'correct'], ['color', 'correct']],
    ['warm-middle-mode-off', false, false, 'automatic', ['color', 'correct'], ['bw', 'edit'], ['color', 'edit']],
    ['full-middle-mode-off', true, false, 'automatic', ['color', 'correct'], ['bw', 'edit'], ['color', 'edit']],
    ['warm-middle-type-on', false, true, 'automatic', ['bw', 'correct'], ['positive', 'correct'], ['color', 'correct']],
    ['full-middle-type-on', true, true, 'automatic', ['bw', 'correct'], ['positive', 'correct'], ['color', 'correct']],
    ['warm-middle-mode-on', false, true, 'automatic', ['color', 'correct'], ['bw', 'edit'], ['color', 'edit']],
    ['full-middle-mode-on', true, true, 'automatic', ['color', 'correct'], ['bw', 'edit'], ['color', 'edit']],
    ['warm-hit-rescue-dispatch', false, true, 'automatic', ['color', 'correct'], ['bw', 'correct'], null, null, true],
    ['full-hit-rescue-dispatch', true, true, 'automatic', ['color', 'correct'], ['bw', 'correct'], null, null, true],
    ['warm-color-bw-off', false, false, 'automatic', ['color', 'correct'], ['bw', 'correct']],
    ['full-color-bw-off', true, false, 'automatic', ['color', 'correct'], ['bw', 'correct']],
    ['warm-color-mode-off', false, false, 'automatic', ['color', 'correct'], ['color', 'edit']],
    ['full-color-mode-off', true, false, 'automatic', ['color', 'correct'], ['color', 'edit']],
    ['full-positive-mode-off', true, false, 'automatic', ['positive', 'correct'], ['positive', 'edit']],
    ['full-bw-color-off', true, false, 'automatic', ['bw', 'correct'], ['color', 'correct']],
    ['full-color-bw-on', true, true, 'automatic', ['color', 'correct'], ['bw', 'correct']],
    ['full-positive-mode-on', true, true, 'automatic', ['positive', 'correct'], ['positive', 'edit']],
    ['warm-color-bw-manual', false, false, 'manual', ['color', 'correct'], ['bw', 'correct']],
    ['full-color-bw-manual', true, true, 'manual', ['color', 'correct'], ['bw', 'correct']],
    ['warm-color-bw-gray', false, false, 'gray', ['color', 'correct'], ['bw', 'correct']],
    ['full-color-bw-gray', true, true, 'gray', ['color', 'correct'], ['bw', 'correct']]
  ];
  for (const kind of ['filmBase', 'semanticMap', 'rollFrame']) for (const staged of [false, true]) for (const rescue of [false, true]) {
    cases.push([`${staged ? 'full' : 'warm'}-middle-${kind}-${rescue ? 'on' : 'off'}`, staged, rescue,
      'automatic', ['color', 'correct'], ['color', 'correct'], ['color', 'correct'], kind]);
  }
  for (const [scene, staged, rescue, ownership, before, after, middle, inputKind, hitDispatch] of cases) {
    if (process.env.NC229_HISTORY_BROWSER_CASE && !process.env.NC229_HISTORY_BROWSER_CASE.split(',').includes(scene)) continue;
    console.log('interpretation crop history scene:', scene);
    const seed = { ...seedRecipe, filmType: before[0], positiveMode: before[1], filmTypeSource: 'manual',
      coreFilmPreset: 'none', coreColorModel: 'standard', coreEnhancedProfile: 'none', coreBorderBuffer: 0,
      coreExposure: 0, filmBase: { r: 228, g: 194, b: 144, method: 'manual' }, filmBaseSet: true,
      semanticMap: null, rollFrame: null, expiredAnalysis: null, expiredEnabled: rescue,
      expiredBrightness: 17, expiredContrast: 23, expiredBrightnessUserOverride: true, expiredContrastUserOverride: true,
      wbR: 1.17, wbG: 1, wbB: .86, wbAutoConfidence: 'high', wbUserOverride: false, grayPointSampled: false, wbSemanticApplied: false };
    await open(staged && ownership !== 'gray' ? two : one, seed, staged && ownership !== 'gray');
    if (inputKind === 'rollFrame') {
      const roll = await evaluate('window.__ncHistoryInputs.seedRoll()');
      if (!roll?.locked || !roll.channelData || !(roll.offsetStops < -.5)) fail(scene + ': real measured roll histogram and negative density offset missing');
    }
    if (ownership === 'manual') {
      await setSlider('wbR', 1.42); await setSlider('wbB', .77);
    } else if (ownership === 'gray') {
      const point = await evaluate(`(() => {
        document.getElementById('studioTab-edit').click(); document.getElementById('sampleWBBtn').click();
        const gl = document.getElementById('glCanvas'), el = gl.style.display !== 'none' && gl.getBoundingClientRect().width > 0 ? gl : document.getElementById('canvas');
        const r = el.getBoundingClientRect(); return { x: r.left + r.width * .42, y: r.top + r.height * .47 };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await waitFor(scene + ' actual gray sample', `!document.getElementById('sampleWBBtn').classList.contains('active') && ${status}.settings.grayPointSampled`, 60_000);
      if (staged) await open(two, await evaluate(`${status}.settings`), true);
    }
    const initial = await evaluate(`${status}.settings`);
    if (ownership === 'manual' && !initial.wbUserOverride) fail(scene + ': real gain slider did not claim WB');
    if (ownership === 'gray' && !initial.grayPointSampled) fail(scene + ': real canvas click did not claim WB');
    await evaluate(`(() => {
      const probe = window.__interpretationCropHold = { held: [], conversionHeld: [], conversionOn: ${Boolean(hitDispatch)}, conversionCaptured: false }, post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...args) {
        if (message?.type === 'detect-crop-area' && probe.held) { probe.held.push(() => post.call(this, message, ...args)); return; }
        if (probe.conversionOn && !probe.conversionCaptured && message?.wbSample
          && window.__ncAnalysis.diagnostics()?.method === 'manual-image-window') {
          probe.conversionCaptured = true;
          probe.dispatched = { filmType: message.settings.filmType, positiveMode: message.settings.positiveMode };
          const receive = event => {
            if (!probe.conversionOn || event.data?.id !== message.id || event.data?.type !== 'result') return;
            event.stopImmediatePropagation(); this.removeEventListener('message', receive, true);
            probe.conversionHeld.push(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })));
          };
          this.addEventListener('message', receive, true);
        }
        return post.call(this, message, ...args);
      };
      probe.release = () => { const held = probe.held || []; probe.held = null; for (const deliver of held) deliver(); };
      probe.releaseConversion = () => { probe.conversionOn = false; for (const deliver of probe.conversionHeld.splice(0)) deliver(); };
      document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click();
    })()`);
    await waitFor(scene + ' draft', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
    const base = (await evaluate(status)).base;
    await evaluate(`window.__ncAnalysis.setDraftRect({ left: 0, top: 0, width: ${base.width - 2.01}, height: ${base.height - 2.01} });
      document.getElementById('applyCropBtn').click()`);
    await waitFor(scene + ' real detector held', `window.__interpretationCropHold.held.length === 1 && window.__ncAnalysis.pendingDetection()`, 60_000);
    if (hitDispatch) {
      await evaluate('window.__interpretationCropHold.release()');
      await waitFor(scene + ' real hit conversion held', `window.__interpretationCropHold.conversionHeld.length === 1`, 60_000);
      same(scene + ' immutable hit dispatch', await evaluate('window.__interpretationCropHold.dispatched'), { filmType: 'color', positiveMode: 'correct' });
    }
    if (!rescue) await waitFor(scene + ' provisional crop converted', `${ready} && !window.__ncAnalysis.converting()`, 120_000);
    const changeInterpretation = (from, to) => evaluate(`(() => {
      ${from[0] !== to[0] ? `document.querySelector('.film-type-btn[data-type="${to[0]}"]').click();` : ''}
      ${from[1] !== to[1] ? `const mode = document.getElementById('positiveModeSelect'); mode.value = '${to[1]}'; mode.dispatchEvent(new Event('change', { bubbles: true }));` : ''}
    })()`);
    const editInput = async last => {
      if (inputKind === 'filmBase') {
        await waitFor(scene + ' sampling geometry', `!window.__ncGeometry.pending()`, 60_000);
        const point = await evaluate(`(() => {
          document.getElementById('studioTab-edit').click(); document.getElementById('step2ModeBorderBtn').click();
          document.getElementById('sampleBaseBtn').click();
          const gl = document.getElementById('glCanvas'), el = gl.style.display !== 'none' && gl.getBoundingClientRect().width > 0 ? gl : document.getElementById('canvas');
          const r = el.getBoundingClientRect(); return { id: el.id, x: r.left + r.width * ${last ? .71 : .27}, y: r.top + r.height * ${last ? .63 : .31} };
        })()`);
        await waitFor(scene + ' sampler active', `document.getElementById('sampleBaseBtn').classList.contains('active')`, 60_000);
        if (rescue) {
          // Rescue awaits the held detector behind the loading overlay. Deliver
          // only the input event directly; keep the real sampler, history,
          // planes, conversion and overlay protection unchanged.
          const delivery = await evaluate(`(() => {
            const point = ${JSON.stringify(point)}, el = document.getElementById(point.id);
            const hit = document.elementFromPoint(point.x, point.y);
            const blocked = Boolean(hit?.closest('.loading-overlay.visible'));
            if (!blocked || window.__ncGeometry.pending()) throw new Error('Expected held-rescue input barrier');
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: point.x, clientY: point.y }));
            return { controlledPointerTransport: true, target: point.id, blockedBy: hit.className };
          })()`);
          console.log('interpretation history manual-base input:', JSON.stringify({ scene, last, ...delivery }));
        } else {
          const { x, y } = point;
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        }
        await waitFor(scene + ' real manual base sample', `!document.getElementById('sampleBaseBtn').classList.contains('active')`, 60_000);
      } else {
        const value = inputKind === 'semanticMap' ? { width: 2, height: 1, labels: [0, 4], confidence: last ? .8 : .95 }
          : { ...initial.rollFrame, offsetStops: initial.rollFrame.offsetStops + (last ? .7 : .35) };
        await evaluate(`window.__ncHistoryInputs.edit(${JSON.stringify(inputKind)}, ${JSON.stringify(value)})`);
      }
      if (!rescue) await waitFor(scene + ' input conversion', `${ready} && !window.__ncAnalysis.converting()`, 120_000);
      return await evaluate(`${status}.settings`);
    };
    let middleInputs, finalInputs;
    if (middle) {
      if (inputKind) middleInputs = await editInput(false);
      else await changeInterpretation(before, middle);
      await waitFor(scene + ' intermediate interpretation', `${status}.settings.filmType === '${middle[0]}' && ${status}.settings.positiveMode === '${middle[1]}'`, 30_000);
      if (!rescue) await waitFor(scene + ' intermediate conversion', `${ready} && !window.__ncAnalysis.converting()`, 120_000);
    }
    if (inputKind) {
      finalInputs = await editInput(true);
      if (JSON.stringify(middleInputs[inputKind]) === JSON.stringify(initial[inputKind])
        || JSON.stringify(finalInputs[inputKind]) === JSON.stringify(middleInputs[inputKind])) fail(scene + ': all three input recipes must differ');
    } else await changeInterpretation(middle || before, after);
    if (!middle) await setSlider('coreExposure', 15);
    await evaluate('window.__interpretationCropHold.release(); window.__interpretationCropHold.releaseConversion(); window.__ncAnalysis.settle()');
    await waitFor(scene + ' crop hit', `${ready} && !window.__ncAnalysis.converting() && window.__ncAnalysis.diagnostics()?.method === 'manual-image-window'`, 150_000);
    if (staged) {
      if (!(await evaluate(`${status}.pending && !${status}.swapped`))) fail(scene + ': lost held full source');
      await evaluate('window.__ncTwoStage.releaseFullDecodes()');
    }
    await waitFor(scene + ' exact source', `${ready} && ${exact} && !window.__ncAnalysis.converting()`, 150_000);
    const results = {};
    const diagnosticExport = async (label, phase) => {
      if (scene !== 'full-color-bw-gray') return exportFormats(label, formats);
      const before = await evaluate('window.__ncHistoryInputs.exportState()');
      const png = await exportFormats(label, [formats[0]]);
      const afterPng = await evaluate('window.__ncHistoryInputs.exportState()');
      const tiff = await exportFormats(label, [formats[1]]);
      const afterTiff = await evaluate('window.__ncHistoryInputs.exportState()');
      console.log('interpretation gray export state:', JSON.stringify({ scene, phase, before, afterPng, afterTiff }));
      return { ...png, ...tiff };
    };
    const capture = async phase => {
      console.log('interpretation crop history capture:', scene, phase);
      await evaluate('window.__ncAnalysis.settle()');
      const recipe = await evaluate(`${status}.settings`);
      if (scene === 'full-color-bw-gray' && (await evaluate('window.__ncHistoryInputs.exportState()')).spatialCurrent) fail(scene + ' ' + phase + ': exact settlement left its spatial analysis pending');
      if (hitDispatch) console.log('interpretation hit restoration:', JSON.stringify({ scene, phase,
        ...await evaluate('window.__ncHistoryInputs.restoration()') }));
      if ((middle || hitDispatch) && rescue && !recipe.expiredAnalysis) fail(scene + ' ' + phase + ': settled rescued history has no measurement before export');
      const single = await diagnosticExport(scene + ' ' + phase, phase);
      const all = await exportAllFormats(1, scene + ' ' + phase + ' batch', formats);
      const batch = Object.fromEntries(Object.entries(all).map(([key, values]) => [key, Object.values(values)[0]]));
      console.log('interpretation crop history live/batch check:', JSON.stringify({ scene, phase,
        recipe: { filmType: recipe.filmType, positiveMode: recipe.positiveMode, expiredEnabled: recipe.expiredEnabled,
          measuredRescue: Boolean(recipe.expiredAnalysis), wb: [recipe.wbR, recipe.wbG, recipe.wbB] }, single, batch }));
      sameExports(scene + ' ' + phase + ' actual single/batch', single, batch);
      if (single.png8.layout?.bits?.[0] !== 8 || single.tiff16.layout?.bits?.[0] !== 16 || !single.tiff16.lowBits) fail(scene + ': exact 8/true16 layout missing');
      const expectedInputs = inputKind ? (phase.startsWith('middle') ? middleInputs : finalInputs) : initial;
      for (const key of ['filmBase', 'semanticMap', 'rollFrame']) same(scene + ' ' + phase + ' immutable ' + key, recipe[key], expectedInputs[key]);
      same(scene + ' explicit strengths', [recipe.expiredBrightness, recipe.expiredContrast], [17, 23]);
      if (ownership !== 'automatic') same(scene + ' explicit WB', [recipe.wbR, recipe.wbG, recipe.wbB], [initial.wbR, initial.wbG, initial.wbB]);
      results[phase] = { recipe, single, batch };
    };
    if (middle) {
      for (let round = 0; round < 2; round++) {
        await evaluate(`document.getElementById('undoBtn').click(); window.__ncAnalysis.settle()`);
        await capture('middle-undo-' + round);
        await evaluate(`document.getElementById('redoBtn').click(); window.__ncAnalysis.settle()`);
        await capture('final-redo-' + round);
      }
      for (const [phase, result] of Object.entries(results)) same(scene + ' ' + phase + ' interpretation',
        [result.recipe.filmType, result.recipe.positiveMode], phase.startsWith('middle') ? middle : after);
    } else {
      await capture('live');
      await evaluate(`document.getElementById('undoBtn').click(); window.__ncAnalysis.settle()`);
      await capture('new-entry-undo');
      await evaluate(`document.getElementById('undoBtn').click(); window.__ncAnalysis.settle()`);
      await capture('old-entry-undo');
      await evaluate(`document.getElementById('redoBtn').click(); window.__ncAnalysis.settle();`);
      await capture('new-entry-redo');
      same(scene + ' old-entry interpretation', [results['old-entry-undo'].recipe.filmType, results['old-entry-undo'].recipe.positiveMode], before);
      if (rescue || before[0] !== 'color' || ownership !== 'automatic') same(scene + ' valid old WB retained',
        [results['old-entry-undo'].recipe.wbR, results['old-entry-undo'].recipe.wbG, results['old-entry-undo'].recipe.wbB], [initial.wbR, initial.wbG, initial.wbB]);
      for (const phase of ['live', 'new-entry-undo', 'new-entry-redo']) same(scene + ' new-entry interpretation',
        [results[phase].recipe.filmType, results[phase].recipe.positiveMode], after);
    }
    same(scene + ' actual caller errors', await evaluate('window.__historyErrors'), []);
    for (const [phase, result] of Object.entries(results)) {
      console.log('interpretation crop history independent reference:', scene, phase);
      const eligible = ownership === 'automatic' && !rescue && result.recipe.filmType === 'color';
      // Reproduce the event's dispatch exposure (0 for intermediate cases,
      // 15 for the original exposure-edit cases). Import/Apply that recipe
      // with the real full loader, then replay the saved control at exposure 0.
      const measurementExposure = middle ? 0 : 15;
      const recipe = { ...result.recipe, coreExposure: eligible ? measurementExposure : result.recipe.coreExposure,
        ...((middle || hitDispatch) && rescue ? { expiredAnalysis: null } : {}),
        ...(eligible ? { wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null, wbSemanticApplied: false } : {}) };
      await open(one, recipe);
      if (eligible) {
        const wb = await evaluate('window.__ncAnalysis.whiteBalance()');
        console.log('interpretation crop history reference WB:', JSON.stringify({ scene, phase, wb, rollOffset: recipe.rollFrame?.offsetStops,
          diagnostic: inputKind === 'rollFrame' ? await evaluate('window.__ncHistoryInputs.wbDiagnostic()') : null }));
        if (Math.abs(wb.wbR - 1) + Math.abs(wb.wbB - 1) < .0001) fail(scene + ': actual independent color measurement must be nonunit');
        if (result.recipe.coreExposure !== measurementExposure) { await setSlider('coreExposure', result.recipe.coreExposure); await evaluate('window.__ncAnalysis.settle()'); }
      }
      const fresh = await diagnosticExport(scene + ' ' + phase + ' independent full interpretation', 'fresh-' + phase);
      console.log('interpretation crop history comparison:', JSON.stringify({ scene, phase, actual: result.single, fresh }));
      sameExports(scene + ' ' + phase + ' independent exact samples/files', result.single, fresh);
      result.fresh = fresh;
    }
    console.log('interpretation crop history receipt:', JSON.stringify({ scene, staged, rescue, ownership, before, middle, after, inputKind, hitDispatch,
      inputLeaf: inputKind === 'semanticMap' || inputKind === 'rollFrame' ? 'controlled input; actual measured roll histogram'
        : inputKind === 'filmBase' && rescue ? 'controlled pointer transport; actual canvas sampler' : 'real UI', initial, results }));
    console.log(`ok: ${scene}: held real detector, actual callers, warm/full-swap Undo/Redo, PNG8/TIFF16 samples and bytes`);
  }
}
