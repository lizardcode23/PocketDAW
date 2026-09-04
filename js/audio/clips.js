// Playing one audio clip.
//
// A clip is a window onto a sample: `offset` seconds in, `length` steps long,
// optionally looping, stretched or not, with fades at the edges and any
// number of muted step ranges in the middle. All of that is gain automation
// on a single node, so the live engine and the offline bounce run the
// identical code — the context is an argument for exactly that reason.

import * as S from '../state.js';
import { resolveStretch } from './stretch.js';

const RAMP = 0.004;      // mute edges, short enough to be a click-guard only

/**
 * The clip's gain at a local time in seconds, before the channel fader.
 * Mutes are hard zeroes; the ramps in and out of them are added separately.
 */
export function envelopeAt(clip, t, stepDur) {
  const base = clip.gain ?? 1;
  const total = clip.length * stepDur;
  const fadeIn = Math.max(0, clip.fadeIn || 0);
  const fadeOut = Math.max(0, clip.fadeOut || 0);
  for (const [a, b] of S.muteRanges(clip)) {
    if (t >= a * stepDur && t < b * stepDur) return 0;
  }
  let g = base;
  if (fadeIn > 0 && t < fadeIn) g *= Math.max(0, t / fadeIn);
  if (fadeOut > 0 && t > total - fadeOut) g *= Math.max(0, (total - t) / fadeOut);
  return g;
}

/** Gain envelope of a clip as sorted { t, v, ramp } events in local seconds. */
export function envelopePoints(clip, stepDur) {
  const base = clip.gain ?? 1;
  const total = clip.length * stepDur;
  const fadeIn = Math.max(0, Math.min(clip.fadeIn || 0, total));
  const fadeOut = Math.max(0, Math.min(clip.fadeOut || 0, total));
  const shape = (t) => {
    let g = base;
    if (fadeIn > 0 && t < fadeIn) g *= Math.max(0, t / fadeIn);
    if (fadeOut > 0 && t > total - fadeOut) g *= Math.max(0, (total - t) / fadeOut);
    return g;
  };

  const points = [{ t: 0, v: fadeIn > 0 ? 0 : base, ramp: false }];
  if (fadeIn > 0) points.push({ t: fadeIn, v: shape(fadeIn), ramp: true });

  for (const [a, b] of S.muteRanges(clip)) {
    const t0 = a * stepDur;
    const t1 = Math.min(total, b * stepDur);
    if (t1 - t0 <= RAMP * 2) continue;
    points.push({ t: t0, v: shape(t0), ramp: false });
    points.push({ t: t0 + RAMP, v: 0, ramp: true });
    points.push({ t: t1 - RAMP, v: 0, ramp: false });
    points.push({ t: t1, v: shape(t1), ramp: true });
  }

  if (fadeOut > 0) {
    points.push({ t: total - fadeOut, v: shape(total - fadeOut), ramp: false });
    points.push({ t: total, v: 0, ramp: true });
  }

  points.sort((x, y) => x.t - y.t);
  return points;
}

/**
 * Write the envelope onto a gain param. `skipSeconds` is how far into the
 * clip playback already is — the automation starts from the value the
 * envelope had at that instant, so starting mid-clip sounds the same as
 * playing into it.
 */
export function applyClipEnvelope(param, clip, { when, skipSeconds = 0, stepDur }) {
  const points = envelopePoints(clip, stepDur);
  param.cancelScheduledValues(when);
  param.setValueAtTime(envelopeAt(clip, skipSeconds, stepDur), when);
  for (const pt of points) {
    if (pt.t <= skipSeconds) continue;
    const at = when + (pt.t - skipSeconds);
    if (pt.ramp) param.linearRampToValueAtTime(pt.v, at);
    else param.setValueAtTime(pt.v, at);
  }
}

/**
 * Start an audio clip on the given context. Returns { src, gain } or null if
 * there is nothing left to play (the window falls past the end of the sample).
 */
export function startClip(ctx, dest, buffer, clip, { when, skipSteps = 0, stepDur }) {
  const skipSeconds = skipSteps * stepDur;
  const remaining = Math.max(0, (clip.length - skipSteps) * stepDur);
  if (remaining <= 0) return null;

  // A stretched clip either plays a pre-stretched buffer (pitch kept, `scale`
  // folds its different time base back into the clip's offsets) or resamples
  // the original (the tape sound, `speed` on the source node). Everything
  // below then works in one set of units either way.
  const { buffer: source, speed, scale } = resolveStretch(clip, buffer, stepDur);
  const startIn = (clip.offset || 0) / scale;
  const offset = startIn + skipSeconds * speed;
  if (!clip.loop && offset >= source.duration) return null;

  const src = ctx.createBufferSource();
  src.buffer = source;
  src.playbackRate.value = speed;
  const gain = ctx.createGain();
  src.connect(gain);
  gain.connect(dest);

  let dur = remaining;
  let from = offset;
  if (clip.loop) {
    const loopStart = Math.max(0, Math.min(startIn, source.duration - 0.01));
    const loopLen = Math.max(0.01, source.duration - loopStart);
    src.loop = true;
    src.loopStart = loopStart;
    src.loopEnd = source.duration;
    // Starting mid-clip has to land at the right place *inside the loop*, not
    // inside the whole sample, or a resumed clip plays from the wrong phase.
    from = loopStart + ((offset - loopStart) % loopLen);
  } else {
    // What is left of the sample, measured in clip time rather than in it.
    dur = Math.min((source.duration - offset) / speed, remaining);
  }
  if (dur <= 0) return null;

  applyClipEnvelope(gain.gain, clip, { when, skipSeconds, stepDur });
  // A hair of extra time so the final ramp completes before the source ends.
  // `start`'s duration counts buffer seconds, so it takes the rate back out.
  src.start(when, from, (dur + 0.02) * speed);
  return { src, gain };
}
