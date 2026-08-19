/**
 * Loader for signalsmith-stretch (MIT), the WASM stretcher.
 *
 * It is fetched at runtime from public/vendor rather than imported, on purpose:
 * the library builds its own AudioWorklet by stringifying its own functions, so
 * any bundler that renames identifiers produces a worklet that never starts.
 * `scripts/vendor.mjs` refreshes the copy from node_modules.
 */

interface StretchSchedule {
  output?: number;
  active?: boolean;
  input?: number;
  rate?: number;
  semitones?: number;
  tonalityHz?: number;
  loopStart?: number;
  loopEnd?: number;
}

export interface StretchNode extends AudioNode {
  inputTime: number;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<unknown>;
  schedule(change: StretchSchedule): Promise<unknown>;
  start(when?: number | StretchSchedule): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  latency(): Promise<number>;
  configure(config: { blockMs?: number | null; intervalMs?: number; preset?: string }): Promise<unknown>;
  setUpdateInterval(seconds: number, callback?: (t: number) => void): void;
}

type Factory = (ctx: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<StretchNode>;

let factory: Promise<Factory> | null = null;

export function loadSignalsmith(): Promise<Factory> {
  if (!factory) {
    // resolved against the page, not against this module: with a relative base a
    // bare specifier would look for the file next to the source file instead
    const url = new URL(`${import.meta.env.BASE_URL}vendor/SignalsmithStretch.js`, document.baseURI).href;
    factory = import(/* @vite-ignore */ url).then((m: { default: Factory }) => m.default);
  }
  return factory;
}
