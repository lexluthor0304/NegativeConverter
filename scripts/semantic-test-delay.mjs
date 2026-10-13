// Keep the real model and payload, but make the fixture's semantic analysis
// slower than a fixed post-import sleep. Worker control probes stay immediate.
export async function delaySemanticInference(evaluate, milliseconds = 4000) {
  await evaluate(`(() => {
    const Worker = window.Worker;
    const delayed = window.__semanticTestDelay = { queued: 0, posted: 0 };
    window.Worker = class extends Worker {
      constructor(url, options) {
        super(url, options);
        if (!String(url).includes('semanticWorker')) return;
        const post = this.postMessage.bind(this), terminate = this.terminate.bind(this);
        let ended = false;
        this.terminate = () => { ended = true; terminate(); };
        this.postMessage = (message, transfer) => {
          if (!message?.image) return post(message, transfer);
          delayed.queued++;
          setTimeout(() => { if (!ended) { delayed.posted++; post(message, transfer); } }, ${JSON.stringify(milliseconds)});
        };
      }
    };
  })()`);
}

// Start comparisons from the same settled recipe. A manual edit or export
// freezes/cancels unfinished semantic analysis, so a sleep is not a barrier.
export async function waitForSemanticFixture({ evaluate, waitFor, fail, ready, label }) {
  await waitFor(`${label}: colour analysis settled`, `${ready} && !document.body.dataset.studioDetecting && !window.__ncTwoStage.status().semanticPending && !window.__ncAnalysis.converting()`, 180_000);
  const delayed = await evaluate('window.__semanticTestDelay || null');
  if (delayed && (!delayed.queued || delayed.posted !== delayed.queued)) {
    fail(`${label}: delayed semantic analysis was skipped: ${JSON.stringify(delayed)}`);
  }
}
