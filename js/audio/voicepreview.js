// Rendering one synth voice on its own, for the editor's wave display.
//
// The preview is an *offline render of the real voice* rather than a drawing
// of what the settings ought to sound like: it calls `playSynth`, so a filter
// sweep, the drive stage, unison beating and the LFO all show up without the
// display knowing they exist. A divergence between the picture and the sound
// is then impossible by construction.

import { playSynth } from './instruments.js';

const RATE = 44100;        // matches playback, so the filter has the same Nyquist
const cache = new Map();   // signature -> AudioBuffer
const CACHE_LIMIT = 24;

/** Everything the drawing depends on, so an unrelated edit does not re-render. */
const signature = (s, midi, gate, seconds) => JSON.stringify([
  s.wave, s.octave, s.detune, s.voices, s.wave2, s.osc2Semi, s.osc2Level,
  s.subLevel, s.noiseLevel, s.drive, s.filterType, s.cutoff, s.resonance,
  s.filterEnv, s.filterAttack, s.filterDecay,
  s.attack, s.decay, s.sustain, s.release,
  s.lfoTarget, s.lfoRate, s.lfoDepth, s.level,
  midi, gate, seconds,
]);

/**
 * Render a single note into an OfflineAudioContext.
 * `gate` is how long the key is held; `seconds` the whole window, so the
 * release tail is part of the picture.
 */
export async function renderVoice(synth, { midi = 60, gate = 0.45, seconds = 0.9 } = {}) {
  const key = signature(synth, midi, gate, seconds);
  const hit = cache.get(key);
  if (hit) return hit;

  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;
  const ctx = new OAC(1, Math.ceil(seconds * RATE), RATE);
  playSynth(ctx, ctx.destination, synth, midi, 0, gate, 1);
  const buffer = await ctx.startRendering();

  cache.set(key, buffer);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return buffer;
}

/** Drop everything — used when a context is torn down in a test harness. */
export const clearVoiceCache = () => cache.clear();
