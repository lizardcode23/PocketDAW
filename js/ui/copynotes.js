// "Copy notes" — move a part between two tracks inside the current pattern.
//
// Notes belong to the pattern, one list per track, so this is a copy between
// two lists in one document. What it will *not* do is pair a drum track with
// a pitched one: a drum note's `pitch` is a pad index, so the same numbers
// mean something else on the other side.

import * as S from '../state.js';
import { el, clear, icon, ICONS, sheet, toast } from './dom.js';

/** Two tracks share a note space if they are both kits or both pitched. */
export const compatible = (a, b) =>
  !!a && !!b && a !== b && a.type !== 'audio' && b.type !== 'audio'
  && (a.type === 'drum') === (b.type === 'drum');

export const copyTargets = (track) => S.project().tracks.filter((t) => compatible(track, t));

/** The track a plain "copy it into the next one" should land on. */
export function nextTrack(track) {
  const list = S.project().tracks;
  const from = list.indexOf(track);
  if (from < 0) return null;
  for (let i = 1; i < list.length; i++) {
    const t = list[(from + i) % list.length];
    if (compatible(track, t)) return t;
  }
  return null;
}

const noteCount = (track) => ((S.activePattern()?.notes || {})[track.id] || []).length;

/**
 * Run one copy and say what happened. `into` decides the direction, so the
 * same call serves both halves of the sheet.
 */
export function copyBetween(track, other, { into = true, merge = false } = {}) {
  const from = into ? track : other;
  const to = into ? other : track;
  const had = noteCount(to);
  if (!noteCount(from)) {
    toast(`${from.name} has no notes in this pattern`, 'err');
    return 0;
  }
  S.checkpoint();
  const n = S.copyNotes(from, to, { merge });
  S.emit('notes');
  toast(merge
    ? `${n} note${n === 1 ? '' : 's'} added to ${to.name}`
    : `${to.name}: ${n} note${n === 1 ? '' : 's'} from ${from.name}${had ? ` (${had} replaced)` : ''}`, 'ok');
  return n;
}

export function openCopyNotes(track, { onDone } = {}) {
  const opts = { into: true, merge: false };

  sheet(`Copy notes · ${track.name}`, (body, close) => {
    const done = () => { close(); onDone && onDone(); };

    const paint = () => {
      clear(body);
      const targets = copyTargets(track);
      const next = nextTrack(track);

      const seg = (items, get, set) => el('div', { class: 'seg' },
        items.map(([value, label]) => el('button', {
          class: get() === value ? 'on' : '',
          onclick: () => { set(value); paint(); },
        }, label)));

      body.append(
        el('div', { class: 'row wrap' },
          el('span', { class: 'lbl' }, 'Direction'),
          seg([[true, 'To'], [false, 'From']], () => opts.into, (v) => { opts.into = v; })),
        el('div', { class: 'row wrap' },
          el('span', { class: 'lbl' }, 'Existing notes'),
          seg([[false, 'Replace'], [true, 'Keep']], () => opts.merge, (v) => { opts.merge = v; })),
      );

      if (!targets.length) {
        body.append(el('div', { class: 'empty', style: { padding: '18px' } },
          track.type === 'drum'
            ? 'No other drum track to copy between.'
            : 'No other melodic track to copy between — add one in the Song tab.'));
        return;
      }

      if (next && targets.length > 1) {
        body.append(el('button', {
          class: 'btn wide primary', style: { marginTop: '4px' },
          onclick: () => { copyBetween(track, next, opts); done(); },
        }, icon(ICONS.copy, 18),
        opts.into ? `Copy into ${next.name}` : `Copy from ${next.name}`));
      }

      body.append(el('div', { class: 'slist' },
        targets.map((t) => el('button', {
          class: 'sitem', style: { width: '100%' },
          onclick: () => { copyBetween(track, t, opts); done(); },
        },
          el('span', { class: 'play', style: { color: t.color } }, icon(ICONS.copy, 15)),
          el('span', { class: 'meta' },
            el('b', {}, opts.into ? `${track.name} → ${t.name}` : `${t.name} → ${track.name}`),
            el('span', {}, `${noteCount(t)} note${noteCount(t) === 1 ? '' : 's'} on ${t.name} now`)),
        ))));

      body.append(el('p', { class: 'hint' },
        'Only the pattern you are editing is copied, and the notes land on the same steps they were written on.'));
    };

    paint();
  });
}
