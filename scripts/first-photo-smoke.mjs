// #236 in a real browser: the first photo converts before its frame
// detection ends, no full-window "Detecting…" overlay covers an import or a
// photo switch, the filmstrip stays navigable during the detection tail, and a
// default import creates neither the MI-GAN repair worker nor (for a roll of
// three or more) a semantic worker. Opening the Repair tab loads MI-GAN.
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// Installed before the app's own scripts on every navigation of this scenario.
const PROBE = `(() => {
  if (window.__firstPhotoProbe) return;
  const probe = window.__firstPhotoProbe = { workers: [], databases: [], overlay: [], detecting: [], maxOpacity: 0 };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) { probe.workers.push(String(url)); super(url, options); }
  };
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, ...rest) => { probe.databases.push(String(name)); return open(name, ...rest); };
  new MutationObserver(records => {
    for (const record of records) {
      const target = record.target;
      if (record.attributeName === 'class' && target.classList?.contains('loading-overlay')) {
        const visible = target.classList.contains('visible');
        if (probe.overlay.at(-1)?.visible !== visible) {
          probe.overlay.push({ visible, title: target.querySelector('.loading-phase-text')?.textContent || '' });
        }
      }
      if (target === document.body && record.attributeName === 'data-studio-detecting' && document.body.dataset.studioDetecting) {
        // Optionally navigate from inside the tail, the way a user clicks the strip.
        if (probe.clickOnTail != null) {
          const index = probe.clickOnTail;
          probe.clickOnTail = null;
          setTimeout(() => {
            probe.overlay = [];
            probe.clickedDuring = Boolean(document.body.dataset.studioDetecting);
            document.querySelector('.file-list-name[data-index="' + index + '"]')?.click();
          }, 0);
        }
        probe.detecting.push({
          value: document.body.dataset.studioDetecting,
          file: document.getElementById('studioFilename')?.textContent || '',
          feedbackHidden: document.getElementById('studioPhotoSwitchFeedback')?.hidden,
          stripInert: document.getElementById('studioFilmstrip')?.inert,
          panelInert: document.getElementById('controlsPanel')?.inert,
          positive: document.body.classList.contains('studio-ready'),
          overlayVisible: Boolean(document.querySelector('.loading-overlay.visible'))
        });
      }
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class', 'data-studio-detecting'] });
  const sample = () => {
    const overlay = document.querySelector('.loading-overlay');
    if (overlay) probe.maxOpacity = Math.max(probe.maxOpacity, Number(getComputedStyle(overlay).opacity));
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`;

export async function runFirstPhotoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = join(root, 'negative2positive', 'test-fixtures');
  const files = ['negative-sample.jpg', 'negative-sample-2.jpg', 'negative-plain.png'].map(name => join(fixtures, name));
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  try {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('first photo boot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop') && /No model loaded/.test(document.getElementById('dustAiStatus')?.textContent)`);
    await installDialogAutoAccept();
    await wait(300);
    const probeReset = `(() => { const p = window.__firstPhotoProbe; p.workers = []; p.databases = []; p.overlay = []; p.detecting = []; p.maxOpacity = 0; })()`;
    const importFiles = async (paths) => {
      const doc = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
      await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
    };
    const read = () => evaluate(`JSON.parse(JSON.stringify(window.__firstPhotoProbe))`);
    const checkTail = (probe, label) => {
      if (probe.overlay.some(entry => /Detecting the image area/.test(entry.title))) fail(`${label}: a full-window detection overlay appeared: ${JSON.stringify(probe.overlay)}`);
      for (const entry of probe.detecting) {
        if (!entry.positive || !entry.feedbackHidden || entry.stripInert || !entry.panelInert || entry.overlayVisible) {
          fail(`${label}: the detection tail must show the positive, keep the strip navigable and the panel locked: ${JSON.stringify(entry)}`);
        }
      }
    };

    // 1. One colour photo: convert first, detect in the background, no MI-GAN.
    await evaluate(probeReset);
    await importFiles([files[0]]);
    await waitFor('first photo settled', `${ready} && !!document.getElementById('studioFilename').textContent`, 150_000);
    await wait(3000);
    let probe = await read();
    console.log('first photo evidence:', JSON.stringify({ detecting: probe.detecting, overlay: probe.overlay, maxOpacity: probe.maxOpacity, workers: probe.workers.map(url => url.split('/').pop().split('?')[0]) }));
    if (!probe.detecting.length) fail('the first photo was not revealed before its detections ended');
    checkTail(probe, 'first photo');
    const shown = probe.overlay.filter(entry => entry.visible).length;
    if (shown > 1) fail('a first import shows the overlay at most once: ' + JSON.stringify(probe.overlay));
    if (probe.workers.some(url => /aiInpaintWorker/.test(url))) fail('a default import must not start the MI-GAN worker');
    if (probe.databases.includes('nc_ai_models')) fail('a default import must not read the AI model store');
    const idle = await evaluate(`document.getElementById('dustAiStatus').textContent`);
    if (!/No model loaded/.test(idle)) fail('MI-GAN loaded without intent: ' + idle);
    if (await evaluate(`[...document.querySelectorAll('.toast-message')].some(t => /AI repair model loaded/.test(t.textContent))`)) fail('an implicit model load must not toast');
    // Opening the Repair tab is the intent that loads it.
    await evaluate(`document.getElementById('studioTab-repair').click()`);
    await waitFor('Repair tab starts the MI-GAN load', `/Loading model|Model ready/.test(document.getElementById('dustAiStatus').textContent)`, 30_000);
    await waitFor('MI-GAN ready after the Repair tab', `/Model ready/.test(document.getElementById('dustAiStatus').textContent)`, 180_000);
    probe = await read();
    if (!probe.workers.some(url => /aiInpaintWorker/.test(url))) fail('the Repair tab did not start the MI-GAN worker');
    if (await evaluate(`[...document.querySelectorAll('.toast-message')].some(t => /AI repair model loaded/.test(t.textContent))`)) fail('an implicit model load must not toast');
    console.log('ok: first photo converts before detection ends, no detection overlay, MI-GAN loads on the Repair tab only');

    // 2. The strip is clicked as soon as the first photo's provisional
    // positive shows (normally inside its detection tail). The unanalysed
    // second photo is a cold switch: its switch surface lifts at its own
    // provisional paint, and no full-window overlay appears.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('first photo reboot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(`${probeReset}; window.__firstPhotoProbe.clickOnTail = 1`);
    await importFiles(files.slice(0, 2));
    await waitFor('cold switch from the detection tail settled', `(() => {
      const tails = window.__firstPhotoProbe.detecting;
      return ${ready} && tails.length >= 2 && tails.at(-1).file !== tails[0].file
        && document.getElementById('studioFilename').textContent === tails.at(-1).file;
    })()`, 150_000);
    probe = await read();
    console.log('cold switch evidence:', JSON.stringify({ clickedDuringTail: probe.clickedDuring, detecting: probe.detecting, overlay: probe.overlay }));
    checkTail(probe, 'cold switch');
    if (probe.overlay.some(entry => entry.visible)) fail('a cold switch must not raise the full-window overlay: ' + JSON.stringify(probe.overlay));
    console.log('ok: cold switch reveals the provisional positive with a navigable filmstrip');

    // 3. Three photos with automatic roll analysis: the first photo skips the
    // semantic inference whose result the roll would discard.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('roll boot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(probeReset);
    await importFiles(files);
    await waitFor('roll first photo settled', `${ready} && !!document.getElementById('studioFilename').textContent`, 150_000);
    await wait(2000);
    probe = await read();
    const semantic = probe.workers.filter(url => /semanticWorker/.test(url)).length;
    console.log('roll import evidence:', JSON.stringify({ semantic, workers: probe.workers.map(url => url.split('/').pop().split('?')[0]) }));
    if (semantic) fail('a roll import must not run the semantic model for its first photo');
    if (probe.workers.some(url => /aiInpaintWorker/.test(url))) fail('a roll import must not start the MI-GAN worker');
    console.log('ok: a three-photo import creates no semantic or MI-GAN worker');
  } finally {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.result.identifier });
  }
}
