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
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return;
      const name = this.download, href = this.href; pending.add(href);
      window.__routeDownloads.push(fetch(href).then(r => r.arrayBuffer()).then(async bytes => {
        const u8 = new Uint8Array(bytes), fileHash = await hash(bytes);
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
      const files = window.__routeFiles.slice(0, ${all ? 3 : 1});
      const values = ${JSON.stringify(values)};
      const entries = files.map((file, i) => ({ name: file.name, size: file.size, selected: true,
        settings: values[i] || null, lastModified: file.lastModified }));
      const project = new File([serializeRollProject(buildRollProject({ files: entries }))], 'routes.ncroll.json', { type: 'application/json' });
      const dt = new DataTransfer(); for (const file of files) dt.items.add(file); dt.items.add(project);
      const input = document.getElementById('projectInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('saved project source restored', `${ready} && document.getElementById('studioFilename').textContent === 'route-current.png'
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
    if (item.settings?.semanticMap || item.settings?.expiredAnalysis || (item.settings?.filmType !== 'bw' && item.pendingEdits?.filmType !== 'bw')) fail('selected recipe retained old analysis or lost interpretation: ' + JSON.stringify(item));
  }
  const batch = await exports('selected recipe batch', true);
  equalExports(first, batch, 'current single vs real batch', false);
  for (const format of ['png', 'tiff']) for (const entry of batch[format]) {
    if (entry.samples !== first[format][0].samples) fail('selected/unopened remeasurement differs from fresh current: ' + JSON.stringify(entry));
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
  console.log('ok: actual current/selected/mode recipes and detected-film action invalidate completed analysis; PNG8/TIFF16 consecutive, single/batch and fresh-reference samples exact; saved restoration and Undo/Redo preserve valid analysis');
}
