// Voice builders. Every function takes an explicit BaseAudioContext so the
// same code renders both live and inside an OfflineAudioContext for export.

import { midiToFreq } from '../theory.js';

/* ------------------------------------------------------------- waveforms */

/**
 * Wave shapes beyond the four the browser builds in, as Fourier coefficients.
 * A PeriodicWave belongs to the context that made it, so they are cached per
 * context — which also keeps the offline bounce building its own.
 */
const WAVE_HARMONICS = {
  // 25% pulse: the classic hollow, reedy sound a plain square cannot make.
  pulse: (n) => Math.sin(Math.PI * n * 0.25) / (Math.PI * n),
  // Drawbar organ: fundamental, octave, twelfth, double octave.
  organ: (n) => ([0, 1, 0.5, 0, 0.35, 0, 0.12, 0, 0.22][n] ?? 0) / 2,
  // Odd harmonics rolled off fast — a soft, clarinet-ish hollow tone.
  hollow: (n) => (n % 2 === 1 ? 1 / (n * n) : 0),
  // Bright additive stack, the raw material for plucks and bells.
  bright: (n) => 1 / Math.sqrt(n),
};

export const CUSTOM_WAVES = Object.keys(WAVE_HARMONICS);
export const WAVE_TYPES = ['sawtooth', 'square', 'triangle', 'sine', ...CUSTOM_WAVES];

const waveCache = new WeakMap();      // ctx -> { type -> PeriodicWave }

function periodicWave(ctx, type) {
  let byType = waveCache.get(ctx);
  if (!byType) { byType = new Map(); waveCache.set(ctx, byType); }
  let wave = byType.get(type);
  if (!wave) {
    const partials = 32;
    const real = new Float32Array(partials);
    const imag = new Float32Array(partials);
    const fn = WAVE_HARMONICS[type];
    for (let n = 1; n < partials; n++) imag[n] = fn(n);
    wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    byType.set(type, wave);
  }
  return wave;
}

/** Point an oscillator at a wave, built-in or custom. */
export function setWave(ctx, osc, type) {
  if (WAVE_HARMONICS[type]) osc.setPeriodicWave(periodicWave(ctx, type));
  else osc.type = type || 'sawtooth';
  return osc;
}

/** Soft-clip curve for the pre-filter drive stage. */
function driveCurve(amount) {
  const k = 1 + amount * 60;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

const noiseCache = new WeakMap();

/** White noise, one second, reused through looping. */
function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/* ----------------------------------------------------------------- synth */

/**
 * The subtractive voice: an oscillator bank (unison osc 1, optional osc 2,
 * sub and noise) -> drive -> filter with its own envelope -> VCA, with one
 * LFO that can be pointed at pitch, filter or amplitude.
 *
 * `dur` is the gate length in seconds; the release tail extends past it.
 * `opts.glideFrom` is the previous note the voice should slide up from.
 */
export function playSynth(ctx, dest, s, midi, when, dur, vel = 1, opts = {}) {
  const octave = s.octave || 0;
  const freq = midiToFreq(midi + octave * 12);
  const amp = ctx.createGain();
  amp.gain.value = 0;

  const filter = ctx.createBiquadFilter();
  filter.type = s.filterType || 'lowpass';
  filter.Q.value = s.resonance ?? 4;

  const a = Math.max(0.001, s.attack ?? 0.005);
  const d = Math.max(0.001, s.decay ?? 0.15);
  const sus = Math.min(1, Math.max(0, s.sustain ?? 0.6));
  const r = Math.max(0.01, s.release ?? 0.2);
  const peak = 0.32 * vel * (s.level ?? 1);

  const off = when + Math.max(dur, a + 0.01);
  // Where the decay has actually got to when the key comes up. A
  // setValueAtTime lands *inside* the decay ramp and truncates it, so
  // writing the sustain level there would drop the note to the sustain in
  // one sample — inaudible with a 180 ms decay, a click with a 1 s one.
  const decayEnd = when + a + d;
  const atOff = off >= decayEnd
    ? peak * sus
    : peak + (peak * sus - peak) * ((off - (when + a)) / d);

  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(peak, when + a);
  amp.gain.linearRampToValueAtTime(Math.max(0.0001, peak * sus), decayEnd);
  amp.gain.setValueAtTime(Math.max(0.0001, atOff), off);
  amp.gain.exponentialRampToValueAtTime(0.0001, off + r);

  // The filter envelope has its own times, so a slow sweep under a short
  // pluck — the sound the shared A/D could not make — is one setting away.
  // A cutoff above Nyquist is meaningless and the browser warns about it —
  // which matters because the preview renders the same voice offline.
  const ceiling = Math.min(18000, ctx.sampleRate * 0.45);
  const base = Math.min(ceiling, Math.max(30, s.cutoff ?? 3000));
  const envAmt = s.filterEnv ?? 0.4;
  const fa = Math.max(0.001, s.filterAttack ?? a);
  const fd = Math.max(0.001, s.filterDecay ?? d);
  const top = Math.min(ceiling, base * (1 + envAmt * 6));
  filter.frequency.setValueAtTime(base, when);
  if (envAmt > 0.001) {
    filter.frequency.linearRampToValueAtTime(top, when + fa);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, base), when + fa + fd + 0.05);
  }

  // --- oscillator bank -------------------------------------------------
  const mix = ctx.createGain();
  const oscs = [];
  const stopAt = off + r + 0.05;
  const glide = Math.max(0, s.glide || 0);
  const fromFreq = glide > 0 && opts.glideFrom != null
    ? midiToFreq(opts.glideFrom + octave * 12) : null;

  const addOsc = (type, semis, cents, level) => {
    const o = ctx.createOscillator();
    setWave(ctx, o, type);
    const f = freq * Math.pow(2, semis / 12);
    if (fromFreq) {
      o.frequency.setValueAtTime(fromFreq * Math.pow(2, semis / 12), when);
      o.frequency.exponentialRampToValueAtTime(Math.max(8, f), when + glide);
    } else {
      o.frequency.setValueAtTime(f, when);
    }
    o.detune.setValueAtTime(cents, when);
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g); g.connect(mix);
    o.start(when);
    o.stop(stopAt);
    oscs.push(o);
    return o;
  };

  const detune = s.detune ?? 0;
  const voices = Math.max(1, Math.min(7, Math.round(s.voices ?? 2)));
  // Voices are spread evenly across ±detune, so turning the count up widens
  // the same chorus instead of stacking a second, louder one.
  const spread = [];
  for (let i = 0; i < voices; i++) {
    spread.push(voices === 1 ? 0 : (i / (voices - 1)) * 2 - 1);
  }
  const voiceLevel = 1 / Math.sqrt(voices);
  for (const pos of spread) addOsc(s.wave, 0, pos * detune, voiceLevel);

  const osc2 = s.wave2 && s.wave2 !== 'off' ? s.wave2 : null;
  if (osc2 && (s.osc2Level ?? 0) > 0.001) {
    const lvl = (s.osc2Level ?? 0.5) / Math.sqrt(voices);
    for (const pos of spread) addOsc(osc2, s.osc2Semi ?? 0, pos * detune, lvl);
  }
  if ((s.subLevel ?? 0) > 0.001) addOsc('sine', -12, 0, s.subLevel);

  let noise = null;
  if ((s.noiseLevel ?? 0) > 0.001) {
    noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx);
    noise.loop = true;
    const ng = ctx.createGain();
    ng.gain.value = s.noiseLevel * 0.5;
    noise.connect(ng); ng.connect(mix);
    noise.start(when, Math.random() * 0.5);
    noise.stop(stopAt);
  }

  // --- drive ------------------------------------------------------------
  let head = mix;
  if ((s.drive ?? 0) > 0.001) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(s.drive);
    shaper.oversample = '2x';
    const trim = ctx.createGain();
    // Saturation adds level; take it back out so turning drive up is a
    // change of tone rather than a change of loudness.
    trim.gain.value = 1 / (1 + s.drive * 1.6);
    head.connect(shaper); shaper.connect(trim);
    head = trim;
  }
  head.connect(filter);
  filter.connect(amp);
  amp.connect(dest);

  // --- LFO --------------------------------------------------------------
  let lfo = null;
  const target = s.lfoTarget || 'off';
  const depth = s.lfoDepth ?? 0;
  if (target !== 'off' && depth > 0.001) {
    lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = Math.max(0.05, s.lfoRate ?? 5);
    const amount = ctx.createGain();
    lfo.connect(amount);
    if (target === 'pitch') {
      amount.gain.value = depth * 60;             // up to ±60 cents of vibrato
      for (const o of oscs) amount.connect(o.detune);
    } else if (target === 'filter') {
      amount.gain.value = depth * base * 0.9;     // sweep around the cutoff
      amount.connect(filter.frequency);
    } else {
      amount.gain.value = depth * peak * 0.9;     // tremolo around the VCA
      amount.connect(amp.gain);
    }
    lfo.start(when);
    lfo.stop(stopAt);
  }

  return {
    stop(t) {
      const at = Math.max(t, when + 0.005);
      try {
        amp.gain.cancelScheduledValues(at);
        amp.gain.setValueAtTime(Math.max(0.0001, amp.gain.value), at);
        amp.gain.exponentialRampToValueAtTime(0.0001, at + r);
        for (const o of oscs) o.stop(at + r + 0.05);
        if (noise) noise.stop(at + r + 0.05);
        if (lfo) lfo.stop(at + r + 0.05);
      } catch { /* already stopped */ }
    },
  };
}

/**
 * One-shot / gated sample voice. `rate` is the playback ratio,
 * `dur` the gate length in seconds (null = play to the end).
 */
export function playSample(ctx, dest, buffer, {
  when = 0, rate = 1, gain = 1, dur = null,
  attack = 0.002, release = 0.06, loop = false, offset = 0,
} = {}) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  src.loop = loop;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + Math.max(0.001, attack));

  const natural = (buffer.duration - offset) / Math.max(0.01, rate);
  const gate = dur == null ? natural : Math.min(loop ? dur : natural, dur);
  const end = when + Math.max(0.02, gate);
  g.gain.setValueAtTime(gain, Math.max(when + attack, end - release));
  g.gain.exponentialRampToValueAtTime(0.0001, end + release);

  src.connect(g);
  g.connect(dest);
  src.start(when, offset);
  src.stop(end + release + 0.02);

  return {
    stop(t) {
      const at = Math.max(t, when + 0.005);
      try {
        g.gain.cancelScheduledValues(at);
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + release);
        src.stop(at + release + 0.02);
      } catch { /* already stopped */ }
    },
  };
}

/** Short click used by the metronome; accented on the downbeat. */
export function playClick(ctx, dest, when, accent = false) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(accent ? 1600 : 1000, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.12, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
  o.connect(g); g.connect(dest);
  o.start(when); o.stop(when + 0.06);
}

/** Fallback voice for drum pads with no sample loaded yet. */
export function playSynthDrum(ctx, dest, padIndex, when, gain = 1) {
  const kind = padIndex % 4;
  if (kind === 0 || kind === 2) {            // kick / tom
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f0 = kind === 0 ? 150 : 260;
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.3, when + 0.12);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.7 * gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.28);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + 0.32);
  } else {                                    // snare / hat noise
    const len = kind === 1 ? 0.18 : 0.06;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'highpass';
    bp.frequency.value = kind === 1 ? 1200 : 6000;
    const g = ctx.createGain();
    g.gain.value = 0.5 * gain;
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(when);
  }
}
