/**
 * WebGLRenderer.js - GPU-accelerated LUT application
 * Uses WebGL2 (preferred) or WebGL1 for curve application.
 * WebGL2 adds 3D LUT support for enhanced profiles.
 */

// --- WebGL2 shaders (GLSL 300 es, with 3D LUT) ---

const VERT_SRC_2 = `#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
  vTexCoord = (aPosition + 1.0) * 0.5;
  vTexCoord.y = 1.0 - vTexCoord.y;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const FRAG_SRC_2 = `#version 300 es
precision mediump float;
precision mediump sampler3D;

in vec2 vTexCoord;
out vec4 fragColor;

uniform sampler2D uImage;
uniform sampler2D uLutR;
uniform sampler2D uLutG;
uniform sampler2D uLutB;
uniform float uSaturation;

uniform sampler3D uLut3D;
uniform float uLutStrength;

// sRGB D50 -> XYZ D50 (column-major)
const mat3 srgbToXyz = mat3(
  0.4360747, 0.2225045, 0.0139322,
  0.3850649, 0.7168786, 0.0971045,
  0.1430804, 0.0606169, 0.7141733
);

// XYZ D50 -> ProPhoto (column-major)
const mat3 xyzToProPhoto = mat3(
   1.3459433, -0.5445989, 0.0,
  -0.2556075,  1.5081673, 0.0,
  -0.0511118,  0.0205351, 1.2118128
);

// ProPhoto -> XYZ D50 (column-major)
const mat3 proPhotoToXyz = mat3(
  0.7976749, 0.2880402, 0.0,
  0.1351917, 0.7118741, 0.0,
  0.0313534, 0.0000857, 0.82521
);

// XYZ D50 -> sRGB D50 (column-major)
const mat3 xyzToSrgb = mat3(
   3.1338561, -0.9787684,  0.0719453,
  -1.6168667,  1.9161415, -0.2289914,
  -0.4906146,  0.033454,   1.4052427
);

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec4 c = texture(uImage, vTexCoord);

  // 1. Per-channel 1D LUT
  float r = texture(uLutR, vec2(c.r, 0.5)).r;
  float g = texture(uLutG, vec2(c.g, 0.5)).r;
  float b = texture(uLutB, vec2(c.b, 0.5)).r;
  vec3 color = vec3(r, g, b);

  // 2. 3D LUT (enhanced profile)
  if (uLutStrength > 0.0) {
    vec3 lin = srgbToLinear(color);
    vec3 ppLin = max(xyzToProPhoto * (srgbToXyz * lin), 0.0);
    vec3 ppGam = pow(ppLin, vec3(1.0 / 1.8));
    vec3 lutC = texture(uLut3D, clamp(ppGam, 0.0, 1.0)).rgb;
    vec3 lutLin = pow(lutC, vec3(1.8));
    vec3 sLin = max(xyzToSrgb * (proPhotoToXyz * lutLin), 0.0);
    vec3 sGam = linearToSrgb(sLin);
    color = mix(color, clamp(sGam, 0.0, 1.0), uLutStrength);
  }

  // 3. Saturation adjustment
  float lum = 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
  color = vec3(
    lum + uSaturation * (color.r - lum),
    lum + uSaturation * (color.g - lum),
    lum + uSaturation * (color.b - lum)
  );

  fragColor = vec4(clamp(color, 0.0, 1.0), c.a);
}`

// --- WebGL1 shaders (GLSL 100, no 3D LUT) ---

const VERT_SRC_1 = `
attribute vec2 aPosition;
varying vec2 vTexCoord;
void main() {
  vTexCoord = (aPosition + 1.0) * 0.5;
  vTexCoord.y = 1.0 - vTexCoord.y;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const FRAG_SRC_1 = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D uImage;
uniform sampler2D uLutR;
uniform sampler2D uLutG;
uniform sampler2D uLutB;
uniform float uSaturation;

void main() {
  vec4 c = texture2D(uImage, vTexCoord);
  float r = texture2D(uLutR, vec2(c.r, 0.5)).r;
  float g = texture2D(uLutG, vec2(c.g, 0.5)).r;
  float b = texture2D(uLutB, vec2(c.b, 0.5)).r;
  float lum = 0.299 * r + 0.587 * g + 0.114 * b;
  r = lum + uSaturation * (r - lum);
  g = lum + uSaturation * (g - lum);
  b = lum + uSaturation * (b - lum);
  gl_FragColor = vec4(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), c.a);
}`

export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas
    this.isWebGL2 = false
    this.lut3DEnabled = false
    this.lut3DTex = null
    // Pre-allocated buffer for LUT upload (Phase 4)
    this._lutUploadData = new Uint8Array(256 * 4)
    this._lastLutR = null
    this._lastLutG = null
    this._lastLutB = null

    // Try WebGL2 first, fall back to WebGL1
    this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
    if (this.gl) {
      this.isWebGL2 = true
    } else {
      this.gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })
    }

    if (!this.gl) {
      this.available = false
      return
    }
    this.available = true
    this._init()
  }

  _init() {
    const gl = this.gl
    const vertSrc = this.isWebGL2 ? VERT_SRC_2 : VERT_SRC_1
    const fragSrc = this.isWebGL2 ? FRAG_SRC_2 : FRAG_SRC_1

    const vs = this._compile(gl.VERTEX_SHADER, vertSrc)
    const fs = this._compile(gl.FRAGMENT_SHADER, fragSrc)
    this.program = gl.createProgram()
    gl.attachShader(this.program, vs)
    gl.attachShader(this.program, fs)
    gl.linkProgram(this.program)

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.warn('WebGL program link failed:', gl.getProgramInfoLog(this.program))
      this.available = false
      return
    }

    gl.useProgram(this.program)

    // Full-screen quad
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)

    const aPos = gl.getAttribLocation(this.program, 'aPosition')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    // Uniform locations
    this.uImage = gl.getUniformLocation(this.program, 'uImage')
    this.uLutR = gl.getUniformLocation(this.program, 'uLutR')
    this.uLutG = gl.getUniformLocation(this.program, 'uLutG')
    this.uLutB = gl.getUniformLocation(this.program, 'uLutB')
    this.uSaturation = gl.getUniformLocation(this.program, 'uSaturation')

    // Create textures
    this.imageTex = this._createTexture(0)
    this.lutTexR = this._createTexture(1)
    this.lutTexG = this._createTexture(2)
    this.lutTexB = this._createTexture(3)

    gl.uniform1i(this.uImage, 0)
    gl.uniform1i(this.uLutR, 1)
    gl.uniform1i(this.uLutG, 2)
    gl.uniform1i(this.uLutB, 3)

    // 3D LUT uniforms (WebGL2 only)
    if (this.isWebGL2) {
      this.uLut3D = gl.getUniformLocation(this.program, 'uLut3D')
      this.uLutStrength = gl.getUniformLocation(this.program, 'uLutStrength')
      gl.uniform1i(this.uLut3D, 4)
      gl.uniform1f(this.uLutStrength, 0)
    }
  }

  _compile(type, src) {
    const gl = this.gl
    const shader = gl.createShader(type)
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('Shader compile error:', gl.getShaderInfoLog(shader))
    }
    return shader
  }

  _createTexture(unit) {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  /**
   * Upload LUT as 256x1 texture. Skips upload if LUT reference unchanged.
   */
  _uploadLUT(unit, tex, lut, cacheKey) {
    // Skip upload if LUT reference hasn't changed
    if (this[cacheKey] === lut) return
    this[cacheKey] = lut

    const gl = this.gl
    const data = this._lutUploadData
    for (let i = 0; i < 256; i++) {
      const off = i * 4
      data[off] = lut[i]
      data[off + 1] = lut[i]
      data[off + 2] = lut[i]
      data[off + 3] = 255
    }
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
  }

  /**
   * Upload 3D LUT data as a 32^3 3D texture (WebGL2 only).
   * @param {{data: Uint16Array, size: number}|null} lut
   */
  uploadLut3D(lut) {
    if (!this.isWebGL2) {
      this.lut3DEnabled = false
      return
    }
    const gl = this.gl

    if (!lut) {
      this.lut3DEnabled = false
      return
    }

    const size = lut.size
    const total = size * size * size

    // Convert uint16 LUT to float32 RGBA for GPU upload
    const rgba = new Float32Array(total * 4)
    for (let i = 0; i < total; i++) {
      rgba[i * 4]     = lut.data[i * 3]     / 65535
      rgba[i * 4 + 1] = lut.data[i * 3 + 1] / 65535
      rgba[i * 4 + 2] = lut.data[i * 3 + 2] / 65535
      rgba[i * 4 + 3] = 1.0
    }

    if (!this.lut3DTex) {
      this.lut3DTex = gl.createTexture()
    }

    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_3D, this.lut3DTex)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)

    this.lut3DEnabled = true
  }

  /**
   * Render image with LUT application on GPU.
   * @param {ImageData} imageData
   * @param {Uint8Array} rLUT
   * @param {Uint8Array} gLUT
   * @param {Uint8Array} bLUT
   * @param {number} saturation - 0-200 scale (100 = normal)
   * @param {number} lutStrength - 0-200 (3D LUT strength, 0 = disabled)
   * @returns {ImageData}
   */
  render(imageData, rLUT, gLUT, bLUT, saturation = 100, lutStrength = 0) {
    if (!this.available) return null
    const gl = this.gl
    const { width, height, data } = imageData

    this.canvas.width = width
    this.canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.program)

    // Upload image
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)

    // Upload 1D LUTs (cached - skips if unchanged)
    this._uploadLUT(1, this.lutTexR, rLUT, '_lastLutR')
    this._uploadLUT(2, this.lutTexG, gLUT, '_lastLutG')
    this._uploadLUT(3, this.lutTexB, bLUT, '_lastLutB')

    // Saturation
    gl.uniform1f(this.uSaturation, saturation / 100)

    // 3D LUT (WebGL2 only)
    if (this.isWebGL2) {
      const use3D = this.lut3DEnabled && lutStrength > 0
      gl.uniform1f(this.uLutStrength, use3D ? lutStrength / 100 : 0)
      if (use3D) {
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_3D, this.lut3DTex)
      }
    }

    // Draw
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Read back
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    // Flip Y (WebGL renders upside down)
    const result = new Uint8ClampedArray(width * height * 4)
    const rowBytes = width * 4
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowBytes
      const dstRow = y * rowBytes
      result.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow)
    }

    return new ImageData(result, width, height)
  }
}
