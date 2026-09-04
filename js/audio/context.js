// A single AudioContext plus the master output chain.
// Mobile browsers only allow the context to start inside a user gesture,
// so everything funnels through unlock().

let ctx = null;
let master = null;   // everything routes here
let limiter = null;
let analyser = null;

export function getContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.85;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;

    master.connect(limiter);
    limiter.connect(analyser);
    limiter.connect(ctx.destination);
  }
  return ctx;
}

export const getMaster = () => { getContext(); return master; };
export const getAnalyser = () => { getContext(); return analyser; };

/** Resume the context; must be called from a user gesture on iOS/Android. */
export async function unlock() {
  const c = getContext();
  if (c.state !== 'running') {
    try { await c.resume(); } catch { /* ignore */ }
  }
  // iOS additionally needs a real (silent) buffer to play once.
  if (!unlock._primed) {
    const buf = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
    unlock._primed = true;
  }
  return c.state === 'running';
}

export const now = () => getContext().currentTime;
