// "Sequence" tab — toolbar plus the editor that suits the selected track:
// a piano roll for pitched tracks, a step grid for drum kits.

import * as S from '../state.js';
import { el, clear, icon, ICONS, toast, confirmSheet } from './dom.js';
import { createPianoRoll } from './pianoroll.js';
import { createDrumGrid } from './drumgrid.js';
import { openScaleSheet } from './scalepicker.js';
import { openMelodyWizard } from './wizard.js';
import { openRhythmWizard } from './rhythmwizard.js';
import { openCopyNotes, copyTargets } from './copynotes.js';

const SNAPS = [[1, '1/16'], [2, '1/8'], [4, '1/4']];
const LENS = [[1, '1/16'], [2, '1/8'], [4, '1/4'], [8, '1/2'], [16, '1 bar']];

export function createSequencer(container, { onEdit } = {}) {
  let editor = null;
  let kind = null;          // 'roll' | 'grid'
  const bar = el('div', { class: 'seqbar' });
  const host = el('div', { class: 'rollwrap' });
  clear(container).append(el('div', { class: 'seq' }, bar, host));

  const track = () => S.selectedTrack();

  function buildEditor() {
    const t = track();
    const want = !t ? 'roll'
      : t.type === 'drum' ? 'grid'
      : t.type === 'audio' ? 'none'
      : 'roll';
    if (want === kind && editor) {
      editor.render();
      return;
    }
    if (editor && editor.destroy) editor.destroy();
    clear(host);
    host.className = want === 'grid' ? 'dgrid' : 'rollwrap';
    if (want === 'none') {
      // Audio channels have no notes — their content lives on the playlist.
      host.className = 'rollwrap';
      host.append(el('div', { class: 'empty', style: { paddingTop: '48px' } },
        icon(ICONS.wave, 34),
        el('div', {}, `${t.name} is an audio channel.`),
        el('div', {}, 'Record or arrange its clips in the Playlist tab.')));
      editor = null;
      kind = want;
      return;
    }
    if (want === 'grid') {
      editor = createDrumGrid(host, { getTrack: track, onEdit });
      editor.rebuild();
    } else {
      const canvas = el('canvas');
      host.append(canvas);
      editor = createPianoRoll(canvas, { getTrack: track, onEdit });
      // The observer fires once on attach and does the first paint.
    }
    kind = want;
  }

  function buildBar() {
    const t = track();
    clear(bar);
    if (!t) return;

    if (t.type === 'audio') {
      bar.append(
        el('span', { class: 'minibtn', style: { pointerEvents: 'none' } }, 'Audio channel — see the Playlist tab'),
      );
      return;
    }

    if (t.type === 'drum') {
      bar.append(
        // The generative tool comes first here for the same reason it does on
        // the piano roll: the toolbar scrolls on a phone.
        el('button', {
          class: 'minibtn',
          onclick: () => openRhythmWizard({ onInsert: () => { refresh(); onEdit && onEdit(); } }),
        }, icon(ICONS.wand, 16), 'Rhythm'),
        copyBtn(t),
        el('div', { class: 'sep' }),
        el('span', { class: 'minibtn', style: { pointerEvents: 'none' } }, 'Tap or drag to paint · right-click erases'),
        el('div', { class: 'sep' }),
        clearBtn(t),
      );
      return;
    }

    const prefs = editor && editor.prefs;
    if (!prefs) return;

    const seg = (items, get, set) => el('div', { class: 'seg' },
      items.map(([value, label]) => el('button', {
        class: get() === value ? 'on' : '',
        onclick: (e) => {
          set(value);
          [...e.currentTarget.parentElement.children].forEach((c) => c.classList.toggle('on', c === e.currentTarget));
        },
      }, label)));

    const modeSeg = el('div', { class: 'seg' },
      [['draw', ICONS.pencil], ['erase', ICONS.eraser]].map(([m, d]) => el('button', {
        class: prefs.mode === m ? 'on' : '',
        'aria-label': m,
        onclick: (e) => {
          prefs.mode = m;
          editor.savePrefs();
          [...e.currentTarget.parentElement.children].forEach((c) => c.classList.toggle('on', c === e.currentTarget));
        },
      }, icon(d, 18))));

    const suggestBtn = el('button', {
      class: `minibtn${prefs.suggest ? ' on' : ''}`,
      title: 'Show the notes that fit best next',
      onclick: () => {
        prefs.suggest = !prefs.suggest;
        editor.savePrefs();
        suggestBtn.classList.toggle('on', prefs.suggest);
        if (prefs.suggest) editor.revealSuggestions(); else editor.refreshRows();
      },
    }, icon(ICONS.bulb, 16), 'Suggest');

    // Ghosts are the other tracks' notes showing through this pattern, which
    // is a different thing from the suggestion ghosts above — hence the two
    // buttons, and the two names.
    const ghostBtn = el('button', {
      class: `minibtn${prefs.ghosts ? ' on' : ''}`,
      title: 'Show what the other tracks play in this pattern',
      onclick: () => {
        prefs.ghosts = !prefs.ghosts;
        editor.savePrefs();
        ghostBtn.classList.toggle('on', prefs.ghosts);
        editor.render();
      },
    }, icon(ICONS.layers, 16), 'Ghosts');

    const foldBtn = el('button', {
      class: `minibtn${prefs.fold ? ' on' : ''}`,
      onclick: () => {
        prefs.fold = !prefs.fold;
        editor.savePrefs();
        foldBtn.classList.toggle('on', prefs.fold);
        editor.recentre();
      },
    }, icon(ICONS.fold, 16), 'Fold to scale');

    bar.append(
      modeSeg,
      el('div', { class: 'sep' }),
      // The generative tools come first: on a phone the toolbar scrolls, and
      // anything past the fold may as well not exist.
      suggestBtn,
      el('button', {
        class: 'minibtn',
        onclick: () => openMelodyWizard({ onInsert: () => { editor.recentre(); buildBar(); } }),
      }, icon(ICONS.wand, 16), 'Melody'),
      copyBtn(t),
      ghostBtn,
      el('div', { class: 'sep' }),
      el('span', { class: 'seglabel' }, 'Snap'),
      seg(SNAPS, () => prefs.snap, (v) => { prefs.snap = v; editor.savePrefs(); }),
      el('span', { class: 'seglabel' }, 'Note'),
      seg(LENS, () => prefs.drawLen, (v) => { prefs.drawLen = v; editor.savePrefs(); }),
      el('div', { class: 'sep' }),
      foldBtn,
      el('button', {
        class: 'minibtn',
        onclick: () => openScaleSheet(() => { editor.refreshRows(); buildBar(); }),
      }, icon(ICONS.lock, 16), 'Scale'),
      el('div', { class: 'sep' }),
      el('button', {
        class: 'minibtn',
        onclick: () => { prefs.stepW = Math.max(12, prefs.stepW * 0.8); editor.savePrefs(); editor.refreshRows(); },
      }, icon(ICONS.minus, 16)),
      el('button', {
        class: 'minibtn',
        onclick: () => { prefs.stepW = Math.min(64, prefs.stepW * 1.25); editor.savePrefs(); editor.refreshRows(); },
      }, icon(ICONS.plus, 16)),
      el('div', { class: 'sep' }),
      clearBtn(t),
    );
  }

  function copyBtn(t) {
    const targets = copyTargets(t);
    return el('button', {
      class: 'minibtn',
      title: 'Copy this track’s notes to another track',
      onclick: () => {
        if (!targets.length) {
          toast(t.type === 'drum' ? 'No other drum track to copy to' : 'No other melodic track to copy to');
          return;
        }
        openCopyNotes(t, { onDone: () => { refresh(); onEdit && onEdit(); } });
      },
    }, icon(ICONS.copy, 16), 'Copy');
  }

  function clearBtn(t) {
    return el('button', {
      class: 'minibtn',
      onclick: async () => {
        const count = S.notesOf(t).length;
        if (!count) { toast('Nothing to clear'); return; }
        if (!await confirmSheet('Clear track?', `Remove all ${count} notes from “${t.name}” in this pattern?`, 'Clear')) return;
        S.clearTrackNotes(t);
        refresh();
        onEdit && onEdit();
      },
    }, icon(ICONS.trash, 16), 'Clear');
  }

  function refresh() {
    buildEditor();
    buildBar();
  }

  refresh();

  return {
    refresh,
    render() { if (editor) editor.render(); },
    hasEditor: () => !!editor,
    rebuildGrid() { if (editor && editor.rebuild) editor.rebuild(); else if (editor) editor.refreshRows(); },
    tick() {
      if (!editor) return;
      if (editor.followPlayhead) editor.followPlayhead();
      if (editor.render && kind === 'roll') editor.render();
    },
    refreshRows() { if (editor && editor.refreshRows) editor.refreshRows(); },
  };
}
