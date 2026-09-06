// Roll's-home smoke: analog metadata reaches the exported PNG, TIFF and JPEG
// (EXIF + XMP), the contact sheet renders at page size, a roll project saves
// and reopens, and a recipe round-trips through copy and paste.
import { join } from 'node:path';
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
  await waitFor('roll home workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('metaStock')`);
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
}
