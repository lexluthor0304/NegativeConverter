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
  if (!head) return;
  if (!/^[a-f0-9]{40}$/.test(head)) fail('Invalid immutable history control head');
  const source = execFileSync('git', ['show', `${head}:negative2positive/src/app/main.js`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
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
  onCdpEvent(message => {
    if (message.method !== 'Fetch.requestPaused' || message.sessionId) return;
    void (async () => {
      const request = message.params;
      const response = await send('Fetch.getResponseBody', { requestId: request.requestId });
      let text = response.result.base64Encoded ? Buffer.from(response.result.body, 'base64').toString() : response.result.body;
      const compiled = functions(text), replacements = [];
      for (const name of names) {
        const current = compiled.get(name), old = original.get(name);
        if (!current || !old) throw new Error(`Frozen history function absent: ${name}; url=${request.request.url}; status=${request.responseStatusCode}; bytes=${text.length}; start=${text.slice(0, 120)}`);
        replacements.push({ start: current.start, end: current.end, body: source.slice(old.start, old.end) });
      }
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replacement.start) + replacement.body + text.slice(replacement.end);
      await send('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
        responseHeaders: request.responseHeaders.filter(header => !/^(content-length|etag)$/i.test(header.name)),
        body: Buffer.from(text).toString('base64') });
    })().catch(error => fail('Frozen history response: ' + error.stack));
  });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/src/app/main.js*', requestStage: 'Response' }] });
  console.log('interpretation history frozen browser control:', JSON.stringify({ head, functions: names,
    original_main_sha256: createHash('sha256').update(source).digest('hex') }));
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
  for (const [scene, staged, rescue, ownership, before, after] of cases) {
    if (process.env.NC229_HISTORY_BROWSER_CASE && scene !== process.env.NC229_HISTORY_BROWSER_CASE) continue;
    console.log('interpretation crop history scene:', scene);
    const seed = { ...seedRecipe, filmType: before[0], positiveMode: before[1], filmTypeSource: 'manual',
      coreFilmPreset: 'none', coreColorModel: 'standard', coreEnhancedProfile: 'none', coreBorderBuffer: 0,
      coreExposure: 0, filmBase: { r: 228, g: 194, b: 144, method: 'manual' }, filmBaseSet: true,
      semanticMap: null, rollFrame: null, expiredAnalysis: null, expiredEnabled: rescue,
      expiredBrightness: 17, expiredContrast: 23, expiredBrightnessUserOverride: true, expiredContrastUserOverride: true,
      wbR: 1.17, wbG: 1, wbB: .86, wbAutoConfidence: 'high', wbUserOverride: false, grayPointSampled: false, wbSemanticApplied: false };
    await open(staged && ownership !== 'gray' ? two : one, seed, staged && ownership !== 'gray');
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
      const probe = window.__interpretationCropHold = { held: [] }, post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...args) {
        if (message?.type === 'detect-crop-area' && probe.held) { probe.held.push(() => post.call(this, message, ...args)); return; }
        return post.call(this, message, ...args);
      };
      probe.release = () => { const held = probe.held; probe.held = null; for (const deliver of held) deliver(); };
      document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click();
    })()`);
    await waitFor(scene + ' draft', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
    const base = (await evaluate(status)).base;
    await evaluate(`window.__ncAnalysis.setDraftRect({ left: 0, top: 0, width: ${base.width - 2.01}, height: ${base.height - 2.01} });
      document.getElementById('applyCropBtn').click()`);
    await waitFor(scene + ' real detector held', `window.__interpretationCropHold.held.length === 1 && window.__ncAnalysis.pendingDetection()`, 60_000);
    if (!rescue) await waitFor(scene + ' provisional crop converted', `${ready} && !window.__ncAnalysis.converting()`, 120_000);
    await evaluate(`(() => {
      ${before[0] !== after[0] ? `document.querySelector('.film-type-btn[data-type="${after[0]}"]').click();` : ''}
      ${before[1] !== after[1] ? `const mode = document.getElementById('positiveModeSelect'); mode.value = '${after[1]}'; mode.dispatchEvent(new Event('change', { bubbles: true }));` : ''}
    })()`);
    await setSlider('coreExposure', 15);
    await evaluate('window.__interpretationCropHold.release(); window.__ncAnalysis.settle()');
    await waitFor(scene + ' crop hit', `${ready} && !window.__ncAnalysis.converting() && window.__ncAnalysis.diagnostics()?.method === 'manual-image-window'`, 150_000);
    if (staged) {
      if (!(await evaluate(`${status}.pending && !${status}.swapped`))) fail(scene + ': lost held full source');
      await evaluate('window.__ncTwoStage.releaseFullDecodes()');
    }
    await waitFor(scene + ' exact source', `${ready} && ${exact} && !window.__ncAnalysis.converting()`, 150_000);
    const results = {};
    const capture = async phase => {
      console.log('interpretation crop history capture:', scene, phase);
      await evaluate('window.__ncAnalysis.settle()');
      const recipe = await evaluate(`${status}.settings`);
      const single = await exportFormats(scene + ' ' + phase, formats);
      const all = await exportAllFormats(1, scene + ' ' + phase + ' batch', formats);
      const batch = Object.fromEntries(Object.entries(all).map(([key, values]) => [key, Object.values(values)[0]]));
      sameExports(scene + ' ' + phase + ' actual single/batch', single, batch);
      if (single.png8.layout?.bits?.[0] !== 8 || single.tiff16.layout?.bits?.[0] !== 16 || !single.tiff16.lowBits) fail(scene + ': exact 8/true16 layout missing');
      same(scene + ' manual base', recipe.filmBase, initial.filmBase);
      same(scene + ' explicit strengths', [recipe.expiredBrightness, recipe.expiredContrast], [17, 23]);
      if (ownership !== 'automatic') same(scene + ' explicit WB', [recipe.wbR, recipe.wbG, recipe.wbB], [initial.wbR, initial.wbG, initial.wbB]);
      results[phase] = { recipe, single, batch };
    };
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
    for (const [phase, result] of Object.entries(results)) {
      console.log('interpretation crop history independent reference:', scene, phase);
      const eligible = ownership === 'automatic' && !rescue && result.recipe.filmType === 'color';
      // The event converted at exposure 15. Import/Apply that immutable recipe
      // with the real full loader, then replay the saved control at exposure 0.
      const recipe = { ...result.recipe, coreExposure: eligible ? 15 : result.recipe.coreExposure,
        ...(eligible ? { wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null, wbSemanticApplied: false, semanticMap: null } : {}) };
      await open(one, recipe);
      if (eligible) {
        const wb = await evaluate('window.__ncAnalysis.whiteBalance()');
        if (Math.abs(wb.wbR - 1) + Math.abs(wb.wbB - 1) < .0001) fail(scene + ': actual independent color measurement must be nonunit');
        if (result.recipe.coreExposure !== 15) { await setSlider('coreExposure', result.recipe.coreExposure); await evaluate('window.__ncAnalysis.settle()'); }
      }
      const fresh = await exportFormats(scene + ' ' + phase + ' independent full interpretation', formats);
      console.log('interpretation crop history comparison:', JSON.stringify({ scene, phase, actual: result.single, fresh }));
      sameExports(scene + ' ' + phase + ' independent exact samples/files', result.single, fresh);
      result.fresh = fresh;
    }
    console.log('interpretation crop history receipt:', JSON.stringify({ scene, staged, rescue, ownership, before, after, initial, results }));
    console.log(`ok: ${scene}: held real detector, real type/mode/WB/gray callers, warm/full-swap Undo/Redo, PNG8/TIFF16 samples and bytes`);
  }
}
