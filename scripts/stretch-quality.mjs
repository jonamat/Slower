/**
 * Measures the four stretch engines offline, so the trade-offs are numbers rather
 * than opinions.
 *
 *   node scripts/stretch-quality.mjs [rate]
 *
 * Two signals, two metrics:
 *   chord  three sustained tones. "spurious" is the share of energy that is not
 *          on the three partials: the comb and warble artefacts land there, so
 *          lower is better.
 *   clicks noise bursts on a beat. "crest" is peak over RMS of the envelope:
 *          smeared attacks flatten it, so higher is better.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RATE = Number(process.argv[2] ?? 0.3);
mkdirSync(join(HERE, '.tmp'), { recursive: true });

const URL = 'http://localhost:5199/';
const server = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
  cwd: join(HERE, '..'), stdio: 'ignore', detached: true,
});
for (let i = 0; i < 60; i++) {
  try { await fetch(URL); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

const browser = await chromium.launch({ args: ['--mute-audio'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });

const rows = await page.evaluate(async (rate) => {
  const SR = 48000;
  const CHORD = [220, 277.18, 329.63];

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          const a = i + k, b = a + len / 2;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  function makeChord(seconds) {
    const n = SR * seconds;
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (const f of CHORD) v += Math.sin(2 * Math.PI * f * t);
      ch[i] = (v / CHORD.length) * 0.6;
    }
    return ch;
  }

  function makeClicks(seconds) {
    const n = SR * seconds;
    const ch = new Float32Array(n);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < n; i++) {
      const phase = (i % (SR / 4)) / SR;        // a burst every 250 ms
      ch[i] = phase < 0.006 ? rnd() * Math.exp(-phase * 900) * 0.9 : 0;
    }
    return ch;
  }

  function makeVoice(seconds) {           // one instrument: periodic, rich
    const n = SR * seconds;
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * 196 * h * t) / h;
      ch[i] = v * 0.35;
    }
    return ch;
  }

  /** The WASM library, rendered offline through its own node. */
  async function renderSmith(src, outSeconds) {
    const ctx = new OfflineAudioContext({
      numberOfChannels: 2, length: Math.round(SR * outSeconds), sampleRate: SR,
    });
    const mod = await import('/vendor/SignalsmithStretch.mjs');
    const node = await mod.default(ctx);
    await node.addBuffers([src.slice(), src.slice()]);
    node.connect(ctx.destination);
    node.setUpdateInterval(0.011);
    await node.start(0, 0, undefined, rate);
    const buf = await ctx.startRendering();
    return { out: buf.getChannelData(0), series: [] };
  }

  async function render(src, algo, outSeconds, onsets) {
    if (algo === 'signalsmith') return renderSmith(src, outSeconds);
    const ctx = new OfflineAudioContext({
      numberOfChannels: 2, length: Math.round(SR * outSeconds), sampleRate: SR,
    });
    await ctx.audioWorklet.addModule('/stretch-processor.js');
    const a = src.slice(), b = src.slice();
    const node = new AudioWorkletNode(ctx, 'stretch-processor', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { algo, rate, channels: [a, b], play: true, onsets },
    });
    node.connect(ctx.destination);
    const series = [];
    node.port.onmessage = (e) => { if (e.data.type === 'pos') series.push(e.data.pos / SR); };
    const buf = await ctx.startRendering();
    await new Promise((r) => setTimeout(r, 20));
    // the whole position series: the average tells whether the engine stretched by
    // the rate it was asked for, the spread whether it did so steadily
    return { out: buf.getChannelData(0), series };
  }

  /** Share of energy that is not sitting on a partial of `fundamentals`. */
  function spurious(out, fundamentals) {
    const N = 16384;
    const start = Math.min(out.length - N - 1, Math.round(SR * 1.2));
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      re[i] = out[start + i] * w;
    }
    fft(re, im);
    let total = 0, onPartials = 0;
    const binOf = (f) => Math.round((f * N) / SR);
    const wanted = new Set();
    for (const f of fundamentals) {
      for (let h = 1; h <= 8; h++) {           // the partials themselves are fine
        const b = binOf(f * h);
        for (let d = -3; d <= 3; d++) wanted.add(b + d);
      }
    }
    for (let k = 4; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if (wanted.has(k)) onPartials += p;
    }
    return total > 0 ? (1 - onPartials / total) * 100 : 100;
  }

  /**
   * Instantaneous rate over ~100 ms windows. An engine that lurches between full
   * speed and a standstill averages out fine yet is unusable, so the spread
   * matters as much as the mean.
   */
  function rateSpread(series, requested) {
    const step = Math.max(1, Math.round(0.1 / (512 / SR)));   // messages per 100 ms
    const local = [];
    for (let i = step; i < series.length; i += step) {
      const dt = (step * 512) / SR;
      const d = series[i] - series[i - step];
      if (d > -0.2) local.push(d / dt);                        // skip loop wraps
    }
    if (!local.length) return { mean: 0, min: 0, max: 0 };
    local.sort((a, b) => a - b);
    const mean = local.reduce((a, b) => a + b, 0) / local.length;
    return {
      mean: mean / requested,
      min: local[Math.floor(local.length * 0.05)] / requested,
      max: local[Math.floor(local.length * 0.95)] / requested,
    };
  }

  /** RMS envelope, one value per `win` samples. */
  function envelope(out, win) {
    const n = Math.floor(out.length / win);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let j = 0; j < win; j++) { const v = out[i * win + j]; e += v * v; }
      env[i] = Math.sqrt(e / win);
    }
    return env;
  }

  /**
   * Around the loudest attack: how much energy leaks *before* it (pre-echo, the
   * "mushy" sound) and how many times the hit comes out (a flam means the attack
   * was repeated by the stretcher).
   */
  function attackShape(out) {
    const win = 128;
    const env = envelope(out, win);
    const perSec = SR / win;
    let peak = 0, at = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > peak) { peak = env[i]; at = i; }
    if (peak <= 0) return { pre: 1, flam: 0 };

    const back = Math.round(0.025 * perSec);
    const pre = at - back >= 0 ? env[at - back] / peak : 0;

    const span = Math.round(0.12 * perSec);
    let flam = 0;
    for (let i = Math.max(1, at - span); i < Math.min(env.length - 1, at + span); i++) {
      if (env[i] > 0.45 * peak && env[i] >= env[i - 1] && env[i] > env[i + 1]) flam++;
    }
    return { pre, flam };
  }

  const chord = makeChord(4);
  const voice = makeVoice(4);
  const clicks = makeClicks(4);
  // the click positions are known, so the transient engine gets real onsets
  const onsets = new Float32Array(16);
  for (let i = 0; i < onsets.length; i++) onsets[i] = i * (SR / 4);

  const out = [];
  for (const algo of ['signalsmith', 'wsola', 'pv', 'smear']) {
    const t0 = performance.now();
    const ra = await render(chord, algo, 3);
    const cost = performance.now() - t0;
    const rv = await render(voice, algo, 3);
    const rb = await render(clicks, algo, 3, onsets);
    const a = ra.out, v = rv.out, b = rb.out;
    const shape = attackShape(b);
    const spread = rb.series.length ? rateSpread(rb.series, rate) : { mean: NaN, min: NaN, max: NaN };
    let peak = 0, finite = true;
    for (let i = 0; i < a.length; i++) {
      const x = Math.abs(a[i]);
      if (!Number.isFinite(x)) { finite = false; break; }
      if (x > peak) peak = x;
    }
    out.push({
      algo,
      chord: +spurious(a, CHORD).toFixed(1),
      voice: +spurious(v, [196]).toFixed(1),
      pre: +(shape.pre * 100).toFixed(1),
      flam: shape.flam,
      cost: Math.round(cost),
      rateMean: +spread.mean.toFixed(2),
      rateMin: +spread.min.toFixed(2),
      rateMax: +spread.max.toFixed(2),
      ok: finite && peak > 0.01,
    });
  }
  return out;
}, RATE);

console.log(`rate ${RATE} — spurious energy % on a chord and on one instrument (lower is better),`);
console.log('on a click track: pre-echo % before the attack and how many times it comes out');
console.log('(both lower is better) · rate = achieved over requested, mean and 5–95% spread:');
console.log('a wide spread means the speed lurches, which is unusable however good the mean');
for (const r of rows) {
  console.log(`  ${r.algo.padEnd(11)} chord ${String(r.chord).padStart(5)}%  voice ${String(r.voice).padStart(5)}%`
    + `  pre-echo ${String(r.pre).padStart(5)}%  hits ${r.flam}`
    + `  rate ${Number.isFinite(r.rateMean) ? `x${String(r.rateMean).padStart(4)} (${r.rateMin}–${r.rateMax})` : 'n/d (live test)'}  cost ${String(r.cost).padStart(4)} ms`);
}

await browser.close();
try { process.kill(-server.pid); } catch { /* already gone */ }
