import { loadSignalsmith, type StretchNode } from './signalsmith';

/** How long to wait for the WASM player before falling back to the worklet. */
const SMITH_TIMEOUT = 20000;
/** The library asks for changes to be scheduled slightly ahead of the clock. */
const SMITH_AHEAD = 0.03;

/**
 * Decoded track kept in the audio thread + a thin control surface for it.
 *
 * Two players sit behind the same interface: the in-house worklet (wsola, pv,
 * smear) and the Signalsmith Stretch node (WASM). Only one is connected at a
 * time; switching carries position, rate, loop and playing state across.
 */
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

  private smith: StretchNode | null = null;
  private smithBuffered = false;
  private smithInit: Promise<boolean> | null = null;
  /** Kept on the main thread so either player can be fed without decoding again. */
  private channels: Float32Array[] | null = null;
  private algo = 'wsola';

  sampleRate = 48000;
  length = 0;          // source samples
  duration = 0;        // seconds
  playing = false;
  posSamples = 0;      // playhead, source samples (pushed by the worklet)
  rate = 1;
  /** Bumped on every seek: positions from an older generation are dropped. */
  seekCount = 0;
  private loopOn = false;
  private loopStartSec = 0;
  private loopEndSec = 0;

  onEnd: (() => void) | null = null;
  /** Called on every position reported by the audio thread (~90 per second). */
  onPos: ((seconds: number) => void) | null = null;
  /** Reported when the WASM player cannot be started. */
  onSmithError: ((message: string) => void) | null = null;

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
    ctx.onstatechange = () => this.refreshLatency();
    this.ctx = ctx;
    this.node = node;
    this.trackGain = trackGain;
    this.noteGain = noteGain;
    this.gain = gain;
    this.applyMix();
    this.sampleRate = ctx.sampleRate;
    this.ready = true;
  }

  /**
   * Hands the channel data to the worklet. A copy stays here: switching player
   * has to be possible without decoding the file again.
   */
  load(channels: Float32Array[]): void {
    if (!this.node) return;
    this.length = channels[0].length;
    this.duration = this.length / this.sampleRate;
    this.playing = false;
    this.posSamples = 0;
    this.channels = channels;
    if (this.smith) {                 // the old track is no longer the right one
      void this.smith.dropBuffers();
      this.smith.disconnect();
      this.smith = null;
      this.smithBuffered = false;
    }
    const copy = channels.map((c) => c.slice());
    this.node.port.postMessage({ type: 'load', channels: copy }, copy.map((c) => c.buffer));
    if (this.usesSmith) void this.applyAlgorithm();
  }

  private get usesSmith(): boolean { return this.algo === 'signalsmith'; }

  /** True once the WASM player is up and holding the current track. */
  get smithReady(): boolean { return !!this.smith && this.smithBuffered; }

  /**
   * Builds the WASM node and feeds it the track. Never blocks the caller: the
   * wasm compiles on the audio thread, which right after a load is competing with
   * the analysis workers, and can take seconds. Meanwhile the in-house player
   * keeps the track going.
   */
  private ensureSmith(): Promise<boolean> {
    if (this.smithReady) return Promise.resolve(true);
    if (!this.ctx || !this.channels) return Promise.resolve(false);
    if (this.smithInit) return this.smithInit;

    const ctx = this.ctx;
    const channels = this.channels;
    const work = (async () => {
      if (!this.smith) {
        const SignalsmithStretch = await loadSignalsmith();
        // its default channel layout, deliberately: created with numberOfInputs 0
        // the node goes into live-input mode and outputs silence forever
        const node = await SignalsmithStretch(ctx);
        await node.configure({ blockMs: 120 });   // long block: better at low rates
        node.setUpdateInterval(0.011, (t) => {
          if (!this.usesSmith) return;
          this.posSamples = t * this.sampleRate;
          this.onPos?.(this.position);
        });
        this.smith = node;
        this.smithBuffered = false;
      }
      if (!this.smithBuffered) {
        await this.smith.addBuffers(channels.map((c) => c.slice()));
        this.smithBuffered = true;
      }
      return true;
    })();

    const timeout = new Promise<boolean>((res) => setTimeout(() => res(false), SMITH_TIMEOUT));
    this.smithInit = Promise.race([work, timeout])
      .catch((e) => { console.warn('signalsmith failed', e); this.onSmithError?.(String(e)); return false; })
      .then((ok) => {
        this.smithInit = null;
        if (!ok) this.onSmithError?.('the WASM player did not start in time');
        return ok;
      });
    return this.smithInit;
  }

  /** Connects the player the algorithm asks for and moves the state over to it. */
  private async applyAlgorithm(): Promise<void> {
    if (!this.ctx || !this.trackGain) return;
    if (this.usesSmith && !(await this.ensureSmith())) return; // keep what plays now
    if (!this.ctx || !this.trackGain) return;

    const pos = this.position;
    const wasPlaying = this.playing;
    if (this.usesSmith) {
      this.node?.port.postMessage({ type: 'pause' });
      this.node?.disconnect();
      this.smith!.connect(this.trackGain);
    } else {
      if (this.smith) {
        void this.smith.schedule({ active: false, output: this.ctx.currentTime });
        this.smith.disconnect();
      }
      this.node?.connect(this.trackGain);
      this.node?.port.postMessage({ type: 'algo', algo: this.algo });
    }
    this.setRate(this.rate);
    this.setLoop(this.loopOn, this.loopStartSec, this.loopEndSec);
    this.seek(pos);
    if (wasPlaying) void this.play();
  }

  /**
   * Position of what is audible right now, straight from the audio thread: the
   * worklet already accounts for its own queue and for the device buffer.
   */
  get position(): number {
    let t = Math.max(0, this.posSamples / this.sampleRate);
    // the WASM player loops internally and reports its own compensated time, so
    // the value can sit a few ms outside the selection: keep the cursor honest
    if (this.usesSmith && this.loopOn && this.loopEndSec > this.loopStartSec) {
      t = Math.min(Math.max(t, this.loopStartSec), this.loopEndSec);
    }
    return t;
  }

  /** Clock the scheduling is done against, in seconds. */
  get ctxTime(): number { return this.ctx?.currentTime ?? 0; }

  /** Output latency reported by the device, in seconds. */
  get latency(): number {
    const ctx = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    return ctx?.outputLatency ?? ctx?.baseLatency ?? 0;
  }

  /**
   * Tells the worklet how much output the device still holds. Worth repeating:
   * the figure is not final when playback starts, and it changes if the output
   * device does.
   */
  refreshLatency(): void {
    this.node?.port.postMessage({
      type: 'latency',
      samples: Math.round(this.latency * this.sampleRate),
    });
  }

  async play(): Promise<void> {
    if (!this.length) return;
    this.playing = true; // set first, so the UI needn't wait for resume()
    if (this.usesSmith && this.smithReady) {
      void this.smith?.schedule({
        active: true, output: this.ctx!.currentTime + SMITH_AHEAD,
        input: this.position, rate: this.rate,
      });
    } else {
      this.node?.port.postMessage({ type: 'play' });
    }
    await this.ctx!.resume();
    this.refreshLatency(); // only meaningful once the device is running
  }

  pause(): void {
    this.playing = false;
    if (this.usesSmith && this.smithReady) {
      void this.smith?.schedule({ active: false, output: this.ctx!.currentTime + SMITH_AHEAD });
    }
    else this.node?.port.postMessage({ type: 'pause' });
  }

  toggle(): void { if (this.playing) this.pause(); else void this.play(); }

  seek(seconds: number): void {
    const secs = Math.max(0, Math.min(seconds, this.duration));
    this.posSamples = secs * this.sampleRate;
    this.seekCount++;
    if (this.usesSmith && this.smithReady) {
      void this.smith?.schedule({
        input: secs, output: this.ctx!.currentTime + SMITH_AHEAD,
        active: this.playing, rate: this.rate,
      });
    } else {
      this.node?.port.postMessage({ type: 'seek', pos: this.posSamples, gen: this.seekCount });
    }
  }

  /** Picks the player: 'wsola' | 'pv' | 'smear' run here, 'signalsmith' is WASM. */
  setAlgorithm(algo: string): void {
    if (algo === this.algo) return;
    this.algo = algo;
    void this.applyAlgorithm();
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (this.usesSmith && this.smithReady) {
      void this.smith?.schedule({ rate, output: this.ctx!.currentTime + SMITH_AHEAD, active: this.playing });
    } else {
      this.node?.port.postMessage({ type: 'rate', rate });
    }
  }

  setLoop(on: boolean, startSec: number, endSec: number): void {
    this.loopOn = on;
    this.loopStartSec = startSec;
    this.loopEndSec = endSec;
    if (this.usesSmith && this.smithReady) {
      // the library loops on its own; equal bounds turn it off
      void this.smith?.schedule({
        loopStart: on ? startSec : 0, loopEnd: on ? endSec : 0,
        output: this.ctx!.currentTime + SMITH_AHEAD,
      });
      return;
    }
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
   * A short sine, purely as a pitch reference: it lives outside the player, so it
   * never becomes part of the track's playback. `when` is an AudioContext time;
   * scheduling ahead is what lets a note land together with the audio it marks,
   * since both go out through the same device buffer.
   */
  beep(freq: number, ms = 340, when?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noteGain || !(freq > 0)) return;
    void ctx.resume();
    const t = Math.max(ctx.currentTime, when ?? 0);
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
