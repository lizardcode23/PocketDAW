// Time-stretching: play a stretch of a sample over a different length of time
// without moving its pitch.
//
// WSOLA — overlap-add where every grain is nudged to the position that best
// continues the one before it, which is what keeps a stretched vowel from
// stuttering. The similarity search runs on a decimated mono copy: at full
// rate a ten-second take costs hundreds of millions of comparisons and the
// answer is the same to within a sample or two.
//
// A buffer is stretched *whole* and cached per (sample, speed), so a clip's
// window into it is still just `offset / speed` seconds in. The clip player
// therefore keeps working in one coordinate system instead of two — adding a
// stretch costs `clips.js` one division, not a second scheduler.

import { cachedBuffer, getBuffer } from './samples.js';
import { getContext } from './context.js';
import { clipSpeed, MIN_SPEED, MAX_SPEED } from '../state.js';

const NEUTRAL = 0.002;            // closer than this to 1x is not worth doing

const FRAME_SECONDS = 0.046;      // ~46 ms grains: long enough for a low voice
const SEARCH_SECONDS = 0.010;     // how far a grain may slide to line up
const DECIMATE = 4;               // search resolution, in input samples

const cache = new Map();          // sampleId|speed -> AudioBuffer
const pending = new Set();
const CACHE_LIMIT = 24;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const keyOf = (sampleId, speed) => `${sampleId}|${speed.toFixed(4)}`;

/* ------------------------------------------------------------- the DSP */

function hann(n) {
  const w = new Float32Array(n);
  // Periodic, so a 50% overlap sums back to exactly one.
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Mono, decimated copy used only to line grains up. */
function searchSignal(buffer) {
  const len = Math.floor(buffer.length / DECIMATE);
  const out = new Float32Array(len);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let j = 0; j < DECIMATE; j++) {
      const idx = i * DECIMATE + j;
      for (const ch of chans) sum += ch[idx];
    }
    out[i] = sum / (DECIMATE * chans.length);
  }
  return out;
}

/**
 * Where, within +/- search, does the input best continue `target`?
 * Normalised cross-correlation: a loud grain must not win just for being loud.
 */
function bestOffset(sig, target, centre, search, len) {
  let bestScore = -Infinity;
  let best = 0;
  for (let d = -search; d <= search; d++) {
    const at = centre + d;
    if (at < 0 || at + len >= sig.length) continue;
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const v = sig[at + i];
      dot += v * target[i];
      energy += v * v;
    }
    const score = dot / Math.sqrt(energy + 1e-9);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * Stretch a whole buffer by `speed` (>1 shorter, <1 longer), pitch untouched.
 * Pure: the context is only used to allocate, so an offline bounce can run it.
 */
export function stretchBuffer(ctx, buffer, speed) {
  const rate = clamp(speed, MIN_SPEED, MAX_SPEED);
  if (Math.abs(rate - 1) < NEUTRAL) return buffer;

  const sr = buffer.sampleRate;
  const frame = Math.round(FRAME_SECONDS * sr);
  const hop = Math.round(frame / 2);              // synthesis hop, 50% overlap
  const analysisHop = hop * rate;
  const search = Math.round((SEARCH_SECONDS * sr) / DECIMATE);
  const win = hann(frame);

  const outLen = Math.max(1, Math.round(buffer.length / rate) + frame);
  const out = ctx.createBuffer(buffer.numberOfChannels, outLen, sr);
  const sig = searchSignal(buffer);
  const target = new Float32Array(Math.max(8, Math.floor(hop / DECIMATE)));

  const ins = [];
  const outs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    ins.push(buffer.getChannelData(c));
    outs.push(out.getChannelData(c));
  }

  let anaPos = 0;          // fractional read position, in input samples
  let outPos = 0;          // write position, in output samples
  let haveTarget = false;

  while (outPos + frame < outLen) {
    let from = Math.round(anaPos);
    if (from + frame >= buffer.length) break;

    if (haveTarget) {
      // Slide the grain to wherever it continues the last one most smoothly.
      const d = bestOffset(sig, target, Math.round(from / DECIMATE), search, target.length);
      from = Math.max(0, Math.min(buffer.length - frame - 1, from + d * DECIMATE));
    }

    for (let c = 0; c < ins.length; c++) {
      const src = ins[c];
      const dst = outs[c];
      for (let i = 0; i < frame; i++) dst[outPos + i] += src[from + i] * win[i];
    }

    // What the *input* would have played next — the shape the following grain
    // is asked to match.
    const tFrom = Math.round((from + hop) / DECIMATE);
    haveTarget = tFrom + target.length < sig.length;
    if (haveTarget) for (let i = 0; i < target.length; i++) target[i] = sig[tFrom + i];

    anaPos += analysisHop;
    outPos += hop;
  }

  return out;
}

/* ------------------------------------------------------------- the cache */

function remember(key, buffer) {
  cache.set(key, buffer);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/** The stretched buffer if it is ready, without computing anything. */
export function cachedStretch(sampleId, speed) {
  if (Math.abs(speed - 1) < NEUTRAL) return null;
  return cache.get(keyOf(sampleId, speed)) || null;
}

/** Build (or fetch) the stretched buffer, yielding first so a tap stays live. */
export async function ensureStretch(sampleId, speed, buffer = null) {
  if (!sampleId || Math.abs(speed - 1) < NEUTRAL) return null;
  const key = keyOf(sampleId, speed);
  const hit = cache.get(key);
  if (hit) return hit;
  const src = buffer || cachedBuffer(sampleId) || await getBuffer(sampleId);
  if (!src) return null;
  await new Promise((r) => setTimeout(r, 0));
  const made = stretchBuffer(getContext(), src, speed);
  remember(key, made);
  return made;
}

/** Kick a build off in the background; playback falls back until it lands. */
function requestStretch(sampleId, speed, buffer) {
  const key = keyOf(sampleId, speed);
  if (pending.has(key) || cache.has(key)) return;
  pending.add(key);
  ensureStretch(sampleId, speed, buffer)
    .catch(() => null)
    .finally(() => pending.delete(key));
}

/**
 * What a clip should actually play.
 *   buffer  the audio to feed the source node
 *   speed   1 when `buffer` is already stretched, otherwise the playbackRate
 *           the caller must apply (which moves the pitch — the tape sound)
 *   scale   source seconds per buffer second, for mapping the clip's offset
 */
export function resolveStretch(clip, buffer, stepDur) {
  const speed = clipSpeed(clip, stepDur);
  if (!buffer || Math.abs(speed - 1) < NEUTRAL) return { buffer, speed: 1, scale: 1 };
  if (clip.tape) return { buffer, speed, scale: 1 };

  const ready = cachedStretch(clip.sampleId, speed);
  if (ready) return { buffer: ready, speed: 1, scale: speed };
  // Not built yet: keep time correct by resampling for now. The next pass —
  // and every bounce — uses the pitch-preserved version.
  requestStretch(clip.sampleId, speed, buffer);
  return { buffer, speed, scale: 1 };
}

/** Warm every stretch a project needs, so a bounce never falls back to tape. */
export async function ensureStretchesForProject(project, stepDur) {
  const wanted = new Map();
  for (const clip of project.clips || []) {
    if (clip.kind !== 'audio' || !clip.stretch || clip.tape || !clip.sampleId) continue;
    const speed = clipSpeed(clip, stepDur);
    if (Math.abs(speed - 1) < NEUTRAL) continue;
    wanted.set(keyOf(clip.sampleId, speed), { id: clip.sampleId, speed });
  }
  for (const { id, speed } of wanted.values()) {
    await ensureStretch(id, speed).catch(() => null);
  }
}
