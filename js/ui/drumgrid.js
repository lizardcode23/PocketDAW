// Step grid for drum tracks: one row per pad, one cell per 16th note.
// Plain DOM here — the grid is small enough, and native scrolling with a
// sticky pad column feels better on touch than a canvas would.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { el, clear } from './dom.js';
import { sampleMeta } from '../audio/samples.js';
import { openNoteSheet } from './notesheet.js';

const CELL_W = 34;
const LABEL_W = 104;

export function createDrumGrid(container, { getTrack, onEdit }) {
  // The host element outlives this editor, so every listener is tied to an
  // AbortController — otherwise handlers stack up each time the track type
  // changes and cancel each other out.
  const life = new AbortController();
  const on = (type, fn, opts) => container.addEventListener(type, fn, { ...opts, signal: life.signal });

  const inner = el('div', { class: 'dgrid-inner' });
  const playhead = el('div', { class: 'dplay', style: { display: 'none' } });
  container.classList.add('dgrid');
  clear(container).append(inner, playhead);

  let paint = null;        // in-progress paint stroke

  function build() {
    const track = getTrack();
    clear(inner);
    if (!track || track.type !== 'drum') return;

    const total = S.totalSteps();
    const notes = S.notesOf(track);

    // --- header ---------------------------------------------------------
    const head = el('div', { class: 'dhead' }, el('div', { class: 'corner' }));
    const hcells = el('div', { class: 'dcells' });
    for (let s = 0; s < total; s++) {
      const bar = s % S.STEPS_PER_BAR === 0;
      hcells.append(el('div', { class: `hcell${bar ? ' bar' : ''}` },
        bar ? String(s / S.STEPS_PER_BAR + 1) : (s % S.STEPS_PER_BEAT === 0 ? '·' : '')));
    }
    head.append(hcells);
    inner.append(head);

    // --- rows -----------------------------------------------------------
    track.pads.forEach((pad, i) => {
      const meta = pad.sampleId ? sampleMeta(pad.sampleId) : null;
      // A div rather than a button: a stretched flex <button> collapses its
      // children to zero height in Chrome.
      const label = el('div', {
        role: 'button', tabindex: '0',
        class: `dpad${meta ? '' : ' nosample'}`,
        style: { '--c': track.color },
        onpointerdown: () => {
          engine.preview(track, i, `pad${i}`);
          label.classList.add('hit');
          setTimeout(() => label.classList.remove('hit'), 110);
        },
      },
        el('span', { class: 'pn' }, pad.name || `Pad ${i + 1}`),
        el('span', { class: 'ps' }, meta ? meta.name : 'built-in'),
      );

      const cells = el('div', { class: 'dcells' });
      for (let s = 0; s < total; s++) {
        const hit = notes.find((n) => n.pitch === i && n.t === s);
        const cls = ['dcell'];
        if (hit) cls.push('on');
        if ((s + 1) % S.STEPS_PER_BAR === 0) cls.push('barend');
        else if ((s + 1) % S.STEPS_PER_BEAT === 0) cls.push('beat');
        const cell = el('div', {
          class: cls.join(' '),
          style: { '--c': track.color },
          dataset: { pad: String(i), step: String(s) },
        }, el('i', hit ? { style: { opacity: String(0.35 + 0.65 * (hit.vel ?? 0.9)) } } : {}));
        cells.append(cell);
      }
      inner.append(el('div', { class: 'drow' }, label, cells));
    });

    inner.style.width = `${LABEL_W + total * CELL_W}px`;
  }

  /* ------------------------------------------------------------ input */

  function cellFromPoint(x, y) {
    const node = document.elementFromPoint(x, y);
    return node ? node.closest('.dcell') : null;
  }

  function toggle(cell, add) {
    const track = getTrack();
    if (!track) return;
    const pad = +cell.dataset.pad;
    const step = +cell.dataset.step;
    const existing = S.notesOf(track).find((n) => n.pitch === pad && n.t === step);
    if (add && !existing) {
      S.addNote(track, { pitch: pad, t: step, len: 1, vel: 0.9 });
      cell.classList.add('on');
      engine.preview(track, pad, `pad${pad}`);
    } else if (!add && existing) {
      S.removeNote(track, existing.id);
      cell.classList.remove('on');
    }
  }

  on('contextmenu', (e) => { if (e.target.closest('.dcell')) e.preventDefault(); });

  on('pointerdown', (e) => {
    const cell = e.target.closest('.dcell');
    if (!cell) return;
    e.preventDefault();
    S.checkpoint();
    // Right button always erases; that is what a mouse user expects.
    const erase = e.button === 2 || e.buttons === 2;
    paint = { add: erase ? false : !cell.classList.contains('on'), x: e.clientX, y: e.clientY };
    toggle(cell, paint.add);
    try { container.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }

    // Holding a filled cell opens the note editor instead of painting.
    if (erase) return;
    paint.hold = setTimeout(() => {
      const track = getTrack();
      const note = track && S.notesOf(track).find((n) => n.pitch === +cell.dataset.pad && n.t === +cell.dataset.step);
      if (!note) return;
      paint = null;
      openNoteSheet(track, note, { onChange: () => { build(); onEdit && onEdit(); } });
    }, 500);
  });

  on('pointermove', (e) => {
    if (!paint) return;
    if (paint.hold && Math.hypot(e.clientX - paint.x, e.clientY - paint.y) > 8) {
      clearTimeout(paint.hold);
      paint.hold = null;
    }
    const cell = cellFromPoint(e.clientX, e.clientY);
    if (cell) toggle(cell, paint.add);
  });

  const end = (e) => {
    if (!paint) return;
    clearTimeout(paint.hold);
    paint = null;
    try { container.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    onEdit && onEdit();
  };
  on('pointerup', end);
  on('pointercancel', end);

  /* ---------------------------------------------------------- exports */

  return {
    rebuild: build,
    render: build,
    followPlayhead() {
      if (!S.state.playing) { playhead.style.display = 'none'; return; }
      const step = engine.playheadSteps();
      playhead.style.display = 'block';
      playhead.style.transform = `translateX(${LABEL_W + step * CELL_W}px)`;
      playhead.style.height = `${inner.offsetHeight}px`;
      // Keep the moving playhead on screen without fighting manual scrolling.
      const x = LABEL_W + step * CELL_W;
      const left = container.scrollLeft;
      const right = left + container.clientWidth;
      if (x > right - 40 || x < left + LABEL_W) {
        container.scrollLeft = Math.max(0, x - container.clientWidth * 0.4);
      }
    },
    destroy() { life.abort(); clear(container); },
  };
}
