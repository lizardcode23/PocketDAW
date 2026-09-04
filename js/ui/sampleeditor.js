// The sample editor: a waveform, a selection, and destructive edits.
//
// Nothing touches the library until "Save". Every operation pushes the
// previous buffer onto an undo stack, so experimenting is free and the
// original is one tap away right up to the moment it is written.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import * as lib from '../audio/samples.js';
import { getContext } from '../audio/context.js';
import { encodeWav } from '../audio/export.js';
import { detectRootNote } from '../audio/autotune.js';
import {
  cropBuffer, cutRange, silenceRange, fadeRange, normalizeBuffer,
  reverseBuffer, trimEnds, transposeBuffer, peakOf,
} from '../audio/edit.js';
import { noteLabel } from '../theory.js';
import { el, clear, sheet, icon, ICONS, toast, confirmSheet, fmtSize } from './dom.js';
import { drawWave, fmtTime } from './waveform.js';

const EDGE_GRAB = 14;      // px either side of a selection edge that drags it

/**
 * Open the editor for a library sample.
 * `onSaved(meta)` fires after the audio or the key is written.
 */
export function openSampleEditor(sampleId, { onSaved, title } = {}) {
  const meta = lib.sampleMeta(sampleId);
  if (!meta) { toast('That sample is not in the library', 'err'); return; }

  sheet(title || `Edit · ${meta.name}`, (body, close) => {
    const ctx = getContext();
    const canvas = el('canvas', { class: 'wave-edit' });
    const readout = el('p', { class: 'hint', style: { margin: '6px 2px 0' } }, 'Loading…');
    const tools = el('div');
    const keyHost = el('div');

    let buffer = null;          // current, possibly edited
    let original = null;
    let undoStack = [];
    let redoStack = [];
    let sel = null;             // { from, to } in seconds
    let view = null;            // visible window in seconds
    let rootNote = meta.rootNote ?? null;
    let rootSource = meta.rootSource || null;
    let playing = null;         // { startedAt, from, to }
    let raf = 0;

    const selection = () => (sel && sel.to - sel.from > 0.0005 ? sel : null);
    const range = () => selection() || { from: 0, to: buffer.duration };

    /* ------------------------------------------------------------ paint */

    function paint() {
      if (!buffer) return;
      const marks = [];
      if (playing) {
        const t = playing.from + (ctx.currentTime - playing.startedAt);
        if (t <= playing.to) marks.push({ at: t, colour: '#fbbf24', width: 2 });
      }
      drawWave(canvas, buffer, { view, selection: sel, marks, colour: '#6ee7ff' });
      const s = selection();
      readout.textContent = s
        ? `Selection ${fmtTime(s.from)} → ${fmtTime(s.to)} · ${fmtTime(s.to - s.from)} of ${fmtTime(buffer.duration)}`
        : `${fmtTime(buffer.duration)} · ${buffer.numberOfChannels === 2 ? 'stereo' : 'mono'} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · peak ${(peakOf(buffer) * 100).toFixed(0)}%`;
    }

    function loop() {
      if (playing && ctx.currentTime > playing.startedAt + (playing.to - playing.from)) {
        playing = null;
      }
      paint();
      raf = playing ? requestAnimationFrame(loop) : 0;
    }

    /* ------------------------------------------------------------- edits */

    function commit(next, label) {
      if (!next || next === buffer) return;
      undoStack.push(buffer);
      if (undoStack.length > 24) undoStack.shift();
      redoStack = [];
      buffer = next;
      if (view && view.to > buffer.duration) view = null;
      if (sel) sel = { from: Math.min(sel.from, buffer.duration), to: Math.min(sel.to, buffer.duration) };
      buildTools();
      paint();
      if (label) toast(label);
    }

    const needSel = () => {
      if (selection()) return true;
      toast('Drag across the waveform to select a part first');
      return false;
    };

    /* ---------------------------------------------------------- playback */

    function play(from, to) {
      stopPlay();
      const slice = (from > 0 || to < buffer.duration)
        ? cropBuffer(ctx, buffer, from, to)
        : buffer;
      engine.auditionBuffer(slice, 1);
      playing = { startedAt: ctx.currentTime + 0.01, from, to };
      if (!raf) raf = requestAnimationFrame(loop);
    }

    function stopPlay() {
      engine.stopAudition();
      engine.stopPreview('audition');
      playing = null;
    }

    /* ---------------------------------------------------------- gestures */

    let drag = null;
    const localX = (e) => e.clientX - canvas.getBoundingClientRect().left;
    const timeAt = (x) => {
      const from = view ? view.from : 0;
      const to = view ? view.to : buffer.duration;
      const w = canvas.getBoundingClientRect().width || 1;
      return Math.max(0, Math.min(buffer.duration, from + (x / w) * (to - from)));
    };
    const xAt = (t) => {
      const from = view ? view.from : 0;
      const to = view ? view.to : buffer.duration;
      const w = canvas.getBoundingClientRect().width || 1;
      return ((t - from) / Math.max(0.0005, to - from)) * w;
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!buffer) return;
      e.preventDefault();
      const x = localX(e);
      const t = timeAt(x);
      if (sel && Math.abs(x - xAt(sel.from)) < EDGE_GRAB) drag = { edge: 'from' };
      else if (sel && Math.abs(x - xAt(sel.to)) < EDGE_GRAB) drag = { edge: 'to' };
      else { drag = { edge: 'to', anchor: t }; sel = { from: t, to: t }; }
      canvas.setPointerCapture(e.pointerId);
      paint();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag || !buffer) return;
      const t = timeAt(localX(e));
      if (drag.anchor != null) sel = { from: Math.min(drag.anchor, t), to: Math.max(drag.anchor, t) };
      else if (drag.edge === 'from') sel = { from: Math.min(t, sel.to), to: sel.to };
      else sel = { from: sel.from, to: Math.max(t, sel.from) };
      paint();
    });

    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      // A tap, not a drag, means "clear the selection".
      if (sel && sel.to - sel.from < 0.004) sel = null;
      buildTools();
      paint();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    /* -------------------------------------------------------------- key */

    function buildKey() {
      clear(keyHost);
      const known = rootNote != null;
      keyHost.append(
        el('div', { class: 'row' },
          el('span', { class: 'lbl' }, 'Plays as'),
          el('div', { style: { flex: '1', fontSize: '13px', fontWeight: '600' } },
            known ? `${noteLabel(rootNote)}${rootSource ? ` · ${rootSource}` : ''}` : 'not set — treated as C4'),
        ),
        el('div', { class: 'btnrow' },
          el('button', {
            class: 'btn step', 'aria-label': 'Down a semitone',
            onclick: () => { rootNote = Math.max(0, (rootNote ?? 60) - 1); rootSource = 'manual'; buildKey(); },
          }, '−'),
          el('button', {
            class: 'btn step', 'aria-label': 'Up a semitone',
            onclick: () => { rootNote = Math.min(127, (rootNote ?? 60) + 1); rootSource = 'manual'; buildKey(); },
          }, '+'),
          el('button', {
            class: 'btn',
            onclick: () => {
              const found = detectRootNote(buffer);
              if (!found) { toast('No steady pitch found in this sample', 'err'); return; }
              rootNote = found.midi;
              rootSource = 'detected';
              buildKey();
              toast(`Detected ${noteLabel(found.midi)}${found.cents ? ` ${found.cents > 0 ? '+' : ''}${found.cents}¢` : ''}`, 'ok');
            },
          }, icon(ICONS.tune, 18), 'Detect'),
          el('button', {
            class: 'btn',
            onclick: () => { if (rootNote != null) engine.auditionBuffer(buffer, 1); },
          }, icon(ICONS.play, 18), 'Hear'),
        ),
        el('p', { class: 'hint' },
          'A sampler track transposes from this note, so a G5 one-shot sounds at G5 when you play G5 instead of being stretched from middle C.'),
      );
    }

    /* ------------------------------------------------------------ tools */

    function buildTools() {
      clear(tools);
      const hasSel = !!selection();

      const op = (label, iconPath, fn, { danger = false, disabled = false } = {}) => el('button', {
        class: `btn${danger ? ' danger' : ''}`, disabled,
        onclick: fn,
      }, iconPath ? icon(iconPath, 18) : null, label);

      tools.append(
        el('div', { class: 'card' },
          el('h3', {}, 'Selection', el('span', { class: 'r' }, hasSel ? fmtTime(selection().to - selection().from) : 'whole sample')),
          el('div', { class: 'btnrow wrap' },
            op('Play', ICONS.play, () => { const r = range(); play(r.from, r.to); }),
            op('Stop', ICONS.stop, stopPlay),
            op('Select all', null, () => { sel = { from: 0, to: buffer.duration }; buildTools(); paint(); }),
            op('Clear', null, () => { sel = null; buildTools(); paint(); }, { disabled: !hasSel }),
          ),
          el('div', { class: 'btnrow wrap', style: { marginTop: '8px' } },
            op('Zoom to selection', ICONS.plus, () => {
              if (!needSel()) return;
              view = { ...selection() };
              paint();
            }, { disabled: !hasSel }),
            op('Zoom out', ICONS.minus, () => { view = null; paint(); }),
          ),
        ),
        el('div', { class: 'card' },
          el('h3', {}, 'Cut'),
          el('div', { class: 'btnrow wrap' },
            op('Trim to selection', null, () => {
              if (!needSel()) return;
              const r = selection();
              // Clear the selection first: commit() repaints, and painting a
              // selection that belongs to the old buffer marks the wrong region.
              sel = null;
              view = null;
              commit(cropBuffer(ctx, buffer, r.from, r.to), 'Trimmed');
            }, { disabled: !hasSel }),
            op('Cut out', ICONS.eraser, () => {
              if (!needSel()) return;
              const r = selection();
              sel = null;
              view = null;
              commit(cutRange(ctx, buffer, r.from, r.to), 'Cut');
            }, { disabled: !hasSel }),
            op('Silence', null, () => {
              if (!needSel()) return;
              const r = selection();
              commit(silenceRange(ctx, buffer, r.from, r.to), 'Silenced');
            }, { disabled: !hasSel }),
            op('Trim silence', null, () => {
              const { buffer: trimmed } = trimEnds(ctx, buffer);
              if (trimmed === buffer) { toast('Nothing quiet at the ends'); return; }
              sel = null;
              view = null;
              commit(trimmed, 'Ends trimmed');
            }),
          ),
        ),
        el('div', { class: 'card' },
          el('h3', {}, 'Shape'),
          el('div', { class: 'btnrow wrap' },
            op('Fade in', null, () => {
              const r = range();
              commit(fadeRange(ctx, buffer, r.from, r.to, 'in'), 'Faded in');
            }),
            op('Fade out', null, () => {
              const r = range();
              commit(fadeRange(ctx, buffer, r.from, r.to, 'out'), 'Faded out');
            }),
            op('Normalise', null, () => commit(normalizeBuffer(ctx, buffer, 0.98), 'Normalised')),
            op('Reverse', null, () => commit(reverseBuffer(ctx, buffer), 'Reversed')),
          ),
          el('div', { class: 'btnrow wrap', style: { marginTop: '8px' } },
            op('Down a semitone', null, () => {
              commit(transposeBuffer(ctx, buffer, -1), 'Transposed down');
              if (rootNote != null) rootNote -= 1;
              buildKey();
            }),
            op('Up a semitone', null, () => {
              commit(transposeBuffer(ctx, buffer, 1), 'Transposed up');
              if (rootNote != null) rootNote += 1;
              buildKey();
            }),
          ),
          el('p', { class: 'hint' },
            'Transposing resamples, so the sample gets shorter as it goes up — the tape-speed sound. It is the honest way to move a one-shot into another key.'),
        ),
        el('div', { class: 'card' },
          el('h3', {}, 'Key'),
          keyHost,
        ),
        el('div', { class: 'btnrow' },
          op('Undo', null, () => {
            if (!undoStack.length) { toast('Nothing to undo'); return; }
            redoStack.push(buffer);
            buffer = undoStack.pop();
            view = null;
            buildTools();
            paint();
          }, { disabled: !undoStack.length }),
          op('Redo', null, () => {
            if (!redoStack.length) return;
            undoStack.push(buffer);
            buffer = redoStack.pop();
            buildTools();
            paint();
          }, { disabled: !redoStack.length }),
          op('Revert', null, () => {
            if (buffer === original) return;
            undoStack.push(buffer);
            buffer = original;
            view = null;
            sel = null;
            buildTools();
            paint();
          }, { disabled: false }),
        ),
      );
      buildKey();
    }

    /* ------------------------------------------------------------- save */

    const saveRow = el('div', { class: 'btnrow', style: { marginTop: '12px' } },
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          stopPlay();
          const changed = buffer !== original;
          try {
            if (changed) {
              if (usedElsewhere(sampleId) && !await confirmSheet(
                'Overwrite the sample?',
                `${usedElsewhere(sampleId)} — they will all play the edited version. "Save as copy" keeps the original untouched.`,
                'Overwrite')) return;
              await lib.replaceBuffer(sampleId, buffer, { encodeWav });
            }
            if (rootNote !== (meta.rootNote ?? null)) {
              await lib.setSampleRoot(sampleId, rootNote, rootSource || 'manual');
            }
          } catch (e) {
            toast(e.message || 'Could not save the sample', 'err');
            return;
          }
          S.emit('samples');
          close();
          toast(changed ? 'Sample saved' : 'Key saved', 'ok');
          onSaved && onSaved(lib.sampleMeta(sampleId));
        },
      }, icon(ICONS.save, 18), 'Save'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          stopPlay();
          try {
            const copy = await lib.importBuffer(buffer, `${meta.name} edit`, { encodeWav, rootNote });
            S.emit('samples');
            close();
            toast(`Saved as “${copy.name}”`, 'ok');
            onSaved && onSaved(copy);
          } catch (e) {
            toast(e.message || 'Could not save the copy', 'err');
          }
        },
      }, icon(ICONS.copy, 18), 'Save as copy'),
    );

    body.append(
      el('div', { class: 'card' },
        el('h3', {}, meta.name, el('span', { class: 'r' }, fmtSize(meta.size))),
        canvas,
        readout,
      ),
      tools,
      saveRow,
      el('p', { class: 'hint' },
        'Edits are written to this device when you save. Clips already placed on the playlist keep their length in bars — shorten a sample and the clip simply runs out early.'),
    );

    (async () => {
      buffer = await lib.getBuffer(sampleId);
      if (!buffer) { readout.textContent = 'That sample could not be decoded.'; return; }
      original = buffer;
      buildTools();
      // The sheet animates in; measuring the canvas before that gives 0 width.
      requestAnimationFrame(() => requestAnimationFrame(paint));
    })();
  });
}

/** Which project slots would be affected by overwriting a sample. */
function usedElsewhere(id) {
  const names = [];
  for (const t of S.project().tracks) {
    if (t.sampleId === id) names.push(t.name);
    for (const pad of t.pads || []) if (pad.sampleId === id) names.push(`${t.name} · ${pad.name}`);
  }
  const clips = S.project().clips.filter((c) => c.sampleId === id || c.sourceSampleId === id).length;
  if (clips) names.push(`${clips} playlist clip${clips === 1 ? '' : 's'}`);
  return names.length ? `Used by ${names.join(', ')}` : '';
}
