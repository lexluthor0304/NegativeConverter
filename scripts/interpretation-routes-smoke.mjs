// Actual Studio recipe/current/selected and detected-film actions, followed
// by real single/batch exports. Only the semantic model is a bounded leaf;
// loaders, conversion/rescue/spatial/adjustment/encoders remain production.
export async function runInterpretationRoutesSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  const settings = `window.__ncTwoStage.status().settings`;
  const map = { width: 2, height: 1, labels: [0, 4], confidence: .95, model: 'efficientvit-b1-ade20k-v1' };
  const previous = await evaluate('performance.timeOrigin');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
  await waitFor('interpretation boot', `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!window.__ncTwoStage`);
  await installDialogAutoAccept();
  await evaluate(`(() => {
    const probe = window.__routeSemantic = { loads: 0, starts: 0, answers: 0, stops: 0 };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (/efficientvit-b1-ade20k.*\\.onnx/.test(String(input?.url || input))) {
        probe.loads++; return Promise.resolve(new Response(new Uint8Array([1]), { headers: { 'content-length': '1' } }));
      }
      return nativeFetch(input, options);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (/semanticWorker/.test(String(url))) {
          probe.starts++;
          return { onmessage: null, terminate() { probe.stops++; }, postMessage() {
            queueMicrotask(() => { if (this.onmessage) { probe.answers++; this.onmessage({ data: ${JSON.stringify(map)} }); } });
          } };
        }
        super(url, options);
      }
    };
    for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
      const el = document.getElementById(id); if (el.checked) el.click();
    }
    document.querySelector('.film-type-btn[data-type="positive"]').click();
    const label = document.getElementById('uploadExpiredBtn');
    label.addEventListener('click', event => event.preventDefault(), { once: true }); label.click();
    const revoke = URL.revokeObjectURL.bind(URL), pending = new Set();
    URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
    window.__routeDownloads = [];
    window.__routeProjectOpened = false;
    new MutationObserver(records => {
      if (records.some(record => Array.from(record.addedNodes).some(node => /Project opened:/.test(node.textContent)))) window.__routeProjectOpened = true;
    }).observe(document.getElementById('toastContainer'), { childList: true, subtree: true });
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return;
      const name = this.download, href = this.href; pending.add(href);
      window.__routeDownloads.push(fetch(href).then(r => r.arrayBuffer()).then(async bytes => {
        const u8 = new Uint8Array(bytes), fileHash = await hash(bytes);
        if (name.endsWith('.ncroll.json')) {
          const text = new TextDecoder().decode(bytes);
          window.__routeSavedProjectText = text;
          return { name, fileHash, project: JSON.parse(text) };
        }
        if (u8[0] === 137) {
          const { loadPngFile } = await import('/src/app/pngFileLoader.js');
          const image = loadPngFile(bytes);
          return { name, fileHash, samples: await hash(image.data), width: image.width, height: image.height, bits: u8[24] };
        }
        if (u8[0] === 73 && u8[1] === 73) {
          const view = new DataView(bytes), ifd = view.getUint32(4, true), tags = {};
          for (let i = 0, n = view.getUint16(ifd, true); i < n; i++) {
            const at = ifd + 2 + i * 12, tag = view.getUint16(at, true), type = view.getUint16(at + 2, true), count = view.getUint32(at + 4, true);
            const size = type === 3 ? 2 : 4, base = count * size <= 4 ? at + 8 : view.getUint32(at + 8, true);
            tags[tag] = Array.from({ length: count }, (_, k) => type === 3 ? view.getUint16(base + k * 2, true) : view.getUint32(base + k * 4, true));
          }
          const raw = new Uint8Array(tags[279].reduce((sum, size) => sum + size, 0));
          let at = 0; tags[273].forEach((offset, i) => { raw.set(u8.subarray(offset, offset + tags[279][i]), at); at += tags[279][i]; });
          let lowBits = 0; for (let i = 0; i < raw.length; i += 2) if ((raw[i] + raw[i + 1] * 256) % 257) lowBits++;
          return { name, fileHash, samples: await hash(raw), width: tags[256][0], height: tags[257][0], bits: tags[258][0], lowBits };
        }
        return { name, fileHash, unknown: true };
      }).finally(() => { pending.delete(href); revoke(href); }));
    };
  })()`);
  await evaluate(`(async () => {
    const { encodePng16Blob } = await import('/src/app/exportImageEncoders.js');
    const width = 128, height = 96, data16 = new Uint16Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4, value = 9000 + ((x * 71 + y * 157) % 35000);
      for (let c = 0; c < 3; c++) data16[at + c] = Math.min(65535, Math.round(value * (x < width / 2 ? [1.25, 1, .8] : [.7, 1.15, .85])[c]));
      data16[at + 3] = 65535;
    }
    const image = new ImageData(Uint8ClampedArray.from(data16, v => v >>> 8), width, height);
    image.__image16 = { width, height, data: data16 };
    const blob = encodePng16Blob(image);
    window.__routeFiles = ['current', 'selected', 'unopened'].map(name => new File([blob], 'route-' + name + '.png', { type: 'image/png', lastModified: 1 }));
    window.__routeOriginalFiles = window.__routeFiles.slice();
    const donor = new ImageData(Uint8ClampedArray.from(image.data, (v, i) => i % 4 === 3 ? v : Math.round(v * .7)), width, height);
    donor.__image16 = { width, height, data: Uint16Array.from(data16, (v, i) => i % 4 === 3 ? v : Math.round(v * .7)) };
    window.__routeDonorFile = new File([encodePng16Blob(donor)], 'route-current.png', { type: 'image/png', lastModified: 1 });
    const dt = new DataTransfer(); dt.items.add(window.__routeFiles[0]);
    const input = document.getElementById('fileInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('completed original anchors and rescue', `${ready} && ${settings}?.semanticMap && ${settings}.expiredAnalysis?.spatial
    && !window.__ncTwoStage.status().semanticPending`, 120000);
  const old = await evaluate(settings);
  const probe = await evaluate('window.__routeSemantic');
  if (Object.values(probe).some(v => v !== 1)) fail('semantic leaf did not complete exactly once: ' + JSON.stringify(probe));
  await evaluate(`window.__routeOld = ${JSON.stringify(old)}`);
  // A saved project restores valid completed analysis while offering a B&W
  // edge detection; the Apply detected film button is the production writer.
  const openProject = async (values, all = true) => {
    await evaluate(`(async () => {
      const { buildRollProject, serializeRollProject } = await import('/src/app/rollProject.js');
      window.__routeProjectOpened = false;
      const files = window.__routeFiles.slice(0, ${all ? 3 : 1});
      const values = ${JSON.stringify(values)};
      const entries = files.map((file, i) => ({ name: file.name, size: file.size, selected: true,
        settings: values[i] || null, lastModified: file.lastModified }));
      const project = new File([serializeRollProject(buildRollProject({ files: entries }))], 'routes.ncroll.json', { type: 'application/json' });
      const dt = new DataTransfer(); for (const file of files) dt.items.add(file); dt.items.add(project);
      const input = document.getElementById('projectInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('saved project source restored', `window.__routeProjectOpened && ${ready}
      && document.getElementById('studioFilename').textContent === window.__routeFiles[0].name
      && ${settings}?.expiredAnalysis?.spatial`, 120000);
    await evaluate('window.__ncAnalysis.settle()');
    await wait(600);
  };
  const saved = { ...old, filmEdge: { checked: true, found: true, filmKind: 'bw', shortName: 'B&W' } };
  await openProject([saved, old, null]);
  const restored = await evaluate(settings);
  if (JSON.stringify(restored.semanticMap) !== JSON.stringify(old.semanticMap)
    || JSON.stringify(restored.expiredAnalysis) !== JSON.stringify(old.expiredAnalysis)) fail('saved same-interpretation analysis was discarded');

  const applyRecipe = async (patch, selected = false) => {
    await evaluate(`(async () => {
      const { encodeRecipe } = await import('/src/app/recipes.js');
      const box = document.getElementById('recipeCode'); box.value = encodeRecipe(${JSON.stringify(patch)});
      box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('recipeDecodeBtn').click();
      document.getElementById('${selected ? 'recipeApplySelectedBtn' : 'recipeApplyBtn'}').click();
    })()`);
  };
  const measured = async (label, type, mode = 'correct') => {
    await waitFor(label, `${ready} && ${settings}.filmType === '${type}' && ${settings}.positiveMode === '${mode}'
      && !${settings}.semanticMap && ${settings}.expiredAnalysis?.spatial`, 120000);
    await evaluate('window.__ncAnalysis.settle()');
    return evaluate(settings);
  };
  const exports = async (label, batch = false) => {
    const result = {};
    for (const [format, depth] of [['png', 8], ['tiff', 16]]) {
      await evaluate(`(() => {
        document.querySelector('.format-btn[data-format="${format}"]').click();
        document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
        window.__routeDownloads.length = 0; document.getElementById('${batch ? 'exportAllBtn' : 'exportSingleBtn'}').click();
      })()`);
      await waitFor(label + ' ' + format, `window.__routeDownloads.length === ${batch ? 3 : 1}`, 120000);
      const downloads = await evaluate('Promise.all(window.__routeDownloads)');
      await waitFor(label + ' export idle', ready, 120000);
      for (const entry of downloads) {
        if (entry.unknown || entry.width !== 128 || entry.height !== 96 || entry.bits !== depth || (depth === 16 && !entry.lowBits)) fail('export lost samples/precision: ' + JSON.stringify(entry));
      }
      result[format] = downloads;
    }
    console.log(label + ':', JSON.stringify(result));
    return result;
  };
  const equalExports = (a, b, label, exactBytes = true) => {
    for (const format of ['png', 'tiff']) if (a[format][0].samples !== b[format][0].samples
      || (exactBytes && a[format][0].fileHash !== b[format][0].fileHash)) fail(label + ': ' + format + ' samples or exact file bytes differ');
  };
  const patch = { filmType: 'bw', wbR: 1.23, wbG: 1, wbB: .91, wbUserOverride: true,
    expiredBrightness: old.expiredBrightness, expiredContrast: 0, expiredNeutralize: 61, coreExposure: 19 };
  await applyRecipe(patch);
  const current = await measured('current recipe remeasured', 'bw');
  for (const key of ['wbR', 'wbG', 'wbB', 'expiredBrightness', 'expiredContrast', 'expiredNeutralize', 'coreExposure']) {
    if (current[key] !== patch[key]) fail('current recipe explicit value lost: ' + key);
  }
  if (JSON.stringify(current.expiredAnalysis) === JSON.stringify(old.expiredAnalysis)) fail('current recipe retained the old measurement');
  const first = await exports('current recipe');
  equalExports(first, await exports('consecutive current recipe'), 'consecutive current exports');
  await applyRecipe(patch, true);
  const queued = await evaluate('window.__ncTwoStage.queuedRecipes()');
  for (const item of queued.slice(1)) {
    // The thumbnail lane may already have measured this new interpretation.
    // Require no old anchors/measurement, then verify its real batch pixels.
    const stale = item.settings?.expiredAnalysis && JSON.stringify(item.settings.expiredAnalysis) === JSON.stringify(old.expiredAnalysis);
    if (item.settings?.semanticMap || stale || (item.settings?.filmType !== 'bw' && item.pendingEdits?.filmType !== 'bw')) {
      fail('selected recipe retained old analysis or lost interpretation: ' + JSON.stringify({ name: item.name,
        filmType: item.settings?.filmType, pendingType: item.pendingEdits?.filmType, anchors: Boolean(item.settings?.semanticMap), stale }));
    }
  }
  const batch = await exports('selected recipe batch', true);
  equalExports(first, batch, 'current single vs real batch', false);
  const batchSettings = await evaluate('window.__ncTwoStage.queuedRecipes()');
  console.log('selected recipe settings differences:', JSON.stringify(batchSettings.slice(1).map(item => ({ name: item.name,
    values: Object.fromEntries(Object.keys(item.settings || {}).filter(key => !['semanticMap', 'expiredAnalysis', 'curves'].includes(key)
      && JSON.stringify(item.settings[key]) !== JSON.stringify(current[key])).map(key => [key, { current: current[key], selected: item.settings[key] }])),
    analysis: item.settings?.expiredAnalysis ? { method: item.settings.expiredAnalysis.method, confidence: item.settings.expiredAnalysis.confidence,
      interpretation: item.settings.expiredAnalysis.interpretation, spatial: Boolean(item.settings.expiredAnalysis.spatial) } : null
  }))));
  for (const format of ['png', 'tiff']) if (batch[format][1].samples !== first[format][0].samples) {
    fail('saved selected remeasurement differs from fresh current: ' + JSON.stringify(batch[format][1]));
  }
  const unopened = batchSettings[2].settings;
  for (const key of ['wbR', 'wbG', 'wbB', 'expiredBrightness', 'expiredContrast', 'expiredNeutralize', 'coreExposure']) {
    if (unopened?.[key] !== patch[key]) fail('unopened recipe explicit value lost: ' + key);
  }
  if (!unopened.expiredAnalysis || unopened.semanticMap || JSON.stringify(unopened.expiredAnalysis) === JSON.stringify(old.expiredAnalysis)) {
    fail('unopened export did not retain a measurement of its new interpretation');
  }
  await evaluate('document.getElementById("undoBtn").click()');
  await waitFor('recipe undo restores completed old anchors', `${ready} && ${settings}.filmType === 'positive' && !!${settings}.semanticMap`);
  const undone = await evaluate(settings);
  if (JSON.stringify(undone.expiredAnalysis) !== JSON.stringify(old.expiredAnalysis)) fail('recipe undo lost corresponding old measurement');
  await applyRecipe({ positiveMode: 'edit', wbR: 1.23, wbB: .91, wbUserOverride: true, expiredBrightness: 17, expiredContrast: 0 });
  const mode = await measured('positive-mode recipe remeasured', 'positive', 'edit');
  await evaluate('document.getElementById("undoBtn").click()');
  await waitFor('mode undo restores completed old anchors', `${ready} && ${settings}.positiveMode === 'correct' && !!${settings}.semanticMap`);
  await evaluate('document.getElementById("redoBtn").click()');
  const redone = await measured('mode redo preserves new measurement', 'positive', 'edit');
  if (JSON.stringify(redone.expiredAnalysis) !== JSON.stringify(mode.expiredAnalysis)) fail('mode redo discarded valid new measurement');
  await evaluate('document.getElementById("undoBtn").click()');
  await waitFor('detected film old completed anchors', `${ready} && ${settings}.positiveMode === 'correct' && !!${settings}.semanticMap`);
  await evaluate('document.getElementById("applyFilmEdgePresetBtn").click()');
  const detected = await measured('actual detected film action remeasured', 'bw');
  const detectedExports = await exports('detected film');
  equalExports(detectedExports, await exports('consecutive detected film'), 'detected consecutive exports');
  // Fresh stored recipe of the new interpretation, with no prior anchors or
  // rescue, is the reference for the exact actual single-export path.
  await openProject([{ ...detected, semanticMap: null, expiredAnalysis: null }], false);
  const fresh = await evaluate(settings);
  if (JSON.stringify(fresh.expiredAnalysis) !== JSON.stringify(detected.expiredAnalysis)) fail('detected action differs from fresh new-interpretation rescue');
  equalExports(detectedExports, await exports('fresh detected interpretation reference'), 'detected vs fresh new-interpretation reference');
  // Fresh tiles may prepare a new, valid measurement before batch starts.
  // Exports adopt that recipe rather than replacing it with the full-frame
  // measurement. Check both contracts with the identical decoded source:
  // restore its corresponding saved recipe, then measure it fresh at full
  // resolution without the prepared measurement. No old analysis is reused.
  await openProject([unopened], false);
  const reopened = await evaluate(settings);
  if (JSON.stringify(reopened.expiredAnalysis) !== JSON.stringify(unopened.expiredAnalysis)) fail('unopened corresponding saved measurement discarded');
  const unopenedReference = await exports('unopened corresponding saved reference');
  for (const format of ['png', 'tiff']) if (unopenedReference[format][0].samples !== batch[format][2].samples) {
    fail('unopened actual batch differs from its corresponding saved reference: ' + format);
  }
  equalExports(unopenedReference, await exports('consecutive unopened saved reference'), 'unopened restored consecutive exports');
  await openProject([{ ...unopened, expiredAnalysis: null }], false);
  const unopenedFresh = await evaluate(settings);
  if (JSON.stringify(unopenedFresh.expiredAnalysis) !== JSON.stringify(current.expiredAnalysis)) fail('unopened fresh full-source remeasurement differs from current recipe');
  // The unopened photo has its own edge/detection metadata embedded in the
  // files. Decoded PNG8/TIFF16 samples must match; corresponding consecutive
  // exports above also require identical complete encoded files.
  equalExports(first, await exports('unopened fresh full-source reference'), 'unopened fresh full-source reference', false);
  console.log('ok: actual current/selected/mode recipes and detected-film action invalidate completed analysis; PNG8/TIFF16 consecutive, saved-selected single/batch and fresh full-source reference samples exact; unopened corresponding measurement, saved restoration and Undo/Redo preserved');

  const saveProject = async label => {
    await evaluate('window.__routeDownloads.length = 0; document.getElementById("studioSaveProject").click()');
    await waitFor(label + ' saved', 'window.__routeDownloads.length === 1', 120000);
    const [download] = await evaluate('Promise.all(window.__routeDownloads)');
    if (!download.project) fail(label + ': actual project save did not produce a project');
    return download.project;
  };
  const reopenSavedProject = async label => {
    const before = await evaluate('window.__ncTwoStage.status().settings');
    await evaluate(`(() => {
      window.__routeProjectOpened = false;
      const project = new File([window.__routeSavedProjectText], 'saved.ncroll.json', { type: 'application/json' });
      const dt = new DataTransfer(); for (const file of window.__routeFiles) dt.items.add(file); dt.items.add(project);
      const input = document.getElementById('projectInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(label + ' reopened', `window.__routeProjectOpened && ${ready} && ${settings}.filmType === '${before.filmType}' && ${settings}.positiveMode === '${before.positiveMode}'
      && ${settings}.expiredAnalysis?.spatial`, 120000);
    await evaluate('window.__ncAnalysis.settle()');
  };
  const equalRecipient = (batchResult, singleResult, label) => {
    for (const format of ['png', 'tiff']) if (batchResult[format][1].samples !== singleResult[format][0].samples) {
      fail(label + ': decoded ' + format + ' samples differ');
    }
    console.log(label + ': exact decoded PNG8/TIFF16 samples; encoded metadata hashes', JSON.stringify(
      Object.fromEntries(['png', 'tiff'].map(format => [format, { batch: batchResult[format][1].fileHash, single: singleResult[format][0].fileHash }]))));
  };
  for (const action of ['applyToSelectedBtn', 'applyRollReferenceBtn', 'import-lock']) for (const modeOnly of [false, true]) {
    const label = action + ' ' + (modeOnly ? 'mode' : 'type');
    await evaluate('window.__routeFiles = [window.__routeDonorFile, ...window.__routeOriginalFiles.slice(1)]');
    const donorRecipe = { ...old, filmType: modeOnly ? 'positive' : 'bw', positiveMode: modeOnly ? 'edit' : 'correct',
      semanticMap: null, expiredAnalysis: null, wbR: 1.23, wbG: 1, wbB: .91, wbUserOverride: true,
      expiredBrightness: 0, expiredContrast: 25, expiredBrightnessUserOverride: true, expiredContrastUserOverride: true };
    await openProject([donorRecipe, old, old], action !== 'import-lock');
    const donorSettings = await measured(label + ' donor measured', donorRecipe.filmType, donorRecipe.positiveMode);
    if (action !== 'applyToSelectedBtn') {
      await evaluate('document.getElementById("setRollReferenceBtn").click()');
      await wait(300);
    }
    if (action === 'import-lock') {
      await evaluate(`(() => {
        const lock = document.getElementById('lockRollReference'); if (!lock.checked) lock.click();
        const dt = new DataTransfer(); for (const file of window.__routeFiles.slice(1)) dt.items.add(file);
        const click = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {
          if (this.type === 'file' && this.onchange) {
            this.files = dt.files; this.dispatchEvent(new Event('change', { bubbles: true }));
          } else click.call(this);
        };
        try { document.getElementById('addMoreFilesBtn').click(); }
        finally { HTMLInputElement.prototype.click = click; }
      })()`);
      await waitFor(label + ' imports copied', 'window.__ncTwoStage.queuedRecipes().length === 3', 120000);
    } else await evaluate(`document.getElementById('${action}').click()`);
    await waitFor(label + ' copied', `window.__ncTwoStage.queuedRecipes().slice(1).every(item => item.settings?.filmType === '${donorRecipe.filmType}'
      && item.settings.positiveMode === '${donorRecipe.positiveMode}' && !item.settings.semanticMap)`, 120000);
    const copiedRecipes = await evaluate('window.__ncTwoStage.queuedRecipes()');
    for (const item of copiedRecipes.slice(1)) {
      if (item.settings.expiredAnalysis && JSON.stringify(item.settings.expiredAnalysis) === JSON.stringify(donorSettings.expiredAnalysis)) {
        fail(label + ': donor measurement transferred to recipient');
      }
      for (const key of ['wbR', 'wbG', 'wbB', 'expiredBrightness', 'expiredContrast']) {
        if (item.settings[key] !== donorRecipe[key]) fail(label + ': copied explicit value lost: ' + key);
      }
    }
    const copiedBatch = await exports(label + ' real batch', true);
    const savedCopy = await saveProject(label);
    const recipient = savedCopy.files[1].settings;
    if (!recipient.expiredBrightnessUserOverride || !recipient.expiredContrastUserOverride) fail(label + ': saved copy lost explicit ownership');
    // Reopen the actually saved project, then compare the recipient to its
    // single-export path using identical source/settings/measurement.
    await reopenSavedProject(label);
    await evaluate('window.__routeFiles = [window.__routeOriginalFiles[1]]');
    await openProject([recipient], false);
    const recipientSingle = await exports(label + ' saved recipient single');
    equalRecipient(copiedBatch, recipientSingle, label + ' saved single/batch');
    equalExports(recipientSingle, await exports(label + ' consecutive recipient single'), label + ' consecutive recipient');
    const prepared = await evaluate(settings);
    if (JSON.stringify(prepared.expiredAnalysis) === JSON.stringify(donorSettings.expiredAnalysis)) fail(label + ': recipient failed to measure its own pixels');
    await openProject([{ ...recipient, semanticMap: null, expiredAnalysis: null }], false);
    const freshRecipient = await exports(label + ' fresh recipient reference');
    equalExports(recipientSingle, freshRecipient, label + ' fresh recipient reference');
  }
  // Save through the actual Studio command, read the downloaded project,
  // reopen through the file input, then retype without supplying strengths.
  for (const modeOnly of [false, true]) for (const defaults of [false, true]) {
    const label = 'saved explicit ' + (modeOnly ? 'mode' : 'type') + ' ' + (defaults ? 'defaults' : 'measured-equal');
    await evaluate('window.__routeFiles = window.__routeOriginalFiles.slice(0, 1)');
    await openProject([old], false);
    const values = defaults ? { expiredBrightness: 0, expiredContrast: 25 }
      : await evaluate(`(async () => { const { defaultExpiredRescueParams } = await import('/src/pipeline/expiredRescue.js');
        const auto = defaultExpiredRescueParams(${settings}.expiredAnalysis); return { expiredBrightness: auto.expiredBrightness, expiredContrast: auto.expiredContrast }; })()`);
    await evaluate(`(() => {
      for (const [key, value] of Object.entries(${JSON.stringify(values)})) {
        const input = document.getElementById(key + 'Value'); input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    })()`);
    await evaluate('window.__ncAnalysis.settle()');
    const before = await exports(label + ' before save');
    const savedProject = await saveProject(label);
    for (const key of ['expiredBrightnessUserOverride', 'expiredContrastUserOverride']) if (!savedProject.files[0].settings[key]) fail(label + ': actual save omitted ' + key);
    await reopenSavedProject(label);
    equalExports(before, await exports(label + ' reopened'), label + ' exact saved exports');
    const retype = modeOnly ? { positiveMode: 'edit' } : { filmType: 'bw' };
    await applyRecipe(retype);
    const changed = await measured(label + ' remeasured', modeOnly ? 'positive' : 'bw', modeOnly ? 'edit' : 'correct');
    for (const [key, value] of Object.entries(values)) if (changed[key] !== value) fail(label + ': retype lost ' + key);
    const after = await exports(label + ' retyped');
    await evaluate('document.getElementById("undoBtn").click()');
    await waitFor(label + ' undo', `${ready} && ${settings}.filmType === 'positive' && ${settings}.positiveMode === 'correct' && !!${settings}.semanticMap`);
    equalExports(before, await exports(label + ' undone'), label + ' undo exact saved exports');
    await evaluate('document.getElementById("redoBtn").click()');
    const redoneCopy = await measured(label + ' redo', changed.filmType, changed.positiveMode);
    if (JSON.stringify(redoneCopy.expiredAnalysis) !== JSON.stringify(changed.expiredAnalysis)) fail(label + ': redo lost valid new measurement');
    equalExports(after, await exports(label + ' redone'), label + ' redo exact exports');
    await openProject([{ ...changed, expiredAnalysis: null }], false);
    equalExports(after, await exports(label + ' fresh saved-strength reference'), label + ' exact fresh reference');
  }
  console.log('ok: both full-settings buttons and import lock remeasure recipient type/mode; actual project save/reopen retains measured-equal/default strength intent and valid history; strict PNG8/TIFF16 single/batch/fresh samples and corresponding encoded files');
}
