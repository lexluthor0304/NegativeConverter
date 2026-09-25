// #261: once the loading overlay has been shown and hidden it must not keep
// animating (WebKit wakes the main thread for its steps() animations whatever
// their visibility). True when no animation or transition under an overlay is
// running and every overlay has left rendering.
export const loadingOverlayIdle = `(() => {
  const running = document.getAnimations().filter(animation => animation.playState === 'running'
    && animation.effect?.target?.closest?.('.loading-overlay'));
  return running.length === 0 && [...document.querySelectorAll('.loading-overlay')]
    .every(overlay => !overlay.classList.contains('visible') && getComputedStyle(overlay).visibility === 'hidden');
})()`;

// What is still running, for the failure message.
export const loadingOverlayAnimations = `document.getAnimations()
  .filter(animation => animation.effect?.target?.closest?.('.loading-overlay'))
  .map(animation => ({ name: animation.animationName || animation.transitionProperty, state: animation.playState,
    target: animation.effect.target.className?.baseVal ?? animation.effect.target.className }))`;

// Waits (the fade takes a few hundred milliseconds) and fails with details.
export async function expectLoadingOverlayIdle({ evaluate, waitFor, fail }, label, timeout = 10_000) {
  if (await waitFor(`${label}: hidden loading overlay idle`, loadingOverlayIdle, timeout, { soft: true })) return;
  fail(`${label}: the hidden loading overlay keeps animating: ` + JSON.stringify(await evaluate(loadingOverlayAnimations)));
}
