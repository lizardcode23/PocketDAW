// Project-wide scale picker. The chosen root + scale drives note
// highlighting in the piano roll, optional input snapping, and the
// "fold to scale" row filter.

import * as S from '../state.js';
import { NOTE_NAMES, SCALES, SCALE_KEYS, inScale, isRoot, snapToScale } from '../theory.js';
import { el, sheet, icon, ICONS, toast } from './dom.js';

export function openScaleSheet(onChange) {
  sheet('Project scale', (body) => {
    const sc = S.project().scale;

    const preview = el('div', { class: 'scale-preview' });
    const legend = el('div', { class: 'scale-legend' });
    const rootPills = el('div', { class: 'pills' });
    const scalePills = el('div', { class: 'pills' });

    const paint = () => {
      preview.replaceChildren(...Array.from({ length: 13 }, (_, i) => {
        const midi = 60 + i;
        const cls = isRoot(midi, sc.root) ? 'root' : inScale(midi, sc.root, sc.type) ? 'in' : '';
        return el('i', { class: cls });
      }));
      legend.replaceChildren(...Array.from({ length: 13 }, (_, i) =>
        el('span', {}, NOTE_NAMES[(60 + i) % 12])));

      [...rootPills.children].forEach((p, i) => p.classList.toggle('on', i === sc.root));
      [...scalePills.children].forEach((p) => p.classList.toggle('on', p.dataset.key === sc.type));
    };

    const apply = () => {
      S.touch();
      paint();
      onChange && onChange();
      S.emit('scale');
    };

    NOTE_NAMES.forEach((n, i) => {
      rootPills.append(el('button', {
        class: `pill${[1, 3, 6, 8, 10].includes(i) ? ' black' : ''}`,
        onclick: () => { S.checkpoint(); sc.root = i; apply(); },
      }, n));
    });

    SCALE_KEYS.forEach((key) => {
      scalePills.append(el('button', {
        class: 'pill wide',
        dataset: { key },
        onclick: () => { S.checkpoint(); sc.type = key; apply(); },
      }, SCALES[key].name));
    });

    const toggleRow = (label, hint, get, set) => {
      const btn = el('button', {
        class: 'btn',
        style: { minWidth: '78px' },
        onclick: () => { set(!get()); btn.textContent = get() ? 'On' : 'Off'; btn.classList.toggle('primary', get()); apply(); },
      }, get() ? 'On' : 'Off');
      btn.classList.toggle('primary', get());
      return el('div', { class: 'row' },
        el('div', { style: { flex: '1' } },
          el('div', { style: { fontSize: '13.5px', fontWeight: '600' } }, label),
          el('div', { class: 'hint', style: { margin: '2px 0 0' } }, hint)),
        btn);
    };

    body.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Root note'),
        rootPills,
        preview,
        legend,
      ),
      el('div', { class: 'card' },
        el('h3', {}, 'Scale'),
        scalePills,
      ),
      el('div', { class: 'card' },
        el('h3', {}, 'Behaviour'),
        toggleRow('Highlight in editor', 'Tint in-scale rows and mark the root.',
          () => sc.highlight !== false, (v) => { sc.highlight = v; }),
        toggleRow('Snap input to scale', 'New and moved notes land on the nearest scale degree.',
          () => !!sc.lock, (v) => { sc.lock = v; }),
      ),
      el('div', { class: 'card' },
        el('h3', {}, 'Existing notes'),
        el('button', {
          class: 'btn wide',
          onclick: () => {
            const moved = snapAllNotes();
            toast(moved ? `Snapped ${moved} note${moved === 1 ? '' : 's'} to scale` : 'Everything is already in scale', moved ? 'ok' : '');
            onChange && onChange();
          },
        }, icon(ICONS.check, 18), 'Snap all notes into this scale'),
        el('p', { class: 'hint' }, 'Moves every out-of-scale note in every pattern to the closest scale degree. Drum and audio tracks are untouched.'),
      ),
    );

    paint();
  });
}

/** Nudge every out-of-scale note on pitched tracks onto a scale degree. */
export function snapAllNotes() {
  const p = S.project();
  const { root, type } = p.scale;
  let moved = 0;
  let checkpointed = false;
  for (const pattern of p.patterns) {
   for (const track of p.tracks) {
    if (track.type === 'drum' || track.type === 'audio') continue;
    for (const n of S.notesOf(track, pattern)) {
      const snapped = snapToScale(n.pitch, root, type);
      if (snapped !== n.pitch) {
        if (!checkpointed) { S.checkpoint(); checkpointed = true; }
        n.pitch = snapped;
        moved++;
      }
    }
   }
  }
  if (moved) { S.touch(); S.emit('notes'); }
  return moved;
}

/** Short label for the top-bar chip, e.g. "Minor Pent". */
export function scaleChipLabel(scale) {
  const full = SCALES[scale.type]?.name || 'Chromatic';
  return full
    .replace('Pentatonic', 'Pent')
    .replace(' (Ionian)', '')
    .replace(' (Insen)', '')
    .replace(' (Hijaz)', '')
    .replace('Phrygian Dominant', 'Phryg Dom')
    .replace('Hungarian Minor', 'Hung Min');
}
