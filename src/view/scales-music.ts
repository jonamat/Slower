/**
 * Degree names relative to a tonic. Used by the pinned notes: with a key
 * chosen they read as degrees (I, bIII, V…) instead of absolute note names.
 */

export const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Degree for each semitone distance from the tonic, in major. */
const MAJOR_DEGREES = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
/** In natural minor the third, sixth and seventh are already flat. */
const MINOR_DEGREES = ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII'];

export type ScaleKey = 'chromatic' | `${string}:${'maj' | 'min'}`;

export interface ScaleOption { value: string; label: string }

/** The 24 natural keys, plus chromatic. */
export function scaleOptions(): ScaleOption[] {
  const out: ScaleOption[] = [{ value: 'chromatic', label: 'Chromatic' }];
  for (const mode of ['maj', 'min'] as const) {
    for (let i = 0; i < 12; i++) {
      out.push({
        value: `${PITCH_CLASSES[i]}:${mode}`,
        label: `${PITCH_CLASSES[i]} ${mode}`,
      });
    }
  }
  return out;
}

/** Tonic and mode of a key, or null for chromatic. */
export function parseScale(key: string): { tonic: number; minor: boolean } | null {
  const [name, mode] = key.split(':');
  const tonic = PITCH_CLASSES.indexOf(name);
  if (tonic < 0 || (mode !== 'maj' && mode !== 'min')) return null;
  return { tonic, minor: mode === 'min' };
}

/** Degree of a MIDI note in the chosen key. */
export function degreeName(midi: number, key: string): string | null {
  const scale = parseScale(key);
  if (!scale) return null;
  const d = (((midi - scale.tonic) % 12) + 12) % 12;
  return (scale.minor ? MINOR_DEGREES : MAJOR_DEGREES)[d];
}
