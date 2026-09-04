// Transport + mixer + lookahead scheduler.
// The scheduler runs on a timer but every voice is started with an exact
// AudioContext timestamp, so timing does not depend on timer jitter.

import { getContext, getMaster, getAnalyser, unlock } from './context.js';
import { playSynth, playSample, playClick, playSynthDrum } from './instruments.js';
import { getBuffer, cachedBuffer } from './samples.js';
import { buildChain, disposeChain } from './effects.js';
import { startClip } from './clips.js';
import { duckVelocityAt, createDucker } from './sidechain.js';
import * as S from '../state.js';

const LOOKAHEAD = 0.12;      // seconds of audio scheduled ahead
const TICK_MS = 25;

const trackNodes = new Map();   // trackId -> { gain, panner, chain, fxKey, ... }
let previews = new Map();       // key -> voice handle
let liveClips = [];             // audio clip sources currently scheduled
const lastPitch = new Map();    // trackId -> the note before this one, for glide

let timer = null;
let nextStepTime = 0;
let stepCursor = 0;             // step index inside the loop
let anchorTime = 0;             // ctx time matching anchorPos
let anchorPos = 0;              // absolute step position at anchorTime

/* ---------------------------------------------------------------- mixer */

/**
 * Per-track graph, in order:
 *   voices -> fx chain -> hpf -> lpf -> duck -> autoGain -> fader -> panner -> meter
 * The automation nodes are separate from the fader and the pan control so a
 * lane and the mixer never fight over one AudioParam: the fader stays the
 * thing your finger moves, and automation trims underneath it. The duck gain
 * is a third one for the same reason, and it sits after the effects so a
 * reverb tail on the channel is pulled down with everything else.
 */
function nodesFor(track) {
  const ctx = getContext();
  let n = trackNodes.get(track.id);
  if (!n) {
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 20;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 20000;
    const duck = ctx.createGain();
    const autoGain = ctx.createGain();
    const gain = ctx.createGain();
    const meter = ctx.createAnalyser();
    meter.fftSize = 1024;
    meter.smoothingTimeConstant = 0;

    hpf.connect(lpf);
    lpf.connect(duck);
    duck.connect(autoGain);
    autoGain.connect(gain);

    let panner = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      gain.connect(panner);
      panner.connect(meter);
    } else {
      gain.connect(meter);
    }
    meter.connect(getMaster());

    n = { gain, panner, hpf, lpf, duck, ducker: createDucker(duck.gain), autoGain, meter, chain: null, fxKey: '', peak: 0 };
    trackNodes.set(track.id, n);
    rebuildFx(track, n);
  }
  return n;
}

/** Signature of the chain's shape: params update live, structure does not. */
const fxShape = (track) => (track.fx || []).map((f) => `${f.id}:${f.type}:${f.on !== false}`).join(',');

function rebuildFx(track, n = trackNodes.get(track.id)) {
  if (!n) return;
  disposeChain(n.chain);
  n.chain = buildChain(getContext(), track.fx, n.hpf, { secondsPerStep: S.secondsPerStep() });
  n.fxKey = fxShape(track);
}

/** Push effect parameters onto the live nodes without rebuilding the chain. */
export function syncFx(track) {
  const n = trackNodes.get(track.id);
  if (!n) return;
  if (fxShape(track) !== n.fxKey) { rebuildFx(track, n); return; }
  const opts = { secondsPerStep: S.secondsPerStep() };
  for (const node of n.chain.nodes) {
    const fx = (track.fx || []).find((f) => f.id === node.fxId);
    if (fx) node.update(fx.params || {}, opts);
  }
}

/* ------------------------------------------------------------ automation */

/** Which AudioParam each playlist lane drives. */
function autoParam(n, key) {
  if (key === 'volume') return n.autoGain.gain;
  if (key === 'pan') return n.panner ? n.panner.pan : null;
  if (key === 'hpf') return n.hpf.frequency;
  if (key === 'lpf') return n.lpf.frequency;
  return null;
}

/** Lanes only play the arrangement — a pattern loop has no song position. */
const automationLive = () => S.project().mode === 'song';

/**
 * Park every automated parameter on its value at `step`, cancelling anything
 * already scheduled. Called when the transport stops or the position moves,
 * so what you hear standing still matches the curve you drew.
 */
export function resetAutomation(step = S.state.playhead || 0) {
  const ctx = getContext();
  const at = ctx.currentTime;
  const live = automationLive();
  for (const t of S.project().tracks) {
    const n = trackNodes.get(t.id);
    if (!n) continue;
    for (const key of S.AUTO_KEYS) {
      const param = autoParam(n, key);
      if (!param) continue;
      const lane = S.AUTO_LANES[key];
      const norm = live && S.hasAutomation(t, key)
        ? S.autoNormAt(t, key, step) : lane.def;
      try {
        param.cancelScheduledValues(at);
        param.setValueAtTime(lane.value(norm), at);
      } catch { /* the context is being torn down */ }
    }
  }
}

/**
 * Write one step of every automation lane. Ramping to each step's value as
 * the scheduler reaches it keeps the curve loop-safe for free: the cursor
 * wraps and the ramps simply follow it.
 */
function scheduleAutomation(step, when) {
  if (!automationLive()) return;
  for (const t of S.project().tracks) {
    if (!S.anyAutomation(t)) continue;
    const n = trackNodes.get(t.id);
    if (!n) continue;
    for (const key of S.AUTO_KEYS) {
      if (!S.hasAutomation(t, key)) continue;
      const param = autoParam(n, key);
      if (!param) continue;
      try {
        param.linearRampToValueAtTime(S.autoValueAt(t, key, step), Math.max(when, 0));
      } catch { /* a param that is mid-cancel; the next step catches up */ }
    }
  }
}

/* ------------------------------------------------------------- ducking */

/**
 * Write one step of every duck. Unlike the automation lanes this runs in both
 * transport modes — a kick ducking a bass has to work while you loop the
 * pattern you are writing, not only in the arrangement.
 */
function scheduleDucks(step, when) {
  const p = S.project();
  const song = p.mode === 'song';
  for (const t of p.tracks) {
    if (!S.isDucked(t)) continue;
    const n = trackNodes.get(t.id);
    if (!n) continue;
    const vel = duckVelocityAt(p, t, step, song);
    if (vel > 0) n.ducker.duck(when, t.sidechain, vel);
  }
}

/** Push volume/pan/mute/solo from the project onto the audio graph. */
export function syncMixer() {
  const p = S.project();
  getMaster().gain.value = p.masterVolume ?? 0.85;
  for (const t of p.tracks) {
    const n = nodesFor(t);
    if (fxShape(t) !== n.fxKey) rebuildFx(t, n);
    n.gain.gain.value = S.isAudible(t) ? (t.volume ?? 0.8) : 0;
    // Switching the sidechain off (or deleting its trigger) must not leave
    // the channel parked at whatever the last duck reached.
    if (!S.isDucked(t)) n.ducker.reset(getContext().currentTime);
    // Pan automation, when a lane exists, owns the panner — otherwise the
    // strip's pan control would snap it back on every repaint.
    if (n.panner && !(automationLive() && S.hasAutomation(t, 'pan'))) {
      n.panner.pan.value = Math.max(-1, Math.min(1, t.pan ?? 0));
    }
  }
  for (const [id, n] of trackNodes) {
    if (!p.tracks.some((t) => t.id === id)) {
      disposeChain(n.chain);
      try {
        n.gain.disconnect();
        n.panner && n.panner.disconnect();
        n.hpf.disconnect(); n.lpf.disconnect(); n.duck.disconnect();
        n.autoGain.disconnect(); n.meter.disconnect();
      } catch { /* noop */ }
      trackNodes.delete(id);
    }
  }
  if (!S.state.playing) resetAutomation();
}

/* ---------------------------------------------------------------- meters */

const meterBuf = new Map();     // trackId -> Float32Array

/**
 * Post-fader level of a track as { peak, rms }, both 0..1+.
 * Read straight off an analyser, so it costs nothing when nobody is looking.
 */
export function trackLevel(trackId) {
  const n = trackNodes.get(trackId);
  if (!n || !n.meter) return { peak: 0, rms: 0 };
  let data = meterBuf.get(trackId);
  if (!data || data.length !== n.meter.fftSize) {
    data = new Float32Array(n.meter.fftSize);
    meterBuf.set(trackId, data);
  }
  n.meter.getFloatTimeDomainData(data);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / data.length) };
}

/** Level of the whole mix, measured after the master limiter. */
let masterBuf = null;
export function masterLevel() {
  const an = getAnalyser();
  if (!an) return { peak: 0, rms: 0 };
  if (!masterBuf || masterBuf.length !== an.fftSize) masterBuf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(masterBuf);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < masterBuf.length; i++) {
    const v = masterBuf[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / masterBuf.length) };
}

/** Voices route into the head of the track's effect chain. */
export const trackDestination = (track) => nodesFor(track).chain.input;

/* ------------------------------------------------------------ scheduling */

const stepDur = () => S.secondsPerStep();

/** Shuffle: push every other 16th later by up to half a step. */
function swingOffset(step) {
  const amt = S.project().swing || 0;
  return step % 2 === 1 ? amt * 0.5 * stepDur() : 0;
}

function scheduleTrackNote(track, note, when, dest) {
  const dur = note.len * stepDur();
  const vel = note.vel ?? 0.9;

  if (track.type === 'synth') {
    // Glide needs the note before this one on the same track, which only the
    // scheduler knows — the voice builder is stateless on purpose.
    const from = lastPitch.get(track.id);
    lastPitch.set(track.id, note.pitch);
    playSynth(getContext(), dest, track.synth || {}, note.pitch, when, dur, vel,
      { glideFrom: from });
    return;
  }
  if (track.type === 'sampler') {
    const buf = cachedBuffer(track.sampleId);
    if (!buf) { getBuffer(track.sampleId); return; }
    const rate = Math.pow(2, (note.pitch - (track.rootNote ?? 60)) / 12);
    playSample(getContext(), dest, buf, {
      when, rate, gain: vel, dur: track.loop ? dur : null,
      attack: track.attack ?? 0.002, release: track.release ?? 0.08,
      loop: !!track.loop,
    });
    return;
  }
  if (track.type === 'drum') {
    const pad = (track.pads || [])[note.pitch];
    if (!pad) return;
    playPadVoice(getContext(), dest, pad, note.pitch, when, vel);
  }
}

function playPadVoice(ctx, dest, pad, index, when, vel) {
  const buf = cachedBuffer(pad.sampleId);
  const gain = (pad.gain ?? 0.9) * vel;
  if (buf) {
    playSample(ctx, dest, buf, {
      when, gain, rate: Math.pow(2, (pad.pitch || 0) / 12), dur: null, attack: 0.001, release: 0.02,
    });
  } else {
    if (pad.sampleId) getBuffer(pad.sampleId);
    playSynthDrum(ctx, dest, index, when, gain);
  }
}

/**
 * Start an audio clip. `skip` is how far into the clip playback already is,
 * which is what makes hitting play in the middle of a clip work. Trimming,
 * fades, muted sections and looping all live in the shared clip player.
 */
function scheduleAudioClip(track, clip, when, dest, skipSteps = 0) {
  const buf = cachedBuffer(clip.sampleId);
  if (!buf) { getBuffer(clip.sampleId); return; }
  const voice = startClip(getContext(), dest, buf, clip, {
    when, skipSteps, stepDur: stepDur(),
  });
  if (!voice) return;
  const { src, gain: g } = voice;
  liveClips.push({ src, g });
  src.onended = () => { liveClips = liveClips.filter((c) => c.src !== src); };
}

function schedulePatternNotes(track, pattern, localStep, when, dest, maxLen = Infinity) {
  for (const note of S.notesOf(track, pattern)) {
    if (note.t !== localStep) continue;
    const len = Math.min(note.len, maxLen);
    if (len <= 0) continue;
    scheduleTrackNote(track, len === note.len ? note : { ...note, len }, when, dest);
  }
}

function scheduleStep(step, when) {
  const p = S.project();
  scheduleAutomation(step, when);
  scheduleDucks(step, when);

  if (p.mode === 'song') {
    for (const clip of p.clips) {
      if (step < clip.start || step >= clip.start + clip.length) continue;
      const track = S.trackById(clip.trackId);
      if (!track || !S.isAudible(track)) continue;
      const dest = trackDestination(track);
      if (clip.kind === 'pattern') {
        const pattern = S.patternById(clip.patternId);
        if (!pattern) continue;
        if (S.stepMuted(clip, step - clip.start)) continue;
        const patSteps = Math.max(1, pattern.bars * S.STEPS_PER_BAR);
        const local = (step - clip.start + (clip.offsetSteps || 0)) % patSteps;
        schedulePatternNotes(track, pattern, local, when, dest, clip.start + clip.length - step);
      } else if (clip.kind === 'audio' && step === clip.start) {
        scheduleAudioClip(track, clip, when, dest, 0);
      }
    }
  } else {
    const pattern = S.activePattern();
    for (const track of p.tracks) {
      if (track.type === 'audio' || !S.isAudible(track)) continue;
      schedulePatternNotes(track, pattern, step, when, trackDestination(track));
    }
  }

  if (p.metronome && step % S.STEPS_PER_BEAT === 0) {
    playClick(getContext(), getMaster(), when, step % S.STEPS_PER_BAR === 0);
  }
}

/** Audio clips already under way when playback starts part-way through. */
function primeAudioClips(fromStep, when) {
  const p = S.project();
  if (p.mode !== 'song') return;
  for (const clip of p.clips) {
    if (clip.kind !== 'audio') continue;
    if (fromStep <= clip.start || fromStep >= clip.start + clip.length) continue;
    const track = S.trackById(clip.trackId);
    if (!track || !S.isAudible(track)) continue;
    scheduleAudioClip(track, clip, when, trackDestination(track), fromStep - clip.start);
  }
}

function stopLiveClips() {
  const t = getContext().currentTime;
  for (const { src, g } of liveClips) {
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.02);
      src.stop(t + 0.04);
    } catch { /* already finished */ }
  }
  liveClips = [];
}

function tick() {
  const ctx = getContext();
  const total = S.transportSteps();
  while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
    scheduleStep(stepCursor, nextStepTime + swingOffset(stepCursor));
    nextStepTime += stepDur();
    stepCursor++;
    if (stepCursor >= total) {
      if (S.project().loop) {
        stepCursor = 0;
      } else {
        // Let the tail ring out, then stop.
        setTimeout(() => stop(), 400);
        clearInterval(timer);
        timer = null;
        return;
      }
    }
  }
}

/* ------------------------------------------------------------- transport */

export async function start(fromStep = 0) {
  await unlock();
  if (S.state.playing) stop(true);
  syncMixer();
  const ctx = getContext();
  stepCursor = Math.max(0, Math.floor(fromStep)) % Math.max(1, S.transportSteps());
  nextStepTime = ctx.currentTime + 0.06;
  anchorTime = nextStepTime;
  anchorPos = stepCursor;
  lastPitch.clear();
  // Start each lane *at* the value it should already have, so the first ramp
  // moves along the curve rather than up to it from wherever it was left.
  resetAutomation(stepCursor);
  for (const n of trackNodes.values()) n.ducker.reset(ctx.currentTime);
  S.state.playing = true;
  primeAudioClips(stepCursor, nextStepTime);
  clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
  tick();
  S.emit('transport');
}

export function stop(silent = false) {
  clearInterval(timer);
  timer = null;
  stopLiveClips();
  lastPitch.clear();
  // Ducks are scheduled ahead, so stopping mid-pump would otherwise leave a
  // channel sitting at the bottom of its last envelope.
  const now = getContext().currentTime;
  for (const n of trackNodes.values()) n.ducker.reset(now);
  if (!S.state.playing && silent) return;
  S.state.playing = false;
  S.state.playhead = 0;
  resetAutomation(0);
  if (!silent) S.emit('transport');
}

export async function toggle() {
  if (S.state.playing) stop(); else await start(0);
}

/** Current playhead in steps (float), wrapped to the loop length. */
export function playheadSteps() {
  if (!S.state.playing) return S.state.playhead || 0;
  const elapsed = getContext().currentTime - anchorTime;
  const pos = anchorPos + elapsed / stepDur();
  const total = Math.max(1, S.transportSteps());
  return ((pos % total) + total) % total;
}

/** Transport position (in steps) at a given AudioContext time. */
export function stepAtTime(t) {
  if (!S.state.playing) return S.state.playhead || 0;
  const total = Math.max(1, S.transportSteps());
  const pos = anchorPos + (t - anchorTime) / stepDur();
  return ((pos % total) + total) % total;
}

/** Re-anchor after a tempo change so the playhead does not jump. */
export function rebase() {
  if (!S.state.playing) return;
  anchorPos = playheadSteps();
  anchorTime = getContext().currentTime;
}

/* --------------------------------------------------------------- preview */

/** Audition a pitch immediately (piano-roll taps, on-screen keyboard). */
export async function preview(track, pitch, key = 'kbd') {
  await unlock();
  syncMixer();
  const ctx = getContext();
  const dest = trackDestination(track);
  stopPreview(key);
  const when = ctx.currentTime + 0.005;

  if (track.type === 'drum') {
    const pad = (track.pads || [])[pitch];
    if (pad) playPadVoice(ctx, dest, pad, pitch, when, 1);
    return;
  }
  if (track.type === 'sampler') {
    let buf = cachedBuffer(track.sampleId);
    if (!buf && track.sampleId) buf = await getBuffer(track.sampleId);
    if (!buf) return;
    const rate = Math.pow(2, (pitch - (track.rootNote ?? 60)) / 12);
    previews.set(key, playSample(ctx, dest, buf, {
      when, rate, gain: 0.9, dur: null,
      attack: track.attack ?? 0.002, release: track.release ?? 0.08,
    }));
    return;
  }
  previews.set(key, playSynth(ctx, dest, track.synth || {}, pitch, when, 0.35, 0.9));
}

export function stopPreview(key = 'kbd') {
  const v = previews.get(key);
  if (v) { v.stop(getContext().currentTime); previews.delete(key); }
}

export function stopAllPreviews() {
  for (const k of [...previews.keys()]) stopPreview(k);
}

/**
 * Play a list of project notes on a track right now, through a gain node we
 * can cut later — used by the melody wizard's preview.
 */
let auditionGain = null;

export async function auditionNotes(track, notes, { bpm } = {}) {
  stopAudition();
  await unlock();
  syncMixer();
  const ctx = getContext();
  if (!notes.length) return 0;

  auditionGain = ctx.createGain();
  auditionGain.gain.value = 1;
  auditionGain.connect(trackDestination(track));

  const dur = 60 / (bpm || S.project().bpm) / S.STEPS_PER_BEAT;
  const first = Math.min(...notes.map((n) => n.t));
  const t0 = ctx.currentTime + 0.08;
  for (const note of notes) {
    scheduleTrackNote(track, note, t0 + (note.t - first) * dur, auditionGain);
  }
  const last = Math.max(...notes.map((n) => n.t + n.len));
  return (last - first) * dur;
}

export function stopAudition() {
  if (!auditionGain) return;
  const g = auditionGain;
  auditionGain = null;
  try {
    const t = getContext().currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + 0.05);
    setTimeout(() => { try { g.disconnect(); } catch { /* already gone */ } }, 200);
  } catch { /* context torn down */ }
}

/**
 * One-shot audition of a raw AudioBuffer (sample browser, editor preview).
 * Held as a named preview so a second tap replaces the first rather than
 * layering another copy on top of it.
 */
export async function auditionBuffer(buffer, gain = 0.9) {
  await unlock();
  const ctx = getContext();
  stopPreview('audition');
  const voice = playSample(ctx, getMaster(), buffer, { when: ctx.currentTime + 0.01, gain });
  previews.set('audition', voice);
  return voice;
}
