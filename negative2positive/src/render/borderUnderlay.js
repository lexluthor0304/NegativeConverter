// The film-border preview as a GL underlay (#253 D): pass 1 draws the border
// background (composeSprocketFrameBackground at display size) over the whole drawing
// buffer with a pass-through program; pass 2, the caller's Step-3 or apply draw, puts
// the photo into its rectangle with gl.viewport. The photo therefore stays on the GPU
// path with the border shown. GLSL ES 1.00, so the same program serves a WebGL2 and a
// WebGL1 context. Display-only: exports compose their border with
// applySprocketFrameForExport, unchanged.

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Rows are uploaded top-down as stored; the flip is here, as in previewShader.js.
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// highp where it exists: a mediump coordinate cannot address every texel of a
// 2000-texel-wide border.
const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_background;
void main() {
  gl_FragColor = vec4(texture2D(u_background, v_uv).rgb, 1.0);
}
`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
// The unit the underlay binds; every other program binds its own units before it
// draws, so this one is free again after pass 1.
const UNIT = 0;

/**
 * The photo rectangle of a `frameWidth` × `frameHeight` drawing buffer showing a
 * framed photo at `layout` (getSprocketFrameLayout: top-left origin), scaled to a
 * buffer of `bufferWidth` × `bufferHeight` and flipped to GL's bottom-left origin:
 * [x, y, width, height] for gl.viewport.
 */
export function photoViewport(layout, bufferWidth = layout.frameWidth, bufferHeight = layout.frameHeight) {
  const sx = bufferWidth / layout.frameWidth;
  const sy = bufferHeight / layout.frameHeight;
  const left = Math.round(layout.x * sx);
  const top = Math.round(layout.y * sy);
  const right = Math.round((layout.x + layout.width) * sx);
  const bottom = Math.round((layout.y + layout.height) * sy);
  return [left, bufferHeight - bottom, Math.max(1, right - left), Math.max(1, bottom - top)];
}

export function createBorderUnderlay(gl) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'link failed';
    gl.deleteProgram(program);
    throw new Error(`Border underlay: ${info}`);
  }
  const uBackground = gl.getUniformLocation(program, 'u_background');
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  const handle = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const held = { key: null, width: 0, height: 0 };

  return {
    // The background uploaded last, and its size.
    key: () => held.key,
    size: () => ({ width: held.width, height: held.height }),

    // Uploads `image` (RGBA8 ImageData-like) as the background, identified by `key`.
    upload(image, key) {
      gl.activeTexture(gl.TEXTURE0 + UNIT);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.length);
      if (held.width !== image.width || held.height !== image.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
      held.key = key;
      held.width = image.width;
      held.height = image.height;
    },

    // Pass 1: the background over the whole `width` × `height` drawing buffer.
    draw(width, height) {
      if (!held.width) return false;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0 + UNIT);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.uniform1i(uBackground, UNIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },

    // Frees the background's texture memory (the border preview was turned off).
    release() {
      if (!held.width) return;
      gl.activeTexture(gl.TEXTURE0 + UNIT);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      held.key = null;
      held.width = held.height = 0;
    },
  };
}
