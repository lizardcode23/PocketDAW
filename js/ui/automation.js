// Automation lanes on the playlist.
//
// One lane is a canvas over song time and a list of breakpoints; the store
// owns the shape (`S.autoLane`) and the engine reads the same list, so what
// is drawn here is literally what is played. Every lane is edited on the
// same normalised 0..1 axis — the lane's own `format` is what turns a height
// into hertz or decibels — which is why four different parameters need one
// editor rather than four.

import * as S from '../state.js';
import { el, icon, ICONS, sheet } from './dom.js';
import { fitCanvas } from './waveform.js';

const HIT = 15;          // px within which a tap grabs an existing point
const PAD = 6;           // px of headroom, so a point at 0 or 1 stays grabbable

/**
 * Build one automation lane row.
 *
 *   stepW      pixels per 16th step
 *   songSteps  how wide the lane is, in steps
 *   snap       step grid a dragged point lands on
 */
export function automationLane(track, key, {
  stepW, songSteps, snap = 1, headWidth = 96, onChange, onClose,
} = {}) {
  const lane = S.AUTO_LANES[key];
  const canvas = el('canvas', { class: 'plauto-canvas' });
  const readout = el('span', { class: 'plauto-val' }, lane.format(S.autoNormAt(track, key, 0)));
  const width = songSteps * stepW;

  const surface = el('div', {
    class: 'plauto',
    style: { width: `${width}px`, '--c': lane.colour },
    dataset: { lane: key, track: track.id },
  }, canvas);

  const head = el('div', {
    class: 'plhead autohead',
    style: { '--c': lane.colour, width: `${headWidth}px`, flex: `0 0 ${headWidth}px` },
  },
    el('span', { class: 'pln' }, lane.name),
    el('span', { class: 'plauto-row' },
      readout,
      el('button', {
        class: 'plauto-x', 'aria-label': `Hide the ${lane.name} lane`,
        onclick: (e) => { e.stopPropagation(); onClose && onClose(); },
      }, icon(ICONS.close, 12)),
    ),
  );

  const row = el('div', { class: 'plrow autorow' }, head, surface);

  /* ------------------------------------------------------------- paint */

  function paint() {
    const { ctx, w, h } = fitCanvas(canvas, 46);
    ctx.clearRect(0, 0, w, h);
    const pts = S.autoLane(track, key);
    const yOf = (v) => PAD + (1 - v) * (h - PAD * 2);
    const xOf = (t) => (t / Math.max(1, songSteps)) * w;

    // Bar lines, so a curve can be read against the arrangement above it.
    const bars = Math.max(1, Math.round(songSteps / S.STEPS_PER_BAR));
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    for (let b = 1; b < bars; b++) {
      const x = Math.round(xOf(b * S.STEPS_PER_BAR)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // The lane's default level, so "off" reads as a line the curve sits on.
    const defY = Math.round(yOf(lane.def)) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, defY);
    ctx.lineTo(w, defY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Flat before the first point and after the last — the same shape the
    // store hands the scheduler.
    const shape = pts.length
      ? [{ t: 0, v: pts[0].v }, ...pts, { t: songSteps, v: pts[pts.length - 1].v }]
      : [{ t: 0, v: lane.def }, { t: songSteps, v: lane.def }];

    // Filled under the curve: on a 46 px lane a shape reads at a glance
    // where a one-pixel line does not.
    const fill = new Path2D();
    const line = new Path2D();
    shape.forEach((p, i) => {
      const x = xOf(p.t);
      const y = yOf(p.v);
      if (i === 0) { fill.moveTo(x, y); line.moveTo(x, y); }
      else { fill.lineTo(x, y); line.lineTo(x, y); }
    });
    fill.lineTo(w, h);
    fill.lineTo(0, h);
    fill.closePath();
    ctx.fillStyle = pts.length ? `${lane.colour}22` : 'rgba(255,255,255,.03)';
    ctx.fill(fill);

    ctx.strokeStyle = pts.length ? lane.colour : 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1.8;
    ctx.stroke(line);

    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(xOf(p.t), yOf(p.v), 3.6, 0, Math.PI * 2);
      ctx.fillStyle = lane.colour;
      ctx.fill();
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------- gestures */

  let drag = null;

  const geom = () => {
    const rect = canvas.getBoundingClientRect();
    return {
      stepOf: (clientX) => ((clientX - rect.left) / Math.max(1, rect.width)) * songSteps,
      valOf: (clientY) => 1 - ((clientY - rect.top) - PAD) / Math.max(1, rect.height - PAD * 2),
      xOf: (t) => rect.left + (t / Math.max(1, songSteps)) * rect.width,
      yOf: (v) => rect.top + PAD + (1 - v) * (rect.height - PAD * 2),
    };
  };

  const nearest = (g, clientX, clientY) => {
    let best = null;
    let bestD = HIT;
    for (const p of S.autoLane(track, key)) {
      const d = Math.hypot(g.xOf(p.t) - clientX, g.yOf(p.v) - clientY);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const snapStep = (s) => Math.max(0, Math.min(songSteps,
    Math.round(s / Math.max(1, snap)) * Math.max(1, snap)));

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // The playlist's own handler treats a bare lane as "drop a clip here";
    // an automation lane is not that, so the gesture stops at this canvas.
    e.stopPropagation();
    const g = geom();
    const hit = nearest(g, e.clientX, e.clientY);
    S.checkpoint();
    const point = hit
      || S.setAutoPoint(track, key, snapStep(g.stepOf(e.clientX)), clamp01(g.valOf(e.clientY)));
    drag = { point };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* gone */ }
    readout.textContent = lane.format(point.v);
    paint();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.preventDefault();
    const g = geom();
    const t = snapStep(g.stepOf(e.clientX));
    const v = clamp01(g.valOf(e.clientY));
    // Two points on one step would make the lane stop being a function of
    // time: the one being dragged wins and absorbs the other.
    const pts = S.autoLane(track, key);
    const clash = pts.find((p) => p !== drag.point && p.t === t);
    if (clash) pts.splice(pts.indexOf(clash), 1);
    drag.point.t = t;
    drag.point.v = v;
    pts.sort((a, b) => a.t - b.t);
    readout.textContent = lane.format(v);
    paint();
  });

  const endDrag = (e) => {
    if (!drag) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    drag = null;
    S.touch();
    onChange && onChange();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const removeAt = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const hit = nearest(geom(), e.clientX, e.clientY);
    if (!hit) return;
    S.checkpoint();
    S.removeAutoPoint(track, key, hit.t);
    paint();
    onChange && onChange();
  };
  canvas.addEventListener('contextmenu', removeAt);
  canvas.addEventListener('dblclick', removeAt);

  // The canvas has no layout until the row is in the document.
  requestAnimationFrame(paint);
  return { row, paint };
}

/**
 * Choose which lanes a track shows. Which lanes are *visible* is a view
 * preference and lives with the playlist; clearing one is an edit, and is
 * offered here because this is where you look when a lane is in the way.
 */
export function openAutomationSheet(track, { shown = [], onToggle, onChange } = {}) {
  sheet(`Automation — ${track.name}`, (body, close) => {
    const list = el('div', { class: 'slist' });

    for (const key of S.AUTO_KEYS) {
      const lane = S.AUTO_LANES[key];
      const on = shown.includes(key);
      const count = S.autoLane(track, key).length;
      list.append(el('button', {
        class: 'sitem', style: { width: '100%' },
        onclick: () => { onToggle && onToggle(key, !on); close(); },
      },
        el('span', { class: 'play', style: { color: lane.colour } },
          icon(on ? ICONS.check : ICONS.plus, 16)),
        el('span', { class: 'meta' },
          el('b', {}, lane.name),
          el('span', {}, count ? `${count} point${count === 1 ? '' : 's'}` : 'no points yet')),
        count ? el('span', {
          class: 'sclear', role: 'button',
          onclick: (e) => {
            e.stopPropagation();
            S.checkpoint();
            S.clearAutoLane(track, key);
            close();
            onChange && onChange();
          },
        }, 'Clear') : null,
      ));
    }

    body.append(
      list,
      el('p', { class: 'hint' },
        'Lanes play in song mode. Tap a lane to drop a point, drag it to shape the curve, '
        + 'and right-click or double-tap a point to remove it. Volume and pan sit underneath '
        + 'the mixer’s own controls, so the fader still does what you expect.'),
    );
  });
}
