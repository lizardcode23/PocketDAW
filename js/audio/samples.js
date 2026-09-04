// Sample library: import files, keep the original Blob in IndexedDB (so it
// survives reloads), and cache decoded AudioBuffers in memory for playback.

import * as db from '../db.js';
import { getContext } from './context.js';
import { detectRootNote, rootFromName } from './autotune.js';
import { uid } from '../state.js';

const buffers = new Map();   // sampleId -> AudioBuffer
const meta = new Map();      // sampleId -> { id, name, duration, size, type, rootNote, ... }

export const MAX_SAMPLE_BYTES = 40 * 1024 * 1024;

// Analysing a long file frame by frame is not worth the wait — pitch mapping
// is for one-shots and short loops, not for a three-minute stem.
const MAX_ANALYSE_SECONDS = 20;

export function listSamples() {
  return [...meta.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const sampleMeta = (id) => meta.get(id) || null;

/** The sample imported from this folder path, if it is already in here. */
export const sampleByPath = (path) =>
  (path ? [...meta.values()].find((m) => m.sourcePath === path) || null : null);
export const cachedBuffer = (id) => buffers.get(id) || null;

/** The note a sample is recorded at, falling back to middle C. */
export const sampleRoot = (id) => {
  const m = meta.get(id);
  return m && m.rootNote != null ? m.rootNote : 60;
};

const metaOf = (rec) => ({
  id: rec.id, name: rec.name, duration: rec.duration,
  size: rec.size, type: rec.type, createdAt: rec.createdAt,
  rootNote: rec.rootNote ?? null,
  rootSource: rec.rootSource || null,
  rootConfidence: rec.rootConfidence ?? 0,
  editedAt: rec.editedAt || null,
  // Where it came from, when it came from a folder rather than a file
  // picker — this is what lets the browser show a library in its own
  // structure instead of one flat list.
  sourcePath: rec.sourcePath || null,
});

/** Load the catalogue (names/durations only) from IndexedDB at startup. */
export async function refreshIndex() {
  const recs = await db.allSamples();
  meta.clear();
  for (const r of recs) meta.set(r.id, metaOf(r));
  return listSamples();
}

/** Decode a stored sample on demand and memoise the AudioBuffer. */
export async function getBuffer(id) {
  if (!id) return null;
  if (buffers.has(id)) return buffers.get(id);
  const rec = await db.getSample(id);
  if (!rec) return null;
  const arr = rec.data instanceof Blob ? await rec.data.arrayBuffer() : rec.data;
  const buf = await decode(arr.slice(0));
  buffers.set(id, buf);
  return buf;
}

function decode(arrayBuffer) {
  const ctx = getContext();
  return new Promise((resolve, reject) => {
    // The callback form keeps older Safari happy.
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

/**
 * Work out what key a sample is in. The filename wins when it names a note,
 * because that is the author telling us; otherwise YIN decides.
 */
export function identifyRoot(buffer, name) {
  const named = rootFromName(name);
  if (named != null) return { rootNote: named, rootSource: 'name', rootConfidence: 1 };
  if (!buffer || buffer.duration > MAX_ANALYSE_SECONDS) {
    return { rootNote: null, rootSource: null, rootConfidence: 0 };
  }
  try {
    const found = detectRootNote(buffer);
    if (found && found.confidence > 0.25) {
      return { rootNote: found.midi, rootSource: 'detected', rootConfidence: found.confidence };
    }
  } catch { /* unpitched or too short — not an error */ }
  return { rootNote: null, rootSource: null, rootConfidence: 0 };
}

/**
 * Import a File/Blob: decode it once to validate and measure, then persist
 * the original bytes. Returns the sample metadata record.
 */
export async function importFile(file, { sourcePath = null } = {}) {
  // Importing the same folder file twice would leave two copies with one
  // name, and nothing on screen to tell them apart.
  const already = sampleByPath(sourcePath);
  if (already) return already;
  if (file.size > MAX_SAMPLE_BYTES) {
    throw new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_SAMPLE_BYTES / 1048576} MB.`);
  }
  const arr = await file.arrayBuffer();
  let buf;
  try {
    buf = await decode(arr.slice(0));
  } catch (e) {
    throw new Error(`Could not decode "${file.name}". Try WAV, MP3, OGG, M4A or FLAC.`);
  }
  const name = cleanName(file.name);
  const rec = {
    id: uid('smp'),
    name,
    data: new Blob([arr], { type: file.type || 'audio/wav' }),
    type: file.type || '',
    size: file.size,
    duration: buf.duration,
    channels: buf.numberOfChannels,
    sampleRate: buf.sampleRate,
    createdAt: Date.now(),
    sourcePath,
    ...identifyRoot(buf, sourcePath || file.name),
  };
  await db.putSample(rec);
  buffers.set(rec.id, buf);
  const m = metaOf(rec);
  meta.set(rec.id, m);
  return m;
}

/**
 * Store an AudioBuffer we produced ourselves (a recording, a tuned take, an
 * edit) as a library sample, encoded as WAV so it survives a reload.
 */
export async function importBuffer(buffer, name, { encodeWav, rootNote, analyse = false } = {}) {
  const blob = encodeWav(buffer);
  const rec = {
    id: uid('smp'),
    name: (name || 'Recording').slice(0, 48),
    data: blob,
    type: 'audio/wav',
    size: blob.size,
    duration: buffer.duration,
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    createdAt: Date.now(),
    rootNote: rootNote ?? null,
    rootSource: rootNote != null ? 'manual' : null,
    rootConfidence: rootNote != null ? 1 : 0,
  };
  if (rootNote == null && analyse) Object.assign(rec, identifyRoot(buffer, name));
  await db.putSample(rec);
  buffers.set(rec.id, buffer);
  const m = metaOf(rec);
  meta.set(rec.id, m);
  return m;
}

/**
 * Overwrite a sample's audio in place — what "Save" in the editor does.
 * Everything pointing at the id (pads, sampler slots, clips) keeps working
 * because the id does not change.
 */
export async function replaceBuffer(id, buffer, { encodeWav, name } = {}) {
  const rec = await db.getSample(id);
  if (!rec) throw new Error('That sample is no longer in the library');
  const blob = encodeWav(buffer);
  rec.data = blob;
  rec.type = 'audio/wav';
  rec.size = blob.size;
  rec.duration = buffer.duration;
  rec.channels = buffer.numberOfChannels;
  rec.sampleRate = buffer.sampleRate;
  rec.editedAt = Date.now();
  if (name) rec.name = name.slice(0, 48);
  await db.putSample(rec);
  buffers.set(id, buffer);
  const m = metaOf(rec);
  meta.set(id, m);
  return m;
}

/** Set (or clear, with null) the note a sample is recorded at. */
export async function setSampleRoot(id, rootNote, source = 'manual') {
  const rec = await db.getSample(id);
  if (!rec) return null;
  rec.rootNote = rootNote;
  rec.rootSource = rootNote == null ? null : source;
  rec.rootConfidence = rootNote == null ? 0 : 1;
  await db.putSample(rec);
  const m = metaOf(rec);
  meta.set(id, m);
  return m;
}

/** Re-run key detection on a sample already in the library. */
export async function analyseRoot(id) {
  const buf = await getBuffer(id);
  const m = meta.get(id);
  if (!buf || !m) return null;
  const found = identifyRoot(buf, m.name);
  if (found.rootNote == null) return null;
  return setSampleRoot(id, found.rootNote, found.rootSource);
}

export async function renameSample(id, name) {
  const rec = await db.getSample(id);
  if (!rec) return;
  rec.name = name;
  await db.putSample(rec);
  const m = meta.get(id);
  if (m) m.name = name;
}

export async function removeSample(id) {
  await db.deleteSample(id);
  buffers.delete(id);
  meta.delete(id);
}

function cleanName(filename) {
  return filename.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 48) || 'Sample';
}

/** Preload every sample a project references, so playback never stutters. */
export async function preloadForProject(project) {
  const ids = new Set();
  for (const t of project.tracks) {
    if (t.sampleId) ids.add(t.sampleId);
    for (const pad of t.pads || []) if (pad.sampleId) ids.add(pad.sampleId);
  }
  // Playlist audio has to be warm too, or the first bar of a bounce is silent.
  for (const c of project.clips || []) if (c.sampleId) ids.add(c.sampleId);
  await Promise.all([...ids].map((id) => getBuffer(id).catch(() => null)));
}
