// Ducking ("sidechain compression") for a channel.
//
// Web Audio's DynamicsCompressor has no sidechain input, so the duck is not
// detected from a signal at all — it is *scheduled* from the trigger's notes,
// the same way the scheduler already schedules everything else. That makes it
// exact rather than programme-dependent, and it lets the bounce lay the
// identical curve down offline: both callers share `duckVelocityAt()` and
// `duckEnvelope()` here, so a bounce cannot pump differently from playback.
//
// A track's `sidechain` block lives in the store (see `defaultSidechain()`).
// The trigger is a track plus, for a drum kit, one pad — in this app the kick
// is a pad, so pointing at the track alone would duck on every hat too.

import * as S from '../state.js';

/**
 * How hard a trigger hits at an absolute transport step: the loudest note it
 * fires there, or 0 for silence. `pad` restricts it to one pad of a kit;
 * null means any note on the track. `songMode` picks the same source of
 * truth the scheduler uses — clips on the playlist, or the edited pattern.
 *
 * Deliberately independent of mute and solo: the pump is part of the
 * arrangement, so soloing the bass to work on it must not change its shape.
 */
export function triggerVelocity(project, source, step, songMode, pad = null) {
  if (!source) return 0;
  let vel = 0;

  const scan = (notes, local) => {
    for (const n of notes) {
      if (n.t !== local) continue;
      if (pad != null && n.pitch !== pad) continue;
      const v = n.vel ?? 0.9;
      if (v > vel) vel = v;
    }
  };

  if (songMode) {
    for (const clip of project.clips || []) {
      if (clip.trackId !== source.id) continue;
      if (step < clip.start || step >= clip.start + clip.length) continue;
      if (S.stepMuted(clip, step - clip.start)) continue;
      if (clip.kind === 'audio') {
        // An audio clip has no notes; its start is the only event there is.
        if (step === clip.start) vel = Math.max(vel, clip.gain ?? 1);
        continue;
      }
      const pat = (project.patterns || []).find((p) => p.id === clip.patternId);
      if (!pat) continue;
      const patSteps = Math.max(1, (pat.bars || 4) * S.STEPS_PER_BAR);
      scan((pat.notes && pat.notes[source.id]) || [],
        (step - clip.start + (clip.offsetSteps || 0)) % patSteps);
    }
  } else {
    const pat = (project.patterns || []).find((p) => p.id === project.activePatternId)
      || (project.patterns || [])[0];
    scan((pat && pat.notes && pat.notes[source.id]) || [], step);
  }
  return vel;
}

/**
 * The trigger track inside *this* document. The store's `S.duckSource()`
 * answers for the live project; a bounce may be handed another one, so the
 * lookup has to follow the project it was given.
 */
export function duckSourceIn(project, track) {
  const sc = track && track.sidechain;
  if (!sc || !sc.on || !sc.sourceId || sc.sourceId === track.id) return null;
  return (project.tracks || []).find((t) => t.id === sc.sourceId) || null;
}

/**
 * The duck a channel should take at this step, 0 when nothing triggers it.
 * Reads the track's own sidechain block, so callers only need the target.
 */
export function duckVelocityAt(project, track, step, songMode) {
  const source = duckSourceIn(project, track);
  if (!source) return 0;
  const sc = track.sidechain;
  const pad = source.type === 'drum' && sc.sourcePad != null ? sc.sourcePad : null;
  return triggerVelocity(project, source, step, songMode, pad);
}

/**
 * Where the last envelope written had got to at time `t`. Each one records
 * the value it *started* from, so a hit landing inside the one before it is
 * still exact rather than an approximation.
 */
function valueAt(env, t) {
  if (!env) return 1;
  if (t <= env.t0) return env.v0;
  if (t < env.t0 + env.a) return env.v0 + (env.floor - env.v0) * ((t - env.t0) / env.a);
  if (t < env.t0 + env.a + env.r) return env.floor + (1 - env.floor) * ((t - env.t0 - env.a) / env.r);
  return 1;
}

/**
 * A duck writer bound to one gain param.
 *
 * Every envelope has to start with an event *at* the trigger, because a
 * `linearRampToValueAtTime` runs from the previous event — without the
 * anchor the attack ramp starts back at the last recovery and the channel
 * slides downhill for the whole gap between two hits instead of sitting at
 * unity. Knowing the curve's own geometry is what makes that anchor
 * computable in advance, on a param whose future value nothing can read.
 */
export function createDucker(param) {
  let env = null;      // { t0, v0, floor, a, r } of the envelope last written

  return {
    /** Duck now: down to the floor over `attack`, back up over `release`. */
    duck(when, sc, vel = 1) {
      if (!param || !sc) return;
      const depth = Math.max(0, Math.min(1, (sc.amount ?? 0.7) * Math.max(0, Math.min(1, vel))));
      if (depth <= 0.001) return;
      const floor = Math.max(0, 1 - depth);
      const a = Math.max(0.001, sc.attack ?? 0.012);
      const r = Math.max(0.01, sc.release ?? 0.18);
      const t = Math.max(0, when);
      const v0 = valueAt(env, t);
      try {
        // cancelAndHold keeps the curve intact up to `t` when a hit lands
        // inside the envelope before it; the anchor below agrees with it,
        // and stands in on its own where the method is missing.
        if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
        else param.cancelScheduledValues(t);
        param.setValueAtTime(v0, t);
        param.linearRampToValueAtTime(floor, t + a);
        param.linearRampToValueAtTime(1, t + a + r);
        env = { t0: t, v0, floor, a, r };
      } catch { /* a param mid-cancel; the next hit re-establishes the curve */ }
    },

    /** Park back at unity — nothing is triggering this channel any more. */
    reset(when = 0) {
      env = null;
      if (!param) return;
      try {
        param.cancelScheduledValues(when);
        param.setValueAtTime(1, when);
      } catch { /* context torn down */ }
    },
  };
}
