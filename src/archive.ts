/**
 * .tsa - Slower Track Archive.
 *
 * One file holding the track and the state you were looking at it with.
 * Layout: "TSA1" + header length (uint32 LE) + JSON header (UTF-8) + the audio
 * file bytes. No compression: the audio is already compressed, and this keeps
 * reading and writing instant even on long tracks.
 */
import type { Settings, TrackState } from './store';

const MAGIC = 'TSA1';

export interface ArchiveHeader {
  version: 1;
  /** Original name of the audio file. */
  name: string;
  /** MIME type, when the browser knew one. */
  mime: string;
  /** Session key of the track, to match state already saved locally. */
  trackKey: string;
  state: TrackState;
  settings: Settings;
  createdAt: string;
}

export function isArchiveName(name: string): boolean {
  return name.toLowerCase().endsWith('.tsa');
}

export function buildArchive(header: ArchiveHeader, audio: ArrayBuffer): Blob {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length, true);
  return new Blob([MAGIC, len, json, audio], { type: 'application/x-tsa' });
}

/** Suggested file name: the track name with a .tsa extension. */
export function archiveName(trackName: string): string {
  return `${trackName.replace(/\.[^.]+$/, '') || 'track'}.tsa`;
}

export async function readArchive(file: Blob): Promise<{ header: ArchiveHeader; audio: Blob }> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const magic = new TextDecoder().decode(head.subarray(0, 4));
  if (magic !== MAGIC) throw new Error('not a .tsa archive');
  const jsonLen = new DataView(head.buffer, head.byteOffset).getUint32(4, true);
  const json = await file.slice(8, 8 + jsonLen).text();
  const header = JSON.parse(json) as ArchiveHeader;
  return { header, audio: file.slice(8 + jsonLen) };
}
