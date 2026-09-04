// App wiring: boot, top bar, track strip, tab routing, and the frame loop.

import * as S from './state.js';
import * as db from './db.js';
import * as engine from './audio/engine.js';
import * as lib from './audio/samples.js';
import { ensureStretchesForProject } from './audio/stretch.js';
import { unlock } from './audio/context.js';
import { NOTE_NAMES } from './theory.js';
import { $, el, clear, icon, ICONS, sheet, toast } from './ui/dom.js';
import { createSequencer } from './ui/sequencer.js';
import { createPlaylistView } from './ui/playlistview.js';
import { renderSounds } from './ui/sounds.js';
import { renderMixer } from './ui/mixer.js';
import { renderSong } from './ui/song.js';
import { openScaleSheet, scaleChipLabel } from './ui/scalepicker.js';

const app = $('#app');
const views = {
  edit: $('#viewEdit'),
  playlist: $('#viewPlaylist'),
  sounds: $('#viewSounds'),
  mix: $('#viewMix'),
  song: $('#viewSong'),
};
views.sounds.classList.add('padded');
views.song.classList.add('padded');

let sequencer = null;
let playlist = null;
let activeTab = 'edit';

/* ---------------------------------------------------------------- boot */

async function boot() {
  try { await lib.refreshIndex(); } catch { /* storage unavailable; carry on */ }
  const loaded = await S.loadLastProject();
  if (!loaded) {
    S.newProject('First sketch');
    seedDemo();
    await S.save();
  }
  S.state.selectedTrackId = S.project().tracks[0]?.id || null;

  sequencer = createSequencer(views.edit, { onEdit: () => { /* autosaved by the store */ } });
  playlist = createPlaylistView(views.playlist, { onChange: () => paintTopbar() });

  renderTrackStrip();
  paintTopbar();
  bindTopbar();
  bindTabs();
  bindKeyboard();
  bindLifecycle();

  S.subscribe(onStoreChange);
  if (S.state.saveError) toast(S.state.saveError, 'err');
  // Warm the samples first, then the stretched copies of them — a stretched
  // clip plays a resampled fallback until its own buffer exists.
  lib.preloadForProject(S.project())
    .then(() => ensureStretchesForProject(S.project(), S.secondsPerStep()))
    .catch(() => { /* a cold stretch just means the first pass is tape */ });
  db.requestPersistence();
}

/** A tiny starting pattern so the app makes sound on first launch. */
function seedDemo() {
  const [drums, synth] = S.project().tracks;
  for (const t of [0, 4, 8, 12]) S.addNote(drums, { pitch: 0, t, len: 1 });
  for (const t of [4, 12]) S.addNote(drums, { pitch: 1, t, len: 1 });
  for (let t = 2; t < 16; t += 2) S.addNote(drums, { pitch: 3, t, len: 1, vel: 0.6 });
  // C minor pentatonic, matching the default project scale.
  [[0, 48], [4, 55], [6, 51], [8, 58], [12, 55]].forEach(([t, pitch]) =>
    S.addNote(synth, { pitch, t, len: 4, vel: 0.85 }));

  // Lay the pattern onto the playlist so the arrangement is not empty.
  const p = S.project();
  const pat = S.activePattern();
  const len = pat.bars * S.STEPS_PER_BAR;
  for (const track of [drums, synth]) {
    for (let bar = 0; bar < 2; bar++) {
      S.addClip(S.makeClip({ trackId: track.id, kind: 'pattern', patternId: pat.id, start: bar * len, length: len }));
    }
  }
  p.songBars = 16;
}

/* ------------------------------------------------------------- top bar */

function paintTopbar() {
  const p = S.project();
  $('#bpmVal').textContent = String(Math.round(p.bpm));
  $('#scaleRoot').textContent = NOTE_NAMES[p.scale.root];
  $('#scaleName').textContent = scaleChipLabel(p.scale);
  $('#btnMetro').setAttribute('aria-pressed', String(!!p.metronome));
  $('#btnUndo').disabled = !S.canUndo();
  $('#btnRedo').disabled = !S.canRedo();
  app.classList.toggle('is-playing', S.state.playing);
}

function bindTopbar() {
  $('#btnPlay').addEventListener('click', async () => {
    await unlock();
    if (S.state.playing) engine.stop();
    else await engine.start(S.state.playhead || 0);
    paintTopbar();
  });

  $('#btnMetro').addEventListener('click', () => {
    S.project().metronome = !S.project().metronome;
    S.touch();
    paintTopbar();
  });

  $('#btnScale').addEventListener('click', () => openScaleSheet(() => {
    paintTopbar();
    sequencer.refreshRows();
    if (activeTab !== 'edit') renderActive();
  }));

  $('#btnTempo').addEventListener('click', openTempoSheet);
  $('#btnUndo').addEventListener('click', () => { S.undo(); afterHistory(); });
  $('#btnRedo').addEventListener('click', () => { S.redo(); afterHistory(); });
}

function afterHistory() {
  engine.syncMixer();
  renderTrackStrip();
  paintTopbar();
  sequencer.refresh();
  renderActive();
}

function openTempoSheet() {
  sheet('Tempo', (body) => {
    const p = S.project();
    const out = el('div', {
      style: { fontSize: '40px', fontWeight: '700', textAlign: 'center', margin: '4px 0 10px', fontVariantNumeric: 'tabular-nums' },
    }, `${Math.round(p.bpm)}`);

    const range = el('input', {
      type: 'range', min: 40, max: 220, step: 1, value: p.bpm,
      oninput: (e) => {
        p.bpm = parseInt(e.target.value, 10);
        out.textContent = String(p.bpm);
        S.touch();
        engine.rebase();
        paintTopbar();
      },
    });

    const nudge = (delta) => el('button', {
      class: 'btn',
      onclick: () => {
        p.bpm = Math.max(40, Math.min(220, p.bpm + delta));
        range.value = String(p.bpm);
        out.textContent = String(p.bpm);
        S.touch();
        engine.rebase();
        paintTopbar();
      },
    }, delta > 0 ? `+${delta}` : String(delta));

    let taps = [];
    const tapBtn = el('button', {
      class: 'btn wide',
      onclick: () => {
        const now = performance.now();
        taps = taps.filter((t) => now - t < 2500);
        taps.push(now);
        if (taps.length >= 2) {
          const gaps = taps.slice(1).map((t, i) => t - taps[i]);
          const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
          p.bpm = Math.max(40, Math.min(220, Math.round(60000 / avg)));
          range.value = String(p.bpm);
          out.textContent = String(p.bpm);
          S.touch();
          engine.rebase();
          paintTopbar();
        }
      },
    }, 'Tap tempo');

    body.append(out, el('div', { class: 'row' }, range),
      el('div', { class: 'btnrow', style: { marginTop: '10px' } }, nudge(-5), nudge(-1), nudge(1), nudge(5)),
      el('div', { style: { height: '10px' } }), tapBtn);
  });
}

/* --------------------------------------------------------- track strip */

function renderTrackStrip() {
  const strip = $('#trackStrip');
  clear(strip);
  const p = S.project();

  for (const track of p.tracks) {
    let holdTimer = null;
    let held = false;
    const chip = el('button', {
      class: `tchip${track.id === S.state.selectedTrackId ? ' sel' : ''}${track.mute ? ' muted' : ''}`,
      style: { '--c': track.color },
      onclick: () => {
        if (held) { held = false; return; }   // the long press already acted
        if (S.state.selectedTrackId === track.id) return;
        S.state.selectedTrackId = track.id;
        renderTrackStrip();
        sequencer.refresh();
        if (activeTab !== 'edit') renderActive();
      },
      onpointerdown: () => {
        held = false;
        holdTimer = setTimeout(() => {
          held = true;
          track.mute = !track.mute;
          S.touch();
          engine.syncMixer();
          renderTrackStrip();
          toast(`${track.name} ${track.mute ? 'muted' : 'unmuted'}`);
          try { navigator.vibrate?.(12); } catch { /* not allowed yet */ }
        }, 480);
      },
      onpointerup: () => clearTimeout(holdTimer),
      onpointercancel: () => clearTimeout(holdTimer),
      onpointerleave: () => clearTimeout(holdTimer),
    },
      el('span', { class: 'dot' }),
      el('span', { class: 'nm' }, track.name),
      track.solo ? el('span', { class: 'badge' }, 'solo') : null,
    );
    strip.append(chip);
  }

  strip.append(el('button', {
    class: 'tchip add', 'aria-label': 'Add track',
    onclick: openAddTrack,
  }, icon(ICONS.plus, 20)));
}

function openAddTrack() {
  sheet('Add track', (body, close) => {
    const option = (type, title, description) => el('button', {
      class: 'sitem', style: { width: '100%' },
      onclick: () => {
        S.checkpoint();
        const p = S.project();
        const track = S.makeTrack(type, p.tracks.length);
        p.tracks.push(track);
        S.state.selectedTrackId = track.id;
        S.touch();
        engine.syncMixer();
        close();
        renderTrackStrip();
        sequencer.refresh();
        setTab(type === 'audio' ? 'playlist' : 'sounds');
      },
    },
      el('span', { class: 'play' }, icon(type === 'drum' ? ICONS.dice : type === 'sampler' ? ICONS.wave : ICONS.play, 16)),
      el('span', { class: 'meta' }, el('b', {}, title), el('span', {}, description)),
    );

    body.append(el('div', { class: 'slist' },
      option('drum', 'Drum kit', '8 pads on a step grid — load your own samples or use the built-ins'),
      option('sampler', 'Sampler', 'One sample played chromatically across the piano roll'),
      option('synth', 'Synth', 'Two-oscillator subtractive synth with a filter envelope'),
      option('audio', 'Audio', 'Record or place audio clips on the playlist — the home for vocals'),
    ));
  });
}

/* ---------------------------------------------------------------- tabs */

function setTab(name) {
  activeTab = name;
  const wantMode = name === 'playlist' ? 'song' : name === 'edit' ? 'pattern' : null;
  if (wantMode && S.project().mode !== wantMode) {
    S.project().mode = wantMode;
    S.touch();
    if (S.state.playing) engine.start(0);
    paintTopbar();
  }
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  for (const btn of document.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  renderActive();
}

function bindTabs() {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }
}

function renderActive() {
  const onChange = () => { renderTrackStrip(); paintTopbar(); };
  if (activeTab === 'edit') sequencer.refresh();
  if (activeTab === 'playlist') playlist.refresh();
  if (activeTab === 'sounds') renderSounds(views.sounds, { onChange });
  if (activeTab === 'mix') renderMixer(views.mix, { onChange });
  if (activeTab === 'song') renderSong(views.song, { onChange: paintTopbar });
}

/* -------------------------------------------------------------- events */

let warnedSaveError = false;

function onStoreChange(reason) {
  if (reason === 'saveerror') {
    if (!warnedSaveError) {
      warnedSaveError = true;
      toast(S.state.saveError || 'Could not save the project', 'err');
    }
    paintTopbar();
    return;
  }
  if (reason === 'saved') warnedSaveError = false;
  if (reason === 'transport' || reason === 'tempo' || reason === 'saved') {
    paintTopbar();
    if (S.state.playing) startLoop();
    return;
  }
  if (reason === 'addtrack') { openAddTrack(); return; }
  if (reason === 'tracks' || reason === 'select' || reason === 'mixer') {
    renderTrackStrip();
    paintTopbar();
    if (activeTab === 'playlist') playlist.refresh();
  }
  if (reason === 'pattern' || reason === 'clips') {
    if (activeTab === 'playlist') playlist.refresh();
    sequencer.refresh();
    paintTopbar();
  }
  if (reason === 'project') {
    engine.syncMixer();
    lib.preloadForProject(S.project());
    renderTrackStrip();
    paintTopbar();
    sequencer.refresh();
    playlist.refresh();
  }
  if (reason === 'length' || reason === 'notes' || reason === 'scale' || reason === 'samples') {
    if (reason === 'scale') paintTopbar();
    sequencer.rebuildGrid();
    sequencer.refreshRows();
    if (activeTab === 'playlist') playlist.refresh();
  }
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      $('#btnPlay').click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) S.redo(); else S.undo();
      afterHistory();
    } else if (e.key >= '1' && e.key <= '5') {
      setTab(['edit', 'playlist', 'sounds', 'mix', 'song'][+e.key - 1]);
    }
  });
}

function bindLifecycle() {
  const flush = () => { if (S.state.dirty) S.save(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__pdawInstall = e;
  });

  // Files dropped anywhere land in the sample library.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const { importFiles } = await import('./ui/library.js');
    await importFiles(e.dataTransfer.files);
    if (activeTab === 'song') renderActive();
  });

  if ('serviceWorker' in navigator) {
    // boot() awaits IndexedDB, so `load` has usually fired by the time we
    // get here — register straight away in that case.
    const register = () => navigator.serviceWorker.register('sw.js')
      .catch(() => { /* offline support is optional */ });
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

/* ---------------------------------------------------------------- loop */

// The editor only needs repainting while the transport is running, so the
// animation loop parks itself the moment playback stops.
let looping = false;

function frame() {
  if (!S.state.playing) {
    looping = false;
    sequencer.tick();       // one last paint to park the playhead
    playlist.tick();
    paintTopbar();
    return;
  }
  if (activeTab === 'playlist') playlist.tick(); else sequencer.tick();
  requestAnimationFrame(frame);
}

function startLoop() {
  if (looping) return;
  looping = true;
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  toast(e.message || 'Something went wrong while starting up', 'err');
});
