/**
 * WebGLRenderer.js - GPU-accelerated LUT application
 * Uses fragment shader for real-time curve application.
 */

const VERT_SRC = `
attribute vec2 aPosition;
varying vec2 vTexCoord;
void main() {
  vTexCoord = (aPosition + 1.0) * 0.5;
  vTexCoord.y = 1.0 - vTexCoord.y;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D uImage;
uniform sampler2D uLutR;
uniform sampler2D uLutG;
uniform sampler2D uLutB;
uniform float uSaturation;

void main() {
  vec4 c = texture2D(uImage, vTexCoord);
  // Apply per-channel LUT
  float r = texture2D(uLutR, vec2(c.r, 0.5)).r;
  float g = texture2D(uLutG, vec2(c.g, 0.5)).r;
  float b = texture2D(uLutB, vec2(c.b, 0.5)).r;
  // Saturation adjustment
  float lum = 0.299 * r + 0.587 * g + 0.114 * b;
  r = lum + uSaturation * (r - lum);
  g = lum + uSaturation * (g - lum);
  b = lum + uSaturation * (b - lum);
  gl_FragColor = vec4(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), c.a);
}`;

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!this.gl) {
      this.available = false;
      return;
    }
    this.available = true;
    this._init();
  }

  _init() {
    const gl = this.gl;

    // Compile shaders
    const vs = this._compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.useProgram(this.program);

    // Full-screen quad
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    this.uImage = gl.getUniformLocation(this.program, 'uImage');
    this.uLutR = gl.getUniformLocation(this.program, 'uLutR');
    this.uLutG = gl.getUniformLocation(this.program, 'uLutG');
    this.uLutB = gl.getUniformLocation(this.program, 'uLutB');
    this.uSaturation = gl.getUniformLocation(this.program, 'uSaturation');

    // Create textures
    this.imageTex = this._createTexture(0);
    this.lutTexR = this._createTexture(1);
    this.lutTexG = this._createTexture(2);
    this.lutTexB = this._createTexture(3);

    gl.uniform1i(this.uImage, 0);
    gl.uniform1i(this.uLutR, 1);
    gl.uniform1i(this.uLutG, 2);
    gl.uniform1i(this.uLutB, 3);
  }

  _compile(type, src) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  }

  _createTexture(unit) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Upload LUT as 256x1 texture.
   */
  _uploadLUT(unit, tex, lut) {
    const gl = this.gl;
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      data[i * 4] = lut[i];
      data[i * 4 + 1] = lut[i];
      data[i * 4 + 2] = lut[i];
      data[i * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  /**
   * Render image with LUT application on GPU.
   * @param {ImageData} imageData
   * @param {Uint8Array} rLUT
   * @param {Uint8Array} gLUT
   * @param {Uint8Array} bLUT
   * @param {number} saturation - 0-200 scale (100 = normal)
   * @returns {ImageData}
   */
  render(imageData, rLUT, gLUT, bLUT, saturation = 100) {
    if (!this.available) return null;
    const gl = this.gl;
    const { width, height, data } = imageData;

    this.canvas.width = width;
    this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);

    // Upload image
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    // Upload LUTs
    this._uploadLUT(1, this.lutTexR, rLUT);
    this._uploadLUT(2, this.lutTexG, gLUT);
    this._uploadLUT(3, this.lutTexB, bLUT);

    // Saturation
    gl.uniform1f(this.uSaturation, saturation / 100);

    // Draw
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Read back
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Flip Y (WebGL renders upside down)
    const result = new Uint8ClampedArray(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowBytes;
      const dstRow = y * rowBytes;
      result.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow);
    }

    return new ImageData(result, width, height);
  }
}
