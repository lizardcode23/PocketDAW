// Destructive buffer edits for the sample editor.
//
// Every function is pure: it takes an AudioBuffer and returns a new one, so
// the editor can keep an undo stack of buffers and nothing is committed until
// the user saves. The context is an argument (never a module-level singleton)
// for the same reason the voice code takes one — an offline render must be
// able to run the identical code.
//
// Joins and silences are always cross-faded over a few milliseconds. Cutting
// a waveform at an arbitrary zero-crossing-less point is what makes edited
// samples click, and a 3 ms ramp is short enough to be inaudible as a fade.

const JOIN = 0.003;          // seconds of cross-fade at a cut

const clampT = (t, buf) => Math.max(0, Math.min(buf.duration, t));
const toFrame = (t, buf) => Math.max(0, Math.min(buf.length, Math.round(t * buf.sampleRate)));

/** An empty buffer shaped like `like`. */
export function makeLike(ctx, like, frames) {
  return ctx.createBuffer(like.numberOfChannels, Math.max(1, frames), like.sampleRate);
}

/** Copy `count` frames from src[srcFrom] into dst[dstFrom], channel by channel. */
function blit(src, dst, srcFrom, dstFrom, count) {
  for (let c = 0; c < dst.numberOfChannels; c++) {
    const from = src.getChannelData(Math.min(c, src.numberOfChannels - 1));
    const to = dst.getChannelData(c);
    for (let i = 0; i < count; i++) to[dstFrom + i] = from[srcFrom + i];
  }
}

/** Peak amplitude over a frame range. */
export function peakOf(buffer, fromFrame = 0, toFrameIdx = buffer.length) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = fromFrame; i < toFrameIdx; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** RMS over a frame range, used to find where a sample really starts. */
export function rmsOf(buffer, fromFrame, toFrameIdx) {
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = fromFrame; i < toFrameIdx; i++) { sum += d[i] * d[i]; n++; }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/* ----------------------------------------------------------------- cuts */

/** Keep only [start, end] (seconds). */
export function cropBuffer(ctx, buffer, start, end) {
  const a = toFrame(clampT(start, buffer), buffer);
  const b = toFrame(clampT(end, buffer), buffer);
  const count = Math.max(1, b - a);
  const out = makeLike(ctx, buffer, count);
  blit(buffer, out, a, 0, count);
  // Ease the new edges so a cut mid-waveform does not click.
  rampEdges(out, Math.min(JOIN, count / buffer.sampleRate / 2));
  return out;
}

/** Remove [start, end] and butt the two halves together. */
export function cutRange(ctx, buffer, start, end) {
  const a = toFrame(clampT(start, buffer), buffer);
  const b = toFrame(clampT(end, buffer), buffer);
  if (b <= a) return buffer;
  const count = buffer.length - (b - a);
  if (count < 2) return buffer;
  const out = makeLike(ctx, buffer, count);
  blit(buffer, out, 0, 0, a);
  blit(buffer, out, b, a, buffer.length - b);
  crossfadeAt(out, a, Math.round(JOIN * buffer.sampleRate));
  return out;
}

/** Replace [start, end] with silence, fading in and out of it. */
export function silenceRange(ctx, buffer, start, end) {
  const out = copyBuffer(ctx, buffer);
  const a = toFrame(clampT(start, buffer), buffer);
  const b = toFrame(clampT(end, buffer), buffer);
  const ramp = Math.min(Math.round(JOIN * buffer.sampleRate), Math.max(1, Math.floor((b - a) / 2)));
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = a; i < b; i++) {
      const into = i - a;
      const outOf = b - i;
      const g = Math.min(1, Math.min(into, outOf) / ramp);
      d[i] *= 1 - g;
    }
  }
  return out;
}

/** Everything outside [start, end] removed, then normalised to `peak`. */
export function copyBuffer(ctx, buffer) {
  const out = makeLike(ctx, buffer, buffer.length);
  blit(buffer, out, 0, 0, buffer.length);
  return out;
}

/* -------------------------------------------------------------- shaping */

/** Scale so the loudest peak sits at `target` (linear, 0..1). */
export function normalizeBuffer(ctx, buffer, target = 0.98) {
  const peak = peakOf(buffer);
  if (peak <= 0.00001) return buffer;
  return gainBuffer(ctx, buffer, target / peak);
}

export function gainBuffer(ctx, buffer, factor) {
  const out = copyBuffer(ctx, buffer);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i] * factor));
  }
  return out;
}

export function reverseBuffer(ctx, buffer) {
  const out = makeLike(ctx, buffer, buffer.length);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
  }
  return out;
}

/**
 * Fade across [start, end]. `shape` is 'in' or 'out'; the curve is equal-power
 * so a fade-out into a fade-in of the same length keeps a steady loudness.
 */
export function fadeRange(ctx, buffer, start, end, shape = 'in') {
  const out = copyBuffer(ctx, buffer);
  const a = toFrame(clampT(start, buffer), buffer);
  const b = toFrame(clampT(end, buffer), buffer);
  const span = Math.max(1, b - a);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = a; i < b; i++) {
      const x = (i - a) / span;
      d[i] *= Math.sin((shape === 'in' ? x : 1 - x) * Math.PI / 2);
    }
  }
  return out;
}

/** Trim leading and trailing quiet. Returns { buffer, trimmedStart }. */
export function trimEnds(ctx, buffer, thresholdDb = -48) {
  const thresh = Math.pow(10, thresholdDb / 20);
  const win = Math.max(16, Math.round(buffer.sampleRate * 0.005));
  let first = 0;
  let last = buffer.length;
  for (let i = 0; i < buffer.length; i += win) {
    if (rmsOf(buffer, i, Math.min(buffer.length, i + win)) > thresh) { first = i; break; }
  }
  for (let i = buffer.length - win; i > first; i -= win) {
    if (rmsOf(buffer, Math.max(0, i), Math.min(buffer.length, i + win)) > thresh) {
      last = Math.min(buffer.length, i + win);
      break;
    }
  }
  if (last - first < win) return { buffer, trimmedStart: 0 };
  const start = Math.max(0, first - win) / buffer.sampleRate;
  const end = Math.min(buffer.length, last + win) / buffer.sampleRate;
  return { buffer: cropBuffer(ctx, buffer, start, end), trimmedStart: start };
}

/**
 * Resample by a pitch interval — the tape-speed transpose. Length changes
 * with pitch, which is exactly what you want when correcting a one-shot that
 * was sampled at the wrong key.
 */
export function transposeBuffer(ctx, buffer, semitones) {
  if (!semitones) return buffer;
  const ratio = Math.pow(2, semitones / 12);
  const frames = Math.max(2, Math.round(buffer.length / ratio));
  const out = makeLike(ctx, buffer, frames);
  for (let c = 0; c < out.numberOfChannels; c++) {
    const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    const dst = out.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const frac = pos - j;
      const a = src[j] || 0;
      const b = src[j + 1] !== undefined ? src[j + 1] : a;
      dst[i] = a + (b - a) * frac;
    }
  }
  return out;
}

/* ------------------------------------------------------------- internals */

/** Fade the first and last few ms of a buffer in and out. */
function rampEdges(buffer, seconds) {
  const n = Math.max(1, Math.round(seconds * buffer.sampleRate));
  if (n * 2 >= buffer.length) return;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const g = i / n;
      d[i] *= g;
      d[d.length - 1 - i] *= g;
    }
  }
}

/** Blend across a splice point so the join is not a step discontinuity. */
function crossfadeAt(buffer, frame, n) {
  const half = Math.min(n, frame, buffer.length - frame);
  if (half < 2) return;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < half; i++) {
      const g = i / half;
      const before = frame - half + i;
      d[before] *= 1 - g * 0.5;
      d[frame + i] *= 0.5 + g * 0.5;
    }
  }
}
