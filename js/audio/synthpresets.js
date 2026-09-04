// Starting points for the synth. Each preset is a partial patch merged over
// `defaultSynth()`, so a preset only names what it actually changes and a
// field added later still gets its default.

export const SYNTH_PRESETS = [
  {
    key: 'init', name: 'Init',
    patch: {},
  },
  {
    key: 'warmpad', name: 'Warm pad',
    patch: {
      wave: 'sawtooth', voices: 5, detune: 18, wave2: 'triangle', osc2Semi: -12,
      osc2Level: 0.55, subLevel: 0.2, cutoff: 1400, resonance: 3, filterEnv: 0.35,
      filterAttack: 0.6, filterDecay: 1.2,
      attack: 0.35, decay: 0.6, sustain: 0.85, release: 1.1,
      lfoTarget: 'filter', lfoRate: 0.35, lfoDepth: 0.25,
    },
  },
  {
    key: 'pluck', name: 'Pluck',
    patch: {
      wave: 'sawtooth', voices: 2, detune: 6, wave2: 'off',
      cutoff: 900, resonance: 9, filterEnv: 0.9, filterAttack: 0.002, filterDecay: 0.16,
      attack: 0.002, decay: 0.22, sustain: 0.05, release: 0.18,
    },
  },
  {
    key: 'bass', name: 'Fat bass',
    patch: {
      wave: 'square', voices: 1, detune: 0, wave2: 'sawtooth', osc2Semi: 0,
      osc2Level: 0.6, subLevel: 0.7, octave: -1, drive: 0.3,
      cutoff: 620, resonance: 7, filterEnv: 0.55, filterAttack: 0.004, filterDecay: 0.22,
      attack: 0.004, decay: 0.2, sustain: 0.6, release: 0.12,
    },
  },
  {
    key: 'reed', name: 'Reed',
    patch: {
      wave: 'hollow', voices: 1, detune: 0, wave2: 'pulse', osc2Semi: 12, osc2Level: 0.3,
      noiseLevel: 0.05, cutoff: 2600, resonance: 4, filterEnv: 0.25,
      attack: 0.06, decay: 0.2, sustain: 0.8, release: 0.2,
      lfoTarget: 'pitch', lfoRate: 5.2, lfoDepth: 0.22,
    },
  },
  {
    key: 'organ', name: 'Organ',
    patch: {
      wave: 'organ', voices: 1, detune: 0, wave2: 'sine', osc2Semi: 12, osc2Level: 0.35,
      cutoff: 7000, resonance: 1, filterEnv: 0,
      attack: 0.008, decay: 0.05, sustain: 1, release: 0.09,
    },
  },
  {
    key: 'bell', name: 'Bell',
    patch: {
      wave: 'bright', voices: 1, detune: 0, wave2: 'sine', osc2Semi: 19, osc2Level: 0.4,
      cutoff: 6000, resonance: 2, filterEnv: 0.5, filterAttack: 0.002, filterDecay: 0.9,
      attack: 0.002, decay: 1.1, sustain: 0.08, release: 0.9,
    },
  },
  {
    key: 'sweep', name: 'Sweep lead',
    patch: {
      wave: 'pulse', voices: 3, detune: 22, wave2: 'sawtooth', osc2Semi: -12, osc2Level: 0.4,
      drive: 0.25, cutoff: 380, resonance: 12, filterEnv: 1, filterAttack: 0.45, filterDecay: 0.8,
      attack: 0.01, decay: 0.3, sustain: 0.75, release: 0.3,
    },
  },
  {
    key: 'wind', name: 'Air',
    patch: {
      // A narrow band pass throws most of the noise away, so this patch
      // needs its level back to sit alongside the others.
      wave: 'triangle', voices: 2, detune: 12, wave2: 'off', noiseLevel: 0.8, level: 1.4,
      filterType: 'bandpass', cutoff: 1600, resonance: 2, filterEnv: 0.4,
      filterAttack: 0.4, filterDecay: 0.9,
      attack: 0.4, decay: 0.5, sustain: 0.7, release: 0.9,
      lfoTarget: 'filter', lfoRate: 0.6, lfoDepth: 0.4,
    },
  },
];

export const presetByKey = (key) => SYNTH_PRESETS.find((p) => p.key === key) || null;
