// Channel effects. Every effect is a small factory that returns
// { input, output, update(params) } built from native Web Audio nodes, so the
// same chain code runs live and inside the OfflineAudioContext used for
// bouncing. No module-level context references — the context is always passed in.

export const EFFECT_TYPES = ['eq', 'filter', 'drive', 'chorus', 'delay', 'reverb', 'comp'];

export const EFFECT_INFO = {
  eq:     { name: 'EQ',         blurb: 'Three-band tone shaping' },
  filter: { name: 'Filter',     blurb: 'Resonant low/high/band pass' },
  drive:  { name: 'Drive',      blurb: 'Soft saturation and grit' },
  chorus: { name: 'Chorus',     blurb: 'Detuned doubling for width' },
  delay:  { name: 'Delay',      blurb: 'Tempo-synced echoes' },
  reverb: { name: 'Reverb',     blurb: 'Synthesised room and hall' },
  comp:   { name: 'Compressor', blurb: 'Evens out the level' },
};

export const EFFECT_PARAMS = {
  eq: [
    { key: 'low',  label: 'Low',   min: -18, max: 18, step: 0.5, def: 0, unit: 'dB' },
    { key: 'mid',  label: 'Mid',   min: -18, max: 18, step: 0.5, def: 0, unit: 'dB' },
    { key: 'high', label: 'High',  min: -18, max: 18, step: 0.5, def: 0, unit: 'dB' },
    { key: 'midFreq', label: 'Mid freq', min: 200, max: 6000, step: 10, def: 1000, unit: 'Hz' },
  ],
  filter: [
    { key: 'mode', label: 'Mode', options: ['lowpass', 'highpass', 'bandpass'], def: 'lowpass' },
    { key: 'freq', label: 'Cutoff', min: 60, max: 18000, step: 10, def: 6000, unit: 'Hz' },
    { key: 'q',    label: 'Resonance', min: 0.3, max: 20, step: 0.1, def: 1 },
  ],
  drive: [
    { key: 'amount', label: 'Drive', min: 0, max: 1, step: 0.01, def: 0.35 },
    { key: 'tone',   label: 'Tone',  min: 500, max: 16000, step: 100, def: 8000, unit: 'Hz' },
    { key: 'level',  label: 'Output', min: 0, max: 1.5, step: 0.01, def: 0.8 },
  ],
  chorus: [
    { key: 'rate',  label: 'Rate',  min: 0.05, max: 6, step: 0.05, def: 0.8, unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.4 },
    { key: 'mix',   label: 'Mix',   min: 0, max: 1, step: 0.01, def: 0.4 },
  ],
  delay: [
    { key: 'time',     label: 'Time',     min: 1, max: 16, step: 1, def: 3, unit: 'steps' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, def: 0.35 },
    { key: 'tone',     label: 'Tone',     min: 500, max: 16000, step: 100, def: 4000, unit: 'Hz' },
    { key: 'mix',      label: 'Mix',      min: 0, max: 1, step: 0.01, def: 0.3 },
  ],
  reverb: [
    { key: 'size',  label: 'Size',  min: 0.2, max: 6, step: 0.1, def: 1.8, unit: 's' },
    { key: 'damp',  label: 'Damping', min: 500, max: 16000, step: 100, def: 4500, unit: 'Hz' },
    { key: 'mix',   label: 'Mix',   min: 0, max: 1, step: 0.01, def: 0.25 },
  ],
  comp: [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, def: -20, unit: 'dB' },
    { key: 'ratio',     label: 'Ratio',     min: 1, max: 20, step: 0.5, def: 4 },
    { key: 'attack',    label: 'Attack',    min: 0.001, max: 0.2, step: 0.001, def: 0.01, unit: 's' },
    { key: 'release',   label: 'Release',   min: 0.02, max: 1, step: 0.01, def: 0.2, unit: 's' },
    { key: 'makeup',    label: 'Makeup',    min: 0, max: 2, step: 0.01, def: 1 },
  ],
};

export function defaultParams(type) {
  const out = {};
  for (const p of EFFECT_PARAMS[type] || []) out[p.key] = p.def;
  return out;
}

/* ------------------------------------------------------------ builders */

function buildEq(ctx, p) {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 250;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.Q.value = 0.9;

  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 4000;

  low.connect(mid); mid.connect(high);
  const update = (v) => {
    low.gain.value = v.low ?? 0;
    mid.gain.value = v.mid ?? 0;
    mid.frequency.value = v.midFreq ?? 1000;
    high.gain.value = v.high ?? 0;
  };
  update(p);
  return { input: low, output: high, update };
}

function buildFilter(ctx, p) {
  const f = ctx.createBiquadFilter();
  const update = (v) => {
    f.type = v.mode || 'lowpass';
    f.frequency.value = Math.max(20, Math.min(20000, v.freq ?? 6000));
    f.Q.value = v.q ?? 1;
  };
  update(p);
  return { input: f, output: f, update };
}

/** Odd-symmetric soft clipper; `amount` bends the curve from clean to fuzzy. */
function driveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 60;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

function buildDrive(ctx, p) {
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  const out = ctx.createGain();

  pre.connect(shaper); shaper.connect(tone); tone.connect(out);
  const update = (v) => {
    const amount = v.amount ?? 0.35;
    pre.gain.value = 1 + amount * 3;
    shaper.curve = driveCurve(amount);
    tone.frequency.value = v.tone ?? 8000;
    out.gain.value = (v.level ?? 0.8) / (1 + amount);
  };
  update(p);
  return { input: pre, output: out, update };
}

function buildChorus(ctx, p) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();

  input.connect(dry); dry.connect(out);

  // Two delay lines modulated in opposite phase give a wider image.
  const voices = [0, 1].map((i) => {
    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.012 + i * 0.007;
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 0.8 + i * 0.13;
    lfo.connect(depth);
    depth.connect(delay.delayTime);
    lfo.start();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = i === 0 ? -0.6 : 0.6; delay.connect(pan); pan.connect(wet); }
    else delay.connect(wet);
    input.connect(delay);
    return { delay, lfo, depth };
  });
  wet.connect(out);

  const update = (v) => {
    const mix = v.mix ?? 0.4;
    dry.gain.value = 1 - mix * 0.5;
    wet.gain.value = mix;
    voices.forEach((voice, i) => {
      voice.lfo.frequency.value = (v.rate ?? 0.8) * (1 + i * 0.16);
      voice.depth.gain.value = (v.depth ?? 0.4) * 0.004;
    });
  };
  update(p);
  return { input, output: out, update, stop: () => voices.forEach((v) => { try { v.lfo.stop(); } catch { /* already */ } }) };
}

function buildDelay(ctx, p, { secondsPerStep = 0.15 } = {}) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const delay = ctx.createDelay(4);
  const fb = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';

  input.connect(dry); dry.connect(out);
  input.connect(delay);
  delay.connect(tone);
  tone.connect(fb);
  fb.connect(delay);
  tone.connect(wet);
  wet.connect(out);

  const update = (v, opts = {}) => {
    const sps = opts.secondsPerStep ?? secondsPerStep;
    delay.delayTime.value = Math.min(3.9, Math.max(0.02, (v.time ?? 3) * sps));
    fb.gain.value = Math.min(0.9, v.feedback ?? 0.35);
    tone.frequency.value = v.tone ?? 4000;
    const mix = v.mix ?? 0.3;
    wet.gain.value = mix;
    dry.gain.value = 1;
  };
  update(p);
  return { input, output: out, update };
}

/** Noise burst with an exponential tail — a serviceable synthetic room. */
function makeImpulse(ctx, seconds, damp) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let lp = 0;
    const coeff = Math.exp(-2 * Math.PI * Math.min(rate / 2.2, damp) / rate);
    for (let i = 0; i < len; i++) {
      const decay = Math.pow(1 - i / len, 2.6);
      const noise = (Math.random() * 2 - 1) * decay;
      lp = noise * (1 - coeff) + lp * coeff;       // damp the tail
      data[i] = lp * (i < rate * 0.004 ? i / (rate * 0.004) : 1);
    }
  }
  return buf;
}

function buildReverb(ctx, p) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();

  input.connect(dry); dry.connect(out);
  input.connect(conv); conv.connect(wet); wet.connect(out);

  let lastKey = '';
  const update = (v) => {
    const size = Math.max(0.2, v.size ?? 1.8);
    const damp = v.damp ?? 4500;
    const key = `${size}|${damp}`;
    if (key !== lastKey) {
      conv.buffer = makeImpulse(ctx, size, damp);
      lastKey = key;
    }
    const mix = v.mix ?? 0.25;
    wet.gain.value = mix;
    dry.gain.value = 1 - mix * 0.35;
  };
  update(p);
  return { input, output: out, update };
}

function buildComp(ctx, p) {
  const comp = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  comp.connect(makeup);
  const update = (v) => {
    comp.threshold.value = v.threshold ?? -20;
    comp.ratio.value = v.ratio ?? 4;
    comp.attack.value = v.attack ?? 0.01;
    comp.release.value = v.release ?? 0.2;
    comp.knee.value = 6;
    makeup.gain.value = v.makeup ?? 1;
  };
  update(p);
  return { input: comp, output: makeup, update };
}

const BUILDERS = {
  eq: buildEq, filter: buildFilter, drive: buildDrive,
  chorus: buildChorus, delay: buildDelay, reverb: buildReverb, comp: buildComp,
};

export function buildEffect(ctx, fx, opts) {
  const build = BUILDERS[fx.type];
  if (!build) return null;
  const node = build(ctx, fx.params || defaultParams(fx.type), opts);
  node.type = fx.type;
  node.fxId = fx.id;
  return node;
}

/**
 * Wire a list of effect descriptors into a chain.
 * Returns { input, nodes } — connect `input` to the source and the chain's
 * tail is already connected to `destination`.
 */
export function buildChain(ctx, fxList, destination, opts = {}) {
  const nodes = [];
  const passthrough = ctx.createGain();
  let tail = passthrough;

  for (const fx of fxList || []) {
    if (fx.on === false) continue;
    const node = buildEffect(ctx, fx, opts);
    if (!node) continue;
    tail.connect(node.input);
    tail = node.output;
    nodes.push(node);
  }
  tail.connect(destination);
  return { input: passthrough, nodes, tail };
}

export function disposeChain(chain) {
  if (!chain) return;
  for (const node of chain.nodes) {
    if (node.stop) node.stop();
    try { node.output.disconnect(); } catch { /* already gone */ }
    try { node.input.disconnect(); } catch { /* already gone */ }
  }
  try { chain.input.disconnect(); } catch { /* already gone */ }
}
