export const RULER_H = 26;
export const LANE_H = 16;
export const TOP = RULER_H + LANE_H;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Vertical fraction (0 = bottom = fMin) for a frequency. */
export function freqToFrac(f: number, fMin: number, fMax: number, log: boolean): number {
  return log ? Math.log(f / fMin) / Math.log(fMax / fMin) : (f - fMin) / (fMax - fMin);
}

export function fracToFreq(y: number, fMin: number, fMax: number, log: boolean): number {
  return log ? fMin * Math.pow(fMax / fMin, y) : fMin + (fMax - fMin) * y;
}

export function midiToFreq(m: number): number { return 440 * Math.pow(2, (m - 69) / 12); }

export function noteName(f: number): string {
  if (!(f > 0)) return '';
  const m = 69 + 12 * Math.log2(f / 440);
  const r = Math.round(m);
  const cents = Math.round((m - r) * 100);
  const name = `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
  return `${name}${cents === 0 ? '' : (cents > 0 ? '+' : '') + cents}`;
}

const TIME_STEPS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Smallest nice tick step whose on-screen spacing is at least minPx. */
export function timeStep(tSpan: number, widthPx: number, minPx = 78): number {
  for (const s of TIME_STEPS) if ((s / tSpan) * widthPx >= minPx) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

export function fmtTime(t: number, ms = true): string {
  if (!isFinite(t)) t = 0;
  const sign = t < 0 ? '-' : '';
  const total = Math.round(Math.abs(t) * 1000); // integer ms: 1.4 must not print as 1.399
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  if (!ms) return `${sign}${m}:${String(s).padStart(2, '0')}`;
  return `${sign}${m}:${String(s).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

export function fmtHz(f: number): string {
  if (f >= 10000) return `${(f / 1000).toFixed(1)}k`;
  if (f >= 1000) return `${(f / 1000).toFixed(f % 1000 < 50 ? 0 : 2)}k`;
  return `${f < 100 ? f.toFixed(f < 10 ? 1 : 0) : Math.round(f)}`;
}
