// Waveform drawing, shared by the sample editor and the clip editor.
//
// Peaks are computed once per buffer and cached: a four-minute stereo file is
// forty million frames, and walking it on every pointermove is the difference
// between a smooth drag and a slideshow.

const cache = new WeakMap();     // AudioBuffer -> { buckets, min, max }

/**
 * Min/max envelope of a buffer, reduced to `buckets` columns.
 * Both extremes are kept so a waveform still looks like a waveform when a
 * whole second is squeezed into one pixel.
 */
export function peaks(buffer, buckets = 1200) {
  const hit = cache.get(buffer);
  if (hit && hit.buckets === buckets) return hit;

  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const per = buffer.length / buckets;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));

  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(buffer.length, Math.floor((b + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i++) {
      let s = 0;
      for (const ch of chans) s += ch[i];
      s /= chans.length;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[b] = lo;
    max[b] = hi;
  }
  const out = { buckets, min, max };
  cache.set(buffer, out);
  return out;
}

/** Size a canvas to its CSS box at device resolution. Returns its 2D context. */
export function fitCanvas(canvas, fallbackHeight = 120) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(80, rect.width || 320);
  const h = Math.max(40, rect.height || fallbackHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * Draw a buffer.
 *   view       { from, to } in seconds — the visible window
 *   selection  { from, to } in seconds, or null
 *   marks      [{ at, colour }] vertical lines in seconds
 *   shaded     [[from, to]] ranges drawn as muted
 */
export function drawWave(canvas, buffer, {
  view = null, selection = null, marks = [], shaded = [],
  colour = '#6ee7ff', background = '#0a0c11', height,
} = {}) {
  const { ctx, w, h } = fitCanvas(canvas, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  if (!buffer) return { w, h, xOf: () => 0, timeOf: () => 0 };

  const from = view ? Math.max(0, view.from) : 0;
  const to = view ? Math.min(buffer.duration, view.to) : buffer.duration;
  const span = Math.max(0.0005, to - from);
  const xOf = (t) => ((t - from) / span) * w;
  const timeOf = (x) => from + (x / w) * span;

  const p = peaks(buffer, Math.max(200, Math.round(w * 2)));
  const mid = h / 2;

  // Selection behind the waveform, so the trace stays readable.
  if (selection && selection.to > selection.from) {
    ctx.fillStyle = 'rgba(110,231,255,.13)';
    ctx.fillRect(xOf(selection.from), 0, Math.max(2, xOf(selection.to) - xOf(selection.from)), h);
  }
  for (const [a, b] of shaded) {
    ctx.fillStyle = 'rgba(251,113,133,.20)';
    ctx.fillRect(xOf(a), 0, Math.max(1.5, xOf(b) - xOf(a)), h);
  }

  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(mid) + 0.5);
  ctx.lineTo(w, Math.round(mid) + 0.5);
  ctx.stroke();

  ctx.fillStyle = colour;
  for (let x = 0; x < w; x++) {
    const t0 = timeOf(x);
    const t1 = timeOf(x + 1);
    const b0 = Math.floor((t0 / buffer.duration) * p.buckets);
    const b1 = Math.max(b0 + 1, Math.ceil((t1 / buffer.duration) * p.buckets));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1 && b < p.buckets; b++) {
      if (p.min[b] < lo) lo = p.min[b];
      if (p.max[b] > hi) hi = p.max[b];
    }
    const y0 = mid - hi * (mid - 2);
    const y1 = mid - lo * (mid - 2);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }

  // Selection edges last: they are the thing you aim at.
  if (selection && selection.to > selection.from) {
    ctx.strokeStyle = '#6ee7ff';
    ctx.lineWidth = 2;
    for (const t of [selection.from, selection.to]) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  for (const m of marks) {
    ctx.strokeStyle = m.colour || '#fbbf24';
    ctx.lineWidth = m.width || 1.5;
    const x = Math.round(xOf(m.at)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  return { w, h, xOf, timeOf, from, to };
}

export const fmtTime = (s) => {
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m ? `${m}:${rest.toFixed(2).padStart(5, '0')}` : `${rest.toFixed(2)}s`;
};
