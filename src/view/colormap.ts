export type CmapName = 'magma' | 'viridis' | 'gray';

const ANCHORS: Record<CmapName, [number, number, number][]> = {
  magma: [
    [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122],
    [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191],
  ],
  viridis: [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
  ],
  gray: [[0, 0, 0], [255, 255, 255]],
};

/** 256-entry RGB lookup table, linearly interpolated between anchors. */
export function buildLut(name: CmapName): Uint8Array {
  const a = ANCHORS[name];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (a.length - 1);
    const i0 = Math.min(a.length - 1, Math.floor(t));
    const i1 = Math.min(a.length - 1, i0 + 1);
    const f = t - i0;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[i0][c] + (a[i1][c] - a[i0][c]) * f);
  }
  return lut;
}
