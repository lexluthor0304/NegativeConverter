// Roll's-home smoke: analog metadata reaches the exported PNG, TIFF and JPEG
// (EXIF + XMP), the contact sheet renders at page size, a roll project saves
// and reopens, and a recipe round-trips through copy and paste.
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseTiff, TIFF_TAGS, EXIF_TAGS } from '../negative2positive/src/workers/tiffWriter.js';
import { listPngChunks, listJpegSegments } from '../negative2positive/src/app/exportMetadata.js';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// Headless Chrome does not materialise <a download> clicks; capture the blobs
// in-page as data URLs so the whole pipeline (convert, encode, splice) runs.
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

async function setField(evaluate, id, value) {
  await evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

async function exportAs(evaluate, waitFor, format) {
  await evaluate(`document.querySelector('.format-btn[data-format="${format}"]').click()`);
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  return takeDownload(evaluate, waitFor, `${format} export captured`);
}

export async function runRollHomeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-strip-dx.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('roll home workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('fileInput') && !!document.getElementById('metaStock'))`);
  await installDialogAutoAccept();
  await installDownloadCapture(evaluate);
  await wait(300);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  await waitFor('strip converted', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-dx.png'`, 150_000);
  await wait(800);

  // ---- 1. Metadata panel: the DX read prefills the stock; the rest is typed. ----
  await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioMetadata').open = true;`);
  const prefilled = await evaluate(`({ stock: document.getElementById('metaStock').value, placeholder: document.getElementById('metaFrameNumber').placeholder })`);
  console.log('roll home metadata prefill:', JSON.stringify(prefilled));
  if (!/ULTRA MAX/i.test(prefilled.stock)) fail('film stock was not prefilled from the DX read: ' + JSON.stringify(prefilled));
  if (prefilled.placeholder !== '1') fail('frame number placeholder should be the roll position: ' + prefilled.placeholder);
  await setField(evaluate, 'metaIso', '400');
  await setField(evaluate, 'metaCamera', 'Nikon FM2');
  await setField(evaluate, 'metaLens', 'Nikkor 50mm f/1.8');
  await setField(evaluate, 'metaLab', 'Corner Lab');
  await setField(evaluate, 'metaDate', '2026-09-06');
  await setField(evaluate, 'metaFrameNumber', '31A');
  await setField(evaluate, 'metaNotes', 'Land Rover by the fig tree');

  const png = await exportAs(evaluate, waitFor, 'png');
  const chunks = listPngChunks(png.bytes);
  const types = chunks.map((c) => c.type);
  console.log('roll home png chunks:', types.slice(0, 5).join(','), png.name);
  if (types[1] !== 'eXIf' || types[2] !== 'iTXt') fail('PNG export lacks eXIf/iTXt after IHDR: ' + types.join(','));
  const pngExif = parseTiff(chunks[1].data);
  if (pngExif.exif?.[EXIF_TAGS.ISOSpeedRatings]?.values[0] !== 400) fail('PNG EXIF ISO missing');
  if (pngExif.ifd0[TIFF_TAGS.Model]?.values !== 'Nikon FM2') fail('PNG EXIF camera missing');
  const pngXmp = new TextDecoder().decode(chunks[2].data);
  if (!/AnalogExif:Film>[^<]*ULTRA MAX/i.test(pngXmp) || !/AnalogExif:ExposureNumber>31A</.test(pngXmp) || !/<rdf:li>Corner Lab<\/rdf:li>/.test(pngXmp)) fail('PNG XMP lacks film fields: ' + pngXmp.slice(0, 400));

  const tiff = await exportAs(evaluate, waitFor, 'tiff');
  const parsed = parseTiff(tiff.bytes);
  console.log('roll home tiff tags:', Object.keys(parsed.ifd0).length, 'exif:', parsed.exif ? Object.keys(parsed.exif).length : 0, tiff.name);
  if (parsed.ifd0[TIFF_TAGS.Model]?.values !== 'Nikon FM2') fail('TIFF Model tag missing');
  if (parsed.exif?.[EXIF_TAGS.LensModel]?.values !== 'Nikkor 50mm f/1.8') fail('TIFF Exif lens missing');
  if (!/AnalogExif:Lab>Corner Lab</.test(new TextDecoder().decode(parsed.ifd0[TIFF_TAGS.XMP]?.raw || new Uint8Array()))) fail('TIFF XMP tag missing the lab');
  if (parsed.ifd0[TIFF_TAGS.ImageWidth]?.values[0] < 100) fail('TIFF image width implausible');

  const jpeg = await exportAs(evaluate, waitFor, 'jpeg');
  const segments = listJpegSegments(jpeg.bytes);
  const app1 = segments.filter((s) => s.marker === 0xE1);
  console.log('roll home jpeg segments:', segments.map((s) => s.marker.toString(16)).join(','), jpeg.name);
  if (app1.length !== 2) fail('JPEG export lacks the two APP1 segments');
  const jpegExif = parseTiff(app1[0].data.subarray(6));
  if (jpegExif.exif?.[EXIF_TAGS.DateTimeOriginal]?.values !== '2026:09:06 00:00:00') fail('JPEG EXIF date missing');
  if (!/AnalogExif:RollId|AnalogExif:Film>/.test(new TextDecoder().decode(app1[1].data))) fail('JPEG XMP missing');
  await evaluate(`document.querySelector('.format-btn[data-format="png"]').click()`);
  console.log('ok: roll and frame metadata land in the PNG (eXIf + iTXt), TIFF (IFD0 + Exif + XMP) and JPEG (APP1 EXIF + XMP) exports');

  await runContactSheetScenario({ evaluate, waitFor, wait, fail });
  await runProjectScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, fixture });
  await runRecipeScenario({ evaluate, waitFor, wait, fail });
}

// ---- 3. Roll project: save from the batch menu, reopen in a fresh page with the original. ----
async function runProjectScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, fixture }) {
  await evaluate(`document.getElementById('studioSaveProject').click()`);
  const saved = await takeDownload(evaluate, waitFor, 'project captured');
  const text = new TextDecoder().decode(saved.bytes);
  const project = JSON.parse(text);
  console.log('roll home project:', JSON.stringify({ name: saved.name, version: project.version, files: project.files.map((f) => f.name), iso: project.roll?.metadata?.iso, hashed: Boolean(project.files[0]?.hash) }));
  if (!/\.ncroll\.json$/.test(saved.name)) fail('project file name wrong: ' + saved.name);
  if (project.files[0]?.name !== 'negative-strip-dx.png' || project.roll?.metadata?.iso !== '400') fail('project content wrong: ' + text.slice(0, 300));
  if (project.files[0]?.settings?.frameMetadata?.frameNumber !== '31A') fail('project lacks the frame settings: ' + JSON.stringify(project.files[0]?.settings?.frameMetadata));
  if (!project.files[0]?.hash) fail('project entries carry no content hash');
  const projectPath = join(mkdtempSync(join(tmpdir(), 'nc-project-')), saved.name);
  writeFileSync(projectPath, text);

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('roll home reboot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('projectInput'))`);
  await installDialogAutoAccept();
  await installDownloadCapture(evaluate);
  await wait(300);
  await evaluate(`(() => {
    window.__rollToasts = [];
    new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) window.__rollToasts.push(n.textContent); }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#projectInput' });
  await send('DOM.setFileInputFiles', { files: [fixture, projectPath], nodeId: input.result.nodeId });
  await waitFor('project reopened', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-dx.png' && document.getElementById('metaIso').value === '400'`, 150_000);
  await wait(800);
  const restored = await evaluate(`({ iso: document.getElementById('metaIso').value, frame: document.getElementById('metaFrameNumber').value, camera: document.getElementById('metaCamera').value, toasts: window.__rollToasts.filter((t) => /Project/.test(t)) })`);
  console.log('roll home project restored:', JSON.stringify(restored));
  if (restored.frame !== '31A' || restored.camera !== 'Nikon FM2') fail('project did not restore the metadata: ' + JSON.stringify(restored));
  if (!restored.toasts.some((t) => /Project opened: 1 photo/.test(t))) fail('project toast missing: ' + JSON.stringify(restored.toasts));
  console.log('ok: the roll project saves the queue, settings and metadata and restores them when reopened with the original');
}

// ---- 4. Recipe: copy a short NC1 code with a QR, read it back with a diff, apply it, refuse a newer version. ----
async function runRecipeScenario({ evaluate, waitFor, wait, fail }) {
  await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioRecipe').open = true;`);
  const setSlider = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setSlider('coreExposure', '20');
  await waitFor('exposure set', `document.getElementById('coreExposureValue').value === '20'`, 10_000);
  await wait(600);
  await evaluate(`document.getElementById('recipeCopyBtn').click()`);
  await waitFor('recipe code shown', `/^NC1\\./.test(document.getElementById('recipeCode').value)`, 10_000);
  const code = await evaluate(`document.getElementById('recipeCode').value`);
  console.log('roll home recipe:', code.length, 'chars');
  if (code.length > 300) fail('recipe code too long: ' + code.length);
  await evaluate(`document.getElementById('recipeQrBtn').click()`);
  const qr = await evaluate(`(() => { const c = document.getElementById('recipeQrCanvas'); return { hidden: c.hidden, width: c.width }; })()`);
  if (qr.hidden || qr.width < 100) fail('QR not drawn: ' + JSON.stringify(qr));
  await evaluate(`(async () => {
    window.BarcodeDetector = undefined;
    window.__recipeQrBlob = await new Promise((resolve) => document.getElementById('recipeQrCanvas').toBlob(resolve));
  })()`);
  await setSlider('coreExposure', '0');
  await waitFor('exposure reset', `document.getElementById('coreExposureValue').value === '0'`, 10_000);
  // Import the actual generated QR as a file without BarcodeDetector or a camera.
  await evaluate(`(() => {
    const box = document.getElementById('recipeCode');
    box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true }));
    const input = document.getElementById('recipeQrInput');
    const files = new DataTransfer();
    files.items.add(new File([window.__recipeQrBlob], 'friend-recipe.png', { type: 'image/png' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await waitFor('recipe read', `/Recipe read: \\d+ change/.test(document.getElementById('recipeStatus').textContent)`, 10_000);
  const imported = await evaluate(`({ code: document.getElementById('recipeCode').value, exposure: document.getElementById('coreExposureValue').value, reset: document.getElementById('recipeQrInput').value })`);
  if (imported.code !== code || imported.exposure !== '0' || imported.reset !== '') fail('QR import must preview without applying and reset the file input: ' + JSON.stringify(imported));
  const diff = await evaluate(`[...document.querySelectorAll('#recipeDiff li')].map((li) => li.textContent)`);
  console.log('roll home recipe diff:', JSON.stringify(diff));
  if (!diff.some((line) => /coreExposure: 0 → 20/.test(line))) fail('recipe diff does not list the exposure change: ' + JSON.stringify(diff));
  await evaluate(`document.getElementById('recipeApplyBtn').click()`);
  await waitFor('recipe applied', `document.getElementById('coreExposureValue').value === '20'`, 10_000);
  await waitFor('QR reader available again', `!document.getElementById('recipeUploadBtn').disabled`);
  await evaluate(`(() => {
    const files = new DataTransfer();
    files.items.add(new File(['broken'], 'broken.png', { type: 'image/png' }));
    const input = document.getElementById('recipeQrInput'); input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('invalid QR image handled', `window.__rollToasts.some((t) => /Could not read this image/.test(t)) && !document.getElementById('recipeUploadBtn').disabled`);
  const cleared = await evaluate(`({ code: document.getElementById('recipeCode').value, count: document.querySelectorAll('#recipeDiff li').length, disabled: document.getElementById('recipeApplyBtn').disabled && document.getElementById('recipeApplySelectedBtn').disabled })`);
  if (cleared.code || cleared.count || !cleared.disabled) fail('Failed QR import retained an old recipe: ' + JSON.stringify(cleared));
  await evaluate(`(() => { const box = document.getElementById('recipeCode'); box.value = 'NC99.AAAA'; box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('recipeDecodeBtn').click(); })()`);
  await waitFor('newer recipe refused', `window.__rollToasts.some((t) => /newer version/.test(t))`, 10_000);
  await wait(300);
  console.log('ok: a recipe copies as a short NC1 code with a QR, reads back with a diff, applies to the photo, and a newer-version code is refused');
}

const pngSize = (bytes) => ({ width: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0, height: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 });

// ---- 2. Contact sheet: one A4 page at 300 dpi with sprockets, then Letter. ----
async function runContactSheetScenario({ evaluate, waitFor, wait, fail }) {
  const enabled = await evaluate(`!document.getElementById('exportContactSheetBtn').disabled`);
  if (!enabled) fail('contact sheet button should be enabled with a selected photo');
  await evaluate(`(() => {
    document.getElementById('contactSheetLayout').value = '35mm';
    document.getElementById('contactSheetPage').value = 'a4';
    document.getElementById('contactSheetSprockets').checked = true;
    document.getElementById('exportContactSheetBtn').click();
  })()`);
  const started = Date.now();
  const sheet = await takeDownload(evaluate, waitFor, 'contact sheet captured');
  const elapsed = Date.now() - started;
  const size = pngSize(sheet.bytes);
  console.log('roll home contact sheet:', JSON.stringify({ name: sheet.name, ...size, ms: elapsed, bytes: sheet.bytes.length }));
  if (!/^contact-sheet-.*\.png$/.test(sheet.name)) fail('contact sheet file name wrong: ' + sheet.name);
  if (size.width !== 2480 || size.height !== 3508) fail('contact sheet is not A4 at 300 dpi: ' + JSON.stringify(size));
  const chunks = listPngChunks(sheet.bytes);
  if (!/AnalogExif:Film>[^<]*ULTRA MAX/i.test(new TextDecoder().decode(chunks.find((c) => c.type === 'iTXt')?.data || new Uint8Array()))) fail('contact sheet carries no roll XMP');
  await evaluate(`(() => { document.getElementById('contactSheetPage').value = 'letter'; document.getElementById('contactSheetSprockets').checked = false; document.getElementById('exportContactSheetBtn').click(); })()`);
  const letter = await takeDownload(evaluate, waitFor, 'letter contact sheet captured');
  const letterSize = pngSize(letter.bytes);
  if (letterSize.width !== 2550 || letterSize.height !== 3300) fail('Letter contact sheet has the wrong size: ' + JSON.stringify(letterSize));
  await wait(300);
  console.log('ok: the contact sheet renders the selection at A4 and Letter 300 dpi with the roll header and XMP');
}
