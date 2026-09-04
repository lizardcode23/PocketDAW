// A pattern's notes drawn small: on a playlist clip, and in the wizards'
// previews. One drawing routine so a clip on the timeline and the preview
// that produced it look like the same music.

import { fitCanvas } from './waveform.js';

/**
 * Draw notes into a canvas.
 *
 *   steps        how many 16ths the canvas spans
 *   patSteps     length of the pattern the notes live in — notes repeat
 *                every `patSteps` so a clip longer than its pattern shows
 *                the loop rather than one lonely copy at the front
 *   offsetSteps  steps into the pattern the window starts at
 *   range        [lo, hi] pitch range, or null to fit the notes
 *   rows         draw one lane per pitch in `range` (drum grids)
 */
export function drawNoteMini(canvas, notes, {
  steps = 16, patSteps = steps, offsetSteps = 0, range = null, rows = false,
  colour = 'rgba(255,255,255,.72)', background = 'rgba(0,0,0,0)',
  bars = 0, height,
} = {}) {
  const { ctx, w, h } = fitCanvas(canvas, height);
  ctx.clearRect(0, 0, w, h);
  if (background !== 'rgba(0,0,0,0)') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }

  if (bars > 1) {
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 1;
    for (let b = 1; b < bars; b++) {
      const x = Math.round((b / bars) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  if (!notes || !notes.length) return { w, h };

  let [lo, hi] = range || [];
  if (lo == null) {
    lo = Math.min(...notes.map((n) => n.pitch));
    hi = Math.max(...notes.map((n) => n.pitch));
  }
  const span = Math.max(rows ? hi - lo : 3, hi - lo);
  const pad = 1.5;
  const laneH = (h - pad * 2) / (span + 1);
  const noteH = Math.max(1.5, Math.min(rows ? laneH - 0.5 : 5, laneH * 0.85));
  const xOf = (s) => (s / steps) * w;
  // Pitch runs upwards; a drum grid reads the other way round, pad 1 on top,
  // which is how the step editor draws it.
  const yOf = (p) => (rows
    ? pad + ((p - lo) / (span + 1)) * (h - pad * 2)
    : h - pad - ((p - lo) / (span + 1)) * (h - pad * 2) - noteH);

  ctx.fillStyle = colour;
  const period = Math.max(1, patSteps);
  for (const n of notes) {
    // Every copy of the note that lands inside the window.
    const first = Math.floor((0 - (n.t - offsetSteps)) / period);
    const last = Math.ceil((steps - (n.t - offsetSteps)) / period);
    for (let k = first; k <= last; k++) {
      const at = n.t - offsetSteps + k * period;
      if (at >= steps || at + n.len <= 0) continue;
      const from = Math.max(0, at);
      const to = Math.min(steps, at + n.len);
      const x = xOf(from);
      const width = Math.max(1.5, xOf(to) - x - 0.5);
      ctx.globalAlpha = 0.5 + 0.5 * (n.vel ?? 0.9);
      const y = yOf(n.pitch);
      if (ctx.roundRect && width > 3 && noteH > 3) {
        ctx.beginPath();
        ctx.roundRect(x, y, width, noteH, 1.5);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, width, noteH);
      }
    }
  }
  ctx.globalAlpha = 1;
  return { w, h };
}
