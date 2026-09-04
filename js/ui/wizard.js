// Melody wizard: configure a melody against the project scale, preview its
// shape and sound, then write it to the selected track.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { NOTE_NAMES, SCALES, noteLabel, snapToScale } from '../theory.js';
import {
  generateMelody, describePlan, DENSITIES, CONTOURS, STRUCTURES, RHYTHMS, SUSTAINS,
} from '../harmony.js';
import { el, sheet, slider, icon, ICONS, toast } from './dom.js';

const OPT_KEY = 'pdaw.wizard';

function loadOptions() {
  const base = {
    bars: 4, density: 'medium', contour: 'arch', structure: 'AABA',
    octaves: 1, adventurous: 0.35, resolve: true, replace: false,
    rhythm: 'straight', sustain: 'legato', rest: 0, repeat: 0.25,
  };
  try { return { ...base, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; }
  catch { return base; }
}
const saveOptions = (o) => {
  try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* private mode */ }
};

export function openMelodyWizard({ onInsert } = {}) {
  const track = S.selectedTrack();
  const project = S.project();

  if (!track || track.type === 'drum') {
    sheet('Melody wizard', (body, close) => {
      body.append(
        el('p', { class: 'hint', style: { fontSize: '13.5px', color: 'var(--text-dim)' } },
          'The wizard writes pitched melodies, so it needs a synth or sampler track. Drum tracks are step grids and have no pitch.'),
        el('button', {
          class: 'btn primary wide', style: { marginTop: '14px' },
          onclick: () => {
            S.checkpoint();
            const t = S.makeTrack('synth', project.tracks.length);
            t.name = 'Melody';
            project.tracks.push(t);
            S.state.selectedTrackId = t.id;
            S.touch();
            S.emit('tracks');
            close();
            openMelodyWizard({ onInsert });
          },
        }, icon(ICONS.plus, 18), 'Create a synth track and continue'),
      );
    });
    return;
  }

  const opts = loadOptions();
  const patternBars = S.activePattern().bars;
  opts.bars = Math.min(Math.max(1, opts.bars), patternBars);

  // Centre the melody on whatever the track already sits around.
  const existing = S.notesOf(track);
  const baseNote = existing.length
    ? snapToScale(Math.round(existing.reduce((a, n) => a + n.pitch, 0) / existing.length),
      project.scale.root, project.scale.type)
    : snapToScale(60, project.scale.root, project.scale.type);

  let seed = (Math.random() * 1e9) | 0;
  let notes = [];

  sheet('Melody wizard', (body, close) => {
    const preview = el('canvas', { class: 'melody-preview' });
    const summary = el('p', { class: 'hint', style: { margin: '8px 2px 0' } });
    const controls = el('div');

    const regenerate = () => {
      notes = generateMelody({
        root: project.scale.root,
        type: project.scale.type,
        bars: opts.bars,
        baseNote,
        density: opts.density,
        contour: opts.contour,
        structure: opts.structure,
        octaves: opts.octaves,
        adventurous: opts.adventurous,
        resolve: opts.resolve,
        rhythm: opts.rhythm,
        sustain: opts.sustain,
        rest: opts.rest,
        repeat: opts.repeat,
        seed,
      });
      drawPreview(preview, notes, opts.bars, track.color);
      const lo = notes.length ? Math.min(...notes.map((n) => n.pitch)) : 60;
      const hi = notes.length ? Math.max(...notes.map((n) => n.pitch)) : 60;
      let repeats = 0;
      for (let i = 1; i < notes.length; i++) if (notes[i].pitch === notes[i - 1].pitch) repeats++;
      summary.textContent = `${notes.length} notes · ${noteLabel(lo)}–${noteLabel(hi)}${repeats ? ` · ${repeats} repeated` : ''} · ${describePlan(project.scale.root, project.scale.type, opts.structure, opts.bars)}`;
      saveOptions(opts);
    };

    const pillRow = (label, map, current, set) => {
      const row = el('div', { class: 'pills' },
        Object.entries(map).map(([key, def]) => {
          const b = el('button', {
            class: `pill${current() === key ? ' on' : ''}`,
            onclick: () => {
              set(key);
              [...row.children].forEach((c) => c.classList.toggle('on', c === b));
              regenerate();
            },
          }, def.name);
          return b;
        }));
      return el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, label), row);
    };

    const barsRow = el('div', { class: 'row' },
      el('span', { class: 'lbl' }, 'Bars'),
      el('div', { class: 'btnrow', style: { flex: '1' } },
        el('button', {
          class: 'btn step', 'aria-label': 'Fewer bars',
          onclick: () => { opts.bars = Math.max(1, opts.bars - 1); barsVal.textContent = String(opts.bars); regenerate(); },
        }, '−'),
        el('span', { class: 'stepval' }, ''),
        el('button', {
          class: 'btn step', 'aria-label': 'More bars',
          onclick: () => { opts.bars = Math.min(patternBars, opts.bars + 1); barsVal.textContent = String(opts.bars); regenerate(); },
        }, '+'),
      ));
    const barsVal = barsRow.querySelector('.stepval');
    barsVal.textContent = String(opts.bars);

    const resolveBtn = el('button', {
      class: `btn${opts.resolve ? ' primary' : ''}`, style: { minWidth: '78px' },
      onclick: () => {
        opts.resolve = !opts.resolve;
        resolveBtn.textContent = opts.resolve ? 'On' : 'Off';
        resolveBtn.classList.toggle('primary', opts.resolve);
        regenerate();
      },
    }, opts.resolve ? 'On' : 'Off');

    const replaceBtn = el('button', {
      class: `btn${opts.replace ? ' primary' : ''}`, style: { minWidth: '78px' },
      onclick: () => {
        opts.replace = !opts.replace;
        replaceBtn.textContent = opts.replace ? 'Replace' : 'Add';
        replaceBtn.classList.toggle('primary', opts.replace);
        saveOptions(opts);
      },
    }, opts.replace ? 'Replace' : 'Add');

    controls.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Shape',
          el('span', { class: 'r' }, `${NOTE_NAMES[project.scale.root]} ${SCALES[project.scale.type]?.name || ''}`)),
        barsRow,
        pillRow('Density', DENSITIES, () => opts.density, (v) => { opts.density = v; }),
        pillRow('Rhythm', RHYTHMS, () => opts.rhythm, (v) => { opts.rhythm = v; }),
        pillRow('Note length', SUSTAINS, () => opts.sustain, (v) => { opts.sustain = v; }),
        slider('Rests', {
          min: 0, max: 0.6, step: 0.05, value: opts.rest,
          format: (v) => (v < 0.03 ? 'none' : v < 0.25 ? 'a few' : 'breathy'),
          oninput: (v) => { opts.rest = v; regenerate(); },
        }),
        slider('Repeated notes', {
          min: 0, max: 1, step: 0.05, value: opts.repeat,
          format: (v) => (v < 0.03 ? 'never' : v < 0.35 ? 'occasional' : v < 0.7 ? 'chanting' : 'insistent'),
          oninput: (v) => { opts.repeat = v; regenerate(); },
        }),
        pillRow('Contour', CONTOURS, () => opts.contour, (v) => { opts.contour = v; }),
        pillRow('Phrases', STRUCTURES, () => opts.structure, (v) => { opts.structure = v; }),
        slider('Range', {
          min: 1, max: 2, step: 1, value: opts.octaves,
          format: (v) => `${v} octave${v > 1 ? 's' : ''}`,
          oninput: (v) => { opts.octaves = v; regenerate(); },
        }),
        slider('Adventurous', {
          min: 0, max: 1, step: 0.05, value: opts.adventurous,
          format: (v) => (v < 0.3 ? 'safe' : v < 0.6 ? 'balanced' : 'wild'),
          oninput: (v) => { opts.adventurous = v; regenerate(); },
        }),
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'End on root'), el('div', { style: { flex: '1' } }), resolveBtn),
      ),
    );

    let auditioning = null;
    const auditionBtn = el('button', {
      class: 'btn',
      onclick: async () => {
        if (auditioning) {
          engine.stopAudition();
          clearTimeout(auditioning);
          auditioning = null;
          auditionBtn.classList.remove('primary');
          return;
        }
        const seconds = await engine.auditionNotes(track, notes);
        auditionBtn.classList.add('primary');
        auditioning = setTimeout(() => {
          auditioning = null;
          auditionBtn.classList.remove('primary');
        }, seconds * 1000 + 400);
      },
    }, icon(ICONS.play, 18), 'Preview');

    body.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Preview', el('span', { class: 'r' }, track.name)),
        preview,
        summary,
        el('div', { class: 'btnrow', style: { marginTop: '10px' } },
          el('button', {
            class: 'btn',
            onclick: () => { seed = (Math.random() * 1e9) | 0; regenerate(); },
          }, icon(ICONS.dice, 18), 'Another'),
          auditionBtn,
        ),
      ),
      controls,
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('span', { class: 'lbl' }, 'Existing notes'),
          el('div', { style: { flex: '1' } }),
          replaceBtn,
        ),
        el('button', {
          class: 'btn primary wide', style: { marginTop: '10px' },
          onclick: () => {
            if (!notes.length) { toast('Nothing to insert', 'err'); return; }
            engine.stopAudition();
            S.checkpoint();
            if (opts.replace) S.notesOf(track).length = 0;
            for (const n of notes) S.addNote(track, n);
            S.touch();
            S.emit('notes');
            saveOptions(opts);
            close();
            toast(`Added ${notes.length} notes to ${track.name}`, 'ok');
            onInsert && onInsert();
          },
        }, icon(ICONS.check, 18), 'Insert melody'),
        el('p', { class: 'hint' },
          'Every note is drawn from the project scale. Phrase targets follow the circle of fifths — sections lean on the tonic, its dominant and subdominant, and the melody comes home at the end.'),
      ),
    );

    regenerate();
  });
}

/** Little piano-roll thumbnail of the generated melody. */
function drawPreview(canvas, notes, bars, color) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 320;
  const h = rect.height || 96;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, w, h);

  const total = Math.max(1, bars * 16);
  ctx.strokeStyle = '#252c3c';
  ctx.lineWidth = 1;
  for (let b = 1; b < bars; b++) {
    const x = Math.round((b * 16 / total) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  if (!notes.length) return;
  const lo = Math.min(...notes.map((n) => n.pitch));
  const hi = Math.max(...notes.map((n) => n.pitch));
  const span = Math.max(4, hi - lo);
  const rowH = Math.max(3, Math.min(9, (h - 12) / (span + 1)));

  for (const n of notes) {
    const x = (n.t / total) * w;
    const nw = Math.max(2.5, (n.len / total) * w - 1);
    const y = h - 6 - ((n.pitch - lo) / span) * (h - 12) - rowH;
    ctx.globalAlpha = 0.45 + 0.55 * (n.vel ?? 0.9);
    ctx.fillStyle = color || '#6ee7ff';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, nw, rowH, 2) : ctx.rect(x, y, nw, rowH);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
