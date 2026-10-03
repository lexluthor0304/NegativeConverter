// #229 R1-098: a chromatic noMask frame in an automatic B&W group keeps
// its own import detection gate when Auto Frame Selected measures it again.
export async function runAutoFrameSelectedSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1&sharedPlanes=0` });
  await waitFor('Selected boot', `!!window.__ncHiddenJobs?.forgetFrameSettings && !!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(1000);
  const previous = await evaluate(`localStorage.getItem('nc_auto_roll_import_v1')`);
  try {
    await evaluate(`(async () => {
      localStorage.setItem('nc_auto_roll_import_v1', 'on');
      document.getElementById('autoRollOnImport').checked = true;
      for (const id of ['importFilmTypeAuto', 'studioImportAutoCrop']) {
        const control = document.getElementById(id); if (!control.checked) control.click();
      }
      const p = window.__afSelected = { posts: [], projects: [] };
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, transfer) {
        if (message?.type === 'analyze-import' && message.frame) p.posts.push({ width: message.width, height: message.height,
          frameFilmType: message.frame.frameFilmType, returnPlanes: Boolean(message.returnPlanes) });
        return original.call(this, message, transfer);
      };
      const revoke = URL.revokeObjectURL.bind(URL), pending = new Set();
      URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        if (!this.download.endsWith('.ncroll.json')) return click.call(this);
        const url = this.href; pending.add(url);
        p.projects.push(fetch(url).then(response => response.json()).finally(() => { pending.delete(url); revoke(url); }));
      };
      const { detectFilmType } = await import('/src/app/filmTypeDetection.js');
      const { planLineSearch } = await import('/src/app/autoFramePreview.js');
      const files = new DataTransfer();
      for (let n = 0; n < 4; n++) {
        const colour = n === 2, width = colour ? 900 : 910 + n * 10, height = 600;
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'), image = ctx.createImageData(width, height), rad = 2 * Math.PI / 180;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const dx = x - width / 2, dy = y - height / 2;
          const u = dx * Math.cos(rad) + dy * Math.sin(rad), v = -dx * Math.sin(rad) + dy * Math.cos(rad);
          const inside = Math.abs(u) < 270 && Math.abs(v) < 180;
          const grey = inside ? 50 + ((x + y) % 100) : 200;
          const rgb = colour && inside ? [grey * (.7 + (x % 100) / 160), grey, grey * (.7 + (y % 100) / 160)] : [grey * 1.08, grey, grey * 1.23];
          image.data.set([...rgb, 255], (y * width + x) * 4);
        }
        if (colour) p.own = { verdict: detectFilmType(image), lineSearch: planLineSearch(image, { enabled: true, filmType: 'positive' }).record };
        ctx.putImageData(image, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        files.items.add(new File([blob], 'af-selected-' + n + '.png', { type: 'image/png', lastModified: n }));
      }
      const input = document.getElementById('folderInput'); input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
    await waitFor('Selected roll analysed', `${ready} && document.getElementById('rollAnalysisStatus').textContent.includes('4/4')`, 180_000);
    const save = async () => {
      await evaluate(`document.getElementById('studioSaveProject').click()`);
      await waitFor('Selected recipe snapshot', `window.__afSelected.projects.length > 0`);
      return evaluate(`window.__afSelected.projects.shift()`);
    };
    const before = (await save()).files.find(file => file.name === 'af-selected-2.png');
    const own = await evaluate(`window.__afSelected.own`);
    if (own.verdict.filmType !== 'positive' || own.verdict.reason !== 'noMask' || own.lineSearch.reason !== 'colour') {
      fail('Selected fixture has no own/roll gate disagreement: ' + JSON.stringify(own));
    }
    if (before?.settings?.filmType !== 'bw' || before.settings.filmTypeReason !== 'rollMonochrome' || !before.settings.cropRegion) {
      fail('the imported frame was not cropped and automatically grouped as B&W: ' + JSON.stringify(before));
    }
    await evaluate(`(() => {
      for (const checkbox of document.querySelectorAll('#fileListItems .file-list-checkbox')) {
        if (checkbox.checked !== (checkbox.dataset.index === '2')) checkbox.click();
      }
    })()`);
    for (const unset of [false, true]) {
      const count = await evaluate(`window.__afSelected.posts.filter(post => post.width === 900).length`);
      if (unset && !await evaluate(`window.__ncHiddenJobs.forgetFrameSettings(2)`)) fail('could not unset the background frame recipe');
      await evaluate(`document.getElementById('autoFrameSelectedBtn').click()`);
      await waitFor('Selected frame settled', `${ready} && window.__afSelected.posts.filter(post => post.width === 900).length > ${count}`, 90_000);
      const request = await evaluate(`window.__afSelected.posts.filter(post => post.width === 900).at(-1)`);
      if (request.frameFilmType !== 'positive' || !request.returnPlanes) fail('Selected lost the own-type gate or ownership: ' + JSON.stringify(request));
      const after = (await save()).files.find(file => file.name === 'af-selected-2.png');
      if (after.settings.filmType !== 'bw' || after.settings.filmTypeReason !== 'rollMonochrome') fail('Selected erased automatic roll grouping');
      if (after.settings.rotationAngle !== before.settings.rotationAngle || JSON.stringify(after.settings.cropRegion) !== JSON.stringify(before.settings.cropRegion)) {
        fail('Selected/import geometry differs (unset=' + unset + '): ' + JSON.stringify([before.settings, after.settings]));
      }
    }
    const posts = await evaluate(`window.__afSelected.posts.filter(post => post.width === 900)`);
    if (posts.some(post => post.frameFilmType !== 'positive')) fail('import and Selected sent different gates: ' + JSON.stringify(posts));
    console.log('ok: import and Selected use the own positive gate for a B&W-grouped frame, with and without settings; crop and roll type preserved');
  } finally {
    await evaluate(`(() => { const before = ${JSON.stringify(previous)};
      if (before === null) localStorage.removeItem('nc_auto_roll_import_v1'); else localStorage.setItem('nc_auto_roll_import_v1', before);
    })()`).catch(() => {});
  }
}
