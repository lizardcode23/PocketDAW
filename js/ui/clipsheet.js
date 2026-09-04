// Sheets for a single playlist clip, and the pattern chooser.
//
// A clip is not just a rectangle: it has a window into its source, fades, a
// level, and any number of muted sections. All of that is edited here, and
// the sections strip is the piece that makes an audio take workable — mute a
// breath, split around a phrase, drag the phrase somewhere else.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { sampleMeta, getBuffer, cachedBuffer } from '../audio/samples.js';
import { getContext } from '../audio/context.js';
import { cropBuffer } from '../audio/edit.js';
import { el, clear, sheet, slider, icon, ICONS, toast, confirmSheet } from './dom.js';
import { openTuneSheet } from './tunesheet.js';
import { openPitchEditor } from './pitcheditor.js';
import { openSampleEditor } from './sampleeditor.js';
import { drawWave, fmtTime } from './waveform.js';

export function openClipSheet(clip, { onChange } = {}) {
  const track = S.trackById(clip.trackId);
  const isAudio = clip.kind === 'audio';
  const title = isAudio
    ? (sampleMeta(clip.sampleId)?.name || 'Audio clip')
    : (S.patternById(clip.patternId)?.name || 'Pattern clip');

  sheet(title, (body, close) => {
    const done = () => { S.touch(); onChange && onChange(); };
    const reopen = () => { close(); openClipSheet(clip, { onChange }); };

    /* ------------------------------------------------------- position */

    const posVal = el('span', { class: 'val' }, '');
    const lenVal = el('span', { class: 'val' }, '');
    const paintPos = () => {
      posVal.textContent = positionLabel(clip.start);
      lenVal.textContent = lengthLabel(clip);
    };

    const nudge = (steps) => {
      const max = S.songSteps() - clip.length;
      const next = Math.max(0, Math.min(max, clip.start + steps));
      if (next === clip.start) return;
      S.checkpoint();
      clip.start = next;
      paintPos();
      done();
    };

    const resize = (steps) => {
      const next = Math.max(1, Math.min(S.songSteps() - clip.start, clip.length + steps));
      if (next === clip.length) return;
      S.checkpoint();
      clip.length = next;
      // A stretched clip fits the same audio into the new length, so the
      // muted sections still mean what they meant.
      if (!clip.stretch) clip.mutes = (clip.mutes || []).filter((s) => s < next);
      paintPos();
      buildSections();
      done();
    };

    /**
     * A value with its nudges underneath. Four buttons plus a readout do not
     * fit on one line at 375 px, and a stepper that wraps mid-row is worse
     * than one that was designed to be two.
     */
    const stepper = (label, valueNode, buttons) => el('div', { class: 'stepblock' },
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, label), valueNode),
      el('div', { class: 'btnrow' }, buttons),
    );

    /* ------------------------------------------------------- sections */

    const sections = el('div', { class: 'card' });

    function buildSections() {
      clear(sections);
      const cell = cellSteps(clip.length);
      const cells = Math.ceil(clip.length / cell);
      const strip = el('div', { class: 'secstrip' });
      const wave = isAudio ? el('canvas', { class: 'secwave' }) : null;
      if (wave) strip.append(wave);

      let paintTo = null;
      const toggle = (i) => {
        const steps = [];
        for (let s = i * cell; s < Math.min(clip.length, (i + 1) * cell); s++) steps.push(s);
        if (paintTo === null) paintTo = !S.stepMuted(clip, steps[0]);
        S.setClipMutes(clip, steps, paintTo);
        strip.children[i + (wave ? 1 : 0)].classList.toggle('muted', paintTo);
        done();
      };

      for (let i = 0; i < cells; i++) {
        const muted = S.stepMuted(clip, i * cell);
        const box = el('div', {
          class: `seccell${muted ? ' muted' : ''}${(i * cell) % S.STEPS_PER_BAR === 0 ? ' barline' : ''}`,
          style: { width: `${100 / cells}%` },
          dataset: { i: String(i) },
        });
        strip.append(box);
      }

      strip.addEventListener('pointerdown', (e) => {
        const box = e.target.closest('.seccell');
        if (!box) return;
        e.preventDefault();
        S.checkpoint();
        paintTo = null;
        toggle(+box.dataset.i);
        strip.setPointerCapture(e.pointerId);
      });
      strip.addEventListener('pointermove', (e) => {
        if (paintTo === null || e.buttons === 0) return;
        const box = document.elementFromPoint(e.clientX, e.clientY)?.closest('.seccell');
        if (box && strip.contains(box)) toggle(+box.dataset.i);
      });
      strip.addEventListener('pointerup', () => { paintTo = null; });

      sections.append(
        el('h3', {}, 'Sections',
          el('span', { class: 'r' }, (clip.mutes || []).length
            ? `${(clip.mutes || []).length} steps muted`
            : `one cell = ${cellLabel(cell)}`)),
        strip,
        el('div', { class: 'btnrow', style: { marginTop: '8px' } },
          el('button', {
            class: 'btn',
            onclick: () => {
              S.checkpoint();
              clip.mutes = [];
              buildSections();
              done();
            },
          }, 'Unmute all'),
          el('button', {
            class: 'btn',
            onclick: () => {
              const at = Math.round(S.state.playhead || 0);
              if (at <= clip.start || at >= clip.start + clip.length) {
                toast('Move the cursor inside the clip first — tap the bar ruler', 'err');
                return;
              }
              S.checkpoint();
              const right = S.splitClip(clip, at);
              if (right) S.state.selectedClipId = right.id;
              close();
              done();
              toast('Clip split — drag either half', 'ok');
            },
          }, icon(ICONS.cut, 18), 'Split at cursor'),
        ),
        el('p', { class: 'hint' },
          'Tap or drag across the strip to silence a stretch. Muting is not destructive — the audio is still there, and unmuting brings it back.'),
      );

      if (wave) {
        requestAnimationFrame(() => {
          const buf = cachedBuffer(clip.sampleId);
          if (!buf) return;
          // The strip spans the clip; the audio under it is however much
          // sample the clip covers, which a stretch changes.
          const secs = S.clipSourceSeconds(clip);
          drawWave(wave, buf, {
            view: { from: clip.offset || 0, to: (clip.offset || 0) + secs },
            colour: 'rgba(255,255,255,.45)',
            background: 'rgba(0,0,0,0)',
          });
        });
      }
    }

    /* ----------------------------------------------------------- build */

    body.append(el('div', { class: 'card' },
      el('h3', {}, 'Clip', el('span', { class: 'r' }, track ? track.name : '')),
      stepper('Position', posVal, [
        el('button', { class: 'btn', 'aria-label': 'Back one bar', onclick: () => nudge(-S.STEPS_PER_BAR) }, '− bar'),
        el('button', { class: 'btn', 'aria-label': 'Back one beat', onclick: () => nudge(-S.STEPS_PER_BEAT) }, '− beat'),
        el('button', { class: 'btn', 'aria-label': 'Back one 16th', onclick: () => nudge(-1) }, '−'),
        el('button', { class: 'btn', 'aria-label': 'On one 16th', onclick: () => nudge(1) }, '+'),
        el('button', { class: 'btn', 'aria-label': 'On one beat', onclick: () => nudge(S.STEPS_PER_BEAT) }, '+ beat'),
        el('button', { class: 'btn', 'aria-label': 'On one bar', onclick: () => nudge(S.STEPS_PER_BAR) }, '+ bar'),
      ]),
      stepper('Length', lenVal, [
        el('button', { class: 'btn', 'aria-label': 'One bar shorter', onclick: () => resize(-S.STEPS_PER_BAR) }, '− bar'),
        el('button', { class: 'btn', 'aria-label': 'One beat shorter', onclick: () => resize(-S.STEPS_PER_BEAT) }, '− beat'),
        el('button', { class: 'btn', 'aria-label': 'One 16th shorter', onclick: () => resize(-1) }, '−'),
        el('button', { class: 'btn', 'aria-label': 'One 16th longer', onclick: () => resize(1) }, '+'),
        el('button', { class: 'btn', 'aria-label': 'One beat longer', onclick: () => resize(S.STEPS_PER_BEAT) }, '+ beat'),
        el('button', { class: 'btn', 'aria-label': 'One bar longer', onclick: () => resize(S.STEPS_PER_BAR) }, '+ bar'),
      ]),
      slider('Level', {
        min: 0, max: 1.5, step: 0.01, value: clip.gain ?? 1,
        format: (v) => `${Math.round(v * 100)}%`,
        oninput: (v) => { clip.gain = v; done(); },
      }),
    ));

    buildSections();
    body.append(sections);

    if (!isAudio) {
      body.append(el('div', { class: 'card' },
        el('h3', {}, 'Pattern'),
        el('button', {
          class: 'btn wide',
          onclick: () => openPatternPicker({
            selectedId: clip.patternId,
            onPick: (id) => { clip.patternId = id; close(); done(); },
          }),
        }, icon(ICONS.copy, 18), S.patternById(clip.patternId)?.name || 'Choose…'),
        stepper('Starts at step',
          el('span', { class: 'val' }, String(clip.offsetSteps || 0)), [
            el('button', { class: 'btn', onclick: () => shiftPattern(-1) }, 'earlier'),
            el('button', { class: 'btn', onclick: () => shiftPattern(1) }, 'later'),
          ]),
        el('p', { class: 'hint' },
          'A clip longer than its pattern repeats it; editing the pattern updates every clip that uses it. "Starts at step" rotates which part of the pattern lands on the clip’s first beat.'),
      ));
    } else {
      buildAudioCard();
    }

    function shiftPattern(by) {
      const pat = S.patternById(clip.patternId);
      const span = Math.max(1, (pat?.bars || 4) * S.STEPS_PER_BAR);
      S.checkpoint();
      clip.offsetSteps = ((clip.offsetSteps || 0) + by + span) % span;
      done();
      reopen();
    }

    function buildAudioCard() {
      const meta = sampleMeta(clip.sampleId);
      const tuned = clip.sampleId !== clip.sourceSampleId;
      const secs = clip.length * S.secondsPerStep();
      const maxFade = Math.max(0.01, secs / 2);
      const sampleSecs = meta?.duration || 0;
      const offset = clip.offset || 0;

      const trimRow = stepper('Start inside the sample',
        el('span', { class: 'val' }, fmtTime(offset)), [
          el('button', { class: 'btn', onclick: () => shiftOffset(-S.STEPS_PER_BEAT) }, '− beat'),
          el('button', { class: 'btn', onclick: () => shiftOffset(-1) }, '−'),
          el('button', { class: 'btn', onclick: () => shiftOffset(1) }, '+'),
          el('button', { class: 'btn', onclick: () => shiftOffset(S.STEPS_PER_BEAT) }, '+ beat'),
        ]);

      const card = el('div', { class: 'card' },
        el('h3', {}, 'Audio', el('span', { class: 'r' },
          meta ? `${fmtTime(sampleSecs)} sample` : 'missing sample')),
        el('div', { class: 'btnrow' },
          el('button', {
            class: 'btn',
            onclick: async () => {
              const buf = await getBuffer(clip.sampleId);
              if (!buf) { toast('That sample is gone', 'err'); return; }
              const from = Math.min(offset, buf.duration);
              const to = Math.min(buf.duration, from + secs);
              engine.auditionBuffer(
                to - from < buf.duration ? cropBuffer(getContext(), buf, from, to) : buf,
                clip.gain ?? 1,
              );
            },
          }, icon(ICONS.play, 18), 'Play clip'),
          el('button', {
            class: 'btn',
            onclick: () => {
              close();
              openSampleEditor(clip.sampleId, {
                onSaved: () => { done(); },
              });
            },
          }, icon(ICONS.cut, 18), 'Edit sample…'),
        ),
        trimRow,
        el('div', { class: 'btnrow', style: { marginTop: '4px' } },
          el('button', {
            class: 'btn',
            onclick: () => {
              if (!sampleSecs) return;
              S.checkpoint();
              if (clip.stretch) {
                // Stretched, "fit" means the other way round: the rest of the
                // sample is squeezed into the length the clip already has.
                clip.stretchSrc = Math.max(0.05, sampleSecs - offset);
              } else {
                const steps = Math.max(1, Math.ceil((sampleSecs - offset) / S.secondsPerStep()));
                clip.length = Math.min(steps, S.songSteps() - clip.start);
              }
              done();
              reopen();
            },
          }, clip.stretch ? 'Fit sample to clip' : 'Fit to sample'),
          el('button', {
            class: `btn${clip.loop ? ' primary' : ''}`,
            onclick: (e) => {
              clip.loop = !clip.loop;
              e.currentTarget.classList.toggle('primary', clip.loop);
              done();
            },
          }, clip.loop ? 'Looping' : 'Loop off'),
        ),
        el('div', { class: 'btnrow', style: { marginTop: '4px' } },
          el('button', {
            class: `btn${clip.stretch ? ' primary' : ''}`,
            onclick: () => {
              S.checkpoint();
              S.setClipStretch(clip, !clip.stretch);
              done();
              reopen();
            },
          }, icon(ICONS.wave, 18),
          clip.stretch ? `Stretching ${S.clipSpeed(clip).toFixed(2)}x` : 'Stretch off'),
          clip.stretch ? el('button', {
            class: `btn${clip.tape ? ' primary' : ''}`,
            onclick: () => {
              clip.tape = !clip.tape;
              done();
              reopen();
            },
          }, clip.tape ? 'Tape' : 'Keep pitch') : null,
        ),
        clip.stretch ? el('p', { class: 'hint' },
          `With stretch on, the length buttons above fit ${fmtTime(S.clipSourceSeconds(clip))} of audio into the clip instead of trimming it${clip.tape ? ' — “Tape” resamples, so the pitch moves with the speed.' : ' — the pitch stays where it was.'}`) : null,
        slider('Fade in', {
          min: 0, max: maxFade, step: 0.005, value: Math.min(clip.fadeIn || 0, maxFade),
          format: (v) => (v < 0.005 ? 'none' : fmtTime(v)),
          oninput: (v) => { clip.fadeIn = v; done(); },
        }),
        slider('Fade out', {
          min: 0, max: maxFade, step: 0.005, value: Math.min(clip.fadeOut || 0, maxFade),
          format: (v) => (v < 0.005 ? 'none' : fmtTime(v)),
          oninput: (v) => { clip.fadeOut = v; done(); },
        }),
        el('div', { class: 'btnrow', style: { marginTop: '6px' } },
          el('button', {
            class: `btn${tuned ? ' primary' : ''}`,
            onclick: () => { close(); openTuneSheet(clip, { onChange }); },
          }, icon(ICONS.tune, 18), tuned ? 'Retune…' : 'Autotune…'),
          el('button', {
            class: `btn${clip.pitchEdits ? ' primary' : ''}`,
            onclick: () => { close(); openPitchEditor(clip, { onChange }); },
          }, icon(ICONS.pencil, 18), 'Pitch editor…'),
          tuned ? el('button', {
            class: 'btn',
            onclick: () => {
              S.checkpoint();
              clip.sampleId = clip.sourceSampleId;
              clip.pitchEdits = null;
              close();
              toast('Back to the original take');
              done();
            },
          }, 'Revert') : null,
        ),
        el('p', { class: 'hint' },
          'The pitch editor cuts the take into notes you can drag in pitch and in time — one wrong note is a drag, not a re-record.'),
      );
      body.append(card);

      function shiftOffset(dir) {
        const step = S.secondsPerStep();
        S.checkpoint();
        clip.offset = Math.max(0, Math.min(Math.max(0, sampleSecs - 0.01), (clip.offset || 0) + dir * step));
        done();
        reopen();
      }
    }

    body.append(el('div', { class: 'btnrow' },
      el('button', {
        class: 'btn',
        onclick: () => {
          const copy = { ...clip, id: S.uid('clip'), mutes: [...(clip.mutes || [])], start: clip.start + clip.length };
          if (copy.start + copy.length > S.songSteps()) { toast('No room after this clip', 'err'); return; }
          S.checkpoint();
          S.addClip(copy);
          S.state.selectedClipId = copy.id;
          close();
          done();
          toast('Clip duplicated', 'ok');
        },
      }, icon(ICONS.copy, 18), 'Duplicate'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!await confirmSheet('Delete clip?', 'It is removed from the playlist. The pattern or recording itself is kept.')) return;
          S.checkpoint();
          S.removeClip(clip.id);
          close();
          done();
        },
      }, icon(ICONS.trash, 18), 'Delete'),
    ));

    paintPos();
  });
}

const cellLabel = (cell) => (cell === 1 ? 'a 16th'
  : cell === 2 ? 'an 8th'
  : cell === S.STEPS_PER_BEAT ? 'a beat'
  : `${cell / S.STEPS_PER_BAR} bar${cell === S.STEPS_PER_BAR ? '' : 's'}`);

/** How many steps one cell of the sections strip covers. */
function cellSteps(length) {
  if (length <= 32) return 1;
  if (length <= 64) return 2;
  if (length <= 256) return S.STEPS_PER_BEAT;
  return S.STEPS_PER_BAR;
}

const positionLabel = (start) => {
  const bar = Math.floor(start / S.STEPS_PER_BAR) + 1;
  const beat = Math.floor((start % S.STEPS_PER_BAR) / S.STEPS_PER_BEAT) + 1;
  const tick = start % S.STEPS_PER_BEAT;
  return tick ? `${bar}.${beat}.${tick}` : `${bar}.${beat}`;
};

const lengthLabel = (clip) => {
  const bars = clip.length / S.STEPS_PER_BAR;
  if (Number.isInteger(bars)) return `${bars} bar${bars === 1 ? '' : 's'}`;
  const beats = clip.length / S.STEPS_PER_BEAT;
  if (Number.isInteger(beats)) return `${beats} beats`;
  return `${clip.length}/16`;
};

/* ------------------------------------------------------------ patterns */

export function openPatternPicker({ selectedId = null, onPick, manage = false } = {}) {
  sheet(manage ? 'Patterns' : 'Choose a pattern', (body, close) => {
    const list = el('div', { class: 'slist' });

    const paint = () => {
      list.replaceChildren();
      for (const pat of S.project().patterns) {
        const used = S.project().clips.filter((c) => c.patternId === pat.id).length;
        const notes = Object.values(pat.notes).reduce((a, l) => a + l.length, 0);
        list.append(el('div', { class: `sitem${pat.id === selectedId ? ' sel' : ''}` },
          el('span', { class: 'play', style: { background: pat.color, color: '#05121a' } },
            icon(ICONS.copy, 15)),
          el('button', {
            class: 'meta',
            onclick: () => {
              if (onPick) { onPick(pat.id); close(); }
              else { S.setActivePattern(pat.id); close(); }
            },
          },
            el('b', {}, pat.name),
            el('span', {}, `${pat.bars} bars · ${notes} notes · used ${used}×`)),
          manage ? el('button', {
            class: 'kill', 'aria-label': `Delete ${pat.name}`,
            onclick: async () => {
              if (S.project().patterns.length <= 1) { toast('Keep at least one pattern', 'err'); return; }
              const warn = used
                ? `“${pat.name}” is used by ${used} clip${used === 1 ? '' : 's'}, which will be removed too.`
                : `“${pat.name}” will be removed.`;
              if (!await confirmSheet('Delete pattern?', warn)) return;
              S.checkpoint();
              S.removePattern(pat.id);
              paint();
            },
          }, icon(ICONS.trash, 18)) : null,
        ));
      }
    };

    body.append(list);
    if (manage) {
      body.append(el('div', { class: 'btnrow', style: { marginTop: '12px' } },
        el('button', {
          class: 'btn',
          onclick: () => { S.checkpoint(); S.addPattern(); close(); },
        }, icon(ICONS.plus, 18), 'New pattern'),
        el('button', {
          class: 'btn',
          onclick: () => { S.checkpoint(); S.duplicatePattern(S.project().activePatternId); close(); },
        }, icon(ICONS.copy, 18), 'Duplicate current'),
      ));
    }
    paint();
  });
}
