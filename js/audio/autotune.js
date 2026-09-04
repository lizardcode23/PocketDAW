// Autotune: detect the pitch of a recording, snap it to the project scale,
// and resynthesise it at the corrected pitch.
//
// Two stages. YIN gives a frame-by-frame f0 estimate (run on a decimated copy
// of the signal, which is what keeps it fast enough to do in the browser).
// TD-PSOLA then rebuilds the audio: grains cut around pitch marks are laid
// back down at a new spacing, which changes pitch without changing duration.
//
// Corrections are small by nature, so formants are deliberately left alone —
// shifting them as well is what makes naive pitch shifting sound like a
// chipmunk. Anything beyond a few semitones will start to show that.

import { inScale, snapToScale, midiToFreq } from '../theory.js';

const ANALYSIS_RATE = 11025;   // plenty for voices; keeps YIN affordable
const YIN_WINDOW = 512;
const YIN_HOP = 128;
const F_MIN = 65;
const F_MAX = 1100;

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

/* ------------------------------------------------------------ analysis */

/** Average-decimate to roughly ANALYSIS_RATE, mixing channels to mono. */
function decimate(buffer) {
  const factor = Math.max(1, Math.round(buffer.sampleRate / ANALYSIS_RATE));
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const outLen = Math.floor(buffer.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) {
      const idx = i * factor + j;
      let s = 0;
      for (const ch of chans) s += ch[idx];
      sum += s / chans.length;
    }
    out[i] = sum / factor;
  }
  return { data: out, rate: buffer.sampleRate / factor };
}

/**
 * YIN for one frame. Returns { tau, confidence } where confidence is
 * 1 - d'(tau) — higher is more clearly pitched.
 */
function yinFrame(x, start, len, tauMin, tauMax) {
  const half = Math.min(tauMax, Math.floor(len / 2));
  const diff = new Float32Array(half + 1);

  for (let tau = 1; tau <= half; tau++) {
    let sum = 0;
    for (let i = 0; i < len - tau; i++) {
      const d = x[start + i] - x[start + i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // Cumulative mean normalised difference.
  const cmnd = new Float32Array(half + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= half; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : diff[tau] * tau / running;
  }

  const THRESHOLD = 0.15;
  let best = -1;
  for (let tau = tauMin; tau <= half; tau++) {
    if (cmnd[tau] < THRESHOLD) {
      while (tau + 1 <= half && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let min = Infinity;
    for (let tau = tauMin; tau <= half; tau++) {
      if (cmnd[tau] < min) { min = cmnd[tau]; best = tau; }
    }
    if (best < 0 || min > 0.6) return { tau: 0, confidence: 0 };
  }

  // Parabolic interpolation around the dip for sub-sample accuracy.
  let tau = best;
  if (tau > 1 && tau < half) {
    const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
    const denom = 2 * (2 * b - a - c);
    if (denom !== 0) tau += (c - a) / denom;
  }
  return { tau, confidence: Math.max(0, 1 - cmnd[best]) };
}

/**
 * Frame-by-frame pitch track.
 * Returns { f0, confidence, hopSeconds, frames } with f0 in Hz (0 = unvoiced).
 */
export function detectPitch(buffer) {
  const { data, rate } = decimate(buffer);
  const tauMin = Math.max(2, Math.floor(rate / F_MAX));
  const tauMax = Math.min(Math.floor(YIN_WINDOW / 2), Math.ceil(rate / F_MIN));
  const frames = Math.max(0, Math.floor((data.length - YIN_WINDOW) / YIN_HOP) + 1);

  const f0 = new Float32Array(frames);
  const confidence = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    const start = i * YIN_HOP;
    let energy = 0;
    for (let j = 0; j < YIN_WINDOW; j++) energy += data[start + j] * data[start + j];
    if (Math.sqrt(energy / YIN_WINDOW) < 0.005) continue;      // silence

    const { tau, confidence: conf } = yinFrame(data, start, YIN_WINDOW, tauMin, tauMax);
    if (tau > 0 && conf > 0.35) {
      f0[i] = rate / tau;
      confidence[i] = conf;
    }
  }

  // Kill single-frame outliers — usually octave errors.
  for (let i = 1; i < frames - 1; i++) {
    if (!f0[i] || !f0[i - 1] || !f0[i + 1]) continue;
    const jumpBack = Math.abs(Math.log2(f0[i] / f0[i - 1]));
    const jumpFwd = Math.abs(Math.log2(f0[i] / f0[i + 1]));
    const neighbours = Math.abs(Math.log2(f0[i - 1] / f0[i + 1]));
    if (jumpBack > 0.4 && jumpFwd > 0.4 && neighbours < 0.2) {
      f0[i] = (f0[i - 1] + f0[i + 1]) / 2;
    }
  }

  return { f0, confidence, hopSeconds: YIN_HOP / rate, frames, analysisRate: rate };
}

/* ------------------------------------------------------------ retuning */

/** Nearest allowed pitch, in MIDI note numbers (fractional in = integer out). */
function targetMidi(midi, { root, scaleType, chromatic }) {
  const nearest = Math.round(midi);
  if (chromatic) return nearest;
  if (inScale(nearest, root, scaleType)) return nearest;
  // Check the neighbour on the other side too, then take whichever is closer.
  const down = snapToScale(Math.floor(midi), root, scaleType);
  const up = snapToScale(Math.ceil(midi), root, scaleType);
  return Math.abs(midi - down) <= Math.abs(midi - up) ? down : up;
}

/**
 * Build the per-frame correction ratio (target / detected).
 * `strength` is how much of the error to remove, `speedMs` how quickly the
 * correction slides in — a long time makes it glide, a short one snaps.
 */
export function planCorrection(track, {
  root = 0, scaleType = 'major', strength = 1, speedMs = 40, chromatic = false,
} = {}) {
  const { f0, confidence, hopSeconds, frames } = track;
  const ratios = new Float32Array(frames);
  const targets = new Float32Array(frames);
  const alpha = 1 - Math.exp(-hopSeconds / Math.max(0.001, speedMs / 1000));
  let smoothedCents = 0;

  // Which note the singer is *aiming* at, judged over ~200 ms: a full vibrato
  // cycle. Deciding frame by frame makes wide vibrato flip between neighbours.
  const centre = medianFilter(f0, Math.max(3, Math.round(0.2 / hopSeconds)));
  // And once a note is chosen it is held until the voice really leaves it,
  // so a singer sitting between two notes does not get torn back and forth.
  let held = null;

  for (let i = 0; i < frames; i++) {
    if (!f0[i]) { ratios[i] = 1; smoothedCents *= (1 - alpha); held = null; continue; }
    const midi = freqToMidi(f0[i]);
    const aim = freqToMidi(centre[i] || f0[i]);
    if (held === null || Math.abs(aim - held) > 0.7) held = targetMidi(aim, { root, scaleType, chromatic });
    const want = held;
    targets[i] = want;
    // Confidence gates the correction rather than scaling it — otherwise even
    // a fully confident frame would only ever be partly corrected.
    const trust = Math.min(1, confidence[i] / 0.6);
    const errorCents = (want - midi) * 100 * Math.min(1, Math.max(0, strength)) * trust;
    smoothedCents += (errorCents - smoothedCents) * alpha;
    ratios[i] = Math.pow(2, smoothedCents / 1200);
  }
  return { ratios, targets };
}

/** Median of the voiced frames in a sliding window; 0 stays 0. */
function medianFilter(f0, width) {
  const out = new Float32Array(f0.length);
  const half = Math.floor(width / 2);
  const window = [];
  for (let i = 0; i < f0.length; i++) {
    if (!f0[i]) { out[i] = 0; continue; }
    window.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(f0.length - 1, i + half); j++) {
      if (f0[j]) window.push(f0[j]);
    }
    window.sort((a, b) => a - b);
    out[i] = window[Math.floor(window.length / 2)];
  }
  return out;
}

/* -------------------------------------------------------------- PSOLA */

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

const windowCache = new Map();
function windowOf(n) {
  if (!windowCache.has(n)) windowCache.set(n, hann(n));
  return windowCache.get(n);
}

/**
 * Time-domain pitch-synchronous overlap-add.
 * Duration is preserved: output marks are spaced by period/ratio while grains
 * keep coming from the time-aligned position in the input.
 */
function psola(channel, out, { periodAt, ratioAt, length }) {
  // Input pitch marks, one per local period.
  const marks = [];
  let pos = 0;
  while (pos < length) {
    marks.push(Math.round(pos));
    pos += periodAt(pos);
  }
  if (marks.length < 2) { out.set(channel.subarray(0, length)); return; }

  let markIndex = 0;
  let outPos = 0;
  while (outPos < length) {
    // Time-aligned input mark (no time stretching, so we track output time).
    while (markIndex + 1 < marks.length && marks[markIndex + 1] < outPos) markIndex++;
    let i = markIndex;
    if (i + 1 < marks.length && Math.abs(marks[i + 1] - outPos) < Math.abs(marks[i] - outPos)) i++;

    const centre = marks[i];
    const period = periodAt(centre);
    const T = Math.max(8, Math.round(period));
    const grain = 2 * T;
    const w = windowOf(grain);

    const from = centre - T;
    // outPos is fractional; a non-integer index on a typed array is dropped
    // silently, so round it before it becomes a write position.
    const to = Math.round(outPos) - T;
    for (let k = 0; k < grain; k++) {
      const src = from + k;
      const dst = to + k;
      if (src < 0 || src >= length || dst < 0 || dst >= length) continue;
      out[dst] += channel[src] * w[k];
    }

    const ratio = Math.max(0.5, Math.min(2, ratioAt(outPos)));
    // Advance on the unrounded period: rounding here would quantise the
    // achievable correction to a few cents.
    outPos += Math.max(4, Math.max(8, period) / ratio);
  }
}

/**
 * Retune a buffer. Returns a new AudioBuffer of the same length and layout.
 * `ctx` only supplies createBuffer, so an OfflineAudioContext works too.
 */
export function retune(ctx, buffer, options = {}) {
  const track = options.track || detectPitch(buffer);
  const { ratios } = planCorrection(track, options);
  const rate = buffer.sampleRate;
  const framesPerSample = 1 / (track.hopSeconds * rate);
  const defaultPeriod = rate / 150;

  const frameAt = (sample) => {
    const f = sample * framesPerSample;
    const i = Math.max(0, Math.min(track.frames - 1, Math.round(f)));
    return i;
  };
  const periodAt = (sample) => {
    const f0 = track.f0[frameAt(sample)];
    return f0 > 0 ? rate / f0 : defaultPeriod;
  };
  const ratioAt = (sample) => ratios[frameAt(sample)] || 1;

  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, rate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    psola(buffer.getChannelData(c), out.getChannelData(c), {
      periodAt, ratioAt, length: buffer.length,
    });
  }
  return out;
}

/* --------------------------------------------------------- description */

/** A human summary of what the correction actually did. */
export function summarise(track, plan) {
  let voiced = 0;
  let totalCents = 0;
  let maxCents = 0;
  const notes = new Map();
  for (let i = 0; i < track.frames; i++) {
    if (!track.f0[i]) continue;
    voiced++;
    const cents = Math.abs(Math.log2(plan.ratios[i]) * 1200);
    totalCents += cents;
    maxCents = Math.max(maxCents, cents);
    const n = Math.round(plan.targets[i]);
    if (n) notes.set(n, (notes.get(n) || 0) + 1);
  }
  const top = [...notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  return {
    voicedSeconds: voiced * track.hopSeconds,
    averageCents: voiced ? totalCents / voiced : 0,
    maxCents,
    notes: top,
  };
}

export { midiToFreq };

/* ------------------------------------------------------ key identification */

/**
 * What note is this sample? Used to map an imported one-shot onto the key it
 * was actually recorded at, instead of assuming middle C.
 *
 * A one-shot is loudest and most stable just after the attack, so the frames
 * are weighted by confidence and by how early they are, and the estimate is
 * the weighted median rather than a mean — a couple of octave-halved frames
 * should not drag the answer down a fifth.
 *
 * Returns { midi, hz, confidence, cents } or null when nothing is pitched.
 */
export function detectRootNote(buffer) {
  const track = detectPitch(buffer);
  const voiced = [];
  for (let i = 0; i < track.frames; i++) {
    if (!track.f0[i] || track.confidence[i] < 0.35) continue;
    voiced.push({ midi: freqToMidi(track.f0[i]), w: track.confidence[i] });
  }
  if (voiced.length < 3) return null;

  // Ignore the very start (the attack transient is noise, not pitch) and the
  // tail, where a decaying sample is mostly room and noise floor.
  const usable = voiced.slice(Math.floor(voiced.length * 0.1), Math.ceil(voiced.length * 0.75));
  const frames = usable.length >= 3 ? usable : voiced;

  // Octave errors are the classic YIN failure. Fold every estimate into the
  // pitch class first, pick the strongest class, then take the octave that
  // most of those frames agree on.
  const rough = weightedMedian(frames);
  const folded = frames.filter((f) => {
    const d = Math.abs(f.midi - rough);
    return d < 3 || Math.abs(d - 12) < 3 || Math.abs(d - 24) < 3;
  }).map((f) => {
    let m = f.midi;
    while (m - rough > 6) m -= 12;
    while (rough - m > 6) m += 12;
    return { midi: m, w: f.w };
  });

  const midiExact = weightedMedian(folded.length >= 3 ? folded : frames);
  const midi = Math.round(midiExact);
  const cents = Math.round((midiExact - midi) * 100);
  const agree = folded.reduce((a, f) => a + (Math.abs(f.midi - midiExact) < 0.5 ? f.w : 0), 0);
  const total = folded.reduce((a, f) => a + f.w, 0) || 1;

  return {
    midi: Math.max(0, Math.min(127, midi)),
    hz: midiToFreq(midiExact),
    cents,
    confidence: Math.min(1, (agree / total) * (folded.length / Math.max(6, folded.length))),
  };
}

function weightedMedian(items) {
  if (!items.length) return 60;
  const sorted = [...items].sort((a, b) => a.midi - b.midi);
  const total = sorted.reduce((a, i) => a + i.w, 0);
  let run = 0;
  for (const item of sorted) {
    run += item.w;
    if (run >= total / 2) return item.midi;
  }
  return sorted[sorted.length - 1].midi;
}

/**
 * Some libraries put the key in the filename ("Lead_G#5.wav", "kick-c1").
 * That is the author's intent, so it beats analysis when it is unambiguous.
 * Returns a MIDI number or null.
 */
export function rootFromName(name) {
  if (!name) return null;
  // A note letter, optional accidental, then an octave -1..9, at a word edge.
  const m = /(^|[^a-z0-9#])([a-gA-G])([#b]?)(-1|[0-9])(?![0-9])/.exec(name);
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[2].toLowerCase()];
  const acc = m[3] === '#' ? 1 : m[3] === 'b' ? -1 : 0;
  const octave = parseInt(m[4], 10);
  const midi = (octave + 1) * 12 + base + acc;
  return midi >= 0 && midi <= 127 ? midi : null;
}
