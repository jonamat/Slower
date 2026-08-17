/** Decoded track kept in the audio thread + a thin control surface for it. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  /** Track-only gain; the reference notes have their own. */
  private trackGain: GainNode | null = null;
  private noteGain: GainNode | null = null;
  private gain: GainNode | null = null;
  private mix = 0;
  private audible = true;
  private ready = false;

  sampleRate = 48000;
  length = 0;          // source samples
  duration = 0;        // seconds
  playing = false;
  posSamples = 0;      // playhead, source samples (pushed by the worklet)
  rate = 1;
  /** Bumped on every seek: positions from an older generation are dropped. */
  seekCount = 0;

  onEnd: (() => void) | null = null;
  /** Called on every position reported by the audio thread (~90 per second). */
  onPos: ((seconds: number) => void) | null = null;

  async init(): Promise<void> {
    if (this.ready) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}stretch-processor.js`);
    const node = new AudioWorkletNode(ctx, 'stretch-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const trackGain = ctx.createGain();
    const noteGain = ctx.createGain();
    const gain = ctx.createGain();
    node.connect(trackGain).connect(gain).connect(ctx.destination);
    noteGain.connect(gain);
    node.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; pos?: number; gen?: number };
      if (m.type === 'pos') {
        // reported before the last seek: already stale
        if ((m.gen ?? 0) === this.seekCount) {
          this.posSamples = m.pos ?? 0;
          this.onPos?.(this.position);
        }
      } else if (m.type === 'end') { this.playing = false; this.onEnd?.(); }
    };
    this.ctx = ctx;
    this.node = node;
    this.trackGain = trackGain;
    this.noteGain = noteGain;
    this.gain = gain;
    this.applyMix();
    this.sampleRate = ctx.sampleRate;
    this.ready = true;
  }

  /** Hands the channel data over to the audio thread (transferred, not copied). */
  load(channels: Float32Array[]): void {
    if (!this.node) return;
    this.length = channels[0].length;
    this.duration = this.length / this.sampleRate;
    this.playing = false;
    this.posSamples = 0;
    this.node.port.postMessage({ type: 'load', channels }, channels.map((c) => c.buffer));
  }

  /**
   * Position of what is audible right now, straight from the audio thread: the
   * worklet already accounts for its own queue and for the device buffer.
   */
  get position(): number {
    return Math.max(0, this.posSamples / this.sampleRate);
  }

  /** Output latency reported by the device, in seconds. */
  get latency(): number {
    const ctx = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    return ctx?.outputLatency ?? ctx?.baseLatency ?? 0;
  }

  /** Tells the worklet how much output the device still holds. */
  private sendLatency(): void {
    this.node?.port.postMessage({
      type: 'latency',
      samples: Math.round(this.latency * this.sampleRate),
    });
  }

  async play(): Promise<void> {
    if (!this.node || !this.length) return;
    this.playing = true; // set first, so the UI needn't wait for resume()
    this.node.port.postMessage({ type: 'play' });
    await this.ctx!.resume();
    this.sendLatency(); // only meaningful once the device is running
  }

  pause(): void {
    if (!this.node) return;
    this.playing = false;
    this.node.port.postMessage({ type: 'pause' });
  }

  toggle(): void { if (this.playing) this.pause(); else void this.play(); }

  seek(seconds: number): void {
    if (!this.node) return;
    const pos = Math.max(0, Math.min(seconds, this.duration)) * this.sampleRate;
    this.posSamples = pos;
    this.seekCount++;
    this.node.port.postMessage({ type: 'seek', pos, gen: this.seekCount });
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.node?.port.postMessage({ type: 'rate', rate });
  }

  setLoop(on: boolean, startSec: number, endSec: number): void {
    this.node?.port.postMessage({
      type: 'loop',
      on,
      start: Math.round(startSec * this.sampleRate),
      end: Math.round(endSec * this.sampleRate),
    });
  }

  setVolume(v: number): void {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Mutes the track while letting the reference notes through. */
  setTrackAudible(on: boolean): void {
    this.audible = on;
    this.applyMix();
  }

  /**
   * Balance between track and notes: -100 lowers the track, +100 lowers the
   * notes, 0 leaves both at full.
   */
  setMix(mix: number): void {
    this.mix = Math.max(-100, Math.min(100, mix));
    this.applyMix();
  }

  private applyMix(): void {
    if (!this.ctx || !this.trackGain || !this.noteGain) return;
    const t = this.ctx.currentTime;
    const track = Math.min(1, 1 + this.mix / 100) * (this.audible ? 1 : 0);
    const note = Math.min(1, 1 - this.mix / 100);
    this.trackGain.gain.setTargetAtTime(track, t, 0.02);
    this.noteGain.gain.setTargetAtTime(note, t, 0.02);
  }

  get trackVolume(): number { return this.trackGain?.gain.value ?? 1; }
  get noteVolume(): number { return this.noteGain?.gain.value ?? 1; }

  /**
   * A short sine, purely as a pitch reference: it lives outside the player, so
   * it never becomes part of the track's playback.
   */
  beep(freq: number, ms = 340): void {
    const ctx = this.ctx;
    if (!ctx || !this.noteGain || !(freq > 0)) return;
    void ctx.resume();
    const t = ctx.currentTime;
    const dur = ms / 1000;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.25, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(this.noteGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }
}
