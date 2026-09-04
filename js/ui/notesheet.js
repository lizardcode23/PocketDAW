// Long-press editor for a single note. On a phone this is also the only
// precise way to delete or fine-tune a note that is a few pixels wide.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { noteLabel } from '../theory.js';
import { el, sheet, slider, icon, ICONS } from './dom.js';

const LENGTHS = [[1, '1/16'], [2, '1/8'], [3, '1/8.'], [4, '1/4'], [6, '1/4.'], [8, '1/2'], [16, '1 bar']];

export function openNoteSheet(track, note, { onChange } = {}) {
  const title = track.type === 'drum'
    ? (track.pads[note.pitch]?.name || `Pad ${note.pitch + 1}`)
    : noteLabel(note.pitch);

  sheet(title, (body, close) => {
    const done = () => { S.touch(); onChange && onChange(); };

    const lengths = track.type === 'drum' ? null : el('div', { class: 'pills' },
      LENGTHS.map(([steps, label]) => {
        const b = el('button', {
          class: `pill${note.len === steps ? ' on' : ''}`,
          onclick: () => {
            S.checkpoint();
            note.len = Math.min(steps, S.totalSteps() - note.t);
            [...lengths.children].forEach((c) => c.classList.toggle('on', c === b));
            done();
          },
        }, label);
        return b;
      }));

    body.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Velocity'),
        slider('Level', {
          min: 0.1, max: 1, step: 0.01, value: note.vel ?? 0.9,
          format: (v) => `${Math.round(v * 100)}%`,
          oninput: (v) => { note.vel = v; done(); },
        }),
        el('div', { class: 'btnrow' },
          el('button', { class: 'btn', onclick: () => engine.preview(track, note.pitch, 'notesheet') },
            icon(ICONS.play, 18), 'Audition'),
        ),
      ),
      lengths ? el('div', { class: 'card' }, el('h3', {}, 'Length'), lengths) : null,
      el('div', { class: 'btnrow' },
        el('button', {
          class: 'btn danger wide',
          onclick: () => {
            S.checkpoint();
            S.removeNote(track, note.id);
            close();
            onChange && onChange();
          },
        }, icon(ICONS.trash, 18), 'Delete note'),
      ),
    );
  });
}
