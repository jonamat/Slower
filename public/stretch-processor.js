/**
 * Time-stretch player: three algorithms behind one interface.
 *
 * Holds the whole decoded track in the audio thread and synthesises output at 1x
 * while walking the source at `rate`, pitch untouched. Which artefacts show up at
 * low rates depends on the algorithm:
 *
 *   wsola  waveform-similarity overlap-add. Cheap, transparent near 1x; at very
 *          low rates the repeated splices comb the spectrum.
 *   pv     phase vocoder with identity phase locking. Smooth on tonal material
 *          however far it is slowed down; softens attacks, which is the price of
 *          resynthesising instead of copying waveform.
 *
 *   smear  the PaulStretch idea: a long window with the phase of every bin
 *          randomised. Nothing is faithful about it and transients are gone, but
 *          the pitches stay perfectly legible at 20% and it never sounds rough,
 *          which is what picking notes out of a chord needs.
 *
 * An engine that played attacks at 1x to keep them sharp was tried and dropped:
 * it made the speed lurch between full and a standstill.
 *
 * Messages in:  load | play | pause | seek | rate | loop | latency | algo
 * Messages out: pos (audible source position, seek generation) | end
 */

const FRAME_BASE = 2048;  // analysis window near 1x
const FRAME_SLOW = 4096;  // below SLOW_RATE: better pitch resolution
const FRAME_SMEAR = 8192; // ~170 ms: the smear engine wants a long window
const SLOW_RATE = 0.55;
const SEARCH = 320;       // +/- samples of similarity search
const CORR = 256;         // correlation length
const CORR_COARSE = 128;
const FIFO = 16384;       // output ring buffer per channel
const POS_EVERY = 4;      // post the playhead every 4 render quanta (~11 ms)
const MARKS = 64;         // hops tracked to map output samples back to source time

/** Iterative radix-2 FFT. Mirrors src/dsp/fft.ts; a worklet cannot import it. */
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  forward(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = sin[k];
          const a = i + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr;        im[a] += xi;
        }
      }
    }
  }

  /** In place and scaled: conj, forward, conj, 1/n. */
  inverse(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    const s = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= -s; }
  }
}

function princarg(p) {
  let x = p;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ch = null;      // Float32Array[] source channels
    this.nch = 0;
    this.len = 0;

    this.rate = 1;
    this.playing = false;
    this.loopOn = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.algo = 'wsola';

    this.ideal = 0;      // fractional analysis position, in source samples
    this.reset = true;   // no phase or similarity history yet

    this.fifo = [new Float32Array(FIFO), new Float32Array(FIFO)];
    this.fr = 0;
    this.fw = 0;
    this.avail = 0;
    this.blocks = 0;
    this.gen = 0;

    // output-to-source map: what is heard now was produced a while ago, possibly
    // on the other side of a loop wrap
    this.outCount = 0;
    this.readCount = 0;
    this.marks = Array.from({ length: MARKS }, () => ({ out: 0, src: 0 }));
    this.markN = 0;
    this.deviceOut = 0;

    this.frame = 0;
    this.setFrame(FRAME_BASE);
    this.port.onmessage = (e) => this.onMessage(e.data);

    // offline rendering starts before any message can be delivered, so the same
    // state can be handed over at construction time instead
    const o = options && options.processorOptions;
    if (o) {
      if (o.algo) this.algo = o.algo;
      if (o.rate) { this.rate = o.rate; this.syncFrame(); }
      if (o.channels) {
        this.ch = o.channels;
        this.nch = o.channels.length;
        this.len = o.channels[0].length;
        this.loopStart = 0;
        this.loopEnd = this.len;
        this.seek(0);
      }
      if (o.play) this.playing = true;
    }
  }

  /** Allocates everything that depends on the window size. */
  setFrame(n) {
    if (this.frame === n) return;
    this.frame = n;
    this.hopOla = n / 2;   // periodic Hann at 50% overlap sums to 1
    this.hopPv = n / 4;    // Hann squared at 75% overlap, normalised below
    this.win = new Float32Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    let wsum = 0;
    for (let i = 0; i < n; i += this.hopPv) wsum += this.win[i] * this.win[i];
    this.pvNorm = 1 / (wsum || 1);

    this.acc = [new Float32Array(n), new Float32Array(n)];
    this.tmpl = new Float32Array(CORR);

    this.fft = new FFT(n);
    const bins = n / 2 + 1;
    this.reL = new Float32Array(n); this.imL = new Float32Array(n);
    this.reR = new Float32Array(n); this.imR = new Float32Array(n);
    this.magMid = new Float32Array(bins);
    this.phiMid = new Float32Array(bins);
    this.phiPrev = new Float32Array(bins);
    this.phiAcc = new Float32Array(bins);
    this.peakOf = new Int32Array(bins);
    this.clearHistory();
  }

  clearHistory() {
    this.acc[0].fill(0);
    this.acc[1].fill(0);
    this.phiPrev.fill(0);
    this.phiAcc.fill(0);
    this.reset = true;
  }

  /**
   * Window size follows the rate: longer when heavily stretched, for pitch
   * resolution. The transient engine keeps the short one, because a long window
   * smears the attacks it exists to protect.
   */
  syncFrame() {
    // only the plain phase vocoder gains from a long window: overlap-add engines
    // repeat a whole hop of material per step, and a long hop is audible as
    // chorusing, while the transient engine needs time resolution
    const slow = this.rate < SLOW_RATE && this.algo === 'pv';
    this.setFrame(slow ? FRAME_SLOW : FRAME_BASE);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.ch = m.channels;
        this.nch = m.channels.length;
        this.len = m.channels[0].length;
        this.loopStart = 0;
        this.loopEnd = this.len;
        this.playing = false;
        this.seek(0);
        break;
      case 'play':
        if (this.ch) this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        this.gen = m.gen | 0;
        this.seek(m.pos);
        break;
      case 'rate':
        this.rate = Math.min(4, Math.max(0.05, m.rate));
        this.syncFrame();
        break;
      case 'loop':
        this.loopOn = !!m.on;
        this.loopStart = Math.max(0, Math.min(m.start, this.len - 1));
        this.loopEnd = Math.max(this.loopStart + this.frame, Math.min(m.end, this.len));
        break;
      case 'latency':
        this.deviceOut = Math.max(0, m.samples | 0);
        break;
      case 'algo':
        this.algo = m.algo;
        this.syncFrame();
        this.clearHistory();
        break;
      default:
        break;
    }
  }

  seek(pos) {
    this.ideal = Math.max(0, Math.min(pos, Math.max(0, this.len - this.frame - 1)));
    this.clearHistory();
    this.fr = this.fw = 0;
    this.avail = 0;
    this.outCount = 0;
    this.readCount = 0;
    this.marks[0] = { out: 0, src: this.ideal };
    this.markN = 1;
    this.postPos();
  }

  mono(i) {
    return this.nch === 1 ? this.ch[0][i] : 0.5 * (this.ch[0][i] + this.ch[1][i]);
  }

  /** Normalised cross-correlation of source@c against the stored template. */
  score(c, taps) {
    const tmpl = this.tmpl;
    const step = (CORR / taps) | 0;
    let s = 0, e = 1e-9;
    for (let i = 0; i < CORR; i += step) {
      const v = this.mono(c + i);
      s += v * tmpl[i];
      e += v * v;
    }
    return s / Math.sqrt(e);
  }

  /** Keeps the analysis position inside the track, wrapping the loop. */
  advanceBounds(hopIn) {
    const maxStart = this.len - this.frame - CORR - 1;
    if (maxStart < 1) return -1;
    if (this.loopOn && this.ideal + hopIn >= this.loopEnd) {
      this.ideal = this.loopStart + (this.ideal + hopIn - this.loopEnd);
      if (this.ideal > maxStart) this.ideal = this.loopStart;
    } else if (this.ideal > maxStart) {
      return -1;
    }
    let target = Math.round(this.ideal);
    if (target < 0) target = 0;
    if (target > maxStart) target = maxStart;
    return target;
  }

  /** Pushes hopOut samples of the accumulator into the fifo and records the map. */
  flush(hopOut, off) {
    const f0 = this.fifo[0], f1 = this.fifo[1], a0 = this.acc[0], a1 = this.acc[1];
    let w = this.fw;
    for (let i = 0; i < hopOut; i++) {
      f0[w] = a0[i];
      f1[w] = a1[i];
      w = (w + 1) % FIFO;
    }
    this.fw = w;
    this.marks[this.markN % MARKS] = { out: this.outCount, src: off };
    this.markN++;
    this.outCount += hopOut;
    this.avail += hopOut;
    a0.copyWithin(0, hopOut); a0.fill(0, this.frame - hopOut);
    a1.copyWithin(0, hopOut); a1.fill(0, this.frame - hopOut);
  }

  /**
   * Overlap-add engine: pick the splice by similarity search, window it and add it
   * over the tail of the previous one.
   */
  produceOla() {
    const N = this.frame, HOP = this.hopOla;
    const maxStart = this.len - N - CORR - 1;
    const target = this.advanceBounds(HOP);
    if (target < 0) return false;

    let off = target;
    if (!this.reset && Math.abs(this.rate - 1) > 1e-4) {
      off = this.spliceBySearch(target, maxStart);
    }
    this.reset = false;

    const win = this.win;
    for (let c = 0; c < 2; c++) {
      const src = this.ch[Math.min(c, this.nch - 1)];
      const acc = this.acc[c];
      for (let i = 0; i < N; i++) acc[i] += src[off + i] * win[i];
    }
    this.flush(HOP, off);

    for (let i = 0; i < CORR; i++) this.tmpl[i] = this.mono(off + HOP + i);
    this.ideal += HOP * this.rate;
    return true;
  }

  /**
   * Similarity search around the ideal position, coarse then fine. Kept narrow on
   * purpose: a wide search finds a better-matching splice further away, which
   * measures cleaner on a sustained chord but drifts the local timing by tens of
   * milliseconds — and that instability is what you actually hear.
   */
  spliceBySearch(target, maxStart) {
    let bestD = 0, best = -Infinity;
    for (let d = -SEARCH; d <= SEARCH; d += 2) {
      const c = target + d;
      if (c < 0 || c > maxStart) continue;
      const sc = this.score(c, CORR);
      if (sc > best) { best = sc; bestD = d; }
    }
    for (let k = -1; k <= 1; k += 2) {
      const d = bestD + k, c = target + d;
      if (c < 0 || c > maxStart) continue;
      const sc = this.score(c, CORR);
      if (sc > best) { best = sc; bestD = d; }
    }
    return Math.max(0, Math.min(target + bestD, maxStart));
  }

  /**
   * Phase vocoder. Magnitudes come from the analysis frame while phases are
   * propagated at the synthesis hop and locked to the spectral peaks, which is
   * what keeps a chord from smearing. Both channels are rotated by the phase the
   * mid signal asks for, so the stereo image stays put.
   */
  producePv() {
    const N = this.frame, HS = this.hopPv, bins = N / 2 + 1;
    const hopIn = HS * this.rate;
    const target = this.advanceBounds(hopIn);
    if (target < 0) return false;

    const off = target;
    const hardReset = this.reset;

    const win = this.win, reL = this.reL, imL = this.imL, reR = this.reR, imR = this.imR;
    const src0 = this.ch[0], src1 = this.ch[Math.min(1, this.nch - 1)];
    for (let i = 0; i < N; i++) {
      reL[i] = src0[off + i] * win[i]; imL[i] = 0;
      reR[i] = src1[off + i] * win[i]; imR[i] = 0;
    }
    this.fft.forward(reL, imL);
    this.fft.forward(reR, imR);

    const magMid = this.magMid, phiMid = this.phiMid, phiAcc = this.phiAcc;
    for (let k = 0; k < bins; k++) {
      const mr = 0.5 * (reL[k] + reR[k]);
      const mi = 0.5 * (imL[k] + imR[k]);
      magMid[k] = Math.sqrt(mr * mr + mi * mi);
      phiMid[k] = Math.atan2(mi, mr);
    }

    const HA = Math.max(1e-6, HS * this.rate);
    const twoPiN = (2 * Math.PI) / N;
    if (this.algo === 'smear') {
      // no propagation at all: fresh random phases every frame. Overlapping many
      // such frames averages into a smooth pad that keeps the spectrum intact
      for (let k = 0; k < bins; k++) phiAcc[k] = Math.random() * 2 * Math.PI;
    } else if (hardReset) {
      for (let k = 0; k < bins; k++) phiAcc[k] = phiMid[k];
    } else {
      for (let k = 0; k < bins; k++) {
        const dphi = princarg(phiMid[k] - this.phiPrev[k] - HA * twoPiN * k);
        phiAcc[k] += HS * (twoPiN * k + dphi / HA);
      }
    }
    for (let k = 0; k < bins; k++) this.phiPrev[k] = phiMid[k];

    if (this.algo === 'smear') {
      for (let k = 0; k < bins; k++) this.peakOf[k] = k;   // every bin on its own
    } else {
      this.lockPhases(bins);
    }

    for (let k = 0; k < bins; k++) {
      const p = this.peakOf[k];
      const rot = phiAcc[p] - phiMid[p];   // identity phase locking
      const cr = Math.cos(rot), ci = Math.sin(rot);
      let r = reL[k], i2 = imL[k];
      reL[k] = r * cr - i2 * ci; imL[k] = r * ci + i2 * cr;
      r = reR[k]; i2 = imR[k];
      reR[k] = r * cr - i2 * ci; imR[k] = r * ci + i2 * cr;
      if (k > 0 && k < N / 2) {
        reL[N - k] = reL[k]; imL[N - k] = -imL[k];
        reR[N - k] = reR[k]; imR[N - k] = -imR[k];
      }
    }
    this.fft.inverse(reL, imL);
    this.fft.inverse(reR, imR);

    const a0 = this.acc[0], a1 = this.acc[1], g = this.pvNorm;
    for (let i = 0; i < N; i++) {
      const w = win[i] * g;
      a0[i] += reL[i] * w;
      a1[i] += reR[i] * w;
    }
    this.flush(HS, off);
    this.reset = false;
    this.ideal += hopIn;
    return true;
  }

  /** Assigns every bin to its spectral peak, for identity phase locking. */
  lockPhases(bins) {
    const mag = this.magMid, peakOf = this.peakOf;
    let prevPeak = 0;
    peakOf[0] = 0;
    for (let k = 1; k < bins - 1; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) {
        let valley = prevPeak, lowest = Infinity;
        for (let j = prevPeak; j <= k; j++) {
          if (mag[j] < lowest) { lowest = mag[j]; valley = j; }
        }
        for (let j = prevPeak; j < valley; j++) peakOf[j] = prevPeak;
        for (let j = valley; j <= k; j++) peakOf[j] = k;
        prevPeak = k;
      }
    }
    for (let j = prevPeak; j < bins; j++) peakOf[j] = prevPeak;
  }

  produce() {
    return this.algo === 'pv' || this.algo === 'smear' ? this.producePv() : this.produceOla();
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;

    if (!this.ch || !this.playing) return true; // outputs are already zeroed

    let ended = false;
    while (this.avail < n) {
      if (!this.produce()) { ended = true; break; }
    }

    const take = Math.min(n, this.avail);
    const f0 = this.fifo[0], f1 = this.fifo[1];
    let r = this.fr;
    for (let i = 0; i < take; i++) {
      L[i] = f0[r];
      if (R) R[i] = f1[r];
      r = (r + 1) % FIFO;
    }
    this.fr = r;
    this.avail -= take;
    this.readCount += take;

    if (ended && this.avail === 0) {
      this.playing = false;
      this.port.postMessage({ type: 'end' });
    }
    if (++this.blocks % POS_EVERY === 0) this.postPos();
    return true;
  }

  /**
   * Source position of the audio being heard right now: the fifo read head minus
   * what the device still holds, mapped back through the output-to-source marks.
   * Going through the marks is what makes a loop wrap read right — the audible
   * tail still belongs to the previous pass — and it keeps the mapping correct at
   * any rate, since output and source advance by different amounts.
   */
  audiblePos() {
    const target = this.readCount - this.deviceOut;
    let best = null, oldest = null;
    const n = Math.min(this.markN, MARKS);
    for (let i = 0; i < n; i++) {
      const m = this.marks[i];
      if (!oldest || m.out < oldest.out) oldest = m;
      if (m.out <= target && (!best || m.out > best.out)) best = m;
    }
    if (!best) return oldest ? oldest.src : this.ideal; // nothing heard yet
    return best.src + (target - best.out) * this.rate;
  }

  postPos() {
    this.port.postMessage({ type: 'pos', pos: this.audiblePos(), gen: this.gen });
  }
}

registerProcessor('stretch-processor', StretchProcessor);
