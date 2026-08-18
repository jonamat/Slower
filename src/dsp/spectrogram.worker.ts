/// <reference lib="webworker" />
import { FFT } from './fft';
import { DB_FLOOR } from './consts';

/**
 * Computes one spectrogram tile per message, so several workers can share the
 * same track. Each request carries only the slice of audio it needs: its
 * columns times the hop, plus one trailing window.
 */
export interface TileRequest {
  job: number;
  col0: number;
  width: number;
  hop: number;
  fftSize: number;
  /** Mono slice starting exactly at col0 * hop. */
  mono: Float32Array;
}

export type SpecMessage = {
  type: 'tile';
  job: number;
  col0: number;
  width: number;
  bins: number;
  data: Uint8Array;
  ms: number;
};

let fft: FFT | null = null;
let fftN = 0;
let win = new Float32Array(0);
let ampScale = 1;
let re = new Float32Array(0);
let im = new Float32Array(0);

function prepare(n: number): void {
  if (fftN === n) return;
  fft = new FFT(n);
  fftN = n;
  win = new Float32Array(n);
  re = new Float32Array(n);
  im = new Float32Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // periodic Hann
    wsum += win[i];
  }
  ampScale = 2 / wsum;
}

const LOG10 = 1 / Math.LN10;
const invFloor = 255 / -DB_FLOOR;

self.onmessage = (ev: MessageEvent<TileRequest>) => {
  const req = ev.data;
  const { job, col0, width, hop, fftSize, mono } = req;
  const t0 = performance.now();
  prepare(fftSize);
  const bins = fftSize >> 1;
  const data = new Uint8Array(width * bins);

  for (let x = 0; x < width; x++) {
    const start = x * hop;
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      re[i] = s < mono.length ? mono[s] * win[i] : 0;
      im[i] = 0;
    }
    fft!.forward(re, im);
    for (let b = 0; b < bins; b++) {
      const p = re[b] * re[b] + im[b] * im[b];
      // 20*log10(amp) == 10*log10(power), with amp = ampScale*sqrt(power)
      const db = 10 * Math.log(p * ampScale * ampScale + 1e-20) * LOG10;
      let v = (db - DB_FLOOR) * invFloor;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      data[b * width + x] = v;
    }
  }

  const msg: SpecMessage = {
    type: 'tile', job, col0, width, bins, data, ms: performance.now() - t0,
  };
  (self as unknown as Worker).postMessage(msg, [data.buffer]);
};
