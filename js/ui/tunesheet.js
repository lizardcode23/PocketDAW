// Autotune controls for an audio clip. Analysis runs once and is reused, so
// dragging the strength slider only re-renders — it does not re-detect pitch.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { getContext } from '../audio/context.js';
import { getBuffer, importBuffer, sampleMeta } from '../audio/samples.js';
import { encodeWav } from '../audio/export.js';
import { detectPitch, planCorrection, retune, summarise } from '../audio/autotune.js';
import { NOTE_NAMES, SCALES, noteLabel } from '../theory.js';
import { el, sheet, slider, icon, ICONS, toast } from './dom.js';

const OPT_KEY = 'pdaw.tune';
const loadOpts = () => {
  const base = { strength: 0.85, speedMs: 30, chromatic: false };
  try { return { ...base, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; }
  catch { return base; }
};
const saveOpts = (o) => {
  try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* private mode */ }
};

export function openTuneSheet(clip, { onChange } = {}) {
  const opts = loadOpts();
  const scale = S.project().scale;

  sheet('Autotune', (body, close) => {
    const status = el('p', { class: 'hint' }, 'Analysing the take…');
    const graph = el('canvas', { class: 'tune-graph' });
    const controls = el('div');
    let source = null;      // the untouched recording
    let track = null;       // pitch analysis of it
    let preview = null;     // most recent retuned buffer

    const scaleLine = el('div', { class: 'row' },
      el('span', { class: 'lbl' }, 'Snap to'),
      el('div', { style: { flex: '1', fontSize: '13px', fontWeight: '600' } },
        `${NOTE_NAMES[scale.root]} ${SCALES[scale.type]?.name || ''}`),
    );

    const chromaticBtn = el('button', {
      class: `btn${opts.chromatic ? ' primary' : ''}`, style: { minWidth: '96px' },
      onclick: () => {
        opts.chromatic = !opts.chromatic;
        chromaticBtn.textContent = opts.chromatic ? 'Chromatic' : 'Project scale';
        chromaticBtn.classList.toggle('primary', opts.chromatic);
        scaleLine.style.opacity = opts.chromatic ? '.4' : '1';
        replan();
      },
    }, opts.chromatic ? 'Chromatic' : 'Project scale');
    scaleLine.style.opacity = opts.chromatic ? '.4' : '1';

    function planNow() {
      return planCorrection(track, {
        root: scale.root, scaleType: scale.type,
        strength: opts.strength, speedMs: opts.speedMs, chromatic: opts.chromatic,
      });
    }

    function replan() {
      if (!track) return;
      const plan = planNow();
      const sum = summarise(track, plan);
      drawGraph(graph, track, plan);
      status.textContent = sum.voicedSeconds < 0.05
        ? 'No pitched material found — this clip may be percussive or silent.'
        : `${sum.voicedSeconds.toFixed(1)}s of pitched audio · average nudge ${sum.averageCents.toFixed(0)} cents · biggest ${sum.maxCents.toFixed(0)} · notes ${sum.notes.map(noteLabel).join(' ')}`;
      preview = null;
      saveOpts(opts);
    }

    async function render() {
      if (preview) return preview;
      preview = retune(getContext(), source, {
        track,
        root: scale.root, scaleType: scale.type,
        strength: opts.strength, speedMs: opts.speedMs, chromatic: opts.chromatic,
      });
      return preview;
    }

    controls.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Target'),
        el('div', { class: 'row' },
          el('span', { class: 'lbl' }, 'Notes'),
          el('div', { style: { flex: '1' } }),
          chromaticBtn),
        scaleLine,
        slider('Strength', {
          min: 0, max: 1, step: 0.01, value: opts.strength,
          format: (v) => `${Math.round(v * 100)}%`,
          oninput: (v) => { opts.strength = v; replan(); },
        }),
        slider('Retune speed', {
          min: 1, max: 400, step: 1, value: opts.speedMs,
          format: (v) => (v <= 15 ? `${v}ms · hard` : v < 120 ? `${v}ms` : `${v}ms · gliding`),
          oninput: (v) => { opts.speedMs = v; replan(); },
        }),
        el('p', { class: 'hint' },
          'Full strength with a fast speed is the hard-tuned sound. Ease either back and the performance keeps its own movement.'),
      ),
    );

    body.append(
      el('div', { class: 'card' },
        el('h3', {}, 'Pitch', el('span', { class: 'r' }, sampleMeta(clip.sourceSampleId)?.name || '')),
        graph,
        status,
      ),
      controls,
      el('div', { class: 'btnrow' },
        el('button', {
          class: 'btn',
          onclick: async () => {
            if (!track) return;
            engine.auditionBuffer(source, clip.gain ?? 1);
          },
        }, icon(ICONS.play, 18), 'Original'),
        el('button', {
          class: 'btn',
          onclick: async () => {
            if (!track) return;
            engine.auditionBuffer(await render(), clip.gain ?? 1);
          },
        }, icon(ICONS.play, 18), 'Tuned'),
      ),
      el('button', {
        class: 'btn primary wide', style: { marginTop: '10px' },
        onclick: async () => {
          if (!track) { toast('Still analysing', 'err'); return; }
          const buf = await render();
          const base = sampleMeta(clip.sourceSampleId)?.name || 'Take';
          const meta = await importBuffer(buf, `${base} (tuned)`, { encodeWav });
          S.checkpoint();
          clip.sampleId = meta.id;
          S.touch();
          S.emit('samples');
          close();
          toast('Tuned take applied', 'ok');
          onChange && onChange();
        },
      }, icon(ICONS.check, 18), 'Apply to clip'),
      el('p', { class: 'hint' },
        'The tuned take is saved as a new sample, so the original recording is always there to go back to.'),
    );

    // Analysis is synchronous but slow enough to be worth yielding for.
    (async () => {
      source = await getBuffer(clip.sourceSampleId || clip.sampleId);
      if (!source) { status.textContent = 'That clip has no audio.'; return; }
      await new Promise((r) => setTimeout(r, 30));
      track = detectPitch(source);
      replan();
    })();
  });
}

/** Detected pitch in grey with the corrected line drawn over it. */
function drawGraph(canvas, track, plan) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 320;
  const h = rect.height || 110;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, w, h);

  const voiced = [];
  for (let i = 0; i < track.frames; i++) if (track.f0[i]) voiced.push(i);
  if (!voiced.length) {
    ctx.fillStyle = '#6b7488';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('nothing pitched here', 10, h / 2);
    return;
  }

  const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
  let lo = Infinity, hi = -Infinity;
  for (const i of voiced) {
    const m = midiOf(track.f0[i]);
    lo = Math.min(lo, m, plan.targets[i] || m);
    hi = Math.max(hi, m, plan.targets[i] || m);
  }
  lo = Math.floor(lo) - 1; hi = Math.ceil(hi) + 1;
  const span = Math.max(2, hi - lo);
  const y = (m) => h - ((m - lo) / span) * h;
  const x = (i) => (i / Math.max(1, track.frames - 1)) * w;

  // Semitone guides.
  ctx.strokeStyle = '#1b2130';
  ctx.lineWidth = 1;
  for (let m = lo; m <= hi; m++) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(m)) + 0.5);
    ctx.lineTo(w, Math.round(y(m)) + 0.5);
    ctx.stroke();
  }

  const line = (getter, colour, width) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < track.frames; i++) {
      const v = getter(i);
      if (!v) { drawing = false; continue; }
      if (!drawing) { ctx.moveTo(x(i), y(v)); drawing = true; }
      else ctx.lineTo(x(i), y(v));
    }
    ctx.stroke();
  };

  line((i) => (track.f0[i] ? midiOf(track.f0[i]) : 0), '#6b7488', 1.5);
  line((i) => (track.f0[i] ? midiOf(track.f0[i] * plan.ratios[i]) : 0), '#a78bfa', 2);
}
