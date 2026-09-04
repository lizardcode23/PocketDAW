// Rhythm wizard: the melody wizard's twin for a drum kit.
//
// Same shape of interaction on purpose — pick a feel, watch the preview,
// hit "Another" until one lands, then insert it — because the two are the
// same gesture from the musician's side even though one reasons about pitch
// and the other about which part of the kit is playing.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import {
  generateRhythm, describeRhythm, mapRoles, STYLES, ROLE_NAMES, KIT_ROLES,
} from '../rhythm.js';
import { el, sheet, slider, icon, ICONS, toast } from './dom.js';
import { drawNoteMini } from './notemini.js';

const OPT_KEY = 'pdaw.rhythm';

function loadOptions() {
  const base = {
    bars: 2, style: 'boomBap', density: 0.5, variation: 0.25,
    fill: true, humanise: 0.3, replace: true,
  };
  try { return { ...base, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; }
  catch { return base; }
}
const saveOptions = (o) => {
  try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* private mode */ }
};

export function openRhythmWizard({ onInsert } = {}) {
  const track = S.selectedTrack();
  const project = S.project();

  if (!track || track.type !== 'drum') {
    sheet('Rhythm wizard', (body, close) => {
      body.append(
        el('p', { class: 'hint', style: { fontSize: '13.5px', color: 'var(--text-dim)' } },
          'The rhythm wizard writes for a drum kit — it decides which pad plays where, '
          + 'so it needs a track with pads. Pitched tracks have the melody wizard instead.'),
        el('button', {
          class: 'btn primary wide', style: { marginTop: '14px' },
          onclick: () => {
            S.checkpoint();
            const t = S.makeTrack('drum', project.tracks.length);
            t.name = 'Drums';
            project.tracks.push(t);
            S.state.selectedTrackId = t.id;
            S.touch();
            S.emit('tracks');
            close();
            openRhythmWizard({ onInsert });
          },
        }, icon(ICONS.plus, 18), 'Create a drum track and continue'),
      );
    });
    return;
  }

  const opts = loadOptions();
  const patternBars = S.activePattern().bars;
  opts.bars = Math.min(Math.max(1, opts.bars), patternBars);

  const roles = mapRoles(track);
  let seed = (Math.random() * 1e9) | 0;
  let notes = [];

  sheet('Rhythm wizard', (body, close) => {
    const preview = el('canvas', { class: 'melody-preview' });
    const summary = el('p', { class: 'hint', style: { margin: '8px 2px 0' } });

    const regenerate = () => {
      notes = generateRhythm({
        bars: opts.bars,
        style: opts.style,
        density: opts.density,
        variation: opts.variation,
        fill: opts.fill,
        humanise: opts.humanise,
        roles,
        seed,
      });
      drawNoteMini(preview, notes, {
        steps: opts.bars * 16,
        patSteps: opts.bars * 16,
        range: [0, S.PAD_COUNT - 1],
        rows: true,
        bars: opts.bars,
        colour: track.color,
        background: '#0a0c11',
      });
      const pads = new Set(notes.map((n) => n.pitch));
      summary.textContent = `${notes.length} hits · ${pads.size} pad${pads.size === 1 ? '' : 's'} · `
        + describeRhythm(opts.style, opts.bars, opts.density);
      saveOptions(opts);
    };

    const styleRow = el('div', { class: 'pills' },
      Object.entries(STYLES).map(([key, def]) => {
        const b = el('button', {
          class: `pill${opts.style === key ? ' on' : ''}`,
          title: def.blurb,
          onclick: () => {
            opts.style = key;
            [...styleRow.children].forEach((c) => c.classList.toggle('on', c === b));
            blurb.textContent = def.blurb;
            regenerate();
          },
        }, def.name);
        return b;
      }));
    const blurb = el('p', { class: 'hint', style: { margin: '4px 2px 0' } },
      (STYLES[opts.style] || {}).blurb || '');

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

    const fillBtn = el('button', {
      class: `btn${opts.fill ? ' primary' : ''}`, style: { minWidth: '78px' },
      onclick: () => {
        opts.fill = !opts.fill;
        fillBtn.textContent = opts.fill ? 'On' : 'Off';
        fillBtn.classList.toggle('primary', opts.fill);
        regenerate();
      },
    }, opts.fill ? 'On' : 'Off');

    const replaceBtn = el('button', {
      class: `btn${opts.replace ? ' primary' : ''}`, style: { minWidth: '78px' },
      onclick: () => {
        opts.replace = !opts.replace;
        replaceBtn.textContent = opts.replace ? 'Replace' : 'Add';
        replaceBtn.classList.toggle('primary', opts.replace);
        saveOptions(opts);
      },
    }, opts.replace ? 'Replace' : 'Add');

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

    // Which pad the wizard thinks is which part of the kit. Renaming a pad
    // is how you correct it, so the mapping is worth showing.
    const used = KIT_ROLES.filter((r) => (STYLES[opts.style]?.roles || {})[r] != null);
    const mapping = el('p', { class: 'hint', style: { marginTop: '6px' } },
      `Playing ${used.map((r) => `${ROLE_NAMES[r]} → pad ${(roles[r] ?? 0) + 1}`).join(', ')}. `
      + 'Rename a pad after what it holds and the wizard will follow it.');

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
      el('div', { class: 'card' },
        el('h3', {}, 'Groove'),
        el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'Style'), styleRow),
        blurb,
        barsRow,
        slider('Density', {
          min: 0, max: 1, step: 0.05, value: opts.density,
          format: (v) => (v < 0.25 ? 'sparse' : v < 0.55 ? 'steady' : v < 0.8 ? 'busy' : 'relentless'),
          oninput: (v) => { opts.density = v; regenerate(); },
        }),
        slider('Variation', {
          min: 0, max: 1, step: 0.05, value: opts.variation,
          format: (v) => (v < 0.05 ? 'looped' : v < 0.35 ? 'a little' : v < 0.7 ? 'loose' : 'never twice'),
          oninput: (v) => { opts.variation = v; regenerate(); },
        }),
        slider('Human feel', {
          min: 0, max: 1, step: 0.05, value: opts.humanise,
          format: (v) => (v < 0.05 ? 'machine' : v < 0.5 ? 'played' : 'loose'),
          oninput: (v) => { opts.humanise = v; regenerate(); },
        }),
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Fill on the last bar'),
          el('div', { style: { flex: '1' } }), fillBtn),
        mapping,
      ),
      el('div', { class: 'card' },
        el('div', { class: 'row' },
          el('span', { class: 'lbl' }, 'Existing hits'),
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
            toast(`Added ${notes.length} hits to ${track.name}`, 'ok');
            onInsert && onInsert();
          },
        }, icon(ICONS.check, 18), 'Insert rhythm'),
        el('p', { class: 'hint' },
          'Each style is a set of odds per 16th note, not a fixed loop — the backbone always '
          + 'lands, the rest is rolled. Variation is how far later bars may drift from the first.'),
      ),
    );

    regenerate();
  });
}
