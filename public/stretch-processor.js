/**
 * WSOLA time-stretch player.
 *
 * Holds the whole decoded track in the audio thread and synthesises output at
 * 1x while walking the source at `rate` (pitch preserved). Each output hop is
 * an overlap-add of one Hann frame, taken from the position near the ideal
 * analysis point that best correlates with the natural continuation of the
 * previous frame -- that is what keeps transients and phase coherent.
 *
 * Messages in:  load | play | pause | seek | rate | loop | latency
 * Messages out: pos (audible source position, seek generation) | end
 */

const FRAME = 2048;   // analysis/synthesis window
const HOP = FRAME / 2; // synthesis hop; periodic Hann at 50% overlap sums to 1
const SEARCH = 320;   // +/- samples of similarity search
const CORR = 256;     // correlation length
const FIFO = 8192;    // output ring buffer per channel
const POS_EVERY = 4;  // post the playhead every 4 render quanta (~11 ms)
const MARKS = 64;     // hops tracked to map output samples back to source time

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.ch = null;      // Float32Array[] source channels
    this.nch = 0;
    this.len = 0;

    this.rate = 1;
    this.playing = false;
    this.loopOn = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    this.ideal = 0;      // fractional analysis position, in source samples
    this.reset = true;   // skip similarity search on the next frame

    this.win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);

    this.acc = [new Float32Array(FRAME), new Float32Array(FRAME)];
    this.fifo = [new Float32Array(FIFO), new Float32Array(FIFO)];
    this.fr = 0;         // fifo read index
    this.fw = 0;         // fifo write index
    this.avail = 0;      // samples queued in fifo
    this.tmpl = new Float32Array(CORR);
    this.blocks = 0;
    this.gen = 0;        // generation of the last seek, so stale positions can be dropped

    // output-to-source map: what is heard now was produced a while ago, possibly
    // on the other side of a loop wrap
    this.outCount = 0;   // samples written into the fifo
    this.readCount = 0;  // samples read out of the fifo
    this.marks = Array.from({ length: MARKS }, () => ({ out: 0, src: 0 }));
    this.markN = 0;
    this.deviceOut = 0;  // output samples still sitting in the device buffer

    this.port.onmessage = (e) => this.onMessage(e.data);
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
        this.gen = m.gen | 0; // reported positions carry the seek generation
        this.seek(m.pos);
        break;
      case 'rate':
        this.rate = Math.min(4, Math.max(0.1, m.rate));
        break;
      case 'loop':
        this.loopOn = !!m.on;
        this.loopStart = Math.max(0, Math.min(m.start, this.len - 1));
        this.loopEnd = Math.max(this.loopStart + FRAME, Math.min(m.end, this.len));
        break;
      case 'latency':
        this.deviceOut = Math.max(0, m.samples | 0);
        break;
      default:
        break;
    }
  }

  seek(pos) {
    this.ideal = Math.max(0, Math.min(pos, Math.max(0, this.len - FRAME - 1)));
    this.reset = true;
    this.acc[0].fill(0);
    this.acc[1].fill(0);
    this.fr = this.fw = 0;
    this.avail = 0;
    this.outCount = 0;
    this.readCount = 0;
    this.marks[0] = { out: 0, src: this.ideal };
    this.markN = 1;
    this.postPos();
  }

  /** Mono sample of the source (channels summed and averaged). */
  mono(i) {
    return this.nch === 1 ? this.ch[0][i] : 0.5 * (this.ch[0][i] + this.ch[1][i]);
  }

  /** Normalised cross-correlation of source@c against the stored template. */
  score(c) {
    const tmpl = this.tmpl;
    let s = 0, e = 1e-9;
    if (this.nch === 1) {
      const a = this.ch[0];
      for (let i = 0; i < CORR; i++) { const v = a[c + i]; s += v * tmpl[i]; e += v * v; }
    } else {
      const a = this.ch[0], b = this.ch[1];
      for (let i = 0; i < CORR; i++) { const v = 0.5 * (a[c + i] + b[c + i]); s += v * tmpl[i]; e += v * v; }
    }
    return s / Math.sqrt(e);
  }

  /** Synthesise HOP samples into the fifo. Returns false when the track ends. */
  produce() {
    const maxStart = this.len - FRAME - CORR - 1;
    if (maxStart < 1) return false;

    if (this.loopOn && this.ideal + HOP >= this.loopEnd) {
      this.ideal = this.loopStart + (this.ideal + HOP - this.loopEnd);
      if (this.ideal > maxStart) this.ideal = this.loopStart;
    } else if (this.ideal > maxStart) {
      return false;
    }

    let target = Math.round(this.ideal);
    if (target < 0) target = 0;
    if (target > maxStart) target = maxStart;

    let off = target;
    if (!this.reset && Math.abs(this.rate - 1) > 1e-4) {
      let bestD = 0, best = -Infinity;
      for (let d = -SEARCH; d <= SEARCH; d += 2) {
        const c = target + d;
        if (c < 0 || c > maxStart) continue;
        const sc = this.score(c);
        if (sc > best) { best = sc; bestD = d; }
      }
      for (let k = -1; k <= 1; k += 2) {
        const d = bestD + k, c = target + d;
        if (c < 0 || c > maxStart) continue;
        const sc = this.score(c);
        if (sc > best) { best = sc; bestD = d; }
      }
      off = target + bestD;
    }
    this.reset = false;

    // overlap-add one windowed frame, then flush the first HOP samples
    const win = this.win;
    for (let c = 0; c < 2; c++) {
      const src = this.ch[Math.min(c, this.nch - 1)];
      const acc = this.acc[c];
      for (let i = 0; i < FRAME; i++) acc[i] += src[off + i] * win[i];
    }
    const f0 = this.fifo[0], f1 = this.fifo[1], a0 = this.acc[0], a1 = this.acc[1];
    let w = this.fw;
    for (let i = 0; i < HOP; i++) {
      f0[w] = a0[i];
      f1[w] = a1[i];
      w = (w + 1) % FIFO;
    }
    this.fw = w;
    this.marks[this.markN % MARKS] = { out: this.outCount, src: off };
    this.markN++;
    this.outCount += HOP;
    this.avail += HOP;
    a0.copyWithin(0, HOP); a0.fill(0, FRAME - HOP);
    a1.copyWithin(0, HOP); a1.fill(0, FRAME - HOP);

    // template = what would naturally follow this frame
    for (let i = 0; i < CORR; i++) this.tmpl[i] = this.mono(off + HOP + i);

    this.ideal += HOP * this.rate;
    return true;
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
   * Going through the marks is what makes a loop wrap read right - the audible
   * tail still belongs to the previous pass - and it keeps the mapping correct at
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
