// Exercise the actual Studio event handlers. A display buffer can be full-sized
// yet stale: slider input updates the bounded preview before the idle full pass.
export async function runComparePreviewSmoke({ send, evaluate, waitFor, wait, fail, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('compare preview boot', `!!document.getElementById('studioImportAutoCrop')`);
  await wait(1500);
  await evaluate(`(() => {
    for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto']) {
      const input = document.getElementById(id); if (input.checked) input.click();
    }
    const originalPut = CanvasRenderingContext2D.prototype.putImageData;
    const probe = window.__comparePreviewProbe = { calls: [], canvases: {} };
    CanvasRenderingContext2D.prototype.putImageData = function(image, ...args) {
      const stack = new Error().stack || '';
      const full = stack.includes('updateFullCpu');
      const preview = stack.includes('updatePreviewCpu');
      if (full || preview) probe.calls.push({ width: image.width, height: image.height, full, preview });
      if (stack.includes('ensureSprocketPreviewFrameBackground')) probe.canvases.frame = this.canvas;
      else if (stack.includes('renderFastSprocketPreview')) probe.canvases.scratch = this.canvas;
      if (stack.includes('renderBeforeAfterReference') && this.canvas.id !== 'canvas') probe.canvases.before = this.canvas;
      return originalPut.call(this, image, ...args);
    };
    window.__restoreComparePreviewProbe = () => {
      CanvasRenderingContext2D.prototype.putImageData = originalPut;
      delete window.__comparePreviewProbe;
      delete window.__comparePreviewFile;
      delete window.__comparePreviewHash;
      delete window.__restoreComparePreviewProbe;
    };
    // Five interior patches are enough to distinguish adjustment states without
    // a full-resolution readback itself perturbing the 1.2-second idle window.
    window.__comparePreviewHash = () => {
      const canvas = document.getElementById('canvas'), ctx = canvas.getContext('2d');
      let hash = 2166136261;
      for (const [x, y] of [[.25,.25],[.75,.25],[.5,.5],[.25,.75],[.75,.75]]) {
        const pixels = ctx.getImageData(Math.floor(canvas.width*x)-48, Math.floor(canvas.height*y)-32, 96, 64).data;
        for (let i=0; i<pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
      }
      return [canvas.width, canvas.height, hash >>> 0].join(':');
    };
  })()`);
  try {
    await evaluate(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width=3600; canvas.height=2400;
      const ctx=canvas.getContext('2d'), image=ctx.createImageData(canvas.width,canvas.height);
      for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
        const i=(y*canvas.width+x)*4, t=(x/37+y/29)%100;
        image.data[i]=100+t; image.data[i+1]=45+t*.6; image.data[i+2]=20+t*.3; image.data[i+3]=255;
      }
      ctx.putImageData(image,0,0);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.95));
      window.__comparePreviewFile=new File([blob],'compare-preview-3600x2400.jpg',{type:'image/jpeg'});
      const transfer=new DataTransfer(); transfer.items.add(window.__comparePreviewFile);
      const input=document.getElementById('fileInput'); input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor('compare preview import', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 120000);
    await evaluate(`(() => {
      const gl=document.getElementById('coreUseWebGL'); if(gl.checked) gl.click();
      const border=document.getElementById('sprocketPreviewBtn');
      if(border.getAttribute('aria-pressed')!=='true') border.click();
    })()`);
    // Prove that the stale-buffer precondition exists, instead of accidentally
    // testing only the initial small conversion preview.
    await waitFor('full CPU buffer before recent edit', `window.__comparePreviewProbe.calls.some(call=>call.full && call.width*call.height>=3600*2400)`, 120000);
    await wait(300);

    const result = await evaluate(`(async () => {
      const slider=document.getElementById('wbR'), compare=document.getElementById('beforeAfterBtn');
      const probe=window.__comparePreviewProbe, hash=window.__comparePreviewHash;
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const input=value=>{slider.value=String(value);slider.dispatchEvent(new Event('input',{bubbles:true}));};
      // Input, not change: this isolates synchronous adjustment freshness from
      // asynchronous SilverCore conversion and does not schedule a full pass.
      input(1.05); await frame();
      const baseline=hash();
      input(1.35); await frame();
      const recent=hash(), recentCalls=probe.calls.splice(0);
      compare.click(); const reference=hash();
      compare.click(); const restored=hash(), exitCalls=probe.calls.splice(0);
      input(1.35); await frame();
      const fresh=hash();
      // While compare is active, the normal preview callback intentionally does
      // nothing. Exit must still read the current settings, not a cached render.
      compare.click();
      input(.75); await frame();
      probe.calls.length=0;
      compare.click(); const changedWhileComparing=hash(), secondExitCalls=probe.calls.splice(0);
      input(.75); await frame();
      const freshChanged=hash();
      return { baseline, recent, reference, restored, fresh, changedWhileComparing, freshChanged,
        recentPreviewSizes:recentCalls.filter(call=>call.preview).map(call=>[call.width,call.height]),
        exitCalls,secondExitCalls,cpuVisible:getComputedStyle(document.getElementById('canvas')).display!=='none',
        glVisible:getComputedStyle(document.getElementById('glCanvas')).display!=='none',
        border:document.getElementById('sprocketPreviewBtn').getAttribute('aria-pressed') };
    })()`);
    console.log('compare preview:', JSON.stringify(result));
    if (!result.cpuVisible || result.glVisible || result.border !== 'true'
      || !result.recentPreviewSizes.some(([w,h])=>w*h<3600*2400)) fail('compare scenario did not use bounded CPU border preview');
    if (result.baseline === result.recent || result.reference === result.recent) fail('compare fixture did not distinguish changed settings/reference');
    if (result.restored !== result.recent || result.restored !== result.fresh) fail('compare exit restored stale pixels after recent slider input: '+JSON.stringify(result));
    if (result.changedWhileComparing !== result.freshChanged || result.freshChanged === result.fresh) fail('compare exit ignored settings changed while comparison was active: '+JSON.stringify(result));
    for (const calls of [result.exitCalls, result.secondExitCalls]) {
      if (!calls.some(call=>call.preview) || calls.some(call=>call.full)) fail('compare exit forced full CPU adjustment instead of bounded preview: '+JSON.stringify(calls));
    }

    await evaluate(`(async()=>{
      const {Histogram}=await import('/src/silvercore/ui/Histogram.js');
      const originalDraw=Histogram.prototype.draw, probe=window.__comparePreviewProbe;
      probe.histogramDraws=0;probe.gpuFulls=0;probe.histogramLastDrawAt=0;
      Histogram.prototype.draw=function(...args){
        probe.histogramDraws++;probe.histogramLastDrawAt=performance.now();
        const stack=new Error().stack||'';
        if(stack.includes('updateFull'))probe.gpuFulls++;
        const result=originalDraw.apply(this,args), source=args[0], data=source.__image16?.data||source.data;
        let hash=2166136261;
        for(let i=0;i<data.length;i+=Math.max(1,Math.floor(data.length/4096)))hash=Math.imul(hash^data[i],16777619);
        probe.lastHistogramSource={width:source.width,height:source.height,hash:hash>>>0,
          path:stack.includes('renderHistogramForWebGL')?'gpu':stack.includes('renderBeforeAfterReference')?'reference':'other'};
        return result;
      };
      probe.histogramSnapshot=()=>{
        const canvas=document.getElementById('histogramCanvas');
        const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let hash=2166136261;for(let i=0;i<pixels.length;i++)hash=Math.imul(hash^pixels[i],16777619);
        return {hash:hash>>>0,width:canvas.width,height:canvas.height,source:probe.lastHistogramSource};
      };
      window.__restoreCompareHistogramProbe=()=>{
        Histogram.prototype.draw=originalDraw;delete window.__restoreCompareHistogramProbe;
      };
      const gl=document.getElementById('coreUseWebGL');if(!gl.checked)gl.click();
      const border=document.getElementById('sprocketPreviewBtn');if(border.getAttribute('aria-pressed')==='true')border.click();
    })()`);
    await waitFor('settled GPU source for compare histogram', `window.__comparePreviewProbe.gpuFulls>0 && getComputedStyle(document.getElementById('glCanvas')).display!=='none'`,120000);
    await waitFor('GPU histogram throttle elapsed', `performance.now()-window.__comparePreviewProbe.histogramLastDrawAt>270`);
    const gpu = await evaluate(`(async()=>{
      const probe=window.__comparePreviewProbe, slider=document.getElementById('wbR');
      slider.value='.9';slider.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const adjusted=probe.histogramSnapshot(), beforeDraws=probe.histogramDraws, start=performance.now();
      const compare=document.getElementById('beforeAfterBtn');compare.click();
      const reference=probe.histogramSnapshot(), referenceDraws=probe.histogramDraws;
      compare.click();
      return {adjusted,reference,restored:probe.histogramSnapshot(),beforeDraws,referenceDraws,
        restoredDraws:probe.histogramDraws,elapsedMs:performance.now()-start,
        gpuVisible:getComputedStyle(document.getElementById('glCanvas')).display!=='none'};
    })()`);
    await waitFor('fresh same-settings GPU histogram', `performance.now()-window.__comparePreviewProbe.histogramLastDrawAt>270`);
    gpu.fresh = await evaluate(`(async()=>{
      const slider=document.getElementById('wbR');slider.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return window.__comparePreviewProbe.histogramSnapshot();
    })()`);
    console.log('compare GPU histogram:',JSON.stringify(gpu));
    if(!gpu.gpuVisible || gpu.fresh.hash===gpu.reference.hash || gpu.referenceDraws<=gpu.beforeDraws
      || gpu.fresh.source.path!=='gpu') fail('GPU comparison histogram fixture did not exercise the reference');
    if(JSON.stringify(gpu.fresh)!==JSON.stringify(gpu.restored) || gpu.restoredDraws<=gpu.referenceDraws) fail('GPU compare exit did not restore a fresh same-settings histogram: '+JSON.stringify(gpu));
    await evaluate(`(() => {
      window.__restoreCompareHistogramProbe();
      const probe=window.__comparePreviewProbe;probe.calls.length=0;
      const gl=document.getElementById('coreUseWebGL');if(gl.checked)gl.click();
      const border=document.getElementById('sprocketPreviewBtn');if(border.getAttribute('aria-pressed')!=='true')border.click();
    })()`);
    await waitFor('CPU border restored before close', `window.__comparePreviewProbe.calls.some(call=>call.full && call.width*call.height>=3600*2400) && getComputedStyle(document.getElementById('glCanvas')).display==='none'`,120000);

    await evaluate(`document.getElementById('beforeAfterBtn').click();document.getElementById('studioNewSession').click()`);
    await waitFor('new-session confirmation', `!!document.querySelector('[data-app-dialog-confirm]')`);
    await evaluate(`document.querySelector('[data-app-dialog-confirm]').click()`);
    await waitFor('compare session closed', `!document.body.classList.contains('studio-ready') && document.getElementById('beforeAfterBtn').disabled`);
    const released = await evaluate(`Object.fromEntries(Object.entries(window.__comparePreviewProbe.canvases).map(([key,canvas])=>[key,[canvas.width,canvas.height]]))`);
    if (!released.frame || !released.scratch || !released.before
      || Object.values(released).some(([w,h])=>w*h>1)) fail('session close retained compare/border canvas backing stores: '+JSON.stringify(released));
    await evaluate(`(() => {
      const crop=document.getElementById('studioImportAutoCrop'); if(crop.checked) crop.click();
      const transfer=new DataTransfer(); transfer.items.add(window.__comparePreviewFile);
      const input=document.getElementById('fileInput'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor('compare session reopened', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`,120000);
    const regenerated = await evaluate(`(async()=>{
      const border=document.getElementById('sprocketPreviewBtn'); if(border.getAttribute('aria-pressed')!=='true')border.click();
      const slider=document.getElementById('wbR');slider.value='1.2';slider.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const before=window.__comparePreviewHash();
      const compare=document.getElementById('beforeAfterBtn');compare.click();compare.click();
      return {before,after:window.__comparePreviewHash(),canvases:Object.fromEntries(Object.entries(window.__comparePreviewProbe.canvases).map(([key,c])=>[key,[c.width,c.height]]))};
    })()`);
    if (regenerated.before !== regenerated.after
      || Object.values(regenerated.canvases).some(([w,h])=>w*h<=1)) fail('border/compare canvases did not regenerate after reopen: '+JSON.stringify(regenerated));
    console.log('ok: current CPU preview survives compare, changes during compare, and close/reopen; no forced full adjustment');
  } finally {
    await evaluate(`window.__restoreCompareHistogramProbe?.()`);
    await evaluate(`window.__restoreComparePreviewProbe?.()`);
  }
}
