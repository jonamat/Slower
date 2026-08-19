import { AudioEngine } from './audio/engine';
import { TILE_W } from './dsp/consts';
import type { SpecMessage, TileRequest } from './dsp/spectrogram.worker';
import {
  DEFAULTS, getFile, getPeaks, getSpectrum, loadSession, markWelcomeSeen, promoteSession,
  putFile, putPeaks, putSpectrum, saveSession, spectrumKey, trackKey, welcomeSeen,
  type Marker, type PitchMark, type Session, type Settings, type SpectrumTile, type TimeGrid,
  type TrackState,
} from './store';
import { archiveName, buildArchive, isArchiveName, readArchive } from './archive';
import type { CmapName } from './view/colormap';
import { MARKER_HIT, PITCH_HIT, drawAxis, drawOverlay, drawOverview } from './view/overlay';
import { RULER_H, TOP, fmtHz, fmtTime, fracToFreq, freqToFrac, midiToFreq, noteName } from './view/scales';
import { scaleOptions } from './view/scales-music';
import { SpectroGL, type SpecView } from './view/spectro-gl';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  file: $<HTMLInputElement>('file'),
  play: $<HTMLButtonElement>('play'),
  rate: $<HTMLInputElement>('rate'),
  rateVal: $('rateVal'),
  playMode: $<HTMLSelectElement>('playMode'),
  scale: $<HTMLSelectElement>('scale'),
  zoomAll: $<HTMLButtonElement>('zoomAll'),
  followBtn: $<HTMLButtonElement>('followBtn'),
  setBtn: $<HTMLButtonElement>('setBtn'),
  menu: $('menu'),
  exportBtn: $<HTMLButtonElement>('exportBtn'),
  freqScale: $<HTMLSelectElement>('freqScale'),
  gain: $<HTMLInputElement>('gain'),
  gainVal: $('gainVal'),
  range: $<HTMLInputElement>('range'),
  rangeVal: $('rangeVal'),
  specOffset: $<HTMLInputElement>('specOffset'),
  algo: $<HTMLSelectElement>('algo'),
  gridEdit: $<HTMLButtonElement>('gridEdit'),
  gridDiv: $<HTMLSelectElement>('gridDiv'),
  magnet: $<HTMLInputElement>('magnet'),
  gridBar: $('gridBar'),
  gridHint: $('gridHint'),
  gridSave: $<HTMLButtonElement>('gridSave'),
  gridClear: $<HTMLButtonElement>('gridClear'),
  gridTempo: $('gridTempo'),
  gridCancel: $<HTMLButtonElement>('gridCancel'),
  fft: $<HTMLSelectElement>('fft'),
  cmap: $<HTMLSelectElement>('cmap'),
  mix: $<HTMLInputElement>('mix'),
  mixVal: $('mixVal'),
  overview: $<HTMLCanvasElement>('overview'),
  axis: $<HTMLCanvasElement>('axis'),
  plot: $('plot'),
  gl: $<HTMLCanvasElement>('gl'),
  ovl: $<HTMLCanvasElement>('ovl'),
  drop: $('drop'),
  loading: $('loading'),
  loadingText: $('loadingText'),
  stTime: $('stTime'),
  stDur: $('stDur'),
  stCur: $('stCur'),
  stMsg: $('stMsg'),
  welcome: $<HTMLDialogElement>('welcome'),
  welcomeBtn: $<HTMLButtonElement>('welcomeBtn'),
};

const engine = new AudioEngine();
const spectro = new SpectroGL(el.gl);

const view: SpecView = {
  t0: 0, tSpan: 10, fMin: 30, fMax: 8000, log: false, gain: 12, range: 70, offset: 0,
};

let mono: Float32Array | null = null;   // kept on the main thread so FFT size can be changed
let peaks: Float32Array | null = null;  // overview min/max pairs
let duration = 0;
let nyquist = 24000;

let hasLoop = false;
let loopA = 0;
let loopB = 0;
let markers: Marker[] = [];
let pitches: PitchMark[] = []; // reference notes, each at a precise instant
let notePos = 0;    // last instant already covered by note playback
let noteSeen = 0;   // seek generation already seen, so jumps stay silent
let notesFired = 0; // counter, used by the test
let follow = true;
let hover: { x: number; y: number } | null = null;

let grid: TimeGrid | null = null;
let gridEditing = false;
let gridStage = 0;              // 0 nothing, 1 first beat placed, 2 grid filled
let gridHover = -1;             // beat under the pointer while editing
let gridWas: TimeGrid | null = null;  // to put back if the edit is cancelled
let lastUserSeek = -1;          // so a drag outside a loop does not restart it per pixel

let glDirty = true;
let uiDirty = true;

/** An analysis in flight; the tiles left to do sit in `pending`. */
interface Analysis {
  job: number; key: string; cols: number; bins: number; hop: number;
  fftSize: number; sampleRate: number; t0: number; total: number;
}
let job = 0;
let pool: Worker[] = [];
let pending: { col0: number; width: number }[] = [];
let collected: SpectrumTile[] = [];
let analysis: Analysis | null = null;

/** Samples per bucket of the overview waveform; part of the cache key. */
const PEAK_BUCKET = 1024;
/** How close a right click must be to count as "on a marker", in px. */
const MARKER_NEAR = 14;
/** Booking margin for reference notes, in seconds of output. */
const NOTE_LEAD = 0.03;

const session: Session = loadSession();
let trackKeyCur: string | null = null;
let trackName = '';
let stateDirty = false;
let restored = false; // the current track came from the session archive
let menuOpen = false;
let sourceBlob: Blob | null = null; // original track bytes, kept for export
/** Outcome of the last analysis: for benchmark and tests, not for the UI. */
let lastReady: { cached: boolean; ms: number; cols: number; workers: number } | null = null;

// ---------------------------------------------------------------- geometry ---

const plotW = () => el.plot.clientWidth;
const plotH = () => el.plot.clientHeight - TOP;
const timeAt = (x: number) => view.t0 + (x / Math.max(1, plotW())) * view.tSpan;
const xOfTime = (t: number) => ((t - view.t0) / view.tSpan) * plotW();
const freqAt = (y: number) => fracToFreq(
  Math.min(1, Math.max(0, (el.plot.clientHeight - y) / Math.max(1, plotH()))),
  view.fMin, view.fMax, view.log,
);

/** Distance between two grid lines, in seconds, or 0 without a grid. */
function gridStep(): number {
  return grid && grid.beat > 0 ? grid.beat / Math.max(1, grid.div) : 0;
}

/** Nearest grid line, when the magnet is on. Anything already placed is left alone. */
function snap(t: number): number {
  const step = gridStep();
  if (!step || !el.magnet.checked || !grid) return t;
  return grid.offset + Math.round((t - grid.offset) / step) * step;
}

/**
 * Beat to grab at x, or -1. Once the grid is laid out every beat is grabbable,
 * whatever the pointer is nearest to: correcting the length of the bar is the
 * whole point of the grid, and the error to correct shows up on the *last* beat,
 * where all the small ones have piled up. While only the first beat exists it
 * needs a hit area instead, or the click that sets the spacing could never land.
 */
function beatAt(x: number): number {
  if (!grid) return -1;
  if (grid.beat <= 0) return Math.abs(xOfTime(grid.offset) - x) <= 12 ? 0 : -1;
  return Math.round((timeAt(x) - grid.offset) / grid.beat);
}

function clampTime(): void {
  const total = Math.max(duration, 0.05);
  view.tSpan = Math.min(view.tSpan, total);
  view.t0 = Math.max(0, Math.min(view.t0, total - view.tSpan));
}

function zoomTime(factor: number, anchorFrac: number): void {
  const anchor = view.t0 + view.tSpan * anchorFrac;
  view.tSpan = Math.min(Math.max(duration, 0.05), Math.max(0.02, view.tSpan * factor));
  view.t0 = anchor - view.tSpan * anchorFrac;
  clampTime();
  glDirty = true;
}

function zoomFreq(factor: number, anchorFrac: number): void {
  const lo = view.log ? Math.log(view.fMin) : view.fMin;
  const hi = view.log ? Math.log(view.fMax) : view.fMax;
  const anchor = lo + (hi - lo) * anchorFrac;
  const minSpan = view.log ? Math.log(1.6) : 40;
  const maxSpan = view.log ? Math.log(nyquist / 5) : nyquist - 5;
  let span = Math.min(maxSpan, Math.max(minSpan, (hi - lo) * factor));
  let a = anchor - span * anchorFrac;
  let b = a + span;
  const limLo = view.log ? Math.log(5) : 0;
  const limHi = view.log ? Math.log(nyquist) : nyquist;
  if (a < limLo) { a = limLo; b = a + span; }
  if (b > limHi) { b = limHi; a = b - span; }
  view.fMin = view.log ? Math.exp(a) : Math.max(0, a);
  view.fMax = view.log ? Math.exp(b) : b;
  glDirty = true;
}

function panFreqPx(dy: number): void {
  const frac = dy / Math.max(1, plotH());
  const lo = view.log ? Math.log(view.fMin) : view.fMin;
  const hi = view.log ? Math.log(view.fMax) : view.fMax;
  const span = hi - lo;
  let a = lo + span * frac;
  let b = hi + span * frac;
  const limLo = view.log ? Math.log(5) : 0;
  const limHi = view.log ? Math.log(nyquist) : nyquist;
  if (a < limLo) { a = limLo; b = a + span; }
  if (b > limHi) { b = limHi; a = b - span; }
  view.fMin = view.log ? Math.exp(a) : a;
  view.fMax = view.log ? Math.exp(b) : b;
  glDirty = true;
}

// -------------------------------------------------------------------- load ---

interface LoadOpts {
  /** Session key: passed when the file comes from the archive. */
  key?: string;
  restore?: TrackState;
  /** false when the file already comes from the archive. */
  archive?: boolean;
}

function showLoading(text: string): void {
  el.loadingText.textContent = text;
  el.loading.classList.remove('hide');
  el.drop.classList.add('hide'); // no drop hint behind the spinner
}

function hideLoading(): void {
  el.loading.classList.add('hide');
  if (!duration) el.drop.classList.remove('hide');
}

async function loadFile(file: File, opts: LoadOpts = {}): Promise<void> {
  showLoading(`decoding ${file.name}…`);
  try {
    await engine.init();
    engine.setRate(rateValue());
    engine.setMix(Number(el.mix.value));
    engine.setTrackAudible(el.playMode.value !== 'notes');
    engine.setAlgorithm(el.algo.value);
    const raw = await file.arrayBuffer();
    const buf = await engine.ctx!.decodeAudioData(raw);
    const nch = Math.min(2, buf.numberOfChannels);
    const channels: Float32Array[] = [];
    for (let c = 0; c < nch; c++) channels.push(new Float32Array(buf.getChannelData(c)));

    mono = new Float32Array(buf.length);
    if (nch === 1) {
      mono.set(channels[0]);
    } else {
      const a = channels[0], b = channels[1];
      for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (a[i] + b[i]);
    }

    engine.load(channels); // transfers the channel buffers to the audio thread
    duration = engine.duration;
    nyquist = engine.sampleRate / 2;

    trackName = file.name;
    trackKeyCur = opts.key ?? trackKey(file);
    sourceBlob = file;
    document.title = `${trackName} · Slower!`;

    // the overview waveform is the same in every session
    const cachedPeaks = await getPeaks(trackKeyCur, PEAK_BUCKET);
    if (cachedPeaks) {
      peaks = cachedPeaks;
    } else {
      peaks = buildPeaks(mono, PEAK_BUCKET);
      void putPeaks(trackKeyCur, PEAK_BUCKET, peaks);
    }

    const r = opts.restore;
    if (r) {
      view.t0 = r.t0;
      view.tSpan = Math.min(r.tSpan, Math.max(duration, 0.05));
      view.fMin = Math.max(0, Math.min(r.fMin, nyquist - 1));
      view.fMax = Math.min(r.fMax, nyquist);
      clampFreq();
      clampTime();
      loopA = r.loopA; loopB = r.loopB; hasLoop = r.hasLoop;
      markers = r.markers ?? [];
      grid = r.grid ?? null;
      gridStage = grid ? 2 : 0;
      if (grid) el.gridDiv.value = String(grid.div);
      // pinned notes were bare pitches in an earlier version: drop those
      pitches = (r.pitches ?? []).filter((p) => p && typeof p === 'object' && 't' in p);
      engine.seek(r.pos);
    } else {
      view.t0 = 0;
      view.tSpan = duration;
      view.fMin = 30;
      view.fMax = Math.min(8000, nyquist);
      hasLoop = false; loopA = loopB = 0;
      markers = [];
      grid = null;
      gridStage = 0;
      pitches = [];
    }
    applyLoop();
    setPlayIcon();
    el.drop.classList.add('hide');
    el.stDur.textContent = `/ ${fmtTime(duration)}`;
    void compute();

    session.lastKey = trackKeyCur;
    if (opts.archive !== false) void putFile(trackKeyCur, file.name, file);
    persist(true);
  } catch (e) {
    msg(`error: ${(e as Error).message}`);
    hideLoading();
  }
  uiDirty = glDirty = true;
}

// --------------------------------------------------------------- session ----

function persist(now = false): void {
  if (trackKeyCur) {
    session.tracks[trackKeyCur] = {
      pos: engine.position, loopA, loopB, hasLoop, markers, pitches, grid,
      t0: view.t0, tSpan: view.tSpan, fMin: view.fMin, fMax: view.fMax,
      at: Date.now(),
    };
  }
  session.settings = {
    fft: Number(el.fft.value), cmap: el.cmap.value, log: view.log,
    gain: view.gain, range: view.range, rate: rateValue(),
    mix: Number(el.mix.value), follow, playMode: el.playMode.value,
    specOffsetMs: Number(el.specOffset.value), scale: el.scale.value, algo: el.algo.value,
    magnet: el.magnet.checked,
  };
  if (now) saveSession(session);
  else stateDirty = true;
}

function applySettings(s: Settings): void {
  el.fft.value = String(s.fft);
  el.cmap.value = s.cmap;
  el.gain.value = String(s.gain);
  el.range.value = String(s.range);
  el.playMode.value = s.playMode;
  el.scale.value = s.scale;
  el.algo.value = s.algo;
  el.magnet.checked = s.magnet;
  setMix(s.mix, true);
  view.gain = s.gain;
  view.range = s.range;
  view.log = s.log;
  follow = s.follow;
  el.freqScale.value = s.log ? 'log' : 'lin';
  el.gainVal.textContent = `${s.gain} dB`;
  el.rangeVal.textContent = `${s.range} dB`;
  el.followBtn.classList.toggle('on', s.follow);
  spectro.setColormap(s.cmap as CmapName);
  setRate(s.rate * 100, true);
  setSpecOffset(s.specOffsetMs, true);
  glDirty = uiDirty = true;
}

/** Reopens the last session's track with cursor, selection and view. */
async function restoreLast(): Promise<void> {
  const key = session.lastKey;
  if (!key) return;
  showLoading('restoring the previous session…');
  const rec = await getFile(key);
  if (!rec) { hideLoading(); return; }
  restored = true;
  await loadFile(new File([rec.blob], rec.name, { type: rec.blob.type }), {
    key, restore: session.tracks[key], archive: false,
  });
}

/**
 * Builds the spectrogram: looks in the cache first, otherwise spreads the tiles
 * over a pool of workers and archives the result for the next session.
 */
async function compute(): Promise<void> {
  if (!mono || !trackKeyCur) return;
  const fftSize = Number(el.fft.value);
  let hop = fftSize / 4;
  while (mono.length / hop > 250_000) hop *= 2;
  const sampleRate = engine.sampleRate;
  const bins = fftSize >> 1;
  const cols = Math.max(1, Math.floor((mono.length - fftSize) / hop) + 1);
  const myJob = ++job;
  const t0 = performance.now();

  spectro.reset({ cols, bins, hop, fftSize, sampleRate });
  glDirty = true;
  lastReady = null;
  showLoading('analysing spectrum…');

  const key = spectrumKey(trackKeyCur, fftSize, hop, sampleRate);
  const hit = await getSpectrum(key);
  if (myJob !== job) return; // another analysis already started
  if (hit && hit.cols === cols && hit.bins === bins) {
    for (const t of hit.tiles) spectro.addTile(t.col0, t.width, bins, t.data);
    glDirty = true;
    ready(t0, true);
    return;
  }

  pending = [];
  collected = [];
  for (let col0 = 0; col0 < cols; col0 += TILE_W) {
    pending.push({ col0, width: Math.min(TILE_W, cols - col0) });
  }
  analysis = { job: myJob, key, cols, bins, hop, fftSize, sampleRate, t0, total: pending.length };
  ensurePool();
  for (const w of pool) dispatch(w);
}

/** Spectrum ready: the numbers stay on the debug handle, off the screen. */
function ready(t0: number, cached: boolean): void {
  hideLoading();
  msg(trackName);
  lastReady = {
    cached,
    ms: Math.round(performance.now() - t0),
    cols: spectro.cols,
    workers: cached ? 0 : pool.length,
  };
}

function ensurePool(): void {
  if (pool.length) return;
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL('./dsp/spectrogram.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = onTile;
    pool.push(w);
  }
}

/** Hands a worker the next tile, with only the slice of audio it needs. */
function dispatch(w: Worker): void {
  const a = analysis;
  const next = pending.shift();
  if (!a || !next || !mono) return;
  const from = next.col0 * a.hop;
  const to = Math.min(mono.length, (next.col0 + next.width - 1) * a.hop + a.fftSize);
  const slice = mono.slice(from, to);
  const req: TileRequest = {
    job: a.job, col0: next.col0, width: next.width, hop: a.hop, fftSize: a.fftSize, mono: slice,
  };
  w.postMessage(req, [slice.buffer]);
}

function onTile(ev: MessageEvent<SpecMessage>): void {
  const m = ev.data;
  const a = analysis;
  if (!a || m.job !== a.job || m.job !== job) return;
  spectro.addTile(m.col0, m.width, m.bins, m.data);
  collected.push({ col0: m.col0, width: m.width, data: m.data });
  glDirty = true;

  if (collected.length === a.total) {
    ready(a.t0, false);
    // archived in the background: the next session skips the analysis
    void putSpectrum({
      key: a.key, cols: a.cols, bins: a.bins, hop: a.hop, fftSize: a.fftSize,
      sampleRate: a.sampleRate, tiles: collected, at: Date.now(),
    }).then(() => { collected = []; });
    analysis = null;
    return;
  }
  dispatch(ev.target as Worker);
}

function buildPeaks(src: Float32Array, bucket: number): Float32Array {
  const n = Math.max(1, Math.floor(src.length / bucket));
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let lo = 1, hi = -1;
    const s = i * bucket, e = Math.min(src.length, s + bucket);
    for (let j = s; j < e; j++) { const v = src[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[i * 2] = lo; out[i * 2 + 1] = hi;
  }
  return out;
}

// -------------------------------------------------------------------- loop ---

/** A selection, when there is one, always loops: there is no switch. */
function applyLoop(): void {
  engine.setLoop(hasLoop, Math.min(loopA, loopB), Math.max(loopA, loopB));
  uiDirty = true;
  stateDirty = true;
}

function setLoopRange(a: number, b: number): void {
  loopA = Math.max(0, Math.min(snap(a), duration));
  loopB = Math.max(0, Math.min(snap(b), duration));
  hasLoop = Math.abs(loopB - loopA) > 0.02;
  applyLoop();
}

function clearLoop(): void {
  hasLoop = false;
  loopA = loopB = 0;
  applyLoop();
}

// --------------------------------------------------------------- time grid ---

const GRID_HINTS = [
  'Click the first beat',
  'Click the next beat',
  'Drag any beat: the first moves the grid, the others set the tempo',
];

function showGridHint(): void {
  el.gridHint.textContent = GRID_HINTS[gridStage];
  // the tempo it comes to, so the last beat can be lined up on a number
  el.gridTempo.textContent = grid && grid.beat > 0
    ? `${grid.beat.toFixed(3)} s · ${(60 / grid.beat).toFixed(1)} BPM`
    : '';
  el.gridClear.classList.toggle('hide', gridStage < 2);
  el.gridEdit.classList.toggle('on', gridEditing);
  el.gridBar.classList.toggle('hide', !gridEditing);
}

function enterGridEdit(): void {
  if (!duration) return;
  gridEditing = true;
  gridWas = grid ? { ...grid } : null;
  gridStage = grid && grid.beat > 0 ? 2 : 0;
  showGridHint();
  uiDirty = true;
}

function exitGridEdit(keep: boolean): void {
  gridEditing = false;
  if (keep) {
    if (gridStage < 2) grid = null;      // half a grid is not a grid
  } else {
    grid = gridWas ? { ...gridWas } : null;
  }
  gridStage = grid ? 2 : 0;
  gridHover = -1;
  showGridHint();
  stateDirty = true;
  uiDirty = true;
}

/** Laying the grid out: the first click marks a beat, the second sets the spacing. */
function gridClick(t: number): void {
  const div = Number(el.gridDiv.value);
  if (gridStage === 0) {
    grid = { offset: t, beat: 0, div };
    gridStage = 1;
  } else if (gridStage === 1 && grid) {
    const beat = Math.abs(t - grid.offset);
    if (beat < 0.02) return;             // two clicks on the same spot mean nothing
    grid = { offset: Math.min(grid.offset, t), beat, div };
    gridStage = 2;
  } else {
    return;                              // laid out: clicks tune, they do not clear
  }
  showGridHint();
  stateDirty = true;
  uiDirty = true;
}

/** Drops the grid and starts over from the first beat. */
function gridClear(): void {
  grid = null;
  gridStage = 0;
  gridHover = -1;
  showGridHint();
  stateDirty = true;
  uiDirty = true;
}

/**
 * Micro-tuning: the first beat carries the whole grid, any other one sets the
 * spacing with the first beat as the anchor — drag the eighth beat and the tempo
 * moves by an eighth of what you dragged.
 */
function gridDragTo(index: number, t: number): void {
  if (!grid) return;
  if (index === 0) grid = { ...grid, offset: t };
  else grid = { ...grid, beat: Math.max(0.05, (t - grid.offset) / index) };
  showGridHint();
  uiDirty = true;
  stateDirty = true;
}

el.gridEdit.addEventListener('click', () => (gridEditing ? exitGridEdit(true) : enterGridEdit()));
el.gridSave.addEventListener('click', () => exitGridEdit(true));
el.gridCancel.addEventListener('click', () => exitGridEdit(false));
el.gridClear.addEventListener('click', () => gridClear());
el.gridDiv.addEventListener('change', () => {
  if (grid) grid = { ...grid, div: Number(el.gridDiv.value) };
  uiDirty = true;
  stateDirty = true;
});
el.magnet.addEventListener('change', () => { stateDirty = true; });

// ----------------------------------------------------------------- markers ---

/** A, B, … Z, AA, AB, …: first free label, so they never repeat. */
function nextLabel(): string {
  const used = new Set(markers.map((m) => m.label));
  for (let i = 0; ; i++) {
    let n = i + 1;
    let s = '';
    while (n > 0) {
      s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
      n = Math.floor((n - 1) / 26);
    }
    if (!used.has(s)) return s;
  }
}

function addMarker(t = engine.position): void {
  if (!duration) return;
  markers.push({ t: Math.max(0, Math.min(t, duration)), label: nextLabel() });
  uiDirty = true;
  stateDirty = true;
}

/** Marker whose flag sits under x, if any. */
function markerAt(x: number, tol = MARKER_HIT): number {
  return markers.findIndex((m) => Math.abs(xOfTime(m.t) - x) <= tol);
}

function removeMarker(i: number): void {
  markers.splice(i, 1);
  uiDirty = true;
  stateDirty = true;
}

// ------------------------------------------------------------ pinned notes ---

const yOfFreq = (f: number) =>
  TOP + (1 - freqToFrac(f, view.fMin, view.fMax, view.log)) * plotH();

/** Pinned note nearest the pointer within the hit radius, or -1. */
function pitchAt(x: number, y: number): number {
  let hit = -1;
  let best = Infinity;
  pitches.forEach((p, i) => {
    const dx = xOfTime(p.t) - x;
    const dy = yOfFreq(midiToFreq(p.midi)) - y;
    if (Math.abs(dx) > PITCH_HIT || Math.abs(dy) > PITCH_HIT) return;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; hit = i; }
  });
  return hit;
}

/** Pins pitch and instant of the clicked point, snapping to the semitone. */
function addPitch(t: number, freq: number): void {
  if (!duration || !(freq > 0)) return;
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  if (midi < 12 || midi > 127) return;
  pitches.push({ t: Math.max(0, Math.min(snap(t), duration)), midi });
  pitches.sort((a, b) => a.t - b.t);
  engine.beep(midiToFreq(midi));
  uiDirty = true;
  stateDirty = true;
}

function removePitch(i: number): void {
  pitches.splice(i, 1);
  uiDirty = true;
  stateDirty = true;
}

/**
 * Sounds the notes the cursor has just crossed. Driven by the audio thread, not
 * by the draw loop: under load frames thin out and a note would be missed.
 */
function soundCrossedPitches(playhead: number): void {
  const mode = el.playMode.value;
  // after a seek we resume from here: no burst for the stretch skipped over
  if (noteSeen !== engine.seekCount) {
    noteSeen = engine.seekCount;
    notePos = playhead;
    return;
  }
  if (mode === 'track' || !engine.playing || !pitches.length) {
    notePos = playhead;
    return;
  }

  // A note must be *scheduled* early to be *heard* on time: the tone goes out
  // through the same device buffer as the track, so it is booked at the audio
  // clock time the marked sample is rendered at. Hence the lookahead — and hence
  // an error in the latency figure cancels out, since it shifts `playhead` and
  // `when` by the same amount in opposite directions.
  const rate = Math.max(0.01, engine.rate);
  const lat = engine.latency;
  const horizon = playhead + lat * rate + NOTE_LEAD * rate;
  if (horizon >= notePos) {
    const now = engine.ctxTime;
    for (const p of pitches) {
      if (p.t > notePos && p.t <= horizon) {
        engine.beep(midiToFreq(p.midi), 260, now - lat + (p.t - playhead) / rate);
        notesFired++;
      }
    }
  }
  notePos = horizon;
}

// ---------------------------------------------------------------- controls ---

/** Speed as a fraction (1 = normal), snapped to 100%. */
function rateValue(): number {
  const pct = Number(el.rate.value);
  return (Math.abs(pct - 100) <= 2 ? 100 : pct) / 100;
}

function setRate(pct: number, silent = false): void {
  el.rate.value = String(Math.round(pct));
  const v = rateValue();
  el.rateVal.textContent = `${Math.round(v * 100)}%`;
  if (!silent) {
    engine.setRate(v);
    stateDirty = true;
  }
}

el.rate.addEventListener('input', () => setRate(Number(el.rate.value)));
el.rate.addEventListener('dblclick', () => setRate(100));

el.file.addEventListener('change', () => {
  const f = el.file.files?.[0];
  if (f) void open(f);
});

/** Opens an audio file or a .tsa archive. */
async function open(file: File): Promise<void> {
  restored = false;
  if (!isArchiveName(file.name)) return loadFile(file);
  showLoading(`opening ${file.name}…`);
  try {
    const { header, audio } = await readArchive(file);
    applySettings({ ...DEFAULTS, ...header.settings });
    session.tracks[header.trackKey] = header.state;
    await loadFile(new File([audio], header.name, { type: header.mime }), {
      key: header.trackKey, restore: header.state,
    });
  } catch (e) {
    hideLoading();
    msg(`error: ${(e as Error).message}`);
  }
}

el.exportBtn.addEventListener('click', () => void exportArchive());

/** Writes a .tsa holding track, state and settings. */
async function exportArchive(): Promise<void> {
  if (!sourceBlob || !trackKeyCur) {
    msg('nothing to export yet');
    return;
  }
  persist(true); // the archive carries the state as it is right now
  const state = session.tracks[trackKeyCur];
  const blob = buildArchive({
    version: 1,
    name: trackName,
    mime: sourceBlob.type,
    trackKey: trackKeyCur,
    state,
    settings: session.settings,
    createdAt: new Date().toISOString(),
  }, await sourceBlob.arrayBuffer());

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = archiveName(trackName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

el.play.addEventListener('click', () => togglePlay());
engine.onEnd = () => setPlayIcon();
engine.onPos = soundCrossedPitches;
engine.onSmithError = (why) => {
  msg(`Signalsmith unavailable (${why}) — using the phase vocoder`);
  el.algo.value = 'pv';
  engine.setAlgorithm('pv');
  stateDirty = true;
};

/**
 * Starting from a stop with the cursor outside the selection jumps to its
 * beginning; a pause taken inside the selection resumes where it stopped.
 */
/**
 * Seek asked for by a click. While a selection is playing, a click outside it
 * restarts the loop from its beginning: anything else would either play material
 * the loop is about to skip, or leave the cursor stranded outside the region the
 * player keeps circling.
 */
function seekFromUser(t: number): void {
  let target = t;
  if (hasLoop && engine.playing) {
    const a = Math.min(loopA, loopB);
    const b = Math.max(loopA, loopB);
    if (target < a || target > b) target = a;
  }
  if (Math.abs(target - lastUserSeek) < 1e-6) return;   // no restart on every drag step
  lastUserSeek = target;
  engine.seek(target);
}

function togglePlay(): void {
  notePos = engine.position;
  if (!engine.playing && hasLoop) {
    const a = Math.min(loopA, loopB);
    const b = Math.max(loopA, loopB);
    const p = engine.position;
    if (p < a || p > b) engine.seek(a);
  }
  engine.toggle();
  setPlayIcon();
}

function setPlayIcon(): void {
  el.play.classList.toggle('playing', engine.playing);
  el.play.classList.toggle('on', engine.playing);
  el.play.setAttribute('aria-label', engine.playing ? 'Pausa' : 'Play');
}

el.playMode.addEventListener('change', () => {
  engine.setTrackAudible(el.playMode.value !== 'notes');
  notePos = engine.position; // no burst of notes for what is already behind
  stateDirty = true;
});

el.zoomAll.addEventListener('click', () => { view.t0 = 0; view.tSpan = Math.max(duration, 0.05); glDirty = true; });

// -------------------------------------------------------------- side menu ---

el.setBtn.addEventListener('click', () => toggleMenu());

/** The menu is a sidebar: the button toggles it, Esc closes it. */
function toggleMenu(open = !menuOpen): void {
  menuOpen = open;
  el.menu.classList.toggle('open', open);
  el.setBtn.classList.toggle('on', open);
  el.setBtn.setAttribute('aria-expanded', String(open));
  glDirty = uiDirty = true; // the plot changes width
}

el.freqScale.addEventListener('change', () => {
  view.log = el.freqScale.value === 'log';
  clampFreq();
  glDirty = true;
  stateDirty = true;
});

/** A log scale cannot take fMin = 0: raise the bottom edge when needed. */
function clampFreq(): void {
  if (view.log && view.fMin < 5) view.fMin = 5;
  if (view.fMax < view.fMin * 1.05) view.fMax = Math.min(nyquist, view.fMin * 1.05);
}
el.gain.addEventListener('input', () => {
  view.gain = Number(el.gain.value);
  el.gainVal.textContent = `${el.gain.value} dB`;
  glDirty = true;
});
el.range.addEventListener('input', () => {
  view.range = Number(el.range.value);
  el.rangeVal.textContent = `${el.range.value} dB`;
  glDirty = true;
});
el.algo.addEventListener('change', () => {
  engine.setAlgorithm(el.algo.value);
  stateDirty = true;
});

el.specOffset.addEventListener('input', () => setSpecOffset(Number(el.specOffset.value)));
el.specOffset.addEventListener('change', () => setSpecOffset(Number(el.specOffset.value)));

/** Shifts the spectrum against the track: positive moves it right. */
function setSpecOffset(ms: number, silent = false): void {
  const clamped = Math.max(-250, Math.min(250, Math.round(ms || 0)));
  if (String(clamped) !== el.specOffset.value) el.specOffset.value = String(clamped);
  view.offset = clamped / 1000;
  glDirty = true;
  if (!silent) stateDirty = true;
}

// keys: chromatic plus the 24 natural ones; pinned notes follow the choice
for (const opt of scaleOptions()) {
  if (opt.value === 'chromatic') continue; // already there as the first option
  const o = document.createElement('option');
  o.value = opt.value;
  o.textContent = opt.label;
  el.scale.append(o);
}
el.scale.addEventListener('change', () => { uiDirty = true; stateDirty = true; });
el.fft.addEventListener('change', () => { compute(); stateDirty = true; });
el.cmap.addEventListener('change', () => {
  spectro.setColormap(el.cmap.value as CmapName);
  glDirty = true;
  stateDirty = true;
});
el.followBtn.addEventListener('click', () => {
  follow = !follow;
  el.followBtn.classList.toggle('on', follow);
  stateDirty = true;
});
el.mix.addEventListener('input', () => setMix(Number(el.mix.value)));
el.mix.addEventListener('dblclick', () => setMix(0));

/** Track/notes balance: left lowers the track, right lowers the notes. */
function setMix(mix: number, silent = false): void {
  el.mix.value = String(Math.round(mix));
  const v = Number(el.mix.value);
  engine.setMix(v);
  el.mixVal.textContent = `${Math.round(Math.min(1, 1 + v / 100) * 100)} / ${Math.round(Math.min(1, 1 - v / 100) * 100)}`;
  if (!silent) stateDirty = true;
}

// ------------------------------------------------------------ plot pointer ---

type Mode = 'none' | 'pan' | 'scrub' | 'loopNew' | 'loopA' | 'loopB' | 'gridBeat';
let mode: Mode = 'none';
let startX = 0, startY = 0, lastY = 0, startT0 = 0, startAnchorT = 0, moved = 0;
let dragBeat = -1;

el.ovl.addEventListener('pointerdown', (e) => {
  if (!duration || e.button !== 0) return; // the right button belongs to the markers
  const r = el.ovl.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  startX = x; startY = y; lastY = y; startT0 = view.t0; startAnchorT = timeAt(x); moved = 0;
  el.ovl.setPointerCapture(e.pointerId);

  if (y < RULER_H) {
    // ctrl+click (cmd on mac) on a flag deletes the marker; a plain click moves the cursor
    if (e.ctrlKey || e.metaKey) {
      const hit = markerAt(x);
      if (hit >= 0) { removeMarker(hit); return; }
    }
    mode = 'scrub';
    lastUserSeek = -1;
    seekFromUser(timeAt(x));
  } else if (gridEditing && y >= TOP) {
    // while the grid is being edited the plot belongs to it: a beat under the
    // pointer is dragged, anywhere else the click lands on pointerup
    dragBeat = beatAt(x);
    mode = 'gridBeat';
  } else if (nearHandle(x, y)) {
    mode = nearHandle(x, y)!; // selection edge: grabbable from the lane and the plot
  } else if (y < TOP) {
    mode = 'loopNew';
    setLoopRange(startAnchorT, startAnchorT);
  } else if (e.shiftKey) {
    mode = 'loopNew';
    setLoopRange(startAnchorT, startAnchorT);
  } else {
    mode = 'pan';
  }
  uiDirty = true;
});

/** Selection edge under the pointer, from the lane downwards. */
function nearHandle(x: number, y = TOP): 'loopA' | 'loopB' | null {
  if (!hasLoop || y < RULER_H) return null;
  const xa = xOfTime(Math.min(loopA, loopB));
  const xb = xOfTime(Math.max(loopA, loopB));
  if (Math.abs(x - xa) < 6) return loopA <= loopB ? 'loopA' : 'loopB';
  if (Math.abs(x - xb) < 6) return loopA <= loopB ? 'loopB' : 'loopA';
  return null;
}

el.ovl.addEventListener('pointermove', (e) => {
  const r = el.ovl.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  hover = { x, y };
  uiDirty = true;
  if (duration) {
    el.stCur.textContent = y > TOP
      ? `${fmtTime(timeAt(x))} · ${fmtHz(freqAt(y))} Hz · ${noteName(freqAt(y))}`
      : fmtTime(timeAt(x));
  }
  if (mode === 'none') {
    // over a selection edge, or over a beat while the grid is edited, the pointer
    // says it can be dragged sideways
    const editingHere = gridEditing && y >= TOP;
    const onBeat = editingHere ? beatAt(x) : -1;
    if (onBeat !== gridHover) { gridHover = onBeat; uiDirty = true; }
    // the selection is not grabbable while the grid is edited: don't offer it
    const grabbable = editingHere ? onBeat >= 0 : nearHandle(x, y) !== null;
    el.ovl.style.cursor = grabbable ? 'ew-resize' : 'crosshair';
    return;
  }
  moved = Math.max(moved, Math.abs(x - startX) + Math.abs(y - startY));

  switch (mode) {
    case 'pan': {
      view.t0 = startT0 - ((x - startX) / Math.max(1, plotW())) * view.tSpan;
      clampTime();
      panFreqPx(y - lastY);
      lastY = y;
      glDirty = true;
      break;
    }
    case 'scrub':
      seekFromUser(timeAt(x));
      break;
    case 'gridBeat':
      if (dragBeat >= 0) gridDragTo(dragBeat, timeAt(x));
      break;
    case 'loopNew':
      setLoopRange(startAnchorT, timeAt(x));
      break;
    case 'loopA':
      setLoopRange(timeAt(x), loopB);
      break;
    case 'loopB':
      setLoopRange(loopA, timeAt(x));
      break;
    default:
      break;
  }
});

el.ovl.addEventListener('pointerup', (e) => {
  const r = el.ovl.getBoundingClientRect();
  const x = e.clientX - r.left;
  if (mode === 'gridBeat' && dragBeat < 0 && moved < 4) gridClick(timeAt(x));
  else if (mode === 'pan' && moved < 4) { lastUserSeek = -1; seekFromUser(timeAt(x)); }
  if (mode === 'loopNew' && moved < 4) clearLoop();
  mode = 'none';
  uiDirty = true;
});

el.ovl.addEventListener('pointerleave', () => {
  hover = null;
  el.ovl.style.cursor = 'crosshair';
  uiDirty = true;
});

/**
 * Right click: on the plot it pins (or drops) the note under the pointer; in the
 * ruler and the lane it does the same with time markers.
 */
el.ovl.addEventListener('contextmenu', (e) => {
  if (!duration) return;
  e.preventDefault();
  const r = el.ovl.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;

  if (y >= TOP) {
    const hit = pitchAt(x, y);
    if (hit >= 0) removePitch(hit);
    else addPitch(timeAt(x), freqAt(y));
    return;
  }

  const hit = markerAt(x, MARKER_NEAR);
  if (hit >= 0) removeMarker(hit);
  else addMarker(timeAt(x));
});

el.ovl.addEventListener('wheel', (e) => {
  if (!duration) return;
  e.preventDefault();
  const r = el.ovl.getBoundingClientRect();
  const fx = (e.clientX - r.left) / Math.max(1, plotW());
  const fy = 1 - Math.min(1, Math.max(0, (e.clientY - r.top - TOP) / Math.max(1, plotH())));
  const unit = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 400 : 1;
  const dy = e.deltaY * unit;
  if (e.altKey) {
    zoomFreq(Math.pow(1.0016, dy), fy);
  } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const step = dy !== 0 ? dy : e.deltaX * unit;
    view.t0 += (step / Math.max(1, plotW())) * view.tSpan;
    clampTime();
    glDirty = true;
  } else {
    zoomTime(Math.pow(1.0018, dy), Math.min(1, Math.max(0, fx)));
  }
}, { passive: false });


// -------------------------------------------------------- overview pointer ---

let ovMode: 'none' | 'view' | 'loop' = 'none';
let ovAnchor = 0;

function ovTime(e: PointerEvent): number {
  const r = el.overview.getBoundingClientRect();
  return Math.max(0, Math.min(duration, ((e.clientX - r.left) / Math.max(1, r.width)) * duration));
}

el.overview.addEventListener('pointerdown', (e) => {
  if (!duration || e.button !== 0) return;
  el.overview.setPointerCapture(e.pointerId);
  const t = ovTime(e);
  if (e.shiftKey) { ovMode = 'loop'; ovAnchor = t; setLoopRange(t, t); }
  else { ovMode = 'view'; view.t0 = t - view.tSpan / 2; clampTime(); glDirty = true; }
});
el.overview.addEventListener('pointermove', (e) => {
  if (ovMode === 'none') return;
  const t = ovTime(e);
  if (ovMode === 'view') { view.t0 = t - view.tSpan / 2; clampTime(); glDirty = true; }
  else setLoopRange(ovAnchor, t);
});
el.overview.addEventListener('pointerup', () => { ovMode = 'none'; });

// ---------------------------------------------------------------- keyboard ---

window.addEventListener('keydown', (e) => {
  if (el.welcome.open) return; // the welcome card closes with its button or Esc
  if (gridEditing && e.key === 'Escape') { exitGridEdit(false); return; }
  if (menuOpen && e.key === 'Escape') { toggleMenu(false); return; }
  // space is always play/pause, even with focus on a select or a button
  if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  switch (e.key) {
    case 'a': case 'A':
      setLoopRange(engine.position, hasLoop ? loopB : engine.position + 2);
      break;
    case 'b': case 'B':
      setLoopRange(hasLoop ? loopA : Math.max(0, engine.position - 2), engine.position);
      break;
    case 'Escape': clearLoop(); break;
    case 'm': case 'M': addMarker(); break;
    case 'f': case 'F': el.followBtn.click(); break;
    case '0': view.t0 = 0; view.tSpan = Math.max(duration, 0.05); glDirty = true; break;
    case '+': case '=': zoomTime(1 / 1.6, 0.5); break;
    case '-': case '_': zoomTime(1.6, 0.5); break;
    case 'ArrowLeft': engine.seek(engine.position - (e.shiftKey ? 5 : 1)); break;
    case 'ArrowRight': engine.seek(engine.position + (e.shiftKey ? 5 : 1)); break;
    case 'Home': engine.seek(0); break;
    default: return;
  }
  uiDirty = true;
});

// ------------------------------------------------------------------- drop ----

for (const type of ['dragenter', 'dragover'] as const) {
  el.plot.addEventListener(type, (e) => { e.preventDefault(); el.plot.classList.add('dragover'); });
}
for (const type of ['dragleave', 'drop'] as const) {
  el.plot.addEventListener(type, (e) => { e.preventDefault(); el.plot.classList.remove('dragover'); });
}
el.plot.addEventListener('drop', (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void open(f);
});

// ------------------------------------------------------------------ resize ---

function fit(cv: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width === w && cv.height === h) return false;
  cv.width = w; cv.height = h;
  return true;
}

new ResizeObserver(() => { glDirty = uiDirty = true; }).observe(el.plot);
new ResizeObserver(() => { uiDirty = true; }).observe(el.overview);
window.addEventListener('resize', () => { glDirty = uiDirty = true; });

// -------------------------------------------------------------------- draw ---

let lastPlayhead = -1;

function frame(): void {
  requestAnimationFrame(frame);
  const playhead = engine.position;

  if (engine.playing && follow && duration) {
    const lo = view.t0 + view.tSpan * 0.12;
    const hi = view.t0 + view.tSpan * 0.78;
    if (playhead < lo || playhead > hi) {
      view.t0 = playhead - view.tSpan * 0.35;
      clampTime();
      glDirty = true;
    }
  }

  const moved = playhead !== lastPlayhead;
  if (!glDirty && !uiDirty && !moved) return;
  lastPlayhead = playhead;

  const dpr = window.devicePixelRatio || 1;
  if (fit(el.gl)) glDirty = true;
  fit(el.ovl);
  fit(el.axis);
  fit(el.overview);
  spectro.topPx = Math.round(TOP * dpr);

  if (glDirty) {
    spectro.draw(view);
    drawAxis(el.axis, view);
  }
  drawOverlay(el.ovl, {
    view, duration, playhead,
    loopA: Math.min(loopA, loopB), loopB: Math.max(loopA, loopB), hasLoop, markers, pitches, scale: el.scale.value, grid, gridHover, hover,
  });
  drawOverview(el.overview, peaks, {
    duration, view, playhead, loopA: Math.min(loopA, loopB), loopB: Math.max(loopA, loopB),
    hasLoop, markers,
  });
  el.stTime.textContent = fmtTime(playhead);

  if (glDirty) stateDirty = true; // zoom and pan change the view worth remembering
  glDirty = false;
  uiDirty = false;
}

function msg(text: string): void { el.stMsg.textContent = text; }

// small handle for debugging / automated smoke tests
(window as unknown as Record<string, unknown>).__scribe = {
  engine, view, spectro, setLoopRange, addMarker, addPitch, removePitch, persist,
  beatAt, xOfTime, timeAt,
  setGrid(g: TimeGrid | null) { grid = g; gridStage = g ? 2 : 0; showGridHint(); uiDirty = true; },
  get state() {
    return {
      duration, hasLoop, loopA, loopB, markers, pitches, trackName,
      trackKey: trackKeyCur, restored, playing: engine.playing, ready: lastReady, grid, gridEditing,
      notesFired, notePos, playMode: el.playMode.value, trackVolume: engine.trackVolume,
      mode, dragBeat, gridHover,
    };
  },
};

requestAnimationFrame(frame);

// ----------------------------------------------------------------- session ---

// the cursor always moves: save periodically, plus once on the way out
setInterval(() => {
  if (!stateDirty && !engine.playing) return;
  stateDirty = false;
  persist(true);
  // keep the shared copy fresh: a new tab starts from it
  promoteSession(session);
}, 2000);

// the device latency settles after playback starts, and changes with the output
// device: without refreshing it the playhead would sit wherever it was first read
setInterval(() => { if (engine.playing) engine.refreshLatency(); }, 1000);

// on the way out the tab promotes its own state: it becomes the starting point
// for the next tab, without stepping on the ones already open
for (const ev of ['pagehide', 'beforeunload'] as const) {
  window.addEventListener(ev, () => { persist(true); promoteSession(session); });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { persist(true); promoteSession(session); }
});

el.welcomeBtn.addEventListener('click', () => el.welcome.close());
el.welcome.addEventListener('close', () => markWelcomeSeen());
if (!welcomeSeen()) el.welcome.showModal();

applySettings(session.settings);
// the spinner starts before touching IndexedDB, so the wait shows at once
if (session.lastKey) showLoading('restoring the previous session…');
void restoreLast();
