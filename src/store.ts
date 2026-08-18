/**
 * Persistence between sessions.
 *
 * Settings and per-track state live in web storage (small, synchronous); audio
 * files, spectrograms and waveform peaks live in IndexedDB, so reopening a
 * track needs neither the file dialog nor a fresh analysis.
 */

export interface Settings {
  fft: number;
  cmap: string;
  log: boolean;
  gain: number;
  range: number;
  rate: number;
  /** Track/notes balance: -100 lowers the track, +100 lowers the notes. */
  mix: number;
  follow: boolean;
  /** What playback sounds: 'track' | 'both' | 'notes'. */
  playMode: string;
  /** Spectrogram offset against the track, in milliseconds. */
  specOffsetMs: number;
  /** Key used to name pinned notes: 'chromatic', or for instance 'A:min'. */
  scale: string;
  /** Stretch engine: 'signalsmith' | 'wsola' | 'pv' | 'smear'. */
  algo: string;
}

export interface Marker {
  /** Position in the track, in seconds. */
  t: number;
  /** Reference letter assigned on creation. */
  label: string;
}

/** A note pinned at one spot of the spectrum: when, and at which pitch. */
export interface PitchMark {
  t: number;
  /** MIDI number: the pitch is snapped to the semitone. */
  midi: number;
}

export interface TrackState {
  pos: number;
  loopA: number;
  loopB: number;
  hasLoop: boolean;
  markers: Marker[];
  /** Pinned reference notes, each at a precise instant. */
  pitches: PitchMark[];
  t0: number;
  tSpan: number;
  fMin: number;
  fMax: number;
  at: number; // last save, used when trimming old entries
}

export interface Session {
  settings: Settings;
  lastKey: string | null;
  tracks: Record<string, TrackState>;
}

export const DEFAULTS: Settings = {
  fft: 2048, cmap: 'magma', log: false, gain: 12, range: 70, rate: 1, mix: 0, follow: true,
  playMode: 'track', specOffsetMs: 0, scale: 'chromatic', algo: 'signalsmith',
};

const LS_KEY = 'spectroscribe.session.v1';
/** Marks the welcome card as seen. Shared by every tab. */
const WELCOME_KEY = 'slower.welcome.v1';

export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return true; // without storage, better than nagging on every load
  }
}

export function markWelcomeSeen(): void {
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* no storage */ }
}
const MAX_TRACK_STATES = 40;
/** Past this size the file is not archived, only its state. */
export const MAX_STORED_BYTES = 160 * 1024 * 1024;
const KEEP_FILES = 3;

export function trackKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Session>;
    return {
      settings: { ...DEFAULTS, ...(s.settings ?? {}) },
      lastKey: s.lastKey ?? null,
      tracks: s.tracks ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * The live state belongs to the tab (sessionStorage), so two open tabs never
 * overwrite each other. The shared copy in localStorage is only the starting
 * point for a new tab.
 */
export function loadSession(): Session {
  try {
    return parseSession(sessionStorage.getItem(LS_KEY))
      ?? parseSession(localStorage.getItem(LS_KEY))
      ?? { settings: { ...DEFAULTS }, lastKey: null, tracks: {} };
  } catch {
    return { settings: { ...DEFAULTS }, lastKey: null, tracks: {} };
  }
}

/**
 * Promotes this tab's state to "last known". Per-track entries are merged so
 * another tab's work survives; for the same track the newest save wins.
 */
export function promoteSession(s: Session): void {
  try {
    const shared = parseSession(localStorage.getItem(LS_KEY));
    const tracks = { ...(shared?.tracks ?? {}) };
    for (const [key, mine] of Object.entries(s.tracks)) {
      const theirs = tracks[key];
      if (!theirs || (mine.at ?? 0) >= (theirs.at ?? 0)) tracks[key] = mine;
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ ...s, tracks: trim(tracks) }));
  } catch { /* storage full or denied */ }
}

/** Periodic save: stays inside the tab, leaves the shared state alone. */
export function saveSession(s: Session): void {
  s.tracks = trim(s.tracks);
  try {
    sessionStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch { /* storage full or denied: the session stays in memory */ }
}

/** Keeps only the most recent per-track entries, so storage stays bounded. */
function trim(tracks: Record<string, TrackState>): Record<string, TrackState> {
  const keys = Object.keys(tracks).sort((a, b) => (tracks[b].at ?? 0) - (tracks[a].at ?? 0));
  if (keys.length <= MAX_TRACK_STATES) return tracks;
  const out: Record<string, TrackState> = {};
  for (const k of keys.slice(0, MAX_TRACK_STATES)) out[k] = tracks[k];
  return out;
}

// ------------------------------------------------------------- IndexedDB ----

const DB_NAME = 'spectroscribe';
const DB_VERSION = 3;
const FILES = 'files';
const SPECTRA = 'spectra';
const PEAKS = 'peaks';

/** How many spectrograms and waveforms to keep cached. */
const KEEP_SPECTRA = 3;
const KEEP_PEAKS = 6;
/** A spectrum larger than this is not worth archiving. */
const MAX_SPECTRUM_BYTES = 160 * 1024 * 1024;

interface FileRecord { key: string; name: string; blob: Blob; at: number }

export interface SpectrumTile { col0: number; width: number; data: Uint8Array }

export interface SpectrumRecord {
  key: string;
  cols: number;
  bins: number;
  hop: number;
  fftSize: number;
  sampleRate: number;
  tiles: SpectrumTile[];
  at: number;
}

interface PeaksRecord { key: string; bucket: number; peaks: Float32Array; at: number }

/** A cached spectrum is valid only for the same track and the same parameters. */
export function spectrumKey(track: string, fftSize: number, hop: number, sampleRate: number): string {
  return `${track}|${fftSize}|${hop}|${sampleRate}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of [FILES, SPECTRA, PEAKS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    t.oncomplete = () => db.close();
  }));
}

/** Keeps the `keepN` newest records, always including `keep`. */
async function prune(store: string, keep: string, keepN: number): Promise<void> {
  const all = await run<{ key: string; at?: number }[]>(store, 'readonly',
    (s) => s.getAll() as IDBRequest<{ key: string; at?: number }[]>);
  const doomed = all
    .filter((r) => r.key !== keep)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(keepN - 1)
    .map((r) => r.key);
  for (const k of doomed) await run(store, 'readwrite', (s) => s.delete(k));
}

// ---- audio files ----

export async function putFile(key: string, name: string, blob: Blob): Promise<void> {
  if (blob.size > MAX_STORED_BYTES) return;
  try {
    await run(FILES, 'readwrite', (s) => s.put({ key, name, blob, at: Date.now() } as FileRecord));
    await prune(FILES, key, KEEP_FILES);
  } catch { /* no archive: the track has to be reopened by hand */ }
}

export async function getFile(key: string): Promise<{ name: string; blob: Blob } | null> {
  try {
    const rec = await run<FileRecord | undefined>(FILES, 'readonly',
      (s) => s.get(key) as IDBRequest<FileRecord | undefined>);
    return rec ? { name: rec.name, blob: rec.blob } : null;
  } catch {
    return null;
  }
}

// ---- computed spectrograms ----

export async function putSpectrum(rec: SpectrumRecord): Promise<void> {
  const bytes = rec.tiles.reduce((n, t) => n + t.data.byteLength, 0);
  if (bytes > MAX_SPECTRUM_BYTES) return;
  try {
    await run(SPECTRA, 'readwrite', (s) => s.put(rec));
    await prune(SPECTRA, rec.key, KEEP_SPECTRA);
  } catch { /* full: it will be recomputed next time */ }
}

export async function getSpectrum(key: string): Promise<SpectrumRecord | null> {
  try {
    const rec = await run<SpectrumRecord | undefined>(SPECTRA, 'readonly',
      (s) => s.get(key) as IDBRequest<SpectrumRecord | undefined>);
    return rec ?? null;
  } catch {
    return null;
  }
}

// ---- overview peaks ----

export async function putPeaks(key: string, bucket: number, peaks: Float32Array): Promise<void> {
  try {
    await run(PEAKS, 'readwrite', (s) => s.put({ key, bucket, peaks, at: Date.now() } as PeaksRecord));
    await prune(PEAKS, key, KEEP_PEAKS);
  } catch { /* ignore */ }
}

export async function getPeaks(key: string, bucket: number): Promise<Float32Array | null> {
  try {
    const rec = await run<PeaksRecord | undefined>(PEAKS, 'readonly',
      (s) => s.get(key) as IDBRequest<PeaksRecord | undefined>);
    return rec && rec.bucket === bucket ? rec.peaks : null;
  } catch {
    return null;
  }
}
