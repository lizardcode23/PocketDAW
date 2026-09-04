// The pitch editor: a clip's audio cut into notes you can pick up and move.
//
// The canvas is a piano roll over a recording. Each detected note is a blob
// sitting on the semitone it was sung at; drag it up or down to retune it,
// left or right to move it in time, and the take is rebuilt around the
// arrangement when you apply. Nothing is written until then, and the original
// sample stays behind `sourceSampleId`, so "revert" on the clip sheet is free.
//
// Gestures follow the piano roll rather than the playlist: `touch-action` is
// none and one finger edits, because dragging a blob and scrolling the page
// cannot both own a vertical swipe.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { getContext } from '../audio/context.js';
import { getBuffer, importBuffer, sampleMeta } from '../audio/samples.js';
import { encodeWav } from '../audio/export.js';
import { cropBuffer } from '../audio/edit.js';
import {
  analyseNotes, renderPitchEdits, splitNote, mergeNote,
  targetMidi, isEdited, anyEdits, describeEdits,
} from '../audio/pitchedit.js';
import { detectPitch } from '../audio/autotune.js';
import { noteLabel, snapToScale, inScale, NOTE_NAMES, SCALES } from '../theory.js';
import { el, clear, sheet, slider, icon, ICONS, toast } from './dom.js';
import { peaks, fmtTime } from './waveform.js';

const GUTTER = 34;        // px of note names down the left edge
const MIN_ROW = 13;       // px per semitone — a 44 px target needs the blob wide
const HIT_PAD = 6;

export function openPitchEditor(clip, { onChange } = {}) {
  if (clip.kind !== 'audio') { toast('Pitch editing is for audio clips', 'err'); return; }

  const scale = S.project().scale;
  const sourceId = clip.sourceSampleId || clip.sampleId;
  const name = sampleMeta(sourceId)?.name || 'Audio clip';

  sheet(`Pitch · ${name}`, (body, close) => {
    const ctx = getContext();
    const canvas = el('canvas', { class: 'pitch-edit' });
    const status = el('p', { class: 'hint' }, 'Analysing the take…');
    const controls = el('div');

    let buffer = null;        // the untouched source
    let track = null;         // frame-by-frame pitch
    let notes = [];           // the arrangement
    let selectedId = null;
    let cursor = null;        // seconds, where Split cuts
    let rendered = null;      // cached preview of the current arrangement
    let view = { from: 0, to: 1 };
    let range = { lo: 55, hi: 72 };
    let snapScale = true;

    const selected = () => notes.find((n) => n.id === selectedId) || null;
    const dirty = () => { rendered = null; paint(); buildControls(); };

    /* -------------------------------------------------------- geometry */

    const plotW = () => Math.max(40, canvas.getBoundingClientRect().width - GUTTER);
    const xOf = (t) => GUTTER + ((t - view.from) / Math.max(0.001, view.to - view.from)) * plotW();
    const timeOf = (x) => view.from + ((x - GUTTER) / plotW()) * (view.to - view.from);
    const rows = () => Math.max(1, range.hi - range.lo + 1);
    const rowH = () => Math.max(MIN_ROW, canvasHeight() / rows());
    const canvasHeight = () => canvas.getBoundingClientRect().height || 240;
    const yOf = (midi) => canvasHeight() - ((midi - range.lo + 0.5) / rows()) * canvasHeight();
    const midiOf = (y) => range.lo - 0.5 + ((canvasHeight() - y) / canvasHeight()) * rows();

    function fitRange() {
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of notes) {
        lo = Math.min(lo, n.midi, targetMidi(n));
        hi = Math.max(hi, n.midi, targetMidi(n));
      }
      if (!Number.isFinite(lo)) { lo = 57; hi = 69; }
      range = { lo: Math.floor(lo) - 2, hi: Math.ceil(hi) + 2 };
      if (range.hi - range.lo < 7) range.hi = range.lo + 7;
    }

    /* ----------------------------------------------------------- paint */

    function paint() {
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || 320;
      const h = Math.max(180, rows() * MIN_ROW);
      canvas.style.height = `${h}px`;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#0a0c11';
      g.fillRect(0, 0, w, h);
      if (!buffer) return;

      // --- rows -------------------------------------------------------
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'middle';
      for (let m = range.lo; m <= range.hi; m++) {
        const y = yOf(m);
        const top = y - rowH() / 2;
        const on = inScale(m, scale.root, scale.type);
        g.fillStyle = on ? 'rgba(110,231,255,.06)' : 'rgba(255,255,255,.015)';
        g.fillRect(GUTTER, top, w - GUTTER, rowH());
        g.strokeStyle = 'rgba(255,255,255,.05)';
        g.beginPath();
        g.moveTo(GUTTER, Math.round(top) + 0.5);
        g.lineTo(w, Math.round(top) + 0.5);
        g.stroke();
        if (rowH() >= 12) {
          g.fillStyle = on ? '#8ea1b8' : '#4a5468';
          g.fillText(noteLabel(m), 4, y);
        }
      }

      // --- waveform, faint, behind everything -------------------------
      const p = peaks(buffer, Math.max(200, Math.round(plotW() * 2)));
      g.fillStyle = 'rgba(255,255,255,.07)';
      for (let x = GUTTER; x < w; x++) {
        const t0 = timeOf(x);
        const b = Math.floor((t0 / buffer.duration) * p.buckets);
        if (b < 0 || b >= p.buckets) continue;
        const amp = Math.max(Math.abs(p.min[b]), Math.abs(p.max[b]));
        const half = (amp * h) / 2;
        g.fillRect(x, h / 2 - half, 1, Math.max(1, half * 2));
      }

      // --- the sung pitch ---------------------------------------------
      g.strokeStyle = '#586074';
      g.lineWidth = 1.5;
      g.beginPath();
      let drawing = false;
      for (let i = 0; i < track.frames; i++) {
        const t = i * track.hopSeconds;
        if (t < view.from || t > view.to) { drawing = false; continue; }
        if (!track.f0[i]) { drawing = false; continue; }
        const m = 69 + 12 * Math.log2(track.f0[i] / 440);
        const x = xOf(t);
        const y = yOf(m);
        if (!drawing) { g.moveTo(x, y); drawing = true; } else g.lineTo(x, y);
      }
      g.stroke();

      // --- the notes ---------------------------------------------------
      for (const n of notes) {
        if (n.to < view.from || n.from > view.to) continue;
        const x0 = xOf(n.from + (n.shift || 0));
        const x1 = xOf(n.to + (n.shift || 0));
        const y = yOf(targetMidi(n));
        const bh = Math.max(8, rowH() - 4);
        const sel = n.id === selectedId;
        const edited = isEdited(n);

        // Where it came from, when it has been moved.
        if (edited && !n.mute) {
          g.strokeStyle = 'rgba(255,255,255,.18)';
          g.setLineDash([3, 3]);
          g.lineWidth = 1;
          g.strokeRect(xOf(n.from), yOf(n.midi) - bh / 2, Math.max(2, xOf(n.to) - xOf(n.from)), bh);
          g.setLineDash([]);
        }

        g.fillStyle = n.mute ? 'rgba(107,116,136,.35)'
          : edited ? 'rgba(167,139,250,.85)' : 'rgba(110,231,255,.72)';
        roundRect(g, x0, y - bh / 2, Math.max(3, x1 - x0), bh, Math.min(5, bh / 2));
        g.fill();
        if (sel) {
          g.strokeStyle = '#fbbf24';
          g.lineWidth = 2;
          roundRect(g, x0, y - bh / 2, Math.max(3, x1 - x0), bh, Math.min(5, bh / 2));
          g.stroke();
        }
        if (x1 - x0 > 26 && bh >= 12) {
          g.fillStyle = '#05121a';
          g.font = '10px system-ui, sans-serif';
          g.fillText(noteLabel(Math.round(targetMidi(n))), x0 + 4, y);
        }
      }

      if (cursor != null && cursor >= view.from && cursor <= view.to) {
        g.strokeStyle = '#fbbf24';
        g.lineWidth = 1.5;
        const x = Math.round(xOf(cursor)) + 0.5;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
      }
    }

    function roundRect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    /* -------------------------------------------------------- gestures */

    let drag = null;
    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const noteAt = (x, y) => {
      const t = timeOf(x);
      const m = midiOf(y);
      let best = null;
      for (const n of notes) {
        const from = n.from + (n.shift || 0);
        const to = n.to + (n.shift || 0);
        const dt = t < from ? from - t : t > to ? t - to : 0;
        const dm = Math.abs(targetMidi(n) - m);
        if (dt * plotW() / Math.max(0.001, view.to - view.from) > HIT_PAD) continue;
        if (dm > 0.8) continue;
        if (!best || dm < best.dm) best = { note: n, dm };
      }
      return best ? best.note : null;
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!buffer) return;
      e.preventDefault();
      const { x, y } = local(e);
      const hit = noteAt(x, y);
      if (!hit) {
        cursor = Math.max(view.from, Math.min(view.to, timeOf(x)));
        selectedId = null;
        paint();
        buildControls();
        return;
      }
      selectedId = hit.id;
      drag = {
        note: hit,
        startX: e.clientX, startY: e.clientY,
        baseSemis: hit.semitones || 0,
        baseShift: hit.shift || 0,
        baseMidi: targetMidi(hit),
        moved: false,
      };
      canvas.setPointerCapture(e.pointerId);
      paint();
      buildControls();
    }, { passive: false });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;

      const n = drag.note;
      // Vertical is pitch. Snapping to the project scale is what makes a
      // dragged note land somewhere musical instead of somewhere near it.
      const wantMidi = drag.baseMidi - (dy / canvasHeight()) * rows();
      let landed = Math.round(wantMidi);
      if (snapScale) landed = snapToScale(landed, scale.root, scale.type);
      n.semitones = Math.max(-24, Math.min(24, landed - Math.round(n.midi)));
      n.cents = 0;

      // Horizontal is time, in whole 16ths of the project's grid.
      const perStep = S.secondsPerStep();
      const secs = (dx / plotW()) * (view.to - view.from);
      n.shift = Math.round((drag.baseShift + secs) / (perStep / 4)) * (perStep / 4);

      rendered = null;
      paint();
    });

    const endDrag = (e) => {
      if (!drag) return;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      const was = drag;
      drag = null;
      if (was.moved) { fitRange(); dirty(); }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    /* -------------------------------------------------------- playback */

    function renderNow() {
      if (rendered) return rendered;
      rendered = renderPitchEdits(ctx, buffer, { track, notes });
      return rendered;
    }

    function play(edited) {
      const src = edited ? renderNow() : buffer;
      const from = view.from;
      const to = Math.min(src.duration, view.to);
      engine.auditionBuffer(
        to - from < src.duration - 0.01 ? cropBuffer(ctx, src, from, to) : src,
        clip.gain ?? 1,
      );
    }

    /* -------------------------------------------------------- controls */

    function buildControls() {
      clear(controls);
      const n = selected();

      status.textContent = notes.length
        ? `${notes.length} note${notes.length === 1 ? '' : 's'} · ${describeEdits(notes)}`
        : 'No pitched notes found here — this clip may be percussive or silent.';

      const snapBtn = el('button', {
        class: `btn${snapScale ? ' primary' : ''}`,
        onclick: (e) => {
          snapScale = !snapScale;
          e.currentTarget.classList.toggle('primary', snapScale);
          e.currentTarget.lastChild.textContent = snapScale ? 'Snap to scale' : 'Free pitch';
        },
      }, icon(ICONS.lock, 18), snapScale ? 'Snap to scale' : 'Free pitch');

      controls.append(el('div', { class: 'card' },
        el('h3', {}, 'Arrangement', el('span', { class: 'r' },
          `${NOTE_NAMES[scale.root]} ${SCALES[scale.type]?.name || ''}`)),
        el('div', { class: 'btnrow' },
          snapBtn,
          el('button', {
            class: 'btn',
            onclick: () => {
              for (const note of notes) {
                const want = snapToScale(Math.round(note.midi), scale.root, scale.type);
                note.semitones = want - Math.round(note.midi);
                note.cents = 0;
                note.flatten = Math.max(note.flatten || 0, 0.8);
              }
              fitRange();
              dirty();
              toast('Every note pulled onto the scale', 'ok');
            },
          }, icon(ICONS.wand, 18), 'Tune all'),
          el('button', {
            class: 'btn',
            onclick: () => {
              for (const note of notes) {
                note.semitones = 0; note.cents = 0; note.shift = 0;
                note.flatten = 0; note.mute = false;
              }
              fitRange();
              dirty();
            },
          }, 'Reset all'),
        ),
      ));

      if (!n) {
        controls.append(el('p', { class: 'hint' },
          'Tap a note to select it, then drag it up or down to retune it and left or right to move it in time. Tapping the background drops the cursor that Split cuts at.'));
        return;
      }

      const info = el('span', { class: 'r' },
        `${fmtTime(n.to - n.from)} · heard ${noteLabel(Math.round(n.midi))}`);

      const nudge = (semis) => {
        n.semitones = Math.max(-24, Math.min(24, (n.semitones || 0) + semis));
        fitRange();
        dirty();
      };
      const move = (steps) => {
        n.shift = (n.shift || 0) + steps * S.secondsPerStep();
        dirty();
      };

      controls.append(el('div', { class: 'card' },
        el('h3', {}, `Note · ${noteLabel(Math.round(targetMidi(n)))}`, info),
        el('div', { class: 'btnrow' },
          el('button', { class: 'btn', onclick: () => nudge(-12) }, '− oct'),
          el('button', { class: 'btn', onclick: () => nudge(-1) }, '− semi'),
          el('button', { class: 'btn', onclick: () => nudge(1) }, '+ semi'),
          el('button', { class: 'btn', onclick: () => nudge(12) }, '+ oct'),
        ),
        slider('Fine', {
          min: -50, max: 50, step: 1, value: n.cents || 0,
          format: (v) => `${v > 0 ? '+' : ''}${v} cents`,
          oninput: (v) => { n.cents = v; rendered = null; paint(); },
        }),
        slider('Straighten', {
          min: 0, max: 1, step: 0.01, value: n.flatten || 0,
          format: (v) => (v < 0.01 ? 'keep the wobble' : `${Math.round(v * 100)}%`),
          oninput: (v) => { n.flatten = v; rendered = null; },
        }),
        el('div', { class: 'btnrow' },
          el('button', { class: 'btn', onclick: () => move(-1) }, '← 1/16'),
          el('button', { class: 'btn', onclick: () => move(1) }, '1/16 →'),
          el('button', {
            class: `btn${n.mute ? ' primary' : ''}`,
            onclick: () => { n.mute = !n.mute; dirty(); },
          }, n.mute ? 'Silenced' : 'Silence'),
        ),
        el('div', { class: 'btnrow' },
          el('button', {
            class: 'btn',
            onclick: () => {
              if (cursor == null || cursor <= n.from || cursor >= n.to) {
                toast('Tap inside the note first — that is where it splits', 'err');
                return;
              }
              const next = splitNote(notes, n.id, cursor);
              if (next === notes) { toast('Both halves would be too short', 'err'); return; }
              notes = next;
              dirty();
            },
          }, icon(ICONS.cut, 18), 'Split at cursor'),
          el('button', {
            class: 'btn',
            onclick: () => {
              const next = mergeNote(notes, n.id);
              if (next === notes) { toast('Nothing to join it with', 'err'); return; }
              notes = next;
              selectedId = null;
              dirty();
            },
          }, 'Join next'),
          el('button', {
            class: 'btn',
            onclick: () => {
              n.semitones = 0; n.cents = 0; n.shift = 0; n.flatten = 0; n.mute = false;
              fitRange();
              dirty();
            },
          }, 'Reset'),
        ),
      ));
    }

    /* ----------------------------------------------------------- build */

    body.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Notes', el('span', { class: 'r' }, name)),
        canvas,
        status,
      ),
      controls,
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', onclick: () => play(false) }, icon(ICONS.play, 18), 'Original'),
        el('button', { class: 'btn', onclick: () => play(true) }, icon(ICONS.play, 18), 'Edited'),
      ),
      el('button', {
        class: 'btn primary wide', style: { marginTop: '10px' },
        onclick: async () => {
          if (!buffer) { toast('Still analysing', 'err'); return; }
          if (!anyEdits(notes)) { toast('Nothing has been moved yet'); return; }
          const out = renderNow();
          const base = sampleMeta(sourceId)?.name || 'Take';
          const meta = await importBuffer(out, `${base} (pitched)`, { encodeWav });
          S.checkpoint();
          clip.sourceSampleId = sourceId;
          clip.sampleId = meta.id;
          // Keep the arrangement on the clip so reopening the editor picks up
          // where this left off rather than re-analysing from scratch.
          clip.pitchEdits = { notes: notes.map((x) => ({ ...x })) };
          S.touch();
          S.emit('samples');
          close();
          toast('Pitch arrangement applied', 'ok');
          onChange && onChange();
        },
      }, icon(ICONS.check, 18), 'Apply to clip'),
      el('p', { class: 'hint' },
        'The edited take is saved as a new sample, so the original recording stays one tap away on the clip sheet.'),
    );

    /* --------------------------------------------------------- analyse */

    (async () => {
      buffer = await getBuffer(sourceId);
      if (!buffer) { status.textContent = 'That clip has no audio.'; return; }
      const from = clip.offset || 0;
      const to = Math.min(buffer.duration, from + S.clipSourceSeconds(clip));
      view = { from, to: Math.max(from + 0.05, to) };
      await new Promise((r) => setTimeout(r, 30));

      if (clip.pitchEdits && clip.pitchEdits.notes?.length) {
        // The stored arrangement is the truth about where notes are; the
        // fresh analysis is only needed for the periods the render uses.
        track = detectPitch(buffer);
        notes = clip.pitchEdits.notes.map((n) => ({ ...n }));
      } else {
        const found = analyseNotes(buffer, view);
        track = found.track;
        notes = found.notes;
      }
      fitRange();
      paint();
      buildControls();
    })();
  });
}
