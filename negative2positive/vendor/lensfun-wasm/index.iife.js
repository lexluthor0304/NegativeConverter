"use strict";
var LensfunWasm = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    LF_MODIFY_DISTORTION: () => LF_MODIFY_DISTORTION,
    LF_MODIFY_GEOMETRY: () => LF_MODIFY_GEOMETRY,
    LF_MODIFY_PERSPECTIVE: () => LF_MODIFY_PERSPECTIVE,
    LF_MODIFY_SCALE: () => LF_MODIFY_SCALE,
    LF_MODIFY_TCA: () => LF_MODIFY_TCA,
    LF_MODIFY_VIGNETTING: () => LF_MODIFY_VIGNETTING,
    LF_SEARCH_LOOSE: () => LF_SEARCH_LOOSE,
    LF_SEARCH_SORT_AND_UNIQUIFY: () => LF_SEARCH_SORT_AND_UNIQUIFY,
    LensfunClient: () => LensfunClient,
    createLensfun: () => createLensfun
  });
  var LF_SEARCH_LOOSE = 1;
  var LF_SEARCH_SORT_AND_UNIQUIFY = 2;
  var LF_MODIFY_TCA = 1;
  var LF_MODIFY_VIGNETTING = 2;
  var LF_MODIFY_DISTORTION = 8;
  var LF_MODIFY_GEOMETRY = 16;
  var LF_MODIFY_SCALE = 32;
  var LF_MODIFY_PERSPECTIVE = 64;
  var globalScope = globalThis;
  function requiredString(value, field) {
    if (!value || value.trim().length === 0) {
      throw new Error(`[lensfun-wasm] ${field} is required`);
    }
    return value;
  }
  function toFlag(value) {
    return value ? 1 : 0;
  }
  function toGrid(size, step) {
    return Math.floor((size - 1) / step) + 1;
  }
  function requirePositiveInt(value, field) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`[lensfun-wasm] ${field} must be a positive integer`);
    }
    return value;
  }
  async function loadScript(url) {
    if (typeof document === "undefined") {
      throw new Error("[lensfun-wasm] moduleJsUrl in non-browser runtime requires moduleFactory instead");
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`[lensfun-wasm] failed to load ${url}`));
      document.head.appendChild(script);
    });
  }
  async function resolveFactory(options) {
    if (options.moduleFactory) {
      return options.moduleFactory;
    }
    const existing = globalScope.createLensfunCoreModule;
    if (typeof existing === "function") {
      return existing;
    }
    if (options.moduleJsUrl) {
      if (typeof document !== "undefined") {
        await loadScript(options.moduleJsUrl);
        const globalFactory = globalScope.createLensfunCoreModule;
        if (typeof globalFactory === "function") {
          return globalFactory;
        }
      } else {
        const imported = await import(
          /* @vite-ignore */
          options.moduleJsUrl
        );
        const loaded = imported.default ?? imported.createLensfunCoreModule;
        if (typeof loaded === "function") {
          return loaded;
        }
      }
    }
    throw new Error(
      "[lensfun-wasm] module factory not found. Provide moduleFactory or preload dist/assets/lensfun-core.js (global createLensfunCoreModule)."
    );
  }
  function makeLocateFile(options) {
    return (path, prefix) => {
      if (options.locateFile) {
        return options.locateFile(path, prefix);
      }
      if (path.endsWith(".wasm") && options.wasmUrl) {
        return options.wasmUrl;
      }
      if (path.endsWith(".data") && options.dataUrl) {
        return options.dataUrl;
      }
      return `${prefix}${path}`;
    };
  }
  function parseJsonPtr(module, freePtr, ptr) {
    if (!ptr) {
      return [];
    }
    const raw = module.UTF8ToString(ptr);
    freePtr(ptr);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw);
  }
  function bindFns(module) {
    return {
      init: module.cwrap("lfw_init", "number", ["string"]),
      dispose: module.cwrap("lfw_dispose", null, []),
      findLensesJson: module.cwrap("lfw_find_lenses_json", "number", ["string", "string", "string", "string", "number"]),
      findCamerasJson: module.cwrap("lfw_find_cameras_json", "number", ["string", "string", "number"]),
      availableMods: module.cwrap("lfw_available_mods", "number", ["number", "number"]),
      buildGeometryMap: module.cwrap("lfw_build_geometry_map", "number", [
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number"
      ]),
      buildTcaMap: module.cwrap("lfw_build_tca_map", "number", [
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number"
      ]),
      buildVignettingMap: module.cwrap("lfw_build_vignetting_map", "number", [
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
        "number"
      ]),
      freePtr: module.cwrap("lfw_free", null, ["number"])
    };
  }
  var LensfunClient = class {
    constructor(module, fns) {
      this.disposed = false;
      this.module = module;
      this.fns = fns;
    }
    dispose() {
      if (this.disposed) {
        return;
      }
      this.fns.dispose();
      this.disposed = true;
    }
    searchLenses(input) {
      this.ensureAlive();
      const lensModel = requiredString(input.lensModel, "lensModel");
      const ptr = this.fns.findLensesJson(
        input.cameraMaker ?? "",
        input.cameraModel ?? "",
        input.lensMaker ?? "",
        lensModel,
        input.searchFlags ?? LF_SEARCH_SORT_AND_UNIQUIFY
      );
      return parseJsonPtr(this.module, this.fns.freePtr, ptr);
    }
    searchCameras(input) {
      this.ensureAlive();
      const ptr = this.fns.findCamerasJson(
        input.maker ?? "",
        input.model ?? "",
        input.searchFlags ?? 0
      );
      return parseJsonPtr(this.module, this.fns.freePtr, ptr);
    }
    getAvailableModifications(lensHandle, crop) {
      this.ensureAlive();
      return this.fns.availableMods(lensHandle, crop);
    }
    buildCorrectionMaps(input) {
      this.ensureAlive();
      const width = requirePositiveInt(input.width, "width");
      const height = requirePositiveInt(input.height, "height");
      const step = requirePositiveInt(input.step ?? 1, "step");
      const gridWidth = toGrid(width, step);
      const gridHeight = toGrid(height, step);
      const geometry = this.runFloatMap(
        gridWidth * gridHeight * 2,
        this.fns.buildGeometryMap,
        input.lensHandle,
        input.focal,
        input.crop,
        width,
        height,
        toFlag(input.reverse),
        step
      );
      const result = {
        gridWidth,
        gridHeight,
        step,
        geometry
      };
      if (input.includeTca) {
        result.tca = this.runFloatMap(
          gridWidth * gridHeight * 6,
          this.fns.buildTcaMap,
          input.lensHandle,
          input.focal,
          input.crop,
          width,
          height,
          toFlag(input.reverse),
          step
        );
      }
      if (input.includeVignetting) {
        if (typeof input.aperture !== "number") {
          throw new Error("[lensfun-wasm] aperture is required for vignetting map");
        }
        result.vignetting = this.runFloatMap(
          gridWidth * gridHeight * 3,
          this.fns.buildVignettingMap,
          input.lensHandle,
          input.focal,
          input.crop,
          input.aperture,
          input.distance ?? 1e3,
          width,
          height,
          toFlag(input.reverse),
          step
        );
      }
      return result;
    }
    runFloatMap(size, fn, ...args) {
      const bytes = size * 4;
      const ptr = this.module._malloc(bytes);
      try {
        const rc = fn(...args, ptr, size);
        if (rc !== 0) {
          throw new Error(`[lensfun-wasm] native map builder failed with code ${rc}`);
        }
        const start = ptr >> 2;
        const end = start + size;
        const out = new Float32Array(size);
        out.set(this.module.HEAPF32.subarray(start, end));
        return out;
      } finally {
        this.module._free(ptr);
      }
    }
    ensureAlive() {
      if (this.disposed) {
        throw new Error("[lensfun-wasm] LensfunClient is disposed");
      }
    }
  };
  async function createLensfun(options = {}) {
    const factory = await resolveFactory(options);
    if (!factory) {
      throw new Error("[lensfun-wasm] failed to resolve module factory");
    }
    const module = await factory({
      locateFile: makeLocateFile(options)
    });
    const fns = bindFns(module);
    if (options.autoInitDb ?? true) {
      const dbPath = options.dbPath ?? "/lensfun-db";
      const rc = fns.init(dbPath);
      if (rc !== 0) {
        throw new Error(`[lensfun-wasm] lfw_init failed with code ${rc} for ${dbPath}`);
      }
    }
    return new LensfunClient(module, fns);
  }
  return __toCommonJS(src_exports);
})();
//# sourceMappingURL=index.iife.js.map