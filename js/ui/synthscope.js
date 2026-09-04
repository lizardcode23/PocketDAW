// The synth's wave display: what the current patch actually sounds like.
//
// Two panes over one rendered note. The top is the whole note — attack,
// decay, sustain and the release tail, drawn as a min/max envelope — and the
// bottom is a few cycles taken from the sustain, which is where the timbre
// lives. Seeing both at once is the point: an envelope alone cannot show a
// pulse wave, and a single cycle cannot show a pluck.

import { renderVoice } from '../audio/voicepreview.js';
import { fitCanvas } from './waveform.js';

const GATE = 0.45;
const WINDOW = 0.9;

export function createSynthScope(canvas, { getSynth, colour = '#6ee7ff' } = {}) {
  let pending = null;
  let token = 0;
  let last = null;

  async function repaint() {
    const s = getSynth();
    if (!s) return;
    const mine = ++token;
    let buffer = null;
    try {
      buffer = await renderVoice(s, { midi: 60, gate: GATE, seconds: WINDOW });
    } catch { /* an offline context can be refused while the tab is hidden */ }
    if (mine !== token) return;          // a newer edit already won
    last = buffer;
    draw(canvas, buffer, colour);
  }

  /** Coalesce a slider drag into one render per frame. */
  function schedule() {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = null; repaint(); });
  }

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (last) draw(canvas, last, colour); })
    : null;
  if (observer) observer.observe(canvas);

  schedule();

  return {
    update: schedule,
    setColour(c) { colour = c; if (last) draw(canvas, last, colour); },
    destroy() {
      token++;
      if (pending) cancelAnimationFrame(pending);
      if (observer) observer.disconnect();
    },
  };
}

function draw(canvas, buffer, colour) {
  const { ctx, w, h } = fitCanvas(canvas, 132);
  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, w, h);

  const split = Math.round(h * 0.58);
  ctx.strokeStyle = '#252c3c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, split + 0.5);
  ctx.lineTo(w, split + 0.5);
  ctx.stroke();

  if (!buffer) {
    ctx.fillStyle = '#6b7488';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('No preview available', 8, 18);
    return;
  }

  const data = buffer.getChannelData(0);
  // The picture is normalised: the display is about shape, and the patch's
  // own level already has a fader of its own.
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  const scale = peak > 0.0005 ? 0.94 / peak : 0;

  drawEnvelope(ctx, data, scale, w, split, colour, buffer.sampleRate);
  drawCycles(ctx, data, scale, w, split, h, colour, buffer.sampleRate);

  ctx.fillStyle = '#6b7488';
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillText('note', 6, 12);
  ctx.fillText('wave', 6, split + 12);
}

/** Whole note as a min/max envelope, with the gate marked. */
function drawEnvelope(ctx, data, scale, w, bottom, colour, rate) {
  const mid = bottom / 2;
  const per = data.length / w;

  ctx.fillStyle = colour;
  for (let x = 0; x < w; x++) {
    const from = Math.floor(x * per);
    const to = Math.min(data.length, Math.floor((x + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i++) {
      const v = data[i] * scale;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const y0 = mid - hi * (mid - 3);
    const y1 = mid - lo * (mid - 3);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }

  // Where the key comes up — everything right of it is the release tail.
  const x = Math.round((GATE * rate / data.length) * w) + 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,.28)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A few cycles out of the sustain, drawn as a line. */
function drawCycles(ctx, data, scale, w, top, bottom, colour, rate) {
  const h = bottom - top;
  const mid = top + h / 2;
  // Middle C is ~261 Hz; four cycles is a readable amount of shape.
  const span = Math.min(data.length, Math.round(rate * 4 / 261.63));
  let from = Math.round(rate * GATE * 0.72);
  if (from + span > data.length) from = Math.max(0, data.length - span);

  // Start on a rising zero crossing so the trace does not jitter sideways
  // between repaints while a slider is being dragged.
  for (let i = from; i < from + span / 4 && i + 1 < data.length; i++) {
    if (data[i] <= 0 && data[i + 1] > 0) { from = i; break; }
  }

  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const i = from + Math.round((x / w) * span);
    const v = (data[Math.min(data.length - 1, i)] || 0) * scale;
    const y = mid - v * (h / 2 - 4);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(mid) + 0.5);
  ctx.lineTo(w, Math.round(mid) + 0.5);
  ctx.stroke();
}
