// Technical-depth smoke: a 16-bit export with Step-3 adjustments carries real
// 16-bit samples (thousands of levels per channel), and the linear DNG export
// writes a LinearRaw file with the DNG tags.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseTiff, TIFF_TAGS } from '../negative2positive/src/workers/tiffWriter.js';
import { DNG_TAGS, PHOTOMETRIC_LINEAR_RAW } from '../negative2positive/src/app/linearDng.js';

const UPNG = createRequire(import.meta.url)('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

async function installDownloadCapture(evaluate) {
  await evaluate(`(() => {
    window.__downloads = [];
    const pendingUrls = new Set();
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { if (!pendingUrls.has(url)) origRevoke(url); };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        const href = this.href; const name = this.download;
        pendingUrls.add(href);
        window.__downloads.push(fetch(href).then((r) => r.blob()).then((blob) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => { pendingUrls.delete(href); origRevoke(href); resolve({ name, type: blob.type, dataUrl: reader.result }); };
          reader.readAsDataURL(blob);
        })));
      }
    };
    return true;
  })()`);
}

async function takeDownload(evaluate, waitFor, description) {
  await waitFor(description, `window.__downloads.length > 0`, 120_000);
  const entry = await evaluate(`window.__downloads.shift()`);
  return { name: entry.name, type: entry.type, bytes: new Uint8Array(Buffer.from(entry.dataUrl.split(',')[1], 'base64')) };
}

// Distinct 16-bit values per channel over the middle row of a decoded PNG.
function levelsPerChannel(png) {
  if (png.depth !== 16) return null;
  const channels = png.ctype === 6 ? 4 : png.ctype === 2 ? 3 : 1;
  const rowBytes = png.width * channels * 2;
  const y = png.height >> 1;
  const row = new Uint8Array(png.data.buffer, png.data.byteOffset + y * rowBytes, rowBytes);
  const sets = [new Set(), new Set(), new Set()];
  for (let x = 0; x < png.width; x++) {
    for (let c = 0; c < 3; c++) {
      const o = (x * channels + c) * 2;
      sets[c].add((row[o] << 8) | row[o + 1]);
    }
  }
  return sets.map((s) => s.size);
}

export async function runTechnicalDepthSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-gradient-16.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('technical workspace boot', `!!document.getElementById('fileInput') && !!document.querySelector('.format-btn[data-format="dng"]')`);
  await installDialogAutoAccept();
  await installDownloadCapture(evaluate);
  await wait(300);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  await waitFor('16-bit negative converted', `${ready} && document.getElementById('studioFilename').textContent === 'negative-gradient-16.png'`, 150_000);
  await wait(800);

  // ---- 1. True 16-bit: cyan shift + a curve edit, exported as 16-bit PNG. ----
  const setSlider = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioMore').open = true;`);
  await setSlider('cyan', '15');
  await wait(300);
  await setSlider('coreExposure', '12');
  await waitFor('adjustments applied', `document.getElementById('coreExposureValue').value === '12'`, 10_000);
  await wait(1500);
  const note = await evaluate(`!!document.getElementById('exportBitDepthDowngradeNote')`);
  if (note) fail('the 8-bit-data warning must be gone: the export is true 16-bit now');
  await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click();`);
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  const png16 = await takeDownload(evaluate, waitFor, '16-bit PNG captured');
  const decoded = UPNG.decode(png16.bytes.buffer.slice(png16.bytes.byteOffset, png16.bytes.byteOffset + png16.bytes.byteLength));
  const levels = levelsPerChannel(decoded);
  console.log('technical 16-bit export:', JSON.stringify({ name: png16.name, depth: decoded.depth, ctype: decoded.ctype, levels }));
  if (!/_16bit\.png$/.test(png16.name)) fail('16-bit export is not named as such: ' + png16.name);
  if (decoded.depth !== 16 || !levels) fail('export is not a 16-bit PNG');
  // 8-bit data widened to 16 bits could never exceed 256 distinct values on a row.
  if (!levels.every((n) => n > 320)) fail('16-bit export with adjustments holds too few levels per channel (8-bit data?): ' + JSON.stringify(levels));

  // ---- 2. Linear DNG: LinearRaw, 16-bit RGB, DNG tags, named _linear.dng. ----
  await evaluate(`document.querySelector('.format-btn[data-format="dng"]').click()`);
  const ui = await evaluate(`({ bitDepthHidden: getComputedStyle(document.getElementById('exportBitDepthSection')).display === 'none', label: document.getElementById('exportSingleBtn').textContent, sprocketDisabled: document.getElementById('exportSprocketBtn').disabled, note: getComputedStyle(document.getElementById('exportDngNote')).display !== 'none' })`);
  if (!ui.bitDepthHidden || !/DNG/.test(ui.label) || !ui.sprocketDisabled || !ui.note) fail('DNG export UI wrong: ' + JSON.stringify(ui));
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  const dng = await takeDownload(evaluate, waitFor, 'DNG captured');
  const { ifd0 } = parseTiff(dng.bytes);
  const tags = { photometric: ifd0[TIFF_TAGS.PhotometricInterpretation]?.values[0], bits: ifd0[TIFF_TAGS.BitsPerSample]?.values, samples: ifd0[TIFF_TAGS.SamplesPerPixel]?.values[0], version: ifd0[DNG_TAGS.DNGVersion] ? Array.from(ifd0[DNG_TAGS.DNGVersion].raw) : null, matrix: ifd0[DNG_TAGS.ColorMatrix1]?.count, white: ifd0[DNG_TAGS.WhiteLevel]?.values, size: [ifd0[TIFF_TAGS.ImageWidth]?.values[0], ifd0[TIFF_TAGS.ImageLength]?.values[0]] };
  console.log('technical dng:', JSON.stringify({ name: dng.name, type: dng.type, bytes: dng.bytes.length, ...tags }));
  if (!/_linear\.dng$/.test(dng.name)) fail('DNG name wrong: ' + dng.name);
  if (tags.photometric !== PHOTOMETRIC_LINEAR_RAW || String(tags.bits) !== '16,16,16' || tags.samples !== 3 || String(tags.version) !== '1,4,0,0' || tags.matrix !== 9) fail('DNG tags wrong: ' + JSON.stringify(tags));
  if (tags.size[0] !== 900 || tags.size[1] !== 600) fail('DNG size wrong: ' + JSON.stringify(tags.size));
  // The DNG is a linear positive: the fixture's bright bar (negative
  // transmittance 0.22 + 0.78 * 0.08) against its dim corner (0.22 + 0.78 * 0.90)
  // must come out at the linear ratio of the two, about 3.26, with the bar at white.
  const stripOffset = ifd0[TIFF_TAGS.StripOffsets].values[0];
  const sample = (x, y, c) => dng.bytes[stripOffset + ((y * 900 + x) * 3 + c) * 2] | (dng.bytes[stripOffset + ((y * 900 + x) * 3 + c) * 2 + 1] << 8);
  const bar = sample(680, 150, 1); const shadow = sample(20, 20, 1);
  const ratio = bar / Math.max(1, shadow);
  console.log('technical dng samples:', JSON.stringify({ bar, shadow, ratio: Number(ratio.toFixed(2)) }));
  if (!(bar >= 65000)) fail(`DNG bright bar should sit at white: ${bar}`);
  if (!(ratio > 2.9 && ratio < 3.6)) fail(`DNG is not a linear inversion of the negative: ratio ${ratio}`);
  await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();`);
  console.log('ok: a 16-bit export with cyan and exposure adjustments keeps thousands of levels per channel, and the linear DNG is a LinearRaw positive with the DNG tags');

  await runAiRepairScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root });
}

// ---- 3. AI repair: the controls and the TELEA fallback always; the learned
// bundled MI-GAN model, with an optional AI_INPAINT_MODEL override. ----
async function runAiRepairScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('ai repair workspace boot', `!!document.getElementById('dustAiEnabled')`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(() => {
    window.__aiToasts = [];
    new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) window.__aiToasts.push(n.textContent); }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  await waitFor('sample converted', `${ready} && document.getElementById('studioFilename').textContent === 'negative-sample.jpg'`, 150_000);
  await wait(600);
  await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('dustRemovalEnabled').click();`);
  await waitFor('dust detected with TELEA', `/Detected \\d+ dust/.test(document.getElementById('dustStatus').textContent)`, 60_000);
  const idle = await evaluate(`document.getElementById('dustAiStatus').textContent`);
  console.log('technical ai repair idle:', idle);
  if (!/No model loaded/.test(idle)) fail('AI repair should report no model: ' + idle);

  // Invalid local bytes exercise real runtime failure without depending on a 404.
  await evaluate(`(() => {
    const input = document.getElementById('dustAiModelInput');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['invalid model'], 'broken.onnx'));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('invalid model rejected', `/Model failed/.test(document.getElementById('dustAiStatus').textContent)`);
  const fallback = await evaluate(`document.getElementById('dustStatus').textContent`);
  if (!/Detected \d+ dust/.test(fallback)) fail('Basic repair lost after invalid model: ' + fallback);

  await installDownloadCapture(evaluate);
  await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click(); document.getElementById('exportSingleBtn').click()`);
  const beforeAi = await takeDownload(evaluate, waitFor, 'basic repair PNG');

  const modelPath = process.env.AI_INPAINT_MODEL;
  const loadStart = Date.now();
  if (modelPath) {
    const pick = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#dustAiModelInput' });
    await send('DOM.setFileInputFiles', { files: [modelPath], nodeId: pick.result.nodeId });
  } else {
    await evaluate(`document.getElementById('dustAiLoadBtn').click()`);
  }
  await waitFor('model ready', `/Model ready/.test(document.getElementById('dustAiStatus').textContent)`, 600_000);
  const loadMs = Date.now() - loadStart;
  await evaluate(`document.getElementById('dustAiEnabled').click()`);
  await waitFor('model inpainted the mask', `/last run \\d+ tile/.test(document.getElementById('dustAiStatus').textContent)`, 600_000);
  const result = await evaluate(`({ status: document.getElementById('dustAiStatus').textContent, dust: document.getElementById('dustStatus').textContent, toasts: window.__aiToasts.filter((t) => /AI repair/.test(t)) })`);
  console.log('technical ai repair with model:', JSON.stringify({ loadMs, ...result }));
  const match = result.status.match(/(\d+) tile\(s\) in (\d+) ms/);
  if (!match) fail('AI repair did not report its run: ' + result.status);
  console.log(`ok: the learned inpainter loaded in ${Math.round(loadMs / 1000)} s and filled ${match[1]} tile(s) in ${match[2]} ms (${Math.round(match[2] / Math.max(1, match[1]))} ms per 512-px tile)`);
  await evaluate(`(() => {
    window.__aiBrushRuns = 0;
    new MutationObserver(() => { window.__aiBrushRuns++; }).observe(document.getElementById('dustAiStatus'), { childList: true });
    if (!document.getElementById('dustShowMask').checked) document.getElementById('dustShowMask').click();
    const canvas = document.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    const options = { bubbles: true, clientX: rect.x + rect.width / 2,
      clientY: rect.y + rect.height / 2, button: 0, altKey: true };
    canvas.dispatchEvent(new MouseEvent('mousedown', options));
    document.dispatchEvent(new MouseEvent('mouseup', options));
  })()`);
  await waitFor('MI-GAN replaces brush preview', `window.__aiBrushRuns > 0 && /last run/.test(document.getElementById('dustAiStatus').textContent)`, 120_000);
  await evaluate(`document.getElementById('dustShowMask').click()`);
  console.log('ok: brush release runs MI-GAN');
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  const afterAi = await takeDownload(evaluate, waitFor, 'MI-GAN repaired PNG');
  const decode = (entry) => UPNG.decode(entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength));
  const before = decode(beforeAi); const after = decode(afterAi);
  if (before.width !== after.width || before.height !== after.height) fail('AI repair changed export dimensions');
  const a = new Uint8Array(UPNG.toRGBA8(before)[0]); const b = new Uint8Array(UPNG.toRGBA8(after)[0]);
  if (!a.some((value, index) => value !== b[index])) fail('AI export equals basic repair; model result was not used');
  console.log('ok: full-resolution PNG export contains the MI-GAN result');

  // Exercise CPU fallback with real weights, and verify compositing preserves all
  // unmasked pixels including 16-bit values not representable by 8-bit samples.
  const cpu = await evaluate(`(async () => {
    const ai = await import('/src/app/aiInpaint.js');
    const session = await ai.createInpaintSession(await ai.fetchModelBytes(ai.DEFAULT_MODEL_URL), { prefer: 'wasm' });
    try {
      const width = 64; const source = new ImageData(width, width);
      source.data.fill(128);
      const plane = new Uint16Array(width * width * 4).fill(32891);
      source.__image16 = { width, height: width, data: plane };
      const mask = new Uint8Array(width * width);
      for (let y = 29; y < 35; y++) for (let x = 29; x < 35; x++) {
        const i = y * width + x; mask[i] = 255;
        source.data.fill(255, i * 4, i * 4 + 3);
        plane.fill(65535, i * 4, i * 4 + 3);
      }
      const started = performance.now();
      const { imageData: result } = await ai.inpaintWithModel(source, mask, session.run, { feather: 0 });
      let changed = 0; let outsideChanges = 0;
      for (let i = 0; i < mask.length; i++) for (let c = 0; c < 3; c++) {
        if (mask[i]) changed += result.data[i * 4 + c] !== source.data[i * 4 + c] ? 1 : 0;
        else outsideChanges += result.__image16.data[i * 4 + c] !== plane[i * 4 + c] ? 1 : 0;
      }
      return { provider: session.provider, ms: Math.round(performance.now() - started), changed, outsideChanges };
    } finally { await session.release(); }
  })()`);
  if (cpu.provider !== 'wasm' || !cpu.changed || cpu.outsideChanges) fail('MI-GAN CPU/compositing regression: ' + JSON.stringify(cpu));
  console.log('ok: real MI-GAN CPU repair and untouched 16-bit pixels:', JSON.stringify(cpu));

}
