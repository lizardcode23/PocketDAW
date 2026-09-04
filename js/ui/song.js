// "Song" tab — project settings, saved projects, export, sample library.

import * as S from '../state.js';
import * as db from '../db.js';
import * as engine from '../audio/engine.js';
import { exportWav } from '../audio/export.js';
import { preloadForProject } from '../audio/samples.js';
import { SCALES, NOTE_NAMES } from '../theory.js';
import { el, clear, icon, ICONS, slider, toast, confirmSheet } from './dom.js';
import { renderLibraryManager } from './library.js';
import { openScaleSheet } from './scalepicker.js';
import { openPatternPicker } from './clipsheet.js';

export function renderSong(container, { onChange }) {
  const p = S.project();
  clear(container);
  const inner = el('div', { class: 'inner' });
  container.append(inner);

  const repaint = () => { renderSong(container, { onChange }); onChange && onChange(); };

  /* ------------------------------------------------------------ project */

  const nameInput = el('input', {
    type: 'text', value: p.name, maxlength: '40',
    onchange: (e) => { p.name = e.target.value.trim() || 'Untitled'; S.touch(); },
  });

  const pattern = S.activePattern();
  const barsRow = el('div', { class: 'row' },
    el('span', { class: 'lbl' }, 'Pattern length'),
    el('div', { class: 'btnrow', style: { flex: '1' } },
      el('button', { class: 'btn step', 'aria-label': 'Shorter', onclick: () => setBars(pattern.bars - 1, repaint) }, '−'),
      el('span', { class: 'stepval' }, `${pattern.bars} bar${pattern.bars === 1 ? '' : 's'}`),
      el('button', { class: 'btn step', 'aria-label': 'Longer', onclick: () => setBars(pattern.bars + 1, repaint) }, '+'),
    ));

  const songRow = el('div', { class: 'row' },
    el('span', { class: 'lbl' }, 'Song length'),
    el('div', { class: 'btnrow', style: { flex: '1' } },
      el('button', {
        class: 'btn step', 'aria-label': 'Shorter song',
        onclick: () => { setSongBars(p.songBars - 4); repaint(); },
      }, '−'),
      el('span', { class: 'stepval' }, `${p.songBars} bar${p.songBars === 1 ? '' : 's'}`),
      el('button', {
        class: 'btn step', 'aria-label': 'Longer song',
        onclick: () => { setSongBars(p.songBars + 4); repaint(); },
      }, '+'),
    ));

  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'Project'),
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Name'), nameInput),
    slider('Tempo', {
      min: 40, max: 220, step: 1, value: p.bpm, format: (v) => `${v} BPM`,
      oninput: (v) => { p.bpm = v; S.touch(); engine.rebase(); S.emit('tempo'); },
    }),
    slider('Swing', {
      min: 0, max: 0.7, step: 0.01, value: p.swing, format: (v) => `${Math.round(v * 100)}%`,
      oninput: (v) => { p.swing = v; S.touch(); },
    }),
    barsRow,
    songRow,
    el('div', { class: 'row' },
      el('span', { class: 'lbl' }, 'Patterns'),
      el('div', { style: { flex: '1' } }),
      el('button', {
        class: 'btn',
        onclick: () => openPatternPicker({ manage: true, selectedId: p.activePatternId }),
      }, icon(ICONS.copy, 18), `${p.patterns.length} · manage`),
    ),
    el('div', { class: 'row' },
      el('span', { class: 'lbl' }, 'Double it'),
      el('div', { style: { flex: '1' } }),
      el('button', {
        class: 'btn',
        onclick: () => duplicatePattern(repaint),
      }, icon(ICONS.copy, 18), 'Duplicate bars'),
    ),
    toggleRow('Loop', () => p.loop, (v) => { p.loop = v; S.touch(); }),
    toggleRow('Metronome', () => p.metronome, (v) => { p.metronome = v; S.touch(); onChange && onChange(); }),
  ));

  /* -------------------------------------------------------------- scale */

  const sc = p.scale;
  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'Scale', el('span', { class: 'r' }, 'applies to the whole project')),
    el('button', {
      class: 'sitem', style: { width: '100%' },
      onclick: () => openScaleSheet(repaint),
    },
      el('span', { class: 'play', style: { color: 'var(--accent-2)' } }, icon(ICONS.lock, 16)),
      el('span', { class: 'meta' },
        el('b', {}, `${NOTE_NAMES[sc.root]} ${SCALES[sc.type]?.name || 'Chromatic'}`),
        el('span', {}, [
          sc.highlight !== false ? 'highlighting on' : 'highlighting off',
          sc.lock ? 'input snapped to scale' : 'free input',
        ].join(' · '))),
    ),
  ));

  /* ------------------------------------------------------------- export */

  const exportOne = (mode, label) => {
    const btn = el('button', {
      class: `btn${mode === 'song' ? ' primary' : ''}`,
      onclick: async () => {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Rendering…';
        try {
          await preloadForProject(p);
          const blob = await exportWav(p, { repeats: 1, tailSeconds: 2, mode });
          const suffix = mode === 'song' ? '' : ` - ${S.activePattern().name}`;
          downloadBlob(blob, `${(p.name + suffix).replace(/[^\w -]+/g, '') || 'pocket-daw'}.wav`);
          toast('WAV exported', 'ok');
        } catch (e) {
          toast(e.message || 'Export failed', 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = original;
          btn.prepend(icon(ICONS.down, 18));
        }
      },
    }, icon(ICONS.down, 18), label);
    return btn;
  };

  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'Export'),
    el('div', { class: 'btnrow' },
      exportOne('song', 'Whole song'),
      exportOne('pattern', 'This pattern'),
    ),
    el('p', { class: 'hint' },
      `Rendered offline, faster than real time, including every channel's effects. The song is ${p.songBars} bars; ${S.activePattern().name} is ${S.activePattern().bars}.`),
  ));

  /* ----------------------------------------------------------- projects */

  const projectList = el('div', { class: 'slist' });
  refreshProjects(projectList, repaint);

  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'Projects', el('span', { class: 'r' }, S.state.dirty ? 'saving…' : 'saved')),
    el('div', { class: 'btnrow', style: { marginBottom: '10px' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          await S.save();
          toast('Saved', 'ok');
          repaint();
        },
      }, icon(ICONS.save, 18), 'Save now'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          if (!await confirmSheet('New project?', 'The current project is saved first, then a fresh one opens.', 'Create')) return;
          await S.save();
          S.newProject('Untitled');
          await S.save();
          repaint();
        },
      }, icon(ICONS.plus, 18), 'New'),
    ),
    projectList,
  ));

  /* ------------------------------------------------------------ samples */

  const libraryHost = el('div');
  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'Sample library', el('span', { class: 'r' }, 'stored on this device')),
    libraryHost,
  ));
  renderLibraryManager(libraryHost);

  /* --------------------------------------------------------------- about */

  const installBtn = window.__pdawInstall
    ? el('button', {
        class: 'btn wide',
        onclick: async () => {
          const prompt = window.__pdawInstall;
          if (!prompt) return;
          prompt.prompt();
          await prompt.userChoice;
          window.__pdawInstall = null;
          repaint();
        },
      }, icon(ICONS.down, 18), 'Install as an app')
    : null;

  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'About'),
    installBtn,
    el('p', { class: 'hint' },
      'Pocket DAW runs entirely in your browser. Projects and samples are kept in this browser’s storage on this device — clearing site data removes them, so export anything you want to keep.'),
  ));
}

/* ---------------------------------------------------------------- bits */

function toggleRow(label, get, set) {
  const btn = el('button', { class: `btn${get() ? ' primary' : ''}`, style: { minWidth: '78px' } }, get() ? 'On' : 'Off');
  btn.addEventListener('click', () => {
    set(!get());
    btn.textContent = get() ? 'On' : 'Off';
    btn.classList.toggle('primary', get());
  });
  return el('div', { class: 'row' }, el('span', { class: 'lbl' }, label), el('div', { style: { flex: '1' } }), btn);
}

/** Double the song length and copy everything into the new half. */
function duplicatePattern(repaint) {
  const p = S.project();
  const pattern = S.activePattern();
  if (pattern.bars * 2 > 32) { toast('32 bars is the maximum pattern length', 'err'); return; }
  S.checkpoint();
  const offset = pattern.bars * S.STEPS_PER_BAR;
  for (const track of p.tracks) {
    const notes = S.notesOf(track, pattern);
    notes.push(...notes.map((n) => ({ ...n, id: S.uid('n'), t: n.t + offset })));
  }
  pattern.bars *= 2;
  S.touch();
  S.emit('length');
  toast(`Pattern doubled to ${pattern.bars} bars`, 'ok');
  repaint();
}

function setSongBars(bars) {
  const p = S.project();
  const next = Math.max(4, Math.min(256, bars));
  if (next === p.songBars) return;
  S.checkpoint();
  p.songBars = next;
  const total = next * S.STEPS_PER_BAR;
  p.clips = p.clips.filter((c) => c.start < total);
  for (const c of p.clips) c.length = Math.min(c.length, total - c.start);
  S.touch();
  S.emit('length');
}

function setBars(bars, repaint) {
  const pattern = S.activePattern();
  const next = Math.max(1, Math.min(32, bars));
  if (next === pattern.bars) return;
  S.checkpoint();
  pattern.bars = next;
  // Drop anything that now sits past the end of the pattern.
  const total = next * S.STEPS_PER_BAR;
  for (const key of Object.keys(pattern.notes)) {
    pattern.notes[key] = pattern.notes[key].filter((n) => n.t < total);
    for (const n of pattern.notes[key]) n.len = Math.min(n.len, total - n.t);
  }
  S.touch();
  S.emit('length');
  repaint();
}

async function refreshProjects(list, repaint) {
  const all = await db.allProjects();
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  clear(list);
  if (!all.length) {
    list.append(el('div', { class: 'empty' }, 'No saved projects yet.'));
    return;
  }
  for (const rec of all) {
    const current = rec.id === S.project().id;
    const notes = (rec.patterns || []).reduce((a, pat) =>
      a + Object.values(pat.notes || {}).reduce((b, list) => b + list.length, 0),
      (rec.tracks || []).reduce((a2, t) => a2 + (t.notes || []).length, 0));
    list.append(el('div', { class: `sitem${current ? ' sel' : ''}` },
      el('button', {
        class: 'meta',
        onclick: async () => {
          if (current) return;
          await S.save();
          await S.loadProject(rec.id);
          toast(`Opened “${rec.name}”`, 'ok');
          repaint();
        },
      },
        el('b', {}, rec.name + (current ? ' · open' : '')),
        el('span', {}, `${(rec.patterns || []).length || 1} pattern${(rec.patterns || []).length === 1 ? '' : 's'} · ${rec.bpm} BPM · ${(rec.tracks || []).length} tracks · ${notes} notes`)),
      el('button', {
        class: 'kill', 'aria-label': `Delete ${rec.name}`,
        onclick: async () => {
          if (current) { toast('Close this project first by opening another one', 'err'); return; }
          if (!await confirmSheet('Delete project?', `“${rec.name}” will be removed permanently.`)) return;
          await db.deleteProject(rec.id);
          refreshProjects(list, repaint);
          toast('Project deleted');
        },
      }, icon(ICONS.trash, 18)),
    ));
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
