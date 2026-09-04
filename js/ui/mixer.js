// "Mix" tab — one vertical strip per track plus a master strip.
//
// Each strip carries a live meter fed from an analyser the engine already
// keeps on every channel, read post-fader and post-pan so the bar shows what
// is actually leaving the strip. The animation loop only runs while this
// view is on screen: the moment the tab is switched away the container stops
// being laid out, the loop notices and parks itself.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { el, clear } from './dom.js';

const FLOOR = -60;        // dB at the bottom of the meter
const CEIL = 6;           // dB at the top
const HOLD_MS = 900;      // how long the peak marker stays put

let raf = null;
let meters = [];

export function renderMixer(container, { onChange }) {
  clear(container);
  const strips = el('div', { class: 'strips' });
  container.append(strips);

  meters = [];
  for (const track of S.project().tracks) {
    strips.append(strip(track, onChange));
  }
  strips.append(masterStrip(onChange));
  startMeters(container);
}

/* --------------------------------------------------------------- meters */

/** dB position on the meter, 0 at the floor and 1 at the ceiling. */
function meterPos(level) {
  if (!(level > 0.00001)) return 0;
  const db = 20 * Math.log10(level);
  return Math.max(0, Math.min(1, (db - FLOOR) / (CEIL - FLOOR)));
}

function meterNode(trackId) {
  const fill = el('i');
  const peak = el('b');
  const node = el('div', { class: 'meterbar', 'aria-hidden': 'true' }, fill, peak);
  meters.push({ trackId, node, fill, peak, hold: 0, holdAt: 0, clipUntil: 0 });
  return node;
}

function startMeters(container) {
  cancelAnimationFrame(raf);
  const frame = () => {
    // Switching tabs hides the view, which takes it out of layout — that is
    // the signal to stop, and rendering the tab again starts a fresh loop.
    if (!container.isConnected || container.offsetParent === null) { raf = null; return; }
    const now = performance.now();
    for (const m of meters) {
      const { peak: level } = m.trackId ? engine.trackLevel(m.trackId) : engine.masterLevel();
      const pos = meterPos(level);
      if (pos >= m.hold || now > m.holdAt + HOLD_MS) { m.hold = pos; m.holdAt = now; }
      m.fill.style.height = `${(pos * 100).toFixed(1)}%`;
      m.peak.style.bottom = `${(m.hold * 100).toFixed(1)}%`;
      m.peak.style.opacity = m.hold > 0.001 ? '1' : '0';
      if (level >= 0.999) m.clipUntil = now + 1200;
      m.node.classList.toggle('clip', now < m.clipUntil);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

/* --------------------------------------------------------------- strips */

function fader(value, oninput, label) {
  const readout = el('div', { class: 'lvl' }, label(value));
  const input = el('input', {
    type: 'range', min: 0, max: 1.2, step: 0.01, value,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      readout.textContent = label(v);
      oninput(v);
    },
  });
  // The input is rotated, so it lives in a box sized to its rotated bounds.
  return { node: el('div', { class: 'faderbox' }, input), readout };
}

const dbLabel = (v) => (v <= 0.001 ? '−∞' : `${(20 * Math.log10(v)).toFixed(1)}`);

function strip(track, onChange) {
  const { node: faderNode, readout } = fader(track.volume, (v) => {
    track.volume = v;
    S.touch();
    engine.syncMixer();
  }, dbLabel);

  const btn = (key, text, on) => el('button', {
    class: on ? 'on' : '', dataset: { k: key },
    onclick: () => {
      if (key === 'm') track.mute = !track.mute; else track.solo = !track.solo;
      S.touch();
      engine.syncMixer();
      onChange && onChange();
      S.emit('mixer');
    },
  }, text);

  const panInput = el('input', {
    type: 'range', min: -1, max: 1, step: 0.02, value: track.pan,
    oninput: (e) => {
      track.pan = parseFloat(e.target.value);
      panOut.textContent = panLabel(track.pan);
      S.touch();
      engine.syncMixer();
    },
  });
  const panOut = el('span', {}, panLabel(track.pan));

  // A track whose level is being automated says so, because its fader is
  // then only half the story.
  const autoKeys = S.AUTO_KEYS.filter((k) => S.hasAutomation(track, k));

  return el('div', {
    class: `strip${track.id === S.state.selectedTrackId ? ' sel' : ''}`,
    style: { '--c': track.color },
    onclick: (e) => {
      if (e.target.closest('input') || e.target.closest('button')) return;
      S.state.selectedTrackId = track.id;
      S.emit('select');
    },
  },
    el('div', { class: 'sname' }, track.name),
    el('div', { class: 'fader' }, faderNode, meterNode(track.id)),
    readout,
    autoKeys.length
      ? el('div', { class: 'autotag' }, autoKeys.map((k) => S.AUTO_LANES[k].short).join(' '))
      : null,
    el('div', { class: 'pan' }, panInput, panOut),
    el('div', { class: 'ms' }, btn('m', 'M', track.mute), btn('s', 'S', track.solo)),
  );
}

function panLabel(v) {
  if (Math.abs(v) < 0.02) return 'C';
  return `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
}

function masterStrip(onChange) {
  const p = S.project();
  const { node, readout } = fader(p.masterVolume, (v) => {
    p.masterVolume = v;
    S.touch();
    engine.syncMixer();
  }, dbLabel);

  return el('div', { class: 'strip', style: { '--c': 'var(--accent)' } },
    el('div', { class: 'sname' }, 'Master'),
    el('div', { class: 'fader' }, node, meterNode(null)),
    readout,
    el('div', { class: 'pan' }, el('span', {}, 'output')),
    el('div', { class: 'ms' },
      el('button', {
        class: p.metronome ? 'on' : '', dataset: { k: 's' },
        onclick: () => { p.metronome = !p.metronome; S.touch(); onChange && onChange(); S.emit('transport'); },
      }, 'CLK'),
    ),
  );
}
