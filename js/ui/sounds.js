// "Sound" tab — instrument editor for the selected track.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { sampleMeta, analyseRoot } from '../audio/samples.js';
import { noteLabel } from '../theory.js';
import { el, clear, icon, ICONS, slider, sheet, toast, confirmSheet } from './dom.js';
import { openSampleSheet } from './library.js';
import { openSampleEditor } from './sampleeditor.js';
import { renderFxRack } from './fxrack.js';
import { createSynthScope } from './synthscope.js';
import { SYNTH_PRESETS } from '../audio/synthpresets.js';

const WAVES = [
  ['sawtooth', 'Saw'], ['square', 'Square'], ['triangle', 'Tri'], ['sine', 'Sine'],
  ['pulse', 'Pulse'], ['organ', 'Organ'], ['hollow', 'Hollow'], ['bright', 'Bright'],
];
const WAVES2 = [['off', 'Off'], ...WAVES];

const FILTERS = [['lowpass', 'Low'], ['highpass', 'High'], ['bandpass', 'Band'], ['notch', 'Notch']];
const LFO_TARGETS = [['off', 'Off'], ['pitch', 'Pitch'], ['filter', 'Filter'], ['amp', 'Amp']];

// The scope owns a ResizeObserver and an async render, so the previous one
// has to be released whenever this view is rebuilt.
let scope = null;

export function renderSounds(container, { onChange }) {
  const track = S.selectedTrack();
  if (scope) { scope.destroy(); scope = null; }
  clear(container);
  const inner = el('div', { class: 'inner' });
  container.append(inner);

  if (!track) {
    inner.append(el('div', { class: 'empty' }, 'Add a track to start.'));
    return;
  }

  const repaint = () => { renderSounds(container, { onChange }); onChange && onChange(); };

  inner.append(trackCard(track, repaint));

  if (track.type === 'synth') inner.append(...synthCards(track, onChange, repaint));
  if (track.type === 'sampler') inner.append(samplerCard(track, repaint));
  if (track.type === 'drum') inner.append(padsCard(track, repaint));
  if (track.type === 'audio') inner.append(audioCard(track));

  inner.append(sidechainCard(track, repaint));

  const fxHost = el('div');
  inner.append(el('div', { class: 'card' },
    el('h3', {}, 'Effects', el('span', { class: 'r' }, `${(track.fx || []).length} in chain`)),
    fxHost,
  ));
  renderFxRack(fxHost, track, { onChange });
}

/* ---------------------------------------------------------- sidechain */

// A kit's kick is a pad, not a channel, so picking a drum track as the
// trigger has to pick a pad too — this is the opening guess, and the pad
// pills below let it be corrected.
const KICK_NAME = /kick|bass ?drum|\bbd\b|\bkik\b/i;

function guessKickPad(track) {
  const i = (track.pads || []).findIndex((p) => KICK_NAME.test(p.name || ''));
  return i >= 0 ? i : 0;
}

function triggerLabel(track) {
  const sc = track.sidechain;
  const src = sc && sc.sourceId ? S.trackById(sc.sourceId) : null;
  if (!src) return 'Nothing';
  if (src.type === 'drum' && sc.sourcePad != null) {
    const pad = (src.pads || [])[sc.sourcePad];
    return `${src.name} · ${pad ? pad.name || `Pad ${sc.sourcePad + 1}` : `Pad ${sc.sourcePad + 1}`}`;
  }
  return src.name;
}

function sidechainCard(track, repaint) {
  if (!track.sidechain) track.sidechain = S.defaultSidechain();
  const sc = track.sidechain;
  const src = sc.sourceId ? S.trackById(sc.sourceId) : null;
  const live = S.isDucked(track);
  const apply = () => { S.touch(); engine.syncMixer(); };

  const card = el('div', { class: 'card' },
    el('h3', {}, 'Sidechain',
      el('span', { class: 'r' }, live ? `ducked by ${triggerLabel(track)}` : 'off')),
  );

  card.append(el('div', { class: 'row' },
    el('span', { class: 'lbl' }, 'Trigger'),
    el('button', {
      class: 'btn', style: { flex: '1' },
      onclick: () => openTriggerSheet(track, { onChange: repaint }),
    }, icon(ICONS.wave, 16), triggerLabel(track)),
    el('button', {
      class: `btn${sc.on ? ' primary' : ''}`,
      disabled: !src,
      onclick: () => { sc.on = !sc.on; apply(); repaint(); },
    }, sc.on ? 'On' : 'Off'),
  ));

  if (src && src.type === 'drum') {
    const pads = el('div', { class: 'pills' },
      [['any', 'Any hit'], ...(src.pads || []).map((p, i) => [i, p.name || `Pad ${i + 1}`])]
        .map(([value, label]) => {
          const on = value === 'any' ? sc.sourcePad == null : sc.sourcePad === value;
          return el('button', {
            class: `pill${on ? ' on' : ''}`,
            onclick: () => { sc.sourcePad = value === 'any' ? null : value; apply(); repaint(); },
          }, label);
        }));
    card.append(el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'Pad'), pads));
  }

  if (src) {
    card.append(
      slider('Amount', {
        min: 0, max: 1, step: 0.01, value: sc.amount,
        format: (v) => `${Math.round(v * 100)}%`,
        oninput: (v) => { sc.amount = v; S.touch(); },
      }),
      slider('Duck time', {
        min: 0.002, max: 0.12, step: 0.002, value: sc.attack,
        format: (v) => `${Math.round(v * 1000)} ms`,
        oninput: (v) => { sc.attack = v; S.touch(); },
      }),
      slider('Recovery', {
        min: 0.02, max: 0.8, step: 0.01, value: sc.release,
        format: (v) => `${Math.round(v * 1000)} ms`,
        oninput: (v) => { sc.release = v; S.touch(); },
      }),
    );
  }

  card.append(el('p', { class: 'hint' },
    src
      ? 'The whole channel — effect tails included — is pulled down on every trigger hit and let back up over the recovery time. It follows the notes, not the sound, so it lands the same way in an export.'
      : 'Pick a trigger to make this channel duck out of its way — a bass ducking under a kick is the usual one.'));
  return card;
}

function openTriggerSheet(track, { onChange } = {}) {
  sheet(`Sidechain · ${track.name}`, (body, close) => {
    const sc = track.sidechain;
    const pick = (t) => {
      S.checkpoint();
      if (!t) {
        sc.sourceId = null;
        sc.sourcePad = null;
        sc.on = false;
      } else {
        sc.sourceId = t.id;
        sc.sourcePad = t.type === 'drum' ? guessKickPad(t) : null;
        sc.on = true;
      }
      S.touch();
      engine.syncMixer();
      close();
      toast(t ? `${track.name} ducks under ${triggerLabel(track)}` : 'Sidechain off', 'ok');
      onChange && onChange();
    };

    body.append(el('div', { class: 'slist' },
      el('button', {
        class: 'sitem', style: { width: '100%' },
        onclick: () => pick(null),
      },
        el('span', { class: 'play' }, icon(ICONS.close, 15)),
        el('span', { class: 'meta' }, el('b', {}, 'Nothing'), el('span', {}, 'No ducking on this channel')),
      ),
      S.project().tracks.filter((t) => t.id !== track.id).map((t) => el('button', {
        class: 'sitem', style: { width: '100%' },
        onclick: () => pick(t),
      },
        el('span', { class: 'play', style: { color: t.color } }, icon(ICONS.wave, 15)),
        el('span', { class: 'meta' },
          el('b', {}, t.name),
          el('span', {}, t.type === 'drum' ? 'kit — one pad triggers' : t.type)),
      )),
    ));
  });
}

/* -------------------------------------------------------------- audio */

function audioCard(track) {
  const clips = S.clipsOfTrack(track.id);
  return el('div', { class: 'card' },
    el('h3', {}, 'Audio channel', el('span', { class: 'r' }, `${clips.length} clip${clips.length === 1 ? '' : 's'}`)),
    el('p', { class: 'hint', style: { margin: '0 0 6px' } },
      'Record straight onto this channel from the Playlist tab, or drop an audio file on the window and place it from the clip menu.'),
  );
}

/* ------------------------------------------------------------- shared */

function trackCard(track, repaint) {
  const name = el('input', {
    type: 'text', value: track.name, maxlength: '24',
    onchange: (e) => { track.name = e.target.value.trim() || 'Track'; S.touch(); repaint(); },
  });

  const colors = el('div', { class: 'pills' },
    S.TRACK_COLORS.map((c) => el('button', {
      class: 'pill',
      style: { background: c, borderColor: c, minWidth: '34px', width: '34px', height: '34px', padding: '0', opacity: track.color === c ? '1' : '.45' },
      'aria-label': `Colour ${c}`,
      onclick: () => { track.color = c; S.touch(); repaint(); },
    })));

  return el('div', { class: 'card' },
    el('h3', {}, 'Track', el('span', { class: 'r' }, track.type)),
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Name'), name),
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Colour'), colors),
    el('div', { class: 'btnrow', style: { marginTop: '10px' } },
      el('button', {
        class: 'btn',
        onclick: () => {
          S.checkpoint();
          const copy = structuredClone(track);
          copy.id = S.uid('trk');
          copy.name = `${track.name} 2`;
          const at = S.project().tracks.indexOf(track) + 1;
          S.project().tracks.splice(at, 0, copy);
          // Notes live on the patterns now, one list per track — the copy
          // gets its own in every pattern the original played in.
          for (const pat of S.project().patterns) {
            const notes = pat.notes[track.id];
            if (notes) pat.notes[copy.id] = notes.map((n) => ({ ...n, id: S.uid('n') }));
          }
          S.state.selectedTrackId = copy.id;
          S.touch();
          S.emit('tracks');
          repaint();
        },
      }, icon(ICONS.copy, 18), 'Duplicate'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (S.project().tracks.length <= 1) { toast('Keep at least one track', 'err'); return; }
          if (!await confirmSheet('Delete track?', `“${track.name}” and its notes will be removed.`)) return;
          S.checkpoint();
          const list = S.project().tracks;
          list.splice(list.indexOf(track), 1);
          S.state.selectedTrackId = list[0].id;
          S.touch();
          S.emit('tracks');
          repaint();
        },
      }, icon(ICONS.trash, 18), 'Delete'),
    ),
  );
}

/* -------------------------------------------------------------- synth */

function synthCards(track, onChange, repaint) {
  const s = track.synth;
  // Every edit touches the store, redraws the scope and lets the app know —
  // one path, so no control can quietly skip the display.
  const set = (k, v) => {
    s[k] = v;
    S.touch();
    if (scope) scope.update();
    onChange && onChange();
  };

  const canvas = el('canvas', { class: 'scope' });
  const ms = (v) => `${(v * 1000).toFixed(0)}ms`;
  const pct = (v) => `${Math.round(v * 100)}%`;

  /** A row of mutually exclusive pills bound to one patch field. */
  const pills = (label, options, key, { preview = false } = {}) => {
    const row = el('div', { class: 'pills' },
      options.map(([value, text]) => {
        const b = el('button', {
          class: `pill${s[key] === value ? ' on' : ''}`,
          onclick: () => {
            set(key, value);
            [...row.children].forEach((c) => c.classList.toggle('on', c === b));
            if (preview) engine.preview(track, 60, 'sound');
          },
        }, text);
        return b;
      }));
    return el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, label), row);
  };

  const presets = el('div', { class: 'pills' },
    SYNTH_PRESETS.map((p) => el('button', {
      class: 'pill',
      onclick: () => {
        S.checkpoint();
        track.synth = { ...S.defaultSynth(), ...p.patch };
        S.touch();
        engine.preview(track, 60, 'sound');
        repaint();
      },
    }, p.name)));

  const scopeCard = el('div', { class: 'card' },
    el('h3', {}, 'Synth',
      el('button', { class: 'r', onclick: () => engine.preview(track, 60, 'sound') }, '▶ Test')),
    canvas,
    el('p', { class: 'hint', style: { margin: '6px 2px 10px' } },
      'One note as it is actually rendered: the whole envelope above, a few cycles of the tone below. The dashed line is where the key comes up.'),
    el('div', { class: 'row wrap' }, el('span', { class: 'lbl' }, 'Preset'), presets),
  );

  const oscCard = el('div', { class: 'card' },
    el('h3', {}, 'Oscillators'),
    pills('Wave', WAVES, 'wave', { preview: true }),
    slider('Voices', {
      min: 1, max: 7, step: 1, value: s.voices ?? 2,
      format: (v) => (v === 1 ? 'single' : `${v} unison`),
      oninput: (v) => set('voices', v),
    }),
    slider('Detune', { min: 0, max: 40, step: 1, value: s.detune, format: (v) => `${v}¢`, oninput: (v) => set('detune', v) }),
    slider('Octave', { min: -2, max: 2, step: 1, value: s.octave, format: (v) => (v > 0 ? `+${v}` : String(v)), oninput: (v) => set('octave', v) }),
    el('h3', { style: { marginTop: '14px' } }, 'Oscillator 2'),
    pills('Wave', WAVES2, 'wave2', { preview: true }),
    slider('Interval', {
      min: -24, max: 24, step: 1, value: s.osc2Semi ?? -12,
      format: (v) => `${v > 0 ? '+' : ''}${v} st`,
      oninput: (v) => set('osc2Semi', v),
    }),
    slider('Level', { min: 0, max: 1, step: .01, value: s.osc2Level ?? 0.5, format: pct, oninput: (v) => set('osc2Level', v) }),
    el('h3', { style: { marginTop: '14px' } }, 'Mix in'),
    slider('Sub', { min: 0, max: 1, step: .01, value: s.subLevel ?? 0, format: (v) => (v < 0.005 ? 'off' : pct(v)), oninput: (v) => set('subLevel', v) }),
    slider('Noise', { min: 0, max: 1, step: .01, value: s.noiseLevel ?? 0, format: (v) => (v < 0.005 ? 'off' : pct(v)), oninput: (v) => set('noiseLevel', v) }),
    slider('Drive', { min: 0, max: 1, step: .01, value: s.drive ?? 0, format: (v) => (v < 0.005 ? 'clean' : pct(v)), oninput: (v) => set('drive', v) }),
  );

  const filterCard = el('div', { class: 'card' },
    el('h3', {}, 'Filter'),
    pills('Type', FILTERS, 'filterType'),
    slider('Cutoff', { min: 40, max: 14000, step: 10, value: s.cutoff, format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`), oninput: (v) => set('cutoff', v) }),
    slider('Resonance', { min: 0.5, max: 18, step: .5, value: s.resonance, format: (v) => v.toFixed(1), oninput: (v) => set('resonance', v) }),
    slider('Env amount', { min: 0, max: 1, step: .01, value: s.filterEnv, format: pct, oninput: (v) => set('filterEnv', v) }),
    slider('Env attack', { min: 0.001, max: 2, step: .001, value: s.filterAttack ?? s.attack, format: ms, oninput: (v) => set('filterAttack', v) }),
    slider('Env decay', { min: 0.01, max: 3, step: .01, value: s.filterDecay ?? s.decay, format: ms, oninput: (v) => set('filterDecay', v) }),
    el('p', { class: 'hint' }, 'The filter has its own attack and decay, so a slow sweep can sit under a short note.'),
  );

  const envCard = el('div', { class: 'card' },
    el('h3', {}, 'Envelope'),
    slider('Attack', { min: 0.001, max: 2, step: .001, value: s.attack, format: ms, oninput: (v) => set('attack', v) }),
    slider('Decay', { min: 0.01, max: 3, step: .01, value: s.decay, format: ms, oninput: (v) => set('decay', v) }),
    slider('Sustain', { min: 0, max: 1, step: .01, value: s.sustain, format: pct, oninput: (v) => set('sustain', v) }),
    slider('Release', { min: 0.01, max: 4, step: .01, value: s.release, format: ms, oninput: (v) => set('release', v) }),
  );

  const modCard = el('div', { class: 'card' },
    el('h3', {}, 'Modulation'),
    pills('LFO to', LFO_TARGETS, 'lfoTarget'),
    slider('LFO rate', {
      min: 0.05, max: 14, step: .05, value: s.lfoRate ?? 5,
      format: (v) => `${v.toFixed(2)} Hz`, oninput: (v) => set('lfoRate', v),
    }),
    slider('LFO depth', { min: 0, max: 1, step: .01, value: s.lfoDepth ?? 0.3, format: pct, oninput: (v) => set('lfoDepth', v) }),
    slider('Glide', {
      min: 0, max: 0.6, step: .005, value: s.glide ?? 0,
      format: (v) => (v < 0.003 ? 'off' : ms(v)), oninput: (v) => set('glide', v),
    }),
    slider('Level', { min: 0, max: 1.5, step: .01, value: s.level ?? 1, format: pct, oninput: (v) => set('level', v) }),
    el('p', { class: 'hint' }, 'Glide slides into a note from the one before it on the same track — set it above zero for a lead or a 303 line.'),
  );

  scope = createSynthScope(canvas, { getSynth: () => track.synth, colour: track.color });
  return [scopeCard, oscCard, filterCard, envCard, modCard];
}

/* ------------------------------------------------------------ sampler */

function samplerCard(track, repaint) {
  const meta = track.sampleId ? sampleMeta(track.sampleId) : null;

  const rootRow = el('div', { class: 'row' },
    el('span', { class: 'lbl' }, 'Root note'),
    el('div', { class: 'btnrow', style: { flex: '1' } },
      el('button', { class: 'btn step', 'aria-label': 'Down a semitone', onclick: () => { track.rootNote = Math.max(12, track.rootNote - 1); S.touch(); repaint(); } }, '−'),
      el('span', { class: 'stepval' }, noteLabel(track.rootNote)),
      el('button', { class: 'btn step', 'aria-label': 'Up a semitone', onclick: () => { track.rootNote = Math.min(108, track.rootNote + 1); S.touch(); repaint(); } }, '+'),
    ));

  const loopBtn = el('button', {
    class: `btn${track.loop ? ' primary' : ''}`,
    onclick: () => { track.loop = !track.loop; S.touch(); repaint(); },
  }, track.loop ? 'Loop on' : 'Loop off');

  const sampleKey = meta && meta.rootNote != null ? meta.rootNote : null;
  const keyRow = meta ? el('div', { class: 'row wrap' },
    el('span', { class: 'lbl' }, 'Sample key'),
    el('div', { class: 'btnrow', style: { flex: '1' } },
      el('button', {
        class: 'btn',
        onclick: async () => {
          let key = sampleKey;
          if (key == null) {
            const found = await analyseRoot(track.sampleId);
            key = found ? found.rootNote : null;
            if (key == null) { toast('No steady pitch in that sample — set the root by hand', 'err'); return; }
          }
          S.checkpoint();
          track.rootNote = key;
          S.touch();
          repaint();
          toast(`Root set to ${noteLabel(key)}`, 'ok');
        },
      }, icon(ICONS.tune, 18), sampleKey != null ? `Match ${noteLabel(sampleKey)}` : 'Detect key'),
      el('button', {
        class: 'btn',
        onclick: () => openSampleEditor(track.sampleId, { onSaved: () => repaint() }),
      }, icon(ICONS.cut, 18), 'Edit…'),
    )) : null;

  return el('div', { class: 'card' },
    el('h3', {}, 'Sampler',
      el('button', { class: 'r', onclick: () => engine.preview(track, track.rootNote, 'sound') }, '▶ Test')),
    el('button', {
      class: 'sitem',
      style: { width: '100%' },
      onclick: () => openSampleSheet({
        title: 'Sampler sound',
        selectedId: track.sampleId,
        allowNone: true,
        onPick: (id) => {
          S.checkpoint();
          track.sampleId = id;
          // A sample that knows its own key maps itself: play G5 and you hear
          // G5, instead of the one-shot being stretched down from middle C.
          const m = id ? sampleMeta(id) : null;
          if (m && m.rootNote != null) {
            track.rootNote = m.rootNote;
            toast(`Mapped at ${noteLabel(m.rootNote)} — the key this sample is in`, 'ok');
          }
          S.touch();
          repaint();
        },
      }),
    },
      el('span', { class: 'play' }, icon(ICONS.folder, 16)),
      el('span', { class: 'meta' },
        el('b', {}, meta ? meta.name : 'Choose a sample…'),
        el('span', {}, meta ? `${meta.duration.toFixed(2)}s · plays at ${noteLabel(track.rootNote)}` : 'Nothing loaded — this track is silent')),
    ),
    rootRow,
    keyRow,
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Playback'), loopBtn),
    slider('Attack', { min: 0, max: 0.6, step: .001, value: track.attack, format: (v) => `${(v * 1000).toFixed(0)}ms`, oninput: (v) => { track.attack = v; S.touch(); } }),
    slider('Release', { min: 0.01, max: 1.5, step: .01, value: track.release, format: (v) => `${(v * 1000).toFixed(0)}ms`, oninput: (v) => { track.release = v; S.touch(); } }),
    el('p', { class: 'hint' }, 'The sample is pitched chromatically across the piano roll. “Root note” is the key where it plays back untransposed.'),
  );
}

/* --------------------------------------------------------------- pads */

function padsCard(track, repaint) {
  const grid = el('div', { class: 'padgrid' },
    track.pads.map((pad, i) => {
      const meta = pad.sampleId ? sampleMeta(pad.sampleId) : null;
      const node = el('button', {
        class: `pad${meta ? ' filled' : ''}`,
        style: { '--c': track.color },
        onclick: () => {
          engine.preview(track, i, `pad${i}`);
          node.classList.add('hit');
          setTimeout(() => node.classList.remove('hit'), 120);
        },
        oncontextmenu: (e) => { e.preventDefault(); openPadSheet(track, i, repaint); },
      },
        el('b', {}, pad.name || `Pad ${i + 1}`),
        el('span', {}, meta ? meta.name : 'built-in'),
      );
      return node;
    }));

  const editRow = el('div', { class: 'pills', style: { marginTop: '10px' } },
    track.pads.map((pad, i) => el('button', {
      class: 'pill',
      onclick: () => openPadSheet(track, i, repaint),
    }, `${i + 1}`)));

  return el('div', { class: 'card' },
    el('h3', {}, 'Drum pads', el('span', { class: 'r' }, 'tap to audition')),
    grid,
    el('h3', { style: { marginTop: '14px' } }, 'Edit pad'),
    editRow,
    el('p', { class: 'hint' }, 'Pads without a sample use a built-in synthesised drum, so a new kit makes sound right away.'),
  );
}

function openPadSheet(track, index, repaint) {
  const pad = track.pads[index];
  sheet(`Pad ${index + 1}`, (body, close) => {
    const meta = pad.sampleId ? sampleMeta(pad.sampleId) : null;

    const nameInput = el('input', {
      type: 'text', value: pad.name, maxlength: '18',
      onchange: (e) => { pad.name = e.target.value.trim() || `Pad ${index + 1}`; S.touch(); },
    });

    body.append(
      el('button', {
        class: 'sitem', style: { width: '100%', marginBottom: '12px' },
        onclick: () => openSampleSheet({
          title: `Pad ${index + 1} sound`,
          selectedId: pad.sampleId,
          allowNone: true,
          onPick: (id) => {
            S.checkpoint();
            pad.sampleId = id;
            if (id) {
              const m = sampleMeta(id);
              if (m && /^Pad \d+$/.test(pad.name)) pad.name = m.name.slice(0, 18);
            }
            S.touch();
            close();
            repaint();
          },
        }),
      },
        el('span', { class: 'play' }, icon(ICONS.folder, 16)),
        el('span', { class: 'meta' },
          el('b', {}, meta ? meta.name : 'Built-in drum sound'),
          el('span', {}, meta ? `${meta.duration.toFixed(2)}s` : 'Tap to load a sample')),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Label'), nameInput),
        slider('Level', { min: 0, max: 1.4, step: .01, value: pad.gain, format: (v) => `${Math.round(v * 100)}%`, oninput: (v) => { pad.gain = v; S.touch(); } }),
        slider('Pitch', { min: -24, max: 24, step: 1, value: pad.pitch || 0, format: (v) => `${v > 0 ? '+' : ''}${v} st`, oninput: (v) => { pad.pitch = v; S.touch(); } }),
      ),
      el('div', { class: 'btnrow' },
        el('button', { class: 'btn', onclick: () => engine.preview(track, index, `pad${index}`) }, icon(ICONS.play, 18), 'Audition'),
        pad.sampleId ? el('button', {
          class: 'btn',
          onclick: () => { close(); openSampleEditor(pad.sampleId, { onSaved: () => repaint() }); },
        }, icon(ICONS.cut, 18), 'Edit sample') : null,
        el('button', { class: 'btn primary', onclick: () => { close(); repaint(); } }, 'Done'),
      ),
    );
  });
}
