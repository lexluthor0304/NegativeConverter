// #256: the batch export stages in a real browser. Three generated 4.1 MP
// 16-bit PNG negatives (above the band pool's 4 MP floor; PNG decodes run
// off the main thread, so they are decoded ahead) are exported with Export
// All in one lane, first with `nc_batch_pipeline_v1 = serial` (the lane
// alone, a lane held until its write: the parity oracle), then with the
// stages on (early lane release, decode-ahead, the conversion band pool and
// Step 3 on the bands). Every file must be byte-identical between the two
// runs, for PNG8 and TIFF16. The run also reads what the stages did
// (window.__ncBatchPipeline, per batch): a staged batch must keep a frame's
// bands resident and run its Step 3 there; it counts the band workers (never
// more than min(6, cores - 2), all gone after the batch), and a single
// export of the open photo (Step 3 on the band pool) must match its serial
// export. Last, a staged ZIP whose writes take real time (a save picker whose
// writable writes at 20 MB/s): frames 1 and 2 must start while frames 0 and
// 1 are still being written, and the pipeline must count exactly those two
// overlaps (earlyReleases). The downloads above end in the same task as
// their sink, so whether the next frame starts first is not checked there.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

function writeNegative(dir, name, seed) {
  const width = 2400;
  const height = 1700;
  const raw = Buffer.alloc((width * 6 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 6 + 1);
    for (let x = 0; x < width; x++) {
      const t = x / (width - 1) * 0.6 + y / (height - 1) * 0.4;
      const v = 1 - 0.2 * (((x - width / 2) / width) ** 2 + ((y - height / 2) / height) ** 2);
      const grain = ((x * 7919 + y * 104729 + seed * 131) % 97) - 48;
      const patch = ((x >> 6) + (y >> 6) + seed) % 7 === 0 ? 0.8 : 1;
      const o = row + 1 + x * 6;
      raw.writeUInt16BE(Math.max(0, Math.min(65535, Math.round((61000 - t * 31000) * v * patch + grain))), o);
      raw.writeUInt16BE(Math.max(0, Math.min(65535, Math.round((44000 - t * 25000) * v + grain))), o + 2);
      raw.writeUInt16BE(Math.max(0, Math.min(65535, Math.round((31000 - t * 18000) * v / patch + grain))), o + 4);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  const path = join(dir, name);
  writeFileSync(path, png);
  return path;
}

export async function runBatchPipelineSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
  await waitFor('batch pipeline smoke boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  // One lane (the band pool's case), no gain map, and no automatic roll
  // import: nothing may change a frame's recipe between the two runs.
  const autoRoll = await evaluate(`(() => {
    try {
      localStorage.setItem('nc_batch_lanes_v1', '1');
      localStorage.setItem('nc_hdr_gain_map_v1', 'off');
      localStorage.removeItem('nc_batch_pipeline_v1');
    } catch {}
    const box = document.getElementById('autoRollOnImport');
    const was = Boolean(box && box.checked);
    if (box && box.checked) box.click();
    return was;
  })()`);
  await wait(300);

  const dir = mkdtempSync(join(tmpdir(), 'nc-batch-pipeline-'));
  try {
    const files = [writeNegative(dir, 'pipeline-a.png', 1), writeNegative(dir, 'pipeline-b.png', 2), writeNegative(dir, 'pipeline-c.png', 3)];
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files, nodeId: input.result.nodeId });
    await waitFor('batch pipeline fixtures ready', `${ready} && document.querySelectorAll('.file-list-name').length === 3
      && document.querySelectorAll('.file-list-name[data-preview-state="ready"]').length === 3`, 240_000);
    await wait(1500);
    await evaluate(`(() => {
      const probe = window.__batchPipelineProbe = { downloads: [], bandWorkers: [], longTasks: [] };
      try { delete window.showSaveFilePicker; } catch {}
      window.showSaveFilePicker = undefined;
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(url, options) {
          super(url, options);
          if (String(url).includes('conversionBandWorker')) probe.bandWorkers.push(this);
        }
      };
      const terminate = OriginalWorker.prototype.terminate;
      OriginalWorker.prototype.terminate = function () { this.__terminated = true; return terminate.call(this); };
      // With ?debug=1 the app's idle isolation report (#264) starts one worker
      // of every script once, a band worker too, and posts it only the probe:
      // such a worker is not the band pool's.
      const postMessage = OriginalWorker.prototype.postMessage;
      OriginalWorker.prototype.postMessage = function (message, ...rest) {
        if (message && message.type === 'nc-isolation-probe') this.__isolationProbe = true;
        return postMessage.call(this, message, ...rest);
      };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
        probe.downloads.push({ name: this.download, blob: fetch(this.href).then(r => r.blob()) });
      };
      try {
        new PerformanceObserver((list) => { for (const entry of list.getEntries()) probe.longTasks.push(entry.duration); })
          .observe({ type: 'longtask', buffered: false });
      } catch {}
      probe.restore = () => {
        window.Worker = OriginalWorker;
        OriginalWorker.prototype.terminate = terminate;
        OriginalWorker.prototype.postMessage = postMessage;
        HTMLAnchorElement.prototype.click = click;
      };
      // Every photo takes part.
      document.getElementById('selectAllBtn')?.click();
    })()`);

    const setFormat = (format, depth) => evaluate(`(async () => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      const depth = document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]');
      for (let i = 0; i < 50 && depth && depth.disabled && !depth.classList.contains('disabled'); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (depth && !depth.classList.contains('disabled')) depth.click();
      return document.querySelector('.bitdepth-btn.active')?.dataset.bitdepth;
    })()`);
    const setMode = (mode) => evaluate(`(() => {
      try {
        if (${JSON.stringify(mode)}) localStorage.setItem('nc_batch_pipeline_v1', ${JSON.stringify(mode)});
        else localStorage.removeItem('nc_batch_pipeline_v1');
      } catch {}
    })()`);
    const hashAll = (from) => evaluate(`(async () => {
      const p = window.__batchPipelineProbe;
      const out = [];
      for (const entry of p.downloads.slice(${from})) {
        const bytes = new Uint8Array(await (await entry.blob).arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        out.push({ name: entry.name, size: bytes.length, sha: Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('') });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    })()`);
    const exportAll = async (label) => {
      const from = await evaluate(`(() => {
        const p = window.__batchPipelineProbe;
        p.bandWorkersBefore = p.bandWorkers.length;
        p.longTasks.length = 0;
        document.getElementById('exportAllBtn').click();
        return p.downloads.length;
      })()`);
      await waitFor(label, `window.__batchPipelineProbe.downloads.length >= ${from + 3} && !document.getElementById('exportAllBtn').disabled && !document.body.dataset.studioBusy`, 300_000);
      await wait(1500);
      const files = await hashAll(from);
      const stages = await evaluate(`(() => {
        const p = window.__batchPipelineProbe;
        const created = p.bandWorkers.slice(p.bandWorkersBefore).filter(w => !w.__isolationProbe);
        const d = window.__ncBatchPipeline?.diagnostics || {};
        return {
          last: d.last, bands: d.bands, residentFrames: d.residentFrames, decodeAhead: d.decodeAhead,
          bandWorkers: created.length, bandWorkersAlive: created.filter(w => !w.__terminated).length,
          isolationProbes: p.bandWorkers.slice(p.bandWorkersBefore).length - created.length,
          longestTask: p.longTasks.length ? Math.max(...p.longTasks) : 0,
          cores: navigator.hardwareConcurrency
        };
      })()`);
      return { files, stages };
    };

    for (const [format, depth] of [['png', 8], ['tiff', 16]]) {
      if (String(await setFormat(format, depth)) !== String(depth)) fail(`could not select ${format}${depth}`);
      await setMode('serial');
      const serial = await exportAll(`serial Export All ${format}${depth}`);
      await setMode(null);
      const staged = await exportAll(`staged Export All ${format}${depth}`);
      console.log(`batch pipeline ${format}${depth}:`, JSON.stringify({ serial: serial.files, staged: staged.files, stages: staged.stages }));
      if (serial.files.length !== 3 || staged.files.length !== 3) fail(`${format}${depth}: expected three files per run`);
      for (let i = 0; i < 3; i++) {
        if (serial.files[i].sha !== staged.files[i].sha || serial.files[i].size !== staged.files[i].size) {
          fail(`${format}${depth}: ${staged.files[i].name} differs from the serial run: ` + JSON.stringify({ serial: serial.files[i], staged: staged.files[i] }));
        }
      }
      const { last, bands } = staged.stages;
      if (!last || last.mode !== 'default' || last.lanes !== 1) fail(`${format}${depth}: the staged run did not run one default lane: ` + JSON.stringify(staged.stages));
      if (!(last.peakUnwrittenBytes > 0)) fail(`${format}${depth}: no lane was released before its write: ` + JSON.stringify(last));
      if (!(last.prepare && last.prepare.taken >= 1)) fail(`${format}${depth}: no frame was decoded ahead: ` + JSON.stringify(last));
      if (!(bands && bands.frames >= 1)) fail(`${format}${depth}: no frame converted in bands: ` + JSON.stringify(bands));
      const maxWorkers = Math.min(6, Math.max(0, (staged.stages.cores || 4) - 2));
      if (staged.stages.bandWorkers > maxWorkers) fail(`${format}${depth}: ${staged.stages.bandWorkers} band workers for ${staged.stages.cores} cores`);
      if (staged.stages.bandWorkersAlive !== 0) fail(`${format}${depth}: band workers outlived the batch`);
      // This batch's figures (main.js resets them per batch). A frame that
      // reads no pixels after its conversion keeps its bands in the pool and
      // runs Step 3 there; one of the three does here (every run since #256).
      if (!(bands.resident >= 1) || !(staged.stages.residentFrames >= 1)) {
        fail(`${format}${depth}: no frame kept its bands for Step 3: ` + JSON.stringify({ bands, residentFrames: staged.stages.residentFrames }));
      }
      if (staged.stages.longestTask > 200) console.log(`WARN: ${format}${depth}: a ${staged.stages.longestTask} ms long task during the staged batch`);
      const serialStages = serial.stages.last;
      if (!serialStages || serialStages.mode !== 'serial' || serialStages.earlyReleases !== 0 || serialStages.prepare) {
        fail(`${format}${depth}: serial mode ran stages: ` + JSON.stringify(serialStages));
      }
    }

    // A single export of the open 4.1 MP photo: its Step 3 runs on the band
    // pool (the pool ends with the export), the file is the serial export's.
    const exportSingle = async (label) => {
      const from = await evaluate(`(() => {
        const p = window.__batchPipelineProbe;
        p.bandWorkersBefore = p.bandWorkers.length;
        document.getElementById('exportSingleBtn').click();
        return p.downloads.length;
      })()`);
      await waitFor(label, `window.__batchPipelineProbe.downloads.length > ${from} && !document.getElementById('exportSingleBtn').disabled && !document.body.dataset.studioBusy`, 180_000);
      await wait(800);
      const [file] = await hashAll(from);
      const pool = await evaluate(`(() => {
        const p = window.__batchPipelineProbe;
        const created = p.bandWorkers.slice(p.bandWorkersBefore).filter(w => !w.__isolationProbe);
        return { stats: window.__ncBatchPipeline?.diagnostics?.singleExport || null, workers: created.length, alive: created.filter(w => !w.__terminated).length };
      })()`);
      return { file, pool };
    };
    if (String(await setFormat('png', 8)) !== '8') fail('could not select PNG8');
    await setMode('serial');
    const singleSerial = await exportSingle('serial single export');
    await setMode(null);
    const singleBanded = await exportSingle('banded single export');
    console.log('single export:', JSON.stringify({ serial: singleSerial, banded: singleBanded }));
    if (singleSerial.file.sha !== singleBanded.file.sha) fail('the banded single export differs from the serial one: ' + JSON.stringify({ singleSerial, singleBanded }));
    if (!(singleBanded.pool.stats && singleBanded.pool.stats.adjusts >= 1)) console.log('WARN: the single export did not adjust on the band pool (a CPU display buffer at full resolution needs no adjustment)');
    if (singleBanded.pool.alive !== 0) fail('band workers outlived the single export');

    // Part 2's overlap in Chrome: a ZIP whose writes take real time, like a
    // slow disk or the CRC pass over a large frame.
    if (String(await setFormat('png', 8)) !== '8') fail('could not select PNG8');
    await setMode(null);
    await evaluate(`(() => {
      const p = window.__batchPipelineProbe;
      p.zip = { writes: 0, bytes: 0, closed: false };
      window.showSaveFilePicker = async () => ({
        name: 'pipeline-overlap.zip',
        createWritable: async () => ({
          write: async (chunk) => {
            const bytes = chunk.byteLength ?? chunk.size ?? 0;
            p.zip.writes += 1;
            p.zip.bytes += bytes;
            await new Promise(resolve => setTimeout(resolve, Math.max(2, bytes / 20e6 * 1000)));
          },
          close: async () => { p.zip.closed = true; },
          abort: async () => {}
        })
      });
      document.getElementById('exportZipBtn').click();
    })()`);
    await waitFor('staged ZIP with slow writes', `window.__batchPipelineProbe.zip.closed && !document.getElementById('exportZipBtn').disabled && !document.body.dataset.studioBusy`, 300_000);
    const zip = await evaluate(`(() => {
      window.showSaveFilePicker = undefined;
      return { zip: window.__batchPipelineProbe.zip, last: window.__ncBatchPipeline?.diagnostics?.last || null };
    })()`);
    console.log('batch pipeline ZIP overlap:', JSON.stringify(zip));
    if (!zip.last || zip.last.mode !== 'default' || zip.last.lanes !== 1) fail('the ZIP did not run one default lane: ' + JSON.stringify(zip));
    if (zip.last.earlyReleases !== 2) {
      fail(`frames 1 and 2 must start while 0 and 1 are written (2 overlaps), counted ${zip.last.earlyReleases}: ` + JSON.stringify(zip));
    }
  } finally {
    await evaluate(`(() => {
      window.__batchPipelineProbe?.restore();
      window.showSaveFilePicker = undefined;
      try {
        localStorage.removeItem('nc_batch_lanes_v1');
        localStorage.removeItem('nc_batch_pipeline_v1');
        localStorage.removeItem('nc_hdr_gain_map_v1');
      } catch {}
      const box = document.getElementById('autoRollOnImport');
      if (box && box.checked !== ${autoRoll}) box.click();
      document.querySelector('.format-btn[data-format="png"]')?.click();
    })()`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('ok: Export All with early release, decode-ahead and the band pool writes the serial run\'s files, byte for byte; the next frame overlaps a slow write');
}
