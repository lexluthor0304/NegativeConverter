// WebGL2 renderer of the Studio display preview (#239): step3Program on the exact
// 8-bit worker frame, and applyProgram on the prepared display-size negative while
// SilverCore controls are ahead of that frame. main.js owns when each draws; this
// module owns the GL objects. See previewShader.js for the stages.

import {
  VERTEX_SHADER_300, STEP3_FRAGMENT_SHADER, APPLY_FRAGMENT_SHADER, STEP3_MODES_FRAGMENT_SHADER, APPLY_MODES_FRAGMENT_SHADER,
  UNITS, TABLE_TEXTURE_SIZE, STEP3_CURVE_SIZE, STEP3_CURVE_ROWS, RESCUE_TONE_SIZE, RESCUE_OFFSET_BINS,
} from './previewShader.js';
import { packTableTexture, packHueWeights, packLinearLut, applyUniforms, packCurveRow, wholeFrame, displayModesSupported, TABLE_ENTRIES } from './previewTables.js';
import { SELF_TEST_SIZE, compareSelfTest, compareDisplayModes } from './gpuPreviewSelfTest.js';

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

// The fragment stage must hold the CPU's integers and fp32 floats: 23 mantissa bits
// for highp float and 32-bit highp int (a signed range of [-2^31, 2^31 - 1]).
export function webgl2PrecisionOk(gl) {
  const float = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const int = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT);
  return Boolean(float && float.precision >= 23 && int && int.rangeMin >= 31 && int.rangeMax >= 30);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function linkNow(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return { program, vs, fs };
}

function linkError(gl, { program, vs, fs }) {
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  return gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program) || 'Unknown program link error';
}

function locations(gl, program, names) {
  const out = {};
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  out.a_pos = gl.getAttribLocation(program, 'a_pos');
  return out;
}

const STEP3_UNIFORMS = ['u_image', 'u_curve', 'u_wb', 'u_vib', 'u_cmy'];
const APPLY_UNIFORMS = [
  'u_prepared', 'u_prepared8', 'u_mode', 'u_mix', 'u_preSatOn', 'u_preSat', 'u_preSatRamp', 'u_positiveOn', 'u_gain',
  'u_posWb', 'u_stopsOn', 'u_stops', 'u_linearLut', 'u_toneLut', 'u_hslOn', 'u_hueSkip', 'u_bandActive', 'u_hueShift',
  'u_satFactor', 'u_hueWeights', 'u_lut3dOn', 'u_lut3dStr', 'u_lut3dInvStr', 'u_lut3d', 'u_satOn', 'u_sat', 'u_satRamp',
  'u_paperOn', 'u_paperLut', 'u_curve', 'u_wb', 'u_vib', 'u_cmy',
];
// The display modes' uniforms (#253), in both mode variants.
const MODE_UNIFORMS = [
  'u_frame', 'u_rescueOn', 'u_fogOn', 'u_fog', 'u_fogOffset', 'u_fogScale', 'u_fogLimit', 'u_fraction', 'u_local',
  'u_rescueMean', 'u_offsetsOn', 'u_rescueOffsets', 'u_rescueTone', 'u_lookMatrixOn', 'u_lookMatrix', 'u_lookOffset',
  'u_lookCurvesOn', 'u_roundBeforeCmy',
];

export function createGpuPreviewRenderer(gl) {
  if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
    throw new Error('The GPU preview renderer needs a WebGL2 context');
  }
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  // Unpack state is per context and never changes after this.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  function texture(target = gl.TEXTURE_2D) {
    const handle = gl.createTexture();
    gl.bindTexture(target, handle);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return handle;
  }

  function bind(unit, handle, target = gl.TEXTURE_2D) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, handle);
  }

  // Allocation is the one place an out-of-memory can surface, so it keeps the only
  // error check, for frame-sized textures only (a getError is a GPU round trip). A
  // lost context reports itself here as well; its own events restore the renderer,
  // so it is not an error.
  function checkAllocation(what, width, height) {
    if (width * height <= TABLE_TEXTURE_SIZE * TABLE_TEXTURE_SIZE) return !gl.isContextLost();
    const code = gl.getError();
    if (code === gl.NO_ERROR) return true;
    if (code === gl.CONTEXT_LOST_WEBGL || gl.isContextLost()) return false;
    throw new Error(`WebGL ${what} allocation error code: ${code}`);
  }

  // A 256 × 256 integer table texture (tone curves, paper, grey table, ramps).
  function tableTexture(internalFormat) {
    const handle = texture();
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, TABLE_TEXTURE_SIZE, TABLE_TEXTURE_SIZE);
    return handle;
  }

  // ---- Step 3 (compiled at once: it is the display of every exact frame) ----
  const step3Linked = linkNow(gl, VERTEX_SHADER_300, STEP3_FRAGMENT_SHADER);
  const step3Error = linkError(gl, step3Linked);
  if (step3Error) throw new Error(`Step-3 shader failed: ${step3Error}`);
  const step3 = { program: step3Linked.program, loc: locations(gl, step3Linked.program, STEP3_UNIFORMS) };
  gl.deleteShader(step3Linked.vs);
  gl.deleteShader(step3Linked.fs);

  const exact = { handle: texture(), width: 0, height: 0 };
  // Row 0: the RGB curves; row 1: the look's curves (#253), identity without a look.
  const curve = { handle: texture(), allocated: false, look: null };
  const curveBytes = new Uint8Array(STEP3_CURVE_SIZE * 4);
  const identityRow = packCurveRow(null);

  // Inputs the apply program reads: a live set, and a scratch set for the self-test.
  function createInputs() {
    return {
      prepared: null, // { handle, width, height, eight }
      stops: null, // { handle, width, height }
      toneLut: tableTexture(gl.RGBA16UI),
      paperLut: tableTexture(gl.RGBA16UI),
      paperKey: null,
      preSatRamp: tableTexture(gl.R16UI),
      preSatTable: null,
      satRamp: tableTexture(gl.R16UI),
      satTable: null,
      lut3d: null, // { handle, profile }
    };
  }

  let apply = null; // { program, vs, fs, loc, status }
  let statics = null; // hue weights, linear LUT, dummies
  let live = null;
  const packed = new Uint16Array(TABLE_ENTRIES * 4);

  function ensureStatics() {
    if (statics) return statics;
    const hue = packHueWeights();
    const hueWeights = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, hue.width, hue.height, 0, gl.RGBA, gl.FLOAT, hue.data);
    const linear = packLinearLut();
    const linearLut = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, linear.width, linear.height, 0, gl.RED, gl.FLOAT, linear.data);
    // Samplers with nothing to read still need a texture of their kind bound.
    const noStops = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
    const noProfile = texture(gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16UI, 1, 1, 1, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(3));
    const noPrepared = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(4));
    statics = { hueWeights, linearLut, noStops, noProfile, noPrepared };
    return statics;
  }

  function deleteInputs(inputs) {
    if (!inputs) return;
    for (const handle of [inputs.prepared?.handle, inputs.stops?.handle, inputs.toneLut, inputs.paperLut,
      inputs.preSatRamp, inputs.satRamp, inputs.lut3d?.handle]) {
      if (handle) gl.deleteTexture(handle);
    }
  }

  function uploadPreparedInto(inputs, { width, height, data16 = null, data8 = null }) {
    const eight = !data16;
    const previous = inputs.prepared;
    if (!previous || previous.width !== width || previous.height !== height || previous.eight !== eight) {
      if (previous) gl.deleteTexture(previous.handle);
      const handle = texture();
      gl.texStorage2D(gl.TEXTURE_2D, 1, eight ? gl.RGBA8UI : gl.RGBA16UI, width, height);
      inputs.prepared = { handle, width, height, eight };
      if (!checkAllocation('prepared negative', width, height)) return false;
    }
    bind(UNITS.image, inputs.prepared.handle);
    const pixels = eight ? new Uint8Array(data8.buffer, data8.byteOffset, data8.length) : data16;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA_INTEGER, eight ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT, pixels);
    return true;
  }

  function uploadStopsInto(inputs, stops, width, height) {
    if (!stops) {
      if (inputs.stops) gl.deleteTexture(inputs.stops.handle);
      inputs.stops = null;
      return true;
    }
    const previous = inputs.stops;
    if (!previous || previous.width !== width || previous.height !== height) {
      if (previous) gl.deleteTexture(previous.handle);
      const handle = texture();
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, height);
      inputs.stops = { handle, width, height };
      if (!checkAllocation('stops', width, height)) return false;
    }
    bind(UNITS.stops, inputs.stops.handle);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, stops);
    return true;
  }

  function uploadProfileInto(inputs, profile) {
    if ((inputs.lut3d?.profile || null) === (profile || null)) return;
    if (inputs.lut3d) gl.deleteTexture(inputs.lut3d.handle);
    inputs.lut3d = null;
    if (!profile) return;
    const handle = texture(gl.TEXTURE_3D);
    const size = profile.size;
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16UI, size, size, size, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, profile.bakedData);
    inputs.lut3d = { handle, profile };
  }

  function uploadTable(handle, unit, r, g, b) {
    bind(unit, handle);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_TEXTURE_SIZE, TABLE_TEXTURE_SIZE, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT,
      packTableTexture(r, g, b, packed));
  }

  function uploadRamp(handle, unit, table) {
    bind(unit, handle);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_TEXTURE_SIZE, TABLE_TEXTURE_SIZE, gl.RED_INTEGER, gl.UNSIGNED_SHORT, table);
  }

  // Everything one draw of `frame` reads, into `inputs`: the tone LUT every tick (or
  // the B&W grey table), the rest only when it changed.
  function uploadFrameTables(inputs, frame) {
    const { plan, mode, engine, params } = frame;
    const bw = mode === 'bw';
    const tone = bw ? plan.greyTable : plan.luts;
    uploadTable(inputs.toneLut, UNITS.toneLut, tone.r, tone.g, tone.b);
    if (!bw && plan.paper && inputs.paperKey !== plan.paper) {
      uploadTable(inputs.paperLut, UNITS.paperLut, plan.paper.r, plan.paper.g, plan.paper.b);
      inputs.paperKey = plan.paper;
    }
    const preSatTable = engine.preSaturationRamp(params);
    if (preSatTable && inputs.preSatTable !== preSatTable) {
      uploadRamp(inputs.preSatRamp, UNITS.preSatRamp, preSatTable);
      inputs.preSatTable = preSatTable;
    }
    const satTable = bw ? null : engine.saturationRamp(params);
    if (satTable && inputs.satTable !== satTable) {
      uploadRamp(inputs.satRamp, UNITS.satRamp, satTable);
      inputs.satTable = satTable;
    }
    uploadProfileInto(inputs, bw || !(plan.lutStrength > 0) ? null : engine.enhancedLut);
  }

  function useQuad(loc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc.a_pos);
    gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
  }

  function setStep3Uniforms(loc, { wb, vib, cmy }) {
    gl.uniform1i(loc.u_curve, UNITS.curve);
    gl.uniform3f(loc.u_wb, wb[0], wb[1], wb[2]);
    gl.uniform1f(loc.u_vib, vib);
    gl.uniform3f(loc.u_cmy, cmy[0], cmy[1], cmy[2]);
  }

  function drawApplyWith(inputs, frame, step3Values, curveHandle, viewport, curveState = curve, frameUv = null) {
    const s = ensureStatics();
    const stages = step3Values.stages;
    const program = wantsModes(stages) ? modes.apply : apply;
    const loc = program.loc;
    const u = applyUniforms({
      mode: frame.mode, params: frame.params, plan: frame.plan, positive: frame.engine.positiveAnalysis,
      hasStops: Boolean(inputs.stops), prepared8: Boolean(inputs.prepared?.eight),
    });
    if (program !== apply) uploadStages(stages, curveHandle, curveState);
    gl.useProgram(program.program);
    bind(UNITS.image, inputs.prepared ? inputs.prepared.handle : s.noPrepared);
    bind(UNITS.curve, curveHandle);
    bind(UNITS.toneLut, inputs.toneLut);
    bind(UNITS.paperLut, inputs.paperLut);
    bind(UNITS.lut3d, inputs.lut3d ? inputs.lut3d.handle : s.noProfile, gl.TEXTURE_3D);
    bind(UNITS.hueWeights, s.hueWeights);
    bind(UNITS.stops, inputs.stops ? inputs.stops.handle : s.noStops);
    bind(UNITS.linearLut, s.linearLut);
    bind(UNITS.preSatRamp, inputs.preSatRamp);
    bind(UNITS.satRamp, inputs.satRamp);
    gl.uniform1i(loc.u_prepared, UNITS.image);
    gl.uniform1i(loc.u_toneLut, UNITS.toneLut);
    gl.uniform1i(loc.u_paperLut, UNITS.paperLut);
    gl.uniform1i(loc.u_lut3d, UNITS.lut3d);
    gl.uniform1i(loc.u_hueWeights, UNITS.hueWeights);
    gl.uniform1i(loc.u_stops, UNITS.stops);
    gl.uniform1i(loc.u_linearLut, UNITS.linearLut);
    gl.uniform1i(loc.u_preSatRamp, UNITS.preSatRamp);
    gl.uniform1i(loc.u_satRamp, UNITS.satRamp);
    gl.uniform1i(loc.u_prepared8, u.prepared8);
    gl.uniform1i(loc.u_mode, u.mode);
    gl.uniform3f(loc.u_mix, u.mix[0], u.mix[1], u.mix[2]);
    gl.uniform1i(loc.u_preSatOn, u.preSatOn);
    gl.uniform1f(loc.u_preSat, u.preSat);
    gl.uniform1i(loc.u_positiveOn, u.positiveOn);
    gl.uniform1f(loc.u_gain, u.gain);
    gl.uniform3f(loc.u_posWb, u.posWb[0], u.posWb[1], u.posWb[2]);
    gl.uniform1i(loc.u_stopsOn, u.stopsOn);
    gl.uniform1i(loc.u_hslOn, u.hslOn);
    gl.uniform1i(loc.u_hueSkip, u.hueSkip);
    gl.uniform3i(loc.u_bandActive, u.bandActive[0], u.bandActive[1], u.bandActive[2]);
    gl.uniform3f(loc.u_hueShift, u.hueShift[0], u.hueShift[1], u.hueShift[2]);
    gl.uniform3f(loc.u_satFactor, u.satFactor[0], u.satFactor[1], u.satFactor[2]);
    gl.uniform1i(loc.u_lut3dOn, u.lut3dOn && inputs.lut3d ? 1 : 0);
    gl.uniform1f(loc.u_lut3dStr, u.lut3dStr);
    gl.uniform1f(loc.u_lut3dInvStr, u.lut3dInvStr);
    gl.uniform1i(loc.u_satOn, u.satOn);
    gl.uniform1f(loc.u_sat, u.sat);
    gl.uniform1i(loc.u_paperOn, u.paperOn);
    setStep3Uniforms(loc, step3Values);
    if (program !== apply) {
      const size = inputs.prepared || { width: 1, height: 1 };
      setModeUniforms(loc, stages, frameUv || wholeFrame(size.width, size.height));
    }
    useQuad(loc);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // `size`: the image texture's size, for the rescue's frame positions unless
  // `frameUv` (a region of a larger frame) is given.
  function drawStep3With(imageHandle, curveHandle, step3Values, viewport, size, curveState = curve, frameUv = null) {
    const stages = step3Values.stages;
    const program = wantsModes(stages) ? modes.step3 : step3;
    const loc = program.loc;
    if (program !== step3) uploadStages(stages, curveHandle, curveState);
    gl.useProgram(program.program);
    bind(UNITS.image, imageHandle);
    bind(UNITS.curve, curveHandle);
    gl.uniform1i(loc.u_image, UNITS.image);
    setStep3Uniforms(loc, step3Values);
    if (program !== step3) setModeUniforms(loc, stages, frameUv || wholeFrame(size.width, size.height));
    useQuad(loc);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function uploadCurveInto(handle, curves, allocated) {
    packCurveRow(curves, curveBytes);
    bind(UNITS.curve, handle);
    if (!allocated) {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, STEP3_CURVE_SIZE, STEP3_CURVE_ROWS);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, STEP3_CURVE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, identityRow);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STEP3_CURVE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, curveBytes);
  }

  // Row 1 of a curve texture: the look's curves, or identity.
  function uploadLookRowInto(handle, row) {
    bind(UNITS.curve, handle);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, STEP3_CURVE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, row || identityRow);
  }

  // ---- display modes (#253): two more program variants and their textures ----
  let modes = null; // { step3: linked, apply: linked, status, error }
  const stageTextures = {
    mean: texture(), meanKey: null,
    offsets: texture(), offsetsKey: null,
    tone: texture(), toneKey: null,
  };
  gl.bindTexture(gl.TEXTURE_2D, stageTextures.mean);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
  gl.bindTexture(gl.TEXTURE_2D, stageTextures.offsets);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, RESCUE_OFFSET_BINS, 1);
  gl.bindTexture(gl.TEXTURE_2D, stageTextures.tone);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, RESCUE_TONE_SIZE, 1);

  // Uploads what `stages` (displayStageUniforms) holds that this context lacks: the
  // mean grid per analysis, the colour table and tone curve per strength tick (1 KB
  // each), the look's curves per look. Keyed by the data's identity.
  function uploadStages(stages, curveHandle, curveState) {
    if (stages.mean && stageTextures.meanKey !== stages.mean) {
      bind(UNITS.rescueMean, stageTextures.mean);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, stages.mean.width, stages.mean.height, 0, gl.RED, gl.FLOAT, stages.mean.data);
      stageTextures.meanKey = stages.mean;
    }
    if (stages.offsets && stageTextures.offsetsKey !== stages.offsets) {
      bind(UNITS.rescueOffsets, stageTextures.offsets);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, RESCUE_OFFSET_BINS, 1, gl.RGBA, gl.FLOAT, stages.offsets.data);
      stageTextures.offsetsKey = stages.offsets;
    }
    if (stages.tone && stageTextures.toneKey !== stages.tone) {
      bind(UNITS.rescueTone, stageTextures.tone);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, RESCUE_TONE_SIZE, 1, gl.RED, gl.FLOAT, stages.tone.data);
      stageTextures.toneKey = stages.tone;
    }
    const look = stages.lookCurves || null;
    if (curveState.allocated !== false && curveState.look !== look) {
      uploadLookRowInto(curveHandle, look ? look.data : null);
      curveState.look = look;
    }
  }

  function setModeUniforms(loc, stages, frame) {
    bind(UNITS.rescueMean, stageTextures.mean);
    bind(UNITS.rescueOffsets, stageTextures.offsets);
    bind(UNITS.rescueTone, stageTextures.tone);
    gl.uniform1i(loc.u_rescueMean, UNITS.rescueMean);
    gl.uniform1i(loc.u_rescueOffsets, UNITS.rescueOffsets);
    gl.uniform1i(loc.u_rescueTone, UNITS.rescueTone);
    gl.uniform4f(loc.u_frame, frame[0], frame[1], frame[2], frame[3]);
    gl.uniform1i(loc.u_rescueOn, stages.rescueOn);
    gl.uniform1i(loc.u_fogOn, stages.fogOn);
    gl.uniform1fv(loc.u_fog, stages.fog);
    gl.uniform3f(loc.u_fogOffset, stages.fogOffset[0], stages.fogOffset[1], stages.fogOffset[2]);
    gl.uniform1f(loc.u_fogScale, stages.fogScale);
    gl.uniform1f(loc.u_fogLimit, stages.fogLimit);
    gl.uniform4f(loc.u_fraction, stages.fraction[0], stages.fraction[1], stages.fraction[2], stages.fraction[3]);
    gl.uniform1f(loc.u_local, stages.mean ? stages.local : 0);
    gl.uniform1i(loc.u_offsetsOn, stages.offsets ? stages.offsetsOn : 0);
    gl.uniform1i(loc.u_lookMatrixOn, stages.lookMatrixOn);
    // Row-major as pixelAdjustments.js reads it: WebGL2 transposes on upload.
    gl.uniformMatrix3fv(loc.u_lookMatrix, true, stages.lookMatrix);
    gl.uniform3f(loc.u_lookOffset, stages.lookOffset[0], stages.lookOffset[1], stages.lookOffset[2]);
    gl.uniform1i(loc.u_lookCurvesOn, stages.lookCurves ? stages.lookCurvesOn : 0);
    gl.uniform1i(loc.u_roundBeforeCmy, stages.roundBeforeCmy);
  }

  function modesLinked() {
    return modes?.status === 'linked';
  }

  // Whether a draw of `stages` needs the mode variant.
  function wantsModes(stages) {
    return Boolean(stages && stages.active);
  }

  const renderer = {
    gl,

    // ---- exact frame (step3Program) ----
    // Uploads the exact 8-bit frame; `reallocate` when its size changed. Returns false
    // when the context was lost during the allocation.
    uploadExact(imageData, reallocate) {
      bind(UNITS.image, exact.handle);
      if (reallocate || exact.width !== imageData.width || exact.height !== imageData.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, imageData.width, imageData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
        exact.width = imageData.width;
        exact.height = imageData.height;
        if (!checkAllocation('texture', imageData.width, imageData.height)) {
          exact.width = exact.height = 0;
          return false;
        }
        return true;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, imageData.width, imageData.height, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
      return true;
    },

    // One rect of the exact frame (a dust-brush patch, #259), rows top-down as the
    // frame is stored. False when the texture does not hold a frame of that size.
    uploadExactRect(rect, rows) {
      if (!exact.width || rect.x + rect.width > exact.width || rect.y + rect.height > exact.height) return false;
      bind(UNITS.image, exact.handle);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, rows);
      return true;
    },

    uploadCurves(curves) {
      // A new texture's look row starts as identity.
      if (!curve.allocated) curve.look = null;
      uploadCurveInto(curve.handle, curves, curve.allocated);
      curve.allocated = true;
    },

    // Draws the exact frame. `options.viewport` places it in the drawing buffer (the
    // photo rectangle of the border preview, #253), `options.frame` is u_frame for a
    // region of a larger frame. False when `step3Values.stages` needs the mode
    // programs and they are not linked: nothing was drawn.
    drawStep3(step3Values, width, height, options = {}) {
      if (wantsModes(step3Values.stages) && !displayModesSupported(step3Values)) return false;
      if (wantsModes(step3Values.stages) && !modesLinked()) return false;
      drawStep3With(exact.handle, curve.handle, step3Values, options.viewport || [0, 0, width, height],
        exact, curve, options.frame || null);
      return true;
    },

    // ---- applyProgram: compiled at idle ----
    startApplyCompile() {
      if (apply) return;
      const linked = linkNow(gl, VERTEX_SHADER_300, APPLY_FRAGMENT_SHADER);
      apply = { ...linked, loc: null, status: 'pending', error: null };
    },

    // 'none' | 'pending' | 'linked' | 'failed'. Asks for the link status only once the
    // driver reports the compile complete (KHR_parallel_shader_compile), so polling
    // never blocks; without the extension the first poll waits for the link.
    applyStatus() {
      if (!apply) return 'none';
      if (apply.status !== 'pending') return apply.status;
      if (parallel && !gl.getProgramParameter(apply.program, parallel.COMPLETION_STATUS_KHR)) return 'pending';
      const error = linkError(gl, apply);
      gl.deleteShader(apply.vs);
      gl.deleteShader(apply.fs);
      if (error) {
        apply.status = 'failed';
        apply.error = error;
        return apply.status;
      }
      apply.loc = locations(gl, apply.program, APPLY_UNIFORMS);
      apply.status = 'linked';
      return apply.status;
    },

    applyError() {
      return apply?.error || null;
    },

    // ---- live inputs of the apply program ----
    uploadPrepared(prepared) {
      ensureStatics();
      if (!live) live = createInputs();
      return uploadPreparedInto(live, prepared);
    },

    uploadStops(stops, width, height) {
      if (!live) live = createInputs();
      return uploadStopsInto(live, stops, width, height);
    },

    preparedSize() {
      return live?.prepared ? { width: live.prepared.width, height: live.prepared.height } : null;
    },

    dropPrepared() {
      deleteInputs(live);
      live = null;
    },

    // Draws one tick: `frame` is { mode, params, plan, engine } (Engine.previewPlan on
    // the engine seeded with the worker's analysis).
    drawApply(frame, step3Values, width, height, options = {}) {
      if (wantsModes(step3Values.stages) && !displayModesSupported(step3Values)) return false;
      if (!live?.prepared || apply?.status !== 'linked') return false;
      if (wantsModes(step3Values.stages) && !(modesLinked() && modes.apply)) return false;
      uploadFrameTables(live, frame);
      drawApplyWith(live, frame, step3Values, curve.handle, options.viewport || [0, 0, width, height]);
      return true;
    },

    // ---- display modes (#253): compiled at idle, beside applyProgram ----
    // `apply: false` compiles only the Step-3 variant (the detail layer's
    // context never draws applyProgram).
    startModesCompile({ apply = true } = {}) {
      if (modes) return;
      modes = {
        step3: { ...linkNow(gl, VERTEX_SHADER_300, STEP3_MODES_FRAGMENT_SHADER), loc: null },
        apply: apply ? { ...linkNow(gl, VERTEX_SHADER_300, APPLY_MODES_FRAGMENT_SHADER), loc: null } : null,
        status: 'pending', error: null,
      };
    },

    // 'none' | 'pending' | 'linked' | 'failed', polled like applyStatus.
    modesStatus() {
      if (!modes) return 'none';
      if (modes.status !== 'pending') return modes.status;
      const programs = [modes.step3, modes.apply].filter(Boolean);
      for (const linked of programs) {
        if (parallel && !gl.getProgramParameter(linked.program, parallel.COMPLETION_STATUS_KHR)) return 'pending';
      }
      const error = programs.map((linked) => linkError(gl, linked)).find(Boolean) || null;
      for (const linked of programs) {
        gl.deleteShader(linked.vs);
        gl.deleteShader(linked.fs);
      }
      if (error) {
        modes.status = 'failed';
        modes.error = error;
        return modes.status;
      }
      modes.step3.loc = locations(gl, modes.step3.program, [...STEP3_UNIFORMS, ...MODE_UNIFORMS]);
      if (modes.apply) modes.apply.loc = locations(gl, modes.apply.program, [...APPLY_UNIFORMS, ...MODE_UNIFORMS]);
      modes.status = 'linked';
      return modes.status;
    },

    modesError() {
      return modes?.error || null;
    },

    /**
     * The display modes' self-test: the cases of buildDisplayModesCases (rescue with
     * fog and local contrast, the look, both with vibrance) drawn with the Step-3
     * and apply mode programs side by side into an offscreen framebuffer, read back once and
     * compared with pixelAdjustments.js by the display budget. Scratch textures
     * only; the stage textures are uploaded again by the next live draw.
     */
    modesSelfTest(cases, { corrupt = false, corruptApply = false } = {}) {
      if (!modesLinked()) return { ok: false, reason: 'not linked' };
      ensureStatics();
      const n = cases[0].width, m = cases[0].height;
      const width = n * cases.length;
      const target = texture();
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, m);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      const image = texture();
      const curveScratch = texture();
      const curveState = { look: null };
      const scratch = createInputs();
      try {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return { ok: false, reason: 'framebuffer' };
        uploadCurveInto(curveScratch, cases[0].step3.curves, false);
        cases.forEach((testCase, k) => {
          uploadCurveInto(curveScratch, testCase.step3.curves, true);
          bind(UNITS.image, image);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, m, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array(testCase.image.data.buffer, testCase.image.data.byteOffset, testCase.image.data.length));
          const values = { ...testCase.step3, stages: testCase.stages.active ? testCase.stages : { ...testCase.stages, active: true } };
          if (testCase.preview) {
            const preview = testCase.preview;
            uploadPreparedInto(scratch, { width: n, height: m, data16: preview.prepared.data });
            uploadStopsInto(scratch, preview.stops, n, m);
            const frame = { mode: preview.mode, params: preview.params, plan: preview.plan, engine: preview.engine };
            uploadFrameTables(scratch, frame);
            // Test hook: simulate a miscompiled apply variant independently.
            drawApplyWith(scratch, frame, corruptApply ? { ...values, cmy: [0.9, 0.9, 0.9] } : values,
              curveScratch, [k * n, 0, n, m], curveState);
          } else {
            drawStep3With(image, curveScratch, values, [k * n, 0, n, m], { width: n, height: m }, curveState);
          }
        });
        const pixels = new Uint8Array(width * m * 4);
        gl.readPixels(0, 0, width, m, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (corrupt) for (let i = 0; i < pixels.length; i += 4) pixels[i] ^= 0x10;
        return compareDisplayModes(cases, pixels, width, m);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(target);
        gl.deleteTexture(image);
        gl.deleteTexture(curveScratch);
        deleteInputs(scratch);
        // The live curve texture's look row is untouched; the stage textures are
        // keyed by identity and upload again on the next live draw.
        stageTextures.meanKey = stageTextures.offsetsKey = stageTextures.toneKey = null;
      }
    },

    /**
     * Draws the self-test cases (buildSelfTestCases) side by side into an offscreen
     * framebuffer, plus step3Program at identity over the first case's reference, and
     * compares one readback with the CPU bytes. Uses scratch textures only: the live
     * frame, curves and inputs are untouched.
     */
    selfTest(cases, { corrupt = false } = {}) {
      if (apply?.status !== 'linked') return { ok: false, reason: 'not linked' };
      ensureStatics();
      const n = cases[0].width || SELF_TEST_SIZE;
      const m = cases[0].height || SELF_TEST_SIZE;
      const width = n * (cases.length + 1);
      const target = texture();
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, m);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      const scratch = createInputs();
      const identityCurve = texture();
      const exactScratch = texture();
      try {
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return { ok: false, reason: 'framebuffer' };
        const ramp = new Uint8Array(STEP3_CURVE_SIZE);
        for (let i = 0; i < STEP3_CURVE_SIZE; i++) ramp[i] = i;
        uploadCurveInto(identityCurve, { r: ramp, g: ramp, b: ramp }, false);
        const identity = { wb: [1, 1, 1], vib: 0, cmy: [0, 0, 0] };
        cases.forEach((testCase, k) => {
          uploadPreparedInto(scratch, { width: n, height: m, data16: testCase.prepared.data });
          uploadStopsInto(scratch, testCase.stops, n, m);
          const frame = { mode: testCase.mode, params: testCase.params, plan: testCase.plan, engine: testCase.engine };
          uploadFrameTables(scratch, frame);
          drawApplyWith(scratch, frame, identity, identityCurve, [k * n, 0, n, m], { look: null });
        });
        bind(UNITS.image, exactScratch);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, m, 0, gl.RGBA, gl.UNSIGNED_BYTE, cases[0].expected);
        drawStep3With(exactScratch, identityCurve, identity, [cases.length * n, 0, n, m], { width: n, height: m });
        const pixels = new Uint8Array(width * m * 4);
        gl.readPixels(0, 0, width, m, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (corrupt) pixels[0] ^= 0x10;
        const step3Case = { name: 'step3', width: n, height: m, expected: cases[0].expected };
        return compareSelfTest([...cases, step3Case], pixels, width, m);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(target);
        gl.deleteTexture(identityCurve);
        gl.deleteTexture(exactScratch);
        deleteInputs(scratch);
      }
    },
  };
  return renderer;
}
