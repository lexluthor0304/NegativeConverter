// Test-only helpers for the display-resolution sessions of main.js (#249):
// the names of its small pure helpers, which fixtures extract with the
// functions they test, and stubs for what a fixture that does not exercise
// the tiers needs defined. Never imported by the app.

import { displayFilterOf, displayResampleMode } from './displayPreview.js';

// Helpers every reader of the base, the source or the working planes calls,
// and those every frame that lands goes through (the live dodge composite and
// the exact displays of #254's follow-up).
export const DISPLAY_SESSION_HELPERS = [
  'baseSizeSource', 'conversionSourceSize', 'releasedPlane', 'isReleasedPlane', 'workingPlanes', 'sessionGeometryKey',
  'reviveFrameDescriptor', 'autoWbSampleKey', 'pendingConversionTarget', 'displayFrameReference',
  'applyPreviewFrame', 'liveCompositeOf', 'noteExactFrame', 'noteExactDisplay', 'exactDisplayFilterK'
];

export function displaySessionDiagnosticsStub() {
  return {
    tierA: 0, tierB: 0, demotions: 0, spills: 0, spillWrites: 0, spillFailures: 0, ramHits: 0, spillHits: 0, storeHits: 0,
    recipeChanged: 0, provisional: 0, baseDecodes: 0, sourceBuilds: 0, baseMismatches: 0, baseFailures: 0, selfChecks: 0,
    selfCheckMismatches: 0, sampleMisses: 0, fills: 0, fillSkips: 0, fillsKept: 0, unsettled: 0, force: null
  };
}

// A spill that holds nothing.
export function emptyDisplayProxySpill() {
  return {
    enabled: false, has: () => false, proxyKey: () => null, meta: () => null,
    put: async () => false, get: async () => null, delete: async () => false,
    retain: async () => {}, clear: async () => {}, bytes: 0, size: 0, stats: {}, settled: async () => {}
  };
}

// Stubs for a fixture whose photos never take a display form: no tier is
// captured, nothing spills, and nothing waits on the original.
export function displaySessionStubs(overrides = {}) {
  return {
    cpuPreviewRenderer: { whenIdle: () => null },
    displayViewportPending: false, prepareBeforeAfterReference: () => {},
    captureSnapshotWithPendingDisplay: () => null,
    coreReprocessSettledListeners: new Set(),
    glBorder: { photo: null, smear: null, source: null, smearSource: null, smearFlight: 0, smearToken: 0 },
    noteCoreReprocessSettled: () => {},
    ensureSourcePromise: null, preparingOriginal: 0, displaySourceRequest: null,
    displaySessionDiagnostics: displaySessionDiagnosticsStub(),
    displayProxySpill: emptyDisplayProxySpill(),
    isGeometryFrame: image => Boolean(image?.__geometryFrame),
    geometryMemo: new WeakMap(),
    describeBase: base => (base ? { width: base.width, height: base.height, has16: Boolean(base.__image16), released: true } : null),
    captureDisplaySession: () => null, tierASession: () => null, spillDisplaySession: () => false,
    coldHistory: entries => entries.filter(entry => !entry.dustDelta).map(entry => ({ ...entry, refs: { cold: true } })),
    requestSourceForDisplay: () => {}, ensureSource: async () => true, ensureBase: async () => null,
    // Every photo has its base: no colour-analysis sample is ever missing.
    colorAnalysisSampleMissing: () => false, ensureColorAnalysisSample: async () => true,
    colorAnalysisSampleMisses: new WeakSet(), analysisSamplesFor: () => new Map(), autoWbFromRecords: new WeakSet(),
    // #278: no source or level carries a lens.
    lensCorrectedSources: new WeakMap(), displayLevelLenses: new WeakMap(),
    forgetDisplayProxies: () => {}, readSpilledDisplaySession: async () => null,
    // The planes are always the geometry the settings name (R1-065), and no
    // session is left unsettled without its base (R2-002).
    geometryOutOfStep: () => false, rememberUnsettledDisplaySession: () => false,
    fillDisplayProxy: async () => false, displayProxyFillPlan: async () => null,
    // Part 3: no persistent store.
    displayProxyStore: null, persistDisplayProxy: async () => false, readStoredDisplaySession: async () => null,
    persistPresentationPreview: async () => false, presentStoredPreview: async () => {},
    // No stroke is painted: the registries of exact displays and composites.
    exactFrames: new WeakMap(), exactDisplays: new WeakMap(), liveComposites: new WeakMap(), convertedPixelsRevision: 0,
    displayFilterOf, displayResampleMode,
    ...overrides
  };
}
