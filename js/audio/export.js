// Offline bounce: re-render the project through the same voice and effect
// code into an OfflineAudioContext, then encode the result as 16-bit PCM WAV.

import { getContext } from './context.js';
import { playSynth, playSample, playSynthDrum } from './instruments.js';
import { buildChain } from './effects.js';
import { startClip } from './clips.js';
import { duckVelocityAt, createDucker, duckSourceIn } from './sidechain.js';
import { ensureStretchesForProject } from './stretch.js';
import { getBuffer, cachedBuffer } from './samples.js';
import * as S from '../state.js';

/**
 * Lay a track's automation lanes onto the offline params. The live engine
 * ramps one step at a time as the scheduler reaches it; offline there is no
 * scheduler, so the whole curve is written up front — same values, same
 * breakpoints, and a repeat simply replays them at the next offset.
 */
function writeAutomation(track, params, { span, repeats, stepDur }) {
  for (const key of S.AUTO_KEYS) {
    const param = params[key];
    if (!param || !S.hasAutomation(track, key)) continue;
    param.cancelScheduledValues(0);
    for (let rep = 0; rep < repeats; rep++) {
      const base = rep * span * stepDur;
      for (let step = 0; step <= span; step++) {
        const at = base + step * stepDur;
        const v = S.autoValueAt(track, key, step);
        if (rep === 0 && step === 0) param.setValueAtTime(v, 0);
        else param.linearRampToValueAtTime(v, at);
      }
    }
  }
}

/**
 * Lay a channel's ducking onto its offline gain node. The live engine writes
 * one envelope as the scheduler reaches each trigger; offline the whole span
 * is walked up front, through the same `duckVelocityAt` the engine uses — so
 * a bounce pumps exactly where playback does.
 */
function writeDucking(project, track, param, { span, repeats, stepDur, songMode, swingFor }) {
  const ducker = createDucker(param);
  for (let rep = 0; rep < repeats; rep++) {
    const base = rep * span * stepDur;
    for (let step = 0; step < span; step++) {
      const vel = duckVelocityAt(project, track, step, songMode);
      if (vel > 0) ducker.duck(base + step * stepDur + swingFor(step), track.sidechain, vel);
    }
  }
}

/**
 * Render the arrangement (song mode) or the active pattern (pattern mode).
 * `mode` overrides the project's current transport mode.
 */
export async function renderProject(project, { tailSeconds = 2, repeats = 1, mode } = {}) {
  const live = getContext();
  const stepDur = 60 / project.bpm / S.STEPS_PER_BEAT;
  const useSong = (mode || project.mode) === 'song';

  // Stretched clips fall back to resampling until their pitch-preserved
  // buffer exists. A bounce must never catch that fallback, so build them
  // all up front rather than hoping playback warmed the cache.
  await ensureStretchesForProject(project, stepDur);

  const pattern = project.patterns.find((p) => p.id === project.activePatternId) || project.patterns[0];
  const span = useSong
    ? project.songBars * S.STEPS_PER_BAR
    : (pattern?.bars || 4) * S.STEPS_PER_BAR;

  const length = Math.ceil((span * repeats * stepDur + tailSeconds) * live.sampleRate);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.max(1, length), live.sampleRate);

  const master = ctx.createGain();
  master.gain.value = project.masterVolume ?? 0.85;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12;
  limiter.attack.value = 0.003; limiter.release.value = 0.12;
  master.connect(limiter);
  limiter.connect(ctx.destination);

  const soloed = project.tracks.some((t) => t.solo);
  const audible = (t) => !t.mute && (!soloed || t.solo);
  const swingFor = (step) => (step % 2 === 1 ? (project.swing || 0) * 0.5 * stepDur : 0);

  // One chain per track, exactly as the live engine builds it — including
  // the automation nodes, so a bounce carries the playlist's lanes.
  const inputs = new Map();
  for (const track of project.tracks) {
    if (!audible(track)) continue;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 20;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 20000;
    const duck = ctx.createGain();
    const autoGain = ctx.createGain();
    const gain = ctx.createGain();
    gain.gain.value = track.volume ?? 0.8;
    hpf.connect(lpf); lpf.connect(duck); duck.connect(autoGain); autoGain.connect(gain);

    let panParam = null;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0));
      gain.connect(pan); pan.connect(master);
      panParam = pan.pan;
    } else {
      gain.connect(master);
    }
    const chain = buildChain(ctx, track.fx, hpf, { secondsPerStep: stepDur });
    inputs.set(track.id, chain.input);

    if (useSong) {
      writeAutomation(track, {
        volume: autoGain.gain, pan: panParam, hpf: hpf.frequency, lpf: lpf.frequency,
      }, { span, repeats, stepDur });
    }
    // Ducking is not song-only: a pattern bounce pumps the same way the
    // pattern loop does.
    if (duckSourceIn(project, track)) {
      writeDucking(project, track, duck.gain,
        { span, repeats, stepDur, songMode: useSong, swingFor });
    }
  }

  // Glide is relative to the note before it on the same track, so the bounce
  // has to remember it the way the live scheduler does.
  const lastPitch = new Map();

  const renderNote = async (track, note, when, dest) => {
    const dur = note.len * stepDur;
    const vel = note.vel ?? 0.9;
    if (track.type === 'synth') {
      const from = lastPitch.get(track.id);
      lastPitch.set(track.id, note.pitch);
      playSynth(ctx, dest, track.synth || {}, note.pitch, when, dur, vel, { glideFrom: from });
    } else if (track.type === 'sampler') {
      const buf = cachedBuffer(track.sampleId) || await getBuffer(track.sampleId);
      if (!buf) return;
      playSample(ctx, dest, buf, {
        when, rate: Math.pow(2, (note.pitch - (track.rootNote ?? 60)) / 12),
        gain: vel, dur: track.loop ? dur : null,
        attack: track.attack ?? 0.002, release: track.release ?? 0.08, loop: !!track.loop,
      });
    } else if (track.type === 'drum') {
      const pad = (track.pads || [])[note.pitch];
      if (!pad) return;
      const buf = pad.sampleId ? (cachedBuffer(pad.sampleId) || await getBuffer(pad.sampleId)) : null;
      if (buf) {
        playSample(ctx, dest, buf, {
          when, gain: (pad.gain ?? 0.9) * vel,
          rate: Math.pow(2, (pad.pitch || 0) / 12), dur: null, attack: 0.001, release: 0.02,
        });
      } else {
        playSynthDrum(ctx, dest, note.pitch, when, (pad.gain ?? 0.9) * vel);
      }
    }
  };

  const notesFor = (pat, trackId) => (pat && pat.notes && pat.notes[trackId]) || [];

  for (let rep = 0; rep < repeats; rep++) {
    const base = rep * span * stepDur;

    if (useSong) {
      for (const clip of project.clips) {
        const track = project.tracks.find((t) => t.id === clip.trackId);
        if (!track || !audible(track)) continue;
        const dest = inputs.get(track.id);
        if (!dest) continue;

        if (clip.kind === 'audio') {
          const buf = cachedBuffer(clip.sampleId) || await getBuffer(clip.sampleId);
          if (!buf) continue;
          // Same code path as the live engine, so a bounce cannot drift from
          // what you just heard.
          startClip(ctx, dest, buf, clip, {
            when: base + clip.start * stepDur, skipSteps: 0, stepDur,
          });
          continue;
        }

        const pat = project.patterns.find((p) => p.id === clip.patternId);
        if (!pat) continue;
        const patSteps = Math.max(1, pat.bars * S.STEPS_PER_BAR);
        const notes = notesFor(pat, track.id);
        for (let local = 0; local < clip.length; local++) {
          if (S.stepMuted(clip, local)) continue;
          const inPattern = (local + (clip.offsetSteps || 0)) % patSteps;
          for (const note of notes) {
            if (note.t !== inPattern) continue;
            const step = clip.start + local;
            const when = base + step * stepDur + swingFor(step);
            const len = Math.min(note.len, clip.length - local);
            if (len > 0) await renderNote(track, { ...note, len }, when, dest);
          }
        }
      }
    } else {
      for (const track of project.tracks) {
        if (track.type === 'audio' || !audible(track)) continue;
        const dest = inputs.get(track.id);
        if (!dest) continue;
        for (const note of notesFor(pattern, track.id)) {
          const when = base + note.t * stepDur + swingFor(note.t);
          await renderNote(track, note, when, dest);
        }
      }
    }
  }

  return ctx.startRendering();
}

/** AudioBuffer -> 16-bit PCM WAV Blob. */
export function encodeWav(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));

  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                       // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, frames * channels * 2, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

export async function exportWav(project, opts) {
  const rendered = await renderProject(project, opts);
  return encodeWav(rendered);
}
