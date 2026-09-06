let localLensfunAssetsPromise = null;

export async function loadLocalLensfunAssets() {
  if (!localLensfunAssetsPromise) {
    localLensfunAssetsPromise = Promise.all([
      import('@neoanaloglabkk/lensfun-wasm'),
      import('@neoanaloglabkk/lensfun-wasm/core'),
      import('@neoanaloglabkk/lensfun-wasm/core-wasm?url'),
      import('@neoanaloglabkk/lensfun-wasm/core-data?url')
    ]).then(([api, core, wasm, data]) => ({
      createLensfun: api.createLensfun,
      searchFlags: Number.isFinite(api.LF_SEARCH_SORT_AND_UNIQUIFY)
        ? api.LF_SEARCH_SORT_AND_UNIQUIFY
        : 2,
      moduleFactory: core.default || core.createLensfunCoreModule,
      wasmUrl: wasm.default || wasm,
      dataUrl: data.default || data
    })).catch((err) => {
      // Don't cache the failure: a transient chunk-fetch error would otherwise
      // disable lens correction for the rest of the session. Matches how the
      // other lazy loaders (export encoders, JSZip, auto-frame) behave.
      localLensfunAssetsPromise = null;
      throw err;
    });
  }

  return localLensfunAssetsPromise;
}
