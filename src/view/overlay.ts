import {
  LANE_H, RULER_H, TOP, fmtHz, fmtTime, freqToFrac, midiToFreq, noteName, timeStep,
} from './scales';
import type { Marker, PitchMark } from '../store';
import { degreeName } from './scales-music';
import type { SpecView } from './spectro-gl';

export interface OverlayState {
  view: SpecView;
  duration: number;
  playhead: number;
  loopA: number;
  loopB: number;
  hasLoop: boolean;
  markers: Marker[];
  pitches: PitchMark[];
  /** Chosen key: 'chromatic', or for instance 'A:min'. */
  scale: string;
  hover: { x: number; y: number } | null;
}

/** Half width of a marker flag, in CSS px. */
export const MARKER_HIT = 9;
/**
 * How close the pointer must be to count as "on" a pinned note, in CSS px, both
 * in time and in pitch. Kept generous: a right click should remove the note, not
 * drop a second one beside it.
 */
export const PITCH_HIT = 14;

const C_ACC = '#4aa3ff';
const C_MARK = '#31e0a5';
const C_PITCH = '#ffffff';
const C_PITCH_INK = '#0a0d12';
const C_LINE = 'rgba(255,255,255,.11)';
const C_TEXT = '#aab4c3';

/** Ruler, loop lane, grid, loop region and playhead. Redrawn every frame; it is cheap. */
export function drawOverlay(cv: HTMLCanvasElement, s: OverlayState): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr;
  const h = cv.height / dpr;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { view } = s;
  const plotH = h - TOP;
  const xOf = (t: number) => ((t - view.t0) / view.tSpan) * w;
  const yOf = (f: number) => TOP + (1 - freqToFrac(f, view.fMin, view.fMax, view.log)) * plotH;

  // ---- frequency grid over the spectrogram ----
  ctx.lineWidth = 1;
  ctx.strokeStyle = C_LINE;
  ctx.beginPath();
  for (const f of axisFreqTicks(view, plotH)) {
    const y = Math.round(yOf(f)) + 0.5;
    if (y > TOP && y < h) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  }
  ctx.stroke();

  // semitone guides, only once they are readable
  if (view.log) {
    const semiPx = plotH * (Math.log(Math.pow(2, 1 / 12)) / Math.log(view.fMax / view.fMin));
    if (semiPx > 7) {
      const m0 = Math.ceil(69 + 12 * Math.log2(view.fMin / 440));
      const m1 = Math.floor(69 + 12 * Math.log2(view.fMax / 440));
      for (let m = m0; m <= m1; m++) {
        const y = Math.round(yOf(midiToFreq(m))) + 0.5;
        const isC = ((m % 12) + 12) % 12 === 0;
        ctx.strokeStyle = isC ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)';
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    }
  }

  // ---- time grid ----
  const step = timeStep(view.tSpan, w);
  const k0 = Math.ceil(view.t0 / step);
  const k1 = Math.floor((view.t0 + view.tSpan) / step);
  ctx.strokeStyle = C_LINE;
  ctx.beginPath();
  for (let k = k0; k <= k1; k++) {
    const x = Math.round(xOf(k * step)) + 0.5;
    ctx.moveTo(x, TOP); ctx.lineTo(x, h);
  }
  ctx.stroke();

  // ---- top strip ----
  ctx.fillStyle = '#141922';
  ctx.fillRect(0, 0, w, TOP);
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, RULER_H, w, LANE_H);
  ctx.strokeStyle = '#38424f';
  ctx.beginPath();
  ctx.moveTo(0, TOP - 0.5); ctx.lineTo(w, TOP - 0.5);
  ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(w, RULER_H - 0.5);
  ctx.stroke();

  ctx.fillStyle = C_TEXT;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#5b6879';
  ctx.beginPath();
  const sub = step / 5;
  for (let k = Math.ceil(view.t0 / sub); k <= Math.floor((view.t0 + view.tSpan) / sub); k++) {
    const x = Math.round(xOf(k * sub)) + 0.5;
    ctx.moveTo(x, RULER_H - 5); ctx.lineTo(x, RULER_H - 1);
  }
  for (let k = k0; k <= k1; k++) {
    const t = k * step;
    const x = Math.round(xOf(t)) + 0.5;
    ctx.moveTo(x, RULER_H - 9); ctx.lineTo(x, RULER_H - 1);
    ctx.fillText(fmtTime(t, step < 1), x + 4, RULER_H / 2 - 3);
  }
  ctx.stroke();

  // ---- loop region ----
  if (s.hasLoop) {
    const xa = xOf(s.loopA);
    const xb = xOf(s.loopB);
    ctx.fillStyle = 'rgba(74,163,255,.09)';
    ctx.fillRect(xa, TOP, xb - xa, plotH);
    ctx.fillStyle = C_ACC;
    ctx.fillRect(xa, RULER_H, xb - xa, LANE_H);
    ctx.fillStyle = '#04121f';
    ctx.font = '10px ui-monospace, monospace';
    const label = `${fmtTime(s.loopA)} → ${fmtTime(s.loopB)}  (${(s.loopB - s.loopA).toFixed(2)}s)`;
    const lw = ctx.measureText(label).width;
    const lx = Math.min(Math.max(xa + 6, 6), Math.max(6, xb - lw - 6));
    if (Math.min(xb, w) - Math.max(xa, 0) > lw + 14) {
      ctx.fillText(label, lx, RULER_H + LANE_H / 2);
    }
    ctx.strokeStyle = C_ACC;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of [Math.round(xa) + 0.5, Math.round(xb) + 0.5]) { ctx.moveTo(x, RULER_H); ctx.lineTo(x, h); }
    ctx.stroke();
      ctx.fillStyle = C_ACC;
    ctx.fillRect(xa - 2, RULER_H, 4, LANE_H);
    ctx.fillRect(xb - 2, RULER_H, 4, LANE_H);
  } else if (s.duration) {
    // empty lane: say what it is for
    ctx.fillStyle = '#93a0b1';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('select to loop, right click to mark/unmark', w / 2, RULER_H + LANE_H / 2);
    ctx.textAlign = 'left';
  }

  // ---- pinned notes: one point in the spectrum, pitch and instant together ----
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (const p of s.pitches) {
    const f = midiToFreq(p.midi);
    if (f < view.fMin || f > view.fMax) continue; // outside the window, but still stored
    const x = xOf(p.t);
    if (x < -40 || x > w + 40) continue;
    const y = yOf(f);

    // tick on the exact pitch, to line the eye up with the partial
    ctx.strokeStyle = C_PITCH;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x - 26, Math.round(y) + 0.5);
    ctx.lineTo(x + 26, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = C_PITCH;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();

    const label = degreeName(p.midi, s.scale) ?? noteName(f);
    const tw = ctx.measureText(label).width;
    const left = x + 9 + tw + 8 > w ? x - 9 - tw - 8 : x + 9;
    const top = y - 10 < TOP ? y + 10 : y - 10;
    ctx.fillRect(left, top - 7, tw + 8, 14);
    ctx.fillStyle = C_PITCH_INK;
    ctx.fillText(label, left + 4, top);
  }

  // ---- markers ----
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  for (const m of s.markers) {
    const x = xOf(m.t);
    if (x < -MARKER_HIT || x > w + MARKER_HIT) continue;
    ctx.strokeStyle = C_MARK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 4);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
    ctx.fillStyle = C_MARK;
    ctx.fillRect(x - MARKER_HIT, 3, MARKER_HIT * 2, 13);
    ctx.fillStyle = '#04160f';
    ctx.fillText(m.label, x, 10);
  }
  ctx.textAlign = 'left';

  // ---- hover crosshair ----
  if (s.hover && s.hover.y > TOP) {
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(s.hover.x) + 0.5, TOP); ctx.lineTo(Math.round(s.hover.x) + 0.5, h);
    ctx.moveTo(0, Math.round(s.hover.y) + 0.5); ctx.lineTo(w, Math.round(s.hover.y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- playhead ----
  const px = xOf(s.playhead);
  if (px >= -2 && px <= w + 2) {
    ctx.strokeStyle = '#ff3b5c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, RULER_H); ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = '#ff3b5c';
    ctx.beginPath();
    ctx.moveTo(px - 5, RULER_H); ctx.lineTo(px + 5, RULER_H); ctx.lineTo(px, RULER_H + 6);
    ctx.closePath(); ctx.fill();
  }
}

/** Frequency axis labels, drawn in the gutter to the left of the plot. */
export function drawAxis(cv: HTMLCanvasElement, view: SpecView): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr;
  const h = cv.height / dpr;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#141922';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#38424f';
  ctx.beginPath();
  ctx.moveTo(w - 0.5, 0); ctx.lineTo(w - 0.5, h);
  ctx.moveTo(0, TOP - 0.5); ctx.lineTo(w, TOP - 0.5);
  ctx.stroke();

  ctx.fillStyle = '#93a0b1';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('loop', w - 7, RULER_H + LANE_H / 2);
  ctx.textAlign = 'left';

  const plotH = h - TOP;
  ctx.fillStyle = '#aab4c3';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#5b6879';
  ctx.beginPath();
  for (const f of axisFreqTicks(view, plotH)) {
    const y = TOP + (1 - freqToFrac(f, view.fMin, view.fMax, view.log)) * plotH;
    if (y < TOP + 6 || y > h - 2) continue;
    ctx.moveTo(w - 5, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.fillText(fmtHz(f), w - 8, y);
  }
  ctx.stroke();

  ctx.save();
  ctx.textAlign = 'center';
  ctx.translate(11, TOP + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#93a0b1';
  ctx.fillText('Hz', 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}

/** Ticks thinned so no two labels land closer than minPx on screen. */
function axisFreqTicks(view: SpecView, plotH: number, minPx = 15): number[] {
  const out: number[] = [];
  let lastY = Infinity;
  for (const f of freqTicks(view)) {
    const y = (1 - freqToFrac(f, view.fMin, view.fMax, view.log)) * plotH;
    if (lastY - y >= minPx) { out.push(f); lastY = y; }
  }
  return out;
}

function freqTicks(view: SpecView): number[] {
  const out: number[] = [];
  if (view.log) {
    for (let dec = Math.floor(Math.log10(Math.max(1, view.fMin))); dec <= Math.ceil(Math.log10(view.fMax)); dec++) {
      const base = Math.pow(10, dec);
      for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const f = base * m;
        if (f >= view.fMin && f <= view.fMax) out.push(f);
      }
    }
    if (out.length > 26) return out.filter((f) => {
      const s = f / Math.pow(10, Math.floor(Math.log10(f)));
      return s === 1 || s === 2 || s === 5;
    });
    return out;
  }
  const span = view.fMax - view.fMin;
  const raw = span / 10;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  for (let f = Math.ceil(view.fMin / step) * step; f <= view.fMax; f += step) out.push(f);
  return out;
}

let wave: { key: string; cv: HTMLCanvasElement } | null = null;

/** Waveform rendered once per size and per set of peaks. */
function waveBitmap(peaks: Float32Array, w: number, h: number, dpr: number): HTMLCanvasElement {
  const key = `${peaks.length}|${w}|${h}|${dpr}`;
  if (wave && wave.key === key) return wave.cv;

  const cv = wave?.cv ?? document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  const c = cv.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  const mid = h / 2;
  const n = peaks.length / 2;
  c.strokeStyle = '#4e8bbf';
  c.beginPath();
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor((x / w) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
    let lo = 1, hi = -1;
    for (let i = i0; i < i1 && i < n; i++) {
      if (peaks[i * 2] < lo) lo = peaks[i * 2];
      if (peaks[i * 2 + 1] > hi) hi = peaks[i * 2 + 1];
    }
    if (hi < lo) continue;
    c.moveTo(x + 0.5, mid - hi * mid * 0.94);
    c.lineTo(x + 0.5, mid - lo * mid * 0.94);
  }
  c.stroke();

  wave = { key, cv };
  return cv;
}

/** Overview strip: full-track waveform, loop region and the visible window. */
export function drawOverview(
  cv: HTMLCanvasElement,
  peaks: Float32Array | null,
  st: {
    duration: number; view: SpecView; playhead: number;
    loopA: number; loopB: number; hasLoop: boolean; markers: Marker[];
  },
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr;
  const h = cv.height / dpr;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, w, h);
  if (!peaks || !st.duration) return;

  // the waveform never changes: drawn once, then blitted
  ctx.drawImage(waveBitmap(peaks, w, h, dpr), 0, 0, w, h);

  const xOf = (t: number) => (t / st.duration) * w;
  if (st.hasLoop) {
    ctx.fillStyle = 'rgba(74,163,255,.26)';
    ctx.fillRect(xOf(st.loopA), 0, xOf(st.loopB) - xOf(st.loopA), h);
  }

  const vx = xOf(st.view.t0);
  const vw = Math.max(2, xOf(st.view.t0 + st.view.tSpan) - vx);
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  ctx.fillRect(vx, 0, vw, h);
  ctx.strokeStyle = '#b3bdcb';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(vx) + 0.5, 0.5, Math.round(vw) - 1, h - 1);

  ctx.strokeStyle = C_MARK;
  ctx.beginPath();
  for (const m of st.markers) {
    const x = Math.round(xOf(m.t)) + 0.5;
    ctx.moveTo(x, 0); ctx.lineTo(x, 6);
    ctx.moveTo(x, h - 6); ctx.lineTo(x, h);
  }
  ctx.stroke();

  ctx.strokeStyle = '#ff3b5c';
  ctx.beginPath();
  const px = Math.round(xOf(st.playhead)) + 0.5;
  ctx.moveTo(px, 0); ctx.lineTo(px, h);
  ctx.stroke();
}
