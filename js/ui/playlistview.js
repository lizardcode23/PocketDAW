// The Playlist tab: toolbar (pattern, zoom, record) above the arrangement.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import * as recorder from '../audio/recorder.js';
import { getContext } from '../audio/context.js';
import { importBuffer } from '../audio/samples.js';
import { encodeWav } from '../audio/export.js';
import { el, clear, icon, ICONS, toast } from './dom.js';
import { createPlaylist, SNAPS } from './playlist.js';
import { openPatternPicker } from './clipsheet.js';

/** Turn a getUserMedia rejection into something a musician can act on. */
function inputError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || /denied/i.test(e?.message || '')) {
    return 'Microphone blocked — allow access for this site, then try again';
  }
  if (name === 'NotFoundError') return 'No audio input found — plug one in and try again';
  if (name === 'NotReadableError') return 'The input is in use by another app';
  return e?.message || 'No audio input available';
}

export function createPlaylistView(container, { onChange } = {}) {
  const bar = el('div', { class: 'seqbar' });
  const host = el('div', { class: 'plhost' });
  clear(container).append(el('div', { class: 'seq' }, bar, host));

  const grid = createPlaylist(host, {
    onChange: () => { buildBar(); onChange && onChange(); },
  });

  let recording = null;      // { trackId, startStep, startedAt }
  let meterTimer = null;

  function buildBar() {
    const p = S.project();
    clear(bar);

    const patternBtn = el('button', {
      class: 'minibtn',
      onclick: () => openPatternPicker({
        manage: true,
        selectedId: p.activePatternId,
        onPick: null,
      }),
    }, icon(ICONS.copy, 16), S.activePattern()?.name || 'Pattern');

    const recBtn = el('button', {
      class: `minibtn rec${recording ? ' armed' : ''}`,
      onclick: () => (recording ? stopRecording() : startRecording()),
    }, icon(recording ? ICONS.stop : ICONS.record, 16), recording ? 'Stop' : 'Record');

    const monitorBtn = el('button', {
      class: `minibtn${recorder.hasInput() && monitorOn ? ' on' : ''}`,
      onclick: async () => {
        try {
          await recorder.openInput();
          monitorOn = !monitorOn;
          recorder.setMonitor(monitorOn);
          buildBar();
          if (monitorOn) toast('Monitoring on — use headphones to avoid feedback');
        } catch (e) {
          toast(inputError(e), 'err');
        }
      },
    }, icon(ICONS.mic, 16), 'Monitor');

    const snapSeg = el('div', { class: 'seg' },
      SNAPS.map(([steps, label]) => el('button', {
        class: grid.prefs.snap === steps ? 'on' : '',
        onclick: (e) => {
          grid.setSnap(steps);
          [...e.currentTarget.parentElement.children]
            .forEach((c) => c.classList.toggle('on', c === e.currentTarget));
        },
      }, label)));

    bar.append(
      patternBtn,
      el('div', { class: 'sep' }),
      recBtn,
      monitorBtn,
      meter,
      el('div', { class: 'sep' }),
      el('span', { class: 'seglabel' }, 'Snap'),
      snapSeg,
      el('button', {
        class: 'minibtn',
        title: 'Cut the selected clip at the cursor',
        onclick: () => grid.splitAtCursor(),
      }, icon(ICONS.cut, 16), 'Split'),
      el('button', {
        class: `minibtn${grid.prefs.stretch ? ' on' : ''}`,
        title: 'Dragging an audio clip’s right edge fits the audio to the new length',
        onclick: (e) => {
          grid.setStretchMode(!grid.prefs.stretch);
          e.currentTarget.classList.toggle('on', grid.prefs.stretch);
          toast(grid.prefs.stretch
            ? 'Stretch mode — resizing audio fits it to the new length'
            : 'Resizing audio trims it again');
        },
      }, icon(ICONS.wave, 16), 'Stretch'),
      el('div', { class: 'sep' }),
      el('button', { class: 'minibtn', 'aria-label': 'Zoom out', onclick: () => grid.zoom(0.8) }, icon(ICONS.minus, 16)),
      el('button', { class: 'minibtn', 'aria-label': 'Zoom in', onclick: () => grid.zoom(1.25) }, icon(ICONS.plus, 16)),
      el('button', {
        class: 'minibtn', 'aria-label': 'Shorter lanes',
        onclick: () => { grid.setLaneHeight(grid.prefs.laneH - 12); },
      }, icon(ICONS.chevDown, 16)),
      el('button', {
        class: 'minibtn', 'aria-label': 'Taller lanes',
        onclick: () => { grid.setLaneHeight(grid.prefs.laneH + 12); },
      }, icon(ICONS.up, 16)),
      el('div', { class: 'sep' }),
      el('span', { class: 'minibtn', style: { pointerEvents: 'none' } },
        `${p.songBars} bars`),
    );
  }

  let monitorOn = false;
  const meter = el('div', { class: 'inmeter' }, el('i'));

  function startMeter() {
    stopMeter();
    meterTimer = setInterval(() => {
      const level = recorder.inputLevel();
      meter.firstChild.style.width = `${Math.min(100, level * 140).toFixed(0)}%`;
      meter.classList.toggle('hot', level > 0.95);
    }, 80);
  }
  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
    meter.firstChild.style.width = '0%';
  }

  /* --------------------------------------------------------- recording */

  async function startRecording() {
    const p = S.project();
    let track = S.selectedTrack();
    if (!track || track.type !== 'audio') {
      track = p.tracks.find((t) => t.type === 'audio');
      if (!track) {
        S.checkpoint();
        track = S.makeTrack('audio', p.tracks.length);
        p.tracks.push(track);
        S.touch();
        S.emit('tracks');
        toast(`Added the ${track.name} channel to record onto`);
      }
      S.state.selectedTrackId = track.id;
    }

    try {
      await recorder.openInput();
    } catch (e) {
      toast(inputError(e), 'err');
      return;
    }

    p.mode = 'song';
    const from = Math.floor(S.state.playhead || 0);
    await engine.start(from);
    const startedAt = recorder.startCapture();
    recording = { trackId: track.id, startedAt, startStep: engine.stepAtTime(startedAt) };
    startMeter();
    buildBar();
    grid.build();
    toast('Recording — press Stop when you are done');
  }

  async function stopRecording() {
    const take = recorder.stopCapture();
    const info = recording;
    recording = null;
    stopMeter();
    engine.stop();
    buildBar();

    if (!take || !info) { toast('Nothing was captured', 'err'); grid.build(); return; }

    const ctx = getContext();
    const { buffer, trimmedStart } = recorder.trimSilence(take.buffer, ctx);
    if (buffer.duration < 0.05) { toast('That take was silent', 'err'); grid.build(); return; }

    const stepDur = S.secondsPerStep();
    const startStep = Math.max(0, Math.round(info.startStep + trimmedStart / stepDur));
    const length = Math.max(S.STEPS_PER_BAR, Math.ceil(buffer.duration / stepDur));

    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const meta = await importBuffer(buffer, `Take ${stamp}`, { encodeWav });

    S.checkpoint();
    const clip = S.addClip(S.makeClip({
      trackId: info.trackId, kind: 'audio', sampleId: meta.id,
      start: Math.min(startStep, S.songSteps() - 1),
      length: Math.min(length, S.songSteps() - startStep),
    }));
    S.state.selectedClipId = clip.id;
    S.touch();
    S.emit('samples');
    grid.build();
    onChange && onChange();
    toast(`Recorded ${buffer.duration.toFixed(1)}s onto ${S.trackById(info.trackId)?.name}`, 'ok');
  }

  buildBar();

  return {
    refresh() { grid.build(); buildBar(); },
    tick() { grid.followPlayhead(); },
    destroy() {
      stopMeter();
      if (recording) { recorder.stopCapture(); recording = null; }
      grid.destroy();
    },
  };
}
