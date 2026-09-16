import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function runStudioStylesSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=zh` });
  await waitFor('styles boot', `!!document.getElementById('studioColorCorrect')`);
  await installDialogAutoAccept();
  await evaluate(`(() => {
    const crop = document.getElementById('studioImportAutoCrop'); if (crop.checked) crop.click();
    window.__styleExports = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (this.download && this.href.startsWith('blob:')) { window.__styleExports.push(fetch(this.href).then(r => r.blob())); return; }
      return click.call(this);
    };
  })()`);
  // Use a real scene as a negative, with its own rebate, rather than testing
  // a hue-only synthetic ramp. Keep it small enough to measure full exports.
  await evaluate(`(async () => {
    const bitmap = await createImageBitmap(await (await fetch('/test-fixtures/negative-sample.jpg')).blob());
    const scale = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas'); c.width = Math.round(bitmap.width * scale); c.height = Math.round(bitmap.height * scale);
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0, c.width, c.height); bitmap.close();
    const im = ctx.getImageData(0, 0, c.width, c.height); const base = [235, 180, 135];
    for (let i = 0; i < im.data.length; i += 4) for (let k = 0; k < 3; k++) im.data[i+k] = Math.round(base[k] * (1 - im.data[i+k] / 255));
    ctx.putImageData(im, 0, 0);
    const auto = document.getElementById('importFilmTypeAuto'); if (auto.checked) auto.click();
    const input = document.getElementById('fileInput'), dt = new DataTransfer();
    dt.items.add(new File([await new Promise(r => c.toBlob(r))], 'style-negative.png', { type: 'image/png' }));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('style negative ready', ready, 150000);
  await wait(1200);
  const pick = async model => {
    await evaluate(`document.querySelector('[data-model="${model}"]').click()`);
    await wait(1300);
  };
  const measure = async () => {
    const count = await evaluate('window.__styleExports.length');
    await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click(); document.getElementById('exportSingleBtn').click()`);
    await waitFor('style export', `window.__styleExports.length > ${count} && !document.getElementById('exportSingleBtn').disabled`, 120000);
    await wait(350);
    return evaluate(`(async () => {
      const bitmap = await createImageBitmap(await window.__styleExports.at(-1));
      const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
      const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let warm = 0, chroma = 0, n = 0, hash = 2166136261; const lumas = [];
      for (let i = 0; i < data.length; i += 4) {
        const r=data[i], g=data[i+1], b=data[i+2];
        for (let k=0;k<3;k++) hash=Math.imul(hash^data[i+k],16777619);
        const l = .2126*r + .7152*g + .0722*b; lumas.push(l);
        if (l > 25 && l < 230) { warm += r-b; chroma += Math.max(r,g,b)-Math.min(r,g,b); n++; }
      }
      lumas.sort((a,b)=>a-b);
      return { width:c.width, height:c.height, hash, warm:warm/n, chroma:chroma/n,
        range:lumas[Math.floor(lumas.length*.9)]-lumas[Math.floor(lumas.length*.1)],
        exposure: document.getElementById('coreExposure').value,
        cyan: document.getElementById('cyan').value,
        settings: Object.fromEntries([...document.querySelectorAll('input[type=range],select')].filter(e=>/^(core|expired|wb|cyan|magenta|yellow|filmPreset)/.test(e.id)).map(e=>[e.id,e.value])),
        diagnosis: document.getElementById('expiredDiagnosis')?.textContent };
    })()`);
  };
  await evaluate(`(() => { for (const [id,value] of [['coreExposure',7],['cyan',3]]) { const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
  const reports = [];
  for (const corrected of [false, true]) {
    await pick('standard');
    if (corrected) {
      await evaluate(`document.getElementById('studioColorCorrect').click()`);
      // Change the look while the second correction phase loads OpenCV.
      // It must still measure the original Natural conversion.
      await pick('warm');
      await waitFor('spatial correction ready', `!document.getElementById('expiredUnevenFog').disabled`, 120000);
      await pick('standard');
      const first = await measure();
      await evaluate(`document.getElementById('studioColorCorrect').click()`);
      await wait(1300);
      const repeated = await measure();
      if (first.hash !== repeated.hash) fail('style changed the pending correction baseline: '+JSON.stringify({first,repeated}));
    }
    const outputs = {};
    for (const model of ['standard','warm','frontier','noritsu']) { await pick(model); outputs[model] = await measure(); }
    console.log('style pixels:', JSON.stringify({ corrected, outputs }));
    const normal = outputs.standard;
    for (const [model, out] of Object.entries(outputs)) {
      if (out.width !== normal.width || out.height !== normal.height || out.exposure !== '7' || out.cyan !== '3') fail('style changed geometry/exposure/CMYD: '+model);
      if (model !== 'standard' && out.hash === normal.hash) fail('style has no pixel effect: '+model);
    }
    if (outputs.warm.warm <= normal.warm + 3) fail('Warm does not visibly warm midtones');
    if (outputs.frontier.chroma <= normal.chroma * 1.06 || outputs.frontier.range <= normal.range + 3) fail('Vivid lacks increased color/contrast');
    if (outputs.noritsu.range >= normal.range - 3) fail('Soft does not soften tonal contrast');
    await pick('standard');
    const restored = await measure();
    if (restored.hash !== normal.hash) fail('Natural did not restore its original pixels: '+JSON.stringify({normal,restored}));
    await pick('warm');
    await evaluate(`document.getElementById('undoBtn').click()`); await wait(1300);
    if ((await measure()).hash !== normal.hash) fail('style undo did not restore Natural');
    reports.push({ corrected, outputs });
  }
  mkdirSync(join(root,'output','verification'),{recursive:true});
  writeFileSync(join(root,'output','verification','style-comparison.json'),JSON.stringify(reports,null,2));
  await pick('warm');
  const shot=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(root,'output','verification','styles-warm-zh.png'),Buffer.from(shot.result.data,'base64'));
  console.log('ok: four styles have distinct exported color/tone, with and without correction; Natural and undo restore pixels while exposure/CMYD survive');
}
