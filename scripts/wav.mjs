/** Traccia sintetica per test e benchmark: una nota ricca di armonici al secondo. */
export function makeWav(seconds = 8, sr = 44100) {
  const n = sr * seconds;
  const pcm = Buffer.alloc(n * 4);
  const notes = [220, 277.18, 329.63, 440, 554.37, 659.25, 880, 1174.66];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = notes[Math.floor(t) % notes.length];
    const env = Math.min(1, (t % 1) * 20) * Math.exp(-(t % 1) * 2.2);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += (Math.sin(2 * Math.PI * f * h * t) / h) * env;
    const s = Math.max(-1, Math.min(1, v * 0.22)) * 32767;
    pcm.writeInt16LE(s | 0, i * 4);
    pcm.writeInt16LE((s * 0.8) | 0, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
