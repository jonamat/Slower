import { DB_FLOOR } from '../dsp/consts';
import { buildLut, type CmapName } from './colormap';

export interface SpecView {
  t0: number;       // left edge, seconds
  tSpan: number;    // visible seconds
  fMin: number;     // bottom edge, Hz
  fMax: number;     // top edge, Hz
  log: boolean;     // logarithmic frequency axis
  gain: number;     // dB added before mapping
  range: number;    // dB span mapped to the colour ramp
  /** Spectrogram offset against the track, in seconds (>0 shifts it right). */
  offset: number;
}

interface Tile { col0: number; width: number; tex: WebGLTexture }

const VERT = `#version 300 es
in vec2 aPos;
uniform vec2 uX;      // NDC x of the quad edges
uniform vec2 uCol;    // absolute spectrogram column at those edges
out float vCol;
out float vY;
void main() {
  vCol = mix(uCol.x, uCol.y, aPos.x);
  vY = aPos.y;
  gl_Position = vec4(mix(uX.x, uX.y, aPos.x), aPos.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in float vCol;
in float vY;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform int uTileCol0;
uniform int uTexW;
uniform int uBins;
uniform float uColsPerPx;   // spectrogram columns covered by one screen pixel
uniform float uPxY;         // one screen pixel in vY units
uniform float uFMin;
uniform float uFMax;
uniform float uBinHz;
uniform int uLog;
uniform float uGain;
uniform float uRange;
uniform float uFloor;
out vec4 fragColor;

float binAt(float y) {
  float f = (uLog == 1) ? uFMin * pow(uFMax / uFMin, y) : mix(uFMin, uFMax, y);
  return f / uBinHz;
}

void main() {
  float ba = binAt(vY - 0.5 * uPxY);
  float bb = binAt(vY + 0.5 * uPxY);
  int b0 = int(floor(min(ba, bb)));
  int b1 = int(floor(max(ba, bb)));
  b0 = clamp(b0, 0, uBins - 1);
  b1 = clamp(b1, b0, uBins - 1);
  int c0 = int(floor(vCol - 0.5 * uColsPerPx)) - uTileCol0;
  int c1 = int(floor(vCol + 0.5 * uColsPerPx)) - uTileCol0;
  c0 = clamp(c0, 0, uTexW - 1);
  c1 = clamp(c1, c0, uTexW - 1);

  int ny = b1 - b0 + 1, nx = c1 - c0 + 1;
  int sy = max(1, (ny + 7) / 8), sx = max(1, (nx + 7) / 8);

  // peak-hold over the texels this pixel covers: keeps partials visible zoomed out
  float m = 0.0;
  for (int j = 0; j < 8; j++) {
    int b = b0 + j * sy;
    if (b > b1) break;
    for (int i = 0; i < 8; i++) {
      int c = c0 + i * sx;
      if (c > c1) break;
      m = max(m, texelFetch(uTex, ivec2(c, b), 0).r);
    }
  }

  float db = m * (-uFloor) + uFloor;
  float t = clamp((db + uGain) / uRange + 1.0, 0.0, 1.0);
  fragColor = vec4(texture(uLut, vec2(t, 0.5)).rgb, 1.0);
}`;

export class SpectroGL {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private lut: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private tiles: Tile[] = [];

  cols = 0;
  bins = 0;
  hop = 512;
  fftSize = 2048;
  sampleRate = 48000;
  /** Height in device pixels of the strip at the top reserved for the ruler. */
  topPx = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, antialias: false, depth: false, premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    this.prog = link(gl, VERT, FRAG);
    for (const name of ['uX', 'uCol', 'uTex', 'uLut', 'uTileCol0', 'uTexW', 'uBins', 'uColsPerPx',
      'uPxY', 'uFMin', 'uFMax', 'uBinHz', 'uLog', 'uGain', 'uRange', 'uFloor']) {
      this.u[name] = gl.getUniformLocation(this.prog, name);
    }

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;

    this.lut = gl.createTexture()!;
    this.setColormap('magma');
  }

  setColormap(name: CmapName): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, buildLut(name));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  reset(meta: { cols: number; bins: number; hop: number; fftSize: number; sampleRate: number }): void {
    const gl = this.gl;
    for (const t of this.tiles) gl.deleteTexture(t.tex);
    this.tiles = [];
    this.cols = meta.cols;
    this.bins = meta.bins;
    this.hop = meta.hop;
    this.fftSize = meta.fftSize;
    this.sampleRate = meta.sampleRate;
  }

  addTile(col0: number, width: number, bins: number, data: Uint8Array): void {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, bins, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tiles.push({ col0, width, tex });
  }

  draw(view: SpecView): void {
    const gl = this.gl;
    const cw = gl.drawingBufferWidth;
    const chh = gl.drawingBufferHeight;
    const ph = Math.max(1, chh - this.topPx);

    gl.viewport(0, 0, cw, ph);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, cw, ph);
    gl.clearColor(0.02, 0.02, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.tiles.length) return;

    const colsPerSec = this.sampleRate / this.hop;
    // a positive offset shifts the image right, so we sample further back
    const c0 = (view.t0 - view.offset) * colsPerSec;
    const c1 = (view.t0 + view.tSpan - view.offset) * colsPerSec;
    const colsPerPx = (c1 - c0) / cw;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.uniform1i(this.u.uLut, 1);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uBins, this.bins);
    gl.uniform1f(this.u.uColsPerPx, colsPerPx);
    gl.uniform1f(this.u.uPxY, 1 / ph);
    gl.uniform1f(this.u.uFMin, Math.max(1, view.fMin));
    gl.uniform1f(this.u.uFMax, view.fMax);
    gl.uniform1f(this.u.uBinHz, this.sampleRate / this.fftSize);
    gl.uniform1i(this.u.uLog, view.log ? 1 : 0);
    gl.uniform1f(this.u.uGain, view.gain);
    gl.uniform1f(this.u.uRange, view.range);
    gl.uniform1f(this.u.uFloor, DB_FLOOR);

    for (const t of this.tiles) {
      const a = Math.max(c0, t.col0);
      const b = Math.min(c1, t.col0 + t.width);
      if (b <= a) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(this.u.uTileCol0, t.col0);
      gl.uniform1i(this.u.uTexW, t.width);
      gl.uniform2f(this.u.uX, ((a - c0) / (c1 - c0)) * 2 - 1, ((b - c0) / (c1 - c0)) * 2 - 1);
      gl.uniform2f(this.u.uCol, a, b);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type as number)!;
    gl.shaderSource(s, src as string);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    }
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
