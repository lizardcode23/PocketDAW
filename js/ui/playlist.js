// The playlist: one lane per track, clips laid out in time.
//
// Clips are absolutely positioned inside their lane, which keeps hit-testing
// trivial and lets the browser handle scrolling. Dragging moves a clip, the
// grips at either end trim it, and a long press opens the clip sheet.
//
// Snapping is a user setting rather than a constant: writing a song wants
// bars, fixing a late vocal entry wants single 16ths.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { sampleMeta, cachedBuffer, getBuffer } from '../audio/samples.js';
import { el, clear, icon, ICONS, toast } from './dom.js';
import { openClipSheet } from './clipsheet.js';
import { openSampleSheet } from './library.js';
import { drawWave } from './waveform.js';
import { drawNoteMini } from './notemini.js';
import { openAutomationSheet, automationLane } from './automation.js';

const HEAD_W = 96;      // must match .plhead width in the stylesheet

export const SNAPS = [
  [S.STEPS_PER_BAR, 'Bar'],
  [S.STEPS_PER_BAR / 2, '½'],
  [S.STEPS_PER_BEAT, 'Beat'],
  [1, '1/16'],
];

const prefs = (() => {
  // `lanes` maps a track id to the automation lanes it is showing. Which
  // lanes are open is a view preference, not part of the song.
  const base = { barW: 46, snap: S.STEPS_PER_BAR, laneH: 60, wave: true, stretch: false, lanes: {} };
  try { return { ...base, ...JSON.parse(localStorage.getItem('pdaw.playlist') || '{}') }; }
  catch { return base; }
})();
const savePrefs = () => {
  try { localStorage.setItem('pdaw.playlist', JSON.stringify(prefs)); } catch { /* private mode */ }
};

export function createPlaylist(container, { onChange } = {}) {
  const life = new AbortController();
  const on = (node, type, fn, opts) =>
    node.addEventListener(type, fn, { ...opts, signal: life.signal });

  const scroller = el('div', { class: 'plscroll' });
  const inner = el('div', { class: 'plinner' });
  const playhead = el('div', { class: 'plplay' });
  const cursor = el('div', { class: 'plcursor' });
  scroller.append(inner, cursor, playhead);
  clear(container).append(scroller);

  const shownLanes = (trackId) => {
    const list = prefs.lanes[trackId];
    return Array.isArray(list) ? list.filter((k) => S.AUTO_LANES[k]) : [];
  };
  const toggleLane = (trackId, key, on) => {
    const list = shownLanes(trackId).filter((k) => k !== key);
    if (on) list.push(key);
    // Keep the lanes in a fixed order however they were switched on, so the
    // rows do not reshuffle under your finger.
    prefs.lanes[trackId] = S.AUTO_KEYS.filter((k) => list.includes(k));
    savePrefs();
  };

  const stepW = () => prefs.barW / S.STEPS_PER_BAR;
  const songW = () => S.project().songBars * prefs.barW;
  const snap = () => Math.max(1, prefs.snap);
  const snapTo = (steps) => Math.round(steps / snap()) * snap();
  // Placing something goes to the cell you tapped, never the nearer edge —
  // rounding there puts a clip one bar past where your finger was.
  const snapDown = (steps) => Math.floor(steps / snap()) * snap();

  /* ------------------------------------------------------------- build */

  function build() {
    const p = S.project();
    clear(inner);
    inner.style.width = `${HEAD_W + songW()}px`;
    inner.style.setProperty('--laneh', `${prefs.laneH}px`);

    // --- ruler ---------------------------------------------------------
    const ruler = el('div', { class: 'plruler' }, el('div', { class: 'plcorner' }, 'bar'));
    const marks = el('div', { class: 'plmarks', style: { width: `${songW()}px` }, dataset: { ruler: '1' } });
    for (let bar = 0; bar < p.songBars; bar++) {
      marks.append(el('div', {
        class: `plmark${bar % 4 === 0 ? ' major' : ''}`,
        style: { width: `${prefs.barW}px` },
      }, bar % 4 === 0 || prefs.barW > 34 ? String(bar + 1) : ''));
    }
    ruler.append(marks);
    inner.append(ruler);

    // --- lanes ---------------------------------------------------------
    for (const track of p.tracks) {
      const head = el('div', {
        class: `plhead${track.id === S.state.selectedTrackId ? ' sel' : ''}${track.mute ? ' muted' : ''}`,
        style: { '--c': track.color },
        onclick: () => {
          S.state.selectedTrackId = track.id;
          S.emit('select');
          build();
        },
      },
        el('span', { class: 'pln' }, track.name),
        el('span', { class: 'plt' }, track.type === 'audio' ? 'audio' : track.type),
        el('button', {
          class: `plauto-btn${shownLanes(track.id).length ? ' on' : ''}`,
          'aria-label': `Automation for ${track.name}`,
          title: 'Automation lanes',
          onclick: (e) => {
            e.stopPropagation();
            openAutomationSheet(track, {
              shown: shownLanes(track.id),
              onToggle: (key, on) => { toggleLane(track.id, key, on); build(); },
              onChange: () => { build(); onChange && onChange(); },
            });
          },
        }, icon(ICONS.tune, 14)),
      );

      const lane = el('div', {
        class: 'pllane',
        style: { width: `${songW()}px` },
        dataset: { track: track.id },
      });
      for (let bar = 0; bar < p.songBars; bar++) {
        lane.append(el('div', {
          class: `plcell${bar % 4 === 0 ? ' major' : ''}`,
          style: { left: `${bar * prefs.barW}px`, width: `${prefs.barW}px` },
        }));
      }
      for (const clip of p.clips) {
        if (clip.trackId !== track.id) continue;
        lane.append(clipNode(clip, track));
      }
      inner.append(el('div', { class: 'plrow' }, head, lane));

      // Automation sits directly under the track it belongs to, so a curve
      // is read against the clips it is shaping.
      for (const key of shownLanes(track.id)) {
        const built = automationLane(track, key, {
          stepW: stepW(),
          songSteps: S.songSteps(),
          snap: snap(),
          headWidth: HEAD_W,
          onChange: () => onChange && onChange(),
          onClose: () => { toggleLane(track.id, key, false); build(); },
        });
        inner.append(built.row);
      }
    }

    // --- add-track row --------------------------------------------------
    inner.append(el('div', { class: 'plrow addrow' },
      el('button', {
        class: 'plhead add',
        onclick: () => { S.emit('addtrack'); },
      }, icon(ICONS.plus, 18), 'Track'),
      el('div', { class: 'pllane empty', style: { width: `${songW()}px` } }),
    ));

    paintCursor();
  }

  function clipNode(clip, track) {
    const label = clip.kind === 'pattern'
      ? (S.patternById(clip.patternId)?.name || 'Pattern')
      : (sampleMeta(clip.sampleId)?.name || 'Audio');
    const width = Math.max(10, clip.length * stepW() - 2);
    const node = el('div', {
      class: `plclip ${clip.kind}${clip.id === S.state.selectedClipId ? ' sel' : ''}`,
      style: {
        '--c': clip.kind === 'pattern'
          ? (S.patternById(clip.patternId)?.color || track.color)
          : track.color,
        left: `${clip.start * stepW()}px`,
        width: `${width}px`,
      },
      dataset: { clip: clip.id },
    },
      el('span', { class: 'plclip-label' }, label),
      el('span', { class: 'plclip-grip left' }),
      el('span', { class: 'plclip-grip' }),
    );

    // What has been done to this clip, so a stretched or retuned take does
    // not look like an untouched one.
    const tags = [];
    if (clip.stretch) tags.push(`${S.clipSpeed(clip).toFixed(2)}x`);
    if (clip.pitchEdits && clip.pitchEdits.notes?.some((n) => n.semitones || n.cents || n.shift || n.mute)) {
      tags.push('tuned');
    }
    if (tags.length && width > 52) {
      node.append(el('span', { class: 'plclip-tag' }, tags.join(' · ')));
    }

    // Muted stretches, so a silenced section reads at a glance.
    for (const [a, b] of S.muteRanges(clip)) {
      node.append(el('span', {
        class: 'plclip-mute',
        style: { left: `${a * stepW()}px`, width: `${Math.max(2, (b - a) * stepW())}px` },
      }));
    }

    // A pattern clip shows the notes it will actually play — the same window
    // the scheduler reads, offset and looping included, so a clip trimmed to
    // half a bar looks like half a bar of music.
    if (clip.kind === 'pattern' && prefs.wave && width > 16) {
      const pattern = S.patternById(clip.patternId);
      const notes = pattern ? (pattern.notes[track.id] || []) : [];
      if (notes.length) {
        const canvas = el('canvas', { class: 'plclip-notes' });
        node.prepend(canvas);
        requestAnimationFrame(() => {
          drawNoteMini(canvas, notes, {
            steps: clip.length,
            patSteps: Math.max(1, (pattern.bars || 1) * S.STEPS_PER_BAR),
            offsetSteps: clip.offsetSteps || 0,
            range: track.type === 'drum' ? [0, S.PAD_COUNT - 1] : null,
            rows: track.type === 'drum',
            colour: 'rgba(255,255,255,.78)',
          });
        });
      }
    }

    if (clip.kind === 'audio' && prefs.wave && width > 24) {
      const buf = cachedBuffer(clip.sampleId);
      if (buf) {
        const wave = el('canvas', { class: 'plclip-wave' });
        node.prepend(wave);
        // The canvas has no layout until the lane is in the document.
        requestAnimationFrame(() => {
          // A stretched clip shows the stretch of *sample* it covers, which is
          // no longer the same as its length on the timeline.
          const secs = S.clipSourceSeconds(clip);
          drawWave(wave, buf, {
            view: { from: clip.offset || 0, to: (clip.offset || 0) + secs },
            colour: 'rgba(255,255,255,.55)',
            background: 'rgba(0,0,0,0)',
          });
        });
      } else if (clip.sampleId) {
        getBuffer(clip.sampleId).then((b) => { if (b) build(); });
      }
    }
    return node;
  }

  /* ---------------------------------------------------------- gestures */

  let drag = null;

  const laneFromPoint = (x, y) => {
    const node = document.elementFromPoint(x, y);
    return node ? node.closest('.pllane') : null;
  };

  on(scroller, 'pointerdown', (e) => {
    const clipEl = e.target.closest('.plclip');
    const laneEl = e.target.closest('.pllane');
    const rulerEl = e.target.closest('.plmarks');

    const rect = inner.getBoundingClientRect();
    const localX = e.clientX - rect.left - HEAD_W;

    if (rulerEl) {
      e.preventDefault();
      setCursor(Math.max(0, snapDown(localX / stepW())));
      return;
    }
    if (!laneEl && !clipEl) return;

    if (clipEl) {
      const clip = S.clipById(clipEl.dataset.clip);
      if (!clip) return;
      e.preventDefault();
      S.state.selectedClipId = clip.id;
      const grip = e.target.closest('.plclip-grip');
      const kind = grip ? (grip.classList.contains('left') ? 'trimLeft' : 'resize') : 'move';
      S.checkpoint();
      // In stretch mode the right grip fits the audio to the new length
      // instead of trimming it. Switching the clip over here, before the drag
      // starts, is what freezes the span of sample it is fitting.
      if (kind === 'resize' && prefs.stretch && clip.kind === 'audio' && !clip.stretch) {
        S.setClipStretch(clip, true);
      }
      drag = {
        kind, clip, node: clipEl,
        grabStep: localX / stepW() - clip.start,
        startX: e.clientX, startY: e.clientY,
        moved: false,
      };
      drag.hold = setTimeout(() => {
        if (!drag) return;
        drag.opened = true;
        openClipSheet(clip, { onChange: () => { build(); onChange && onChange(); } });
      }, 500);
      try { scroller.setPointerCapture(e.pointerId); } catch { /* gone */ }
      build();
      return;
    }

    // Empty lane: drop a clip of the active pattern at the tapped position.
    const track = S.trackById(laneEl.dataset.track);
    if (!track) return;
    e.preventDefault();
    addClipAt(track, Math.max(0, snapDown(localX / stepW())));
  }, { passive: false });

  on(scroller, 'pointermove', (e) => {
    if (!drag) return;
    if (drag.hold && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) {
      clearTimeout(drag.hold);
      drag.hold = null;
    }
    if (drag.opened) return;

    const rect = inner.getBoundingClientRect();
    const localX = e.clientX - rect.left - HEAD_W;
    const total = S.songSteps();
    const clip = drag.clip;

    if (drag.kind === 'move') {
      const start = Math.max(0, Math.min(total - clip.length, snapTo(localX / stepW() - drag.grabStep)));
      const lane = laneFromPoint(e.clientX, e.clientY);
      const overTrack = lane ? S.trackById(lane.dataset.track) : null;
      if (overTrack && overTrack.id !== clip.trackId && canHold(overTrack, clip)) {
        clip.trackId = overTrack.id;
        drag.moved = true;
      }
      if (start !== clip.start) { clip.start = start; drag.moved = true; }
    } else if (drag.kind === 'resize') {
      const end = Math.min(total, Math.max(clip.start + snap(), snapTo(localX / stepW())));
      const length = end - clip.start;
      if (length !== clip.length) {
        clip.length = length;
        // A stretched clip keeps the same audio and changes speed instead;
        // `stretchSrc` is untouched, so the ratio falls out of the new length.
        if (!clip.stretch) clip.mutes = (clip.mutes || []).filter((s) => s < length);
        drag.moved = true;
      }
    } else {
      // Trimming the front keeps the material where it is in time: the start
      // moves in, and the clip's offset into the sample (or pattern) moves
      // with it, so nothing shifts underneath.
      const wantStart = Math.max(0, Math.min(clip.start + clip.length - snap(), snapTo(localX / stepW())));
      const delta = wantStart - clip.start;
      if (delta) {
        clip.start = wantStart;
        clip.length -= delta;
        if (clip.kind === 'audio') {
          // Trimming the front of a stretched clip consumes source at the
          // clip's own speed, and takes that much off the span it covers —
          // which is what keeps the rest of the take sounding identical.
          const eaten = delta * S.secondsPerStep() * S.clipSpeed(clip);
          clip.offset = Math.max(0, (clip.offset || 0) + eaten);
          if (clip.stretch) clip.stretchSrc = Math.max(0.01, (clip.stretchSrc || 0) - eaten);
        } else {
          clip.offsetSteps = Math.max(0, (clip.offsetSteps || 0) + delta);
        }
        clip.mutes = (clip.mutes || []).map((s) => s - delta).filter((s) => s >= 0 && s < clip.length);
        drag.moved = true;
      }
    }
    S.touch();
    build();
  });

  const endDrag = (e) => {
    if (!drag) return;
    clearTimeout(drag.hold);
    try { scroller.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    const wasDrag = drag;
    drag = null;
    if (wasDrag.moved) onChange && onChange();
    build();
  };
  on(scroller, 'pointerup', endDrag);
  on(scroller, 'pointercancel', endDrag);
  on(scroller, 'contextmenu', (e) => {
    const clipEl = e.target.closest('.plclip');
    if (!clipEl) return;
    e.preventDefault();
    S.checkpoint();
    S.removeClip(clipEl.dataset.clip);
    build();
    onChange && onChange();
  });
  on(scroller, 'dblclick', (e) => {
    const clipEl = e.target.closest('.plclip');
    if (!clipEl) return;
    const clip = S.clipById(clipEl.dataset.clip);
    if (clip) openClipSheet(clip, { onChange: () => { build(); onChange && onChange(); } });
  });

  /* ------------------------------------------------------------ actions */

  const canHold = (track, clip) =>
    (clip.kind === 'audio') === (track.type === 'audio');

  /** Where "split", "paste" and playback all start from. */
  function setCursor(step) {
    S.state.playhead = Math.max(0, Math.min(S.songSteps() - 1, step));
    if (S.state.playing) engine.start(S.state.playhead);
    paintCursor();
    onChange && onChange();
  }

  function paintCursor() {
    const at = S.state.playhead || 0;
    cursor.style.transform = `translateX(${HEAD_W + at * stepW()}px)`;
    cursor.style.height = `${inner.offsetHeight}px`;
    cursor.style.display = S.project().mode === 'song' ? 'block' : 'none';
  }

  function addClipAt(track, start) {
    const p = S.project();
    if (track.type === 'audio') { placeAudio(track, start); return; }

    const pattern = S.activePattern();
    const length = pattern.bars * S.STEPS_PER_BAR;
    if (start + length > S.songSteps()) {
      toast('Not enough room — lengthen the song in the Song tab', 'err');
      return;
    }
    if (overlaps(track.id, start, length)) { toast('There is already a clip there'); return; }

    S.checkpoint();
    const clip = S.addClip(S.makeClip({
      trackId: track.id, kind: 'pattern', patternId: pattern.id, start, length,
    }));
    S.state.selectedClipId = clip.id;
    build();
    onChange && onChange();
  }

  /** Place a library sample on an audio lane, sized to its own length. */
  function placeAudio(track, start) {
    openSampleSheet({
      title: 'Place audio',
      onPick: async (id) => {
        if (!id) return;
        const meta = sampleMeta(id);
        const steps = Math.max(1, Math.ceil((meta?.duration || 1) / S.secondsPerStep()));
        const length = Math.min(steps, Math.max(1, S.songSteps() - start));
        if (overlaps(track.id, start, length)) { toast('There is already a clip there'); return; }
        S.checkpoint();
        const clip = S.addClip(S.makeClip({
          trackId: track.id, kind: 'audio', sampleId: id, start, length,
        }));
        S.state.selectedClipId = clip.id;
        await getBuffer(id).catch(() => null);
        build();
        onChange && onChange();
        toast(`Placed “${meta?.name || 'audio'}” at bar ${Math.floor(start / S.STEPS_PER_BAR) + 1}`, 'ok');
      },
    });
  }

  const overlaps = (trackId, start, length) => S.project().clips.some((c) =>
    c.trackId === trackId && start < c.start + c.length && start + length > c.start);

  /** Cut the selected clip at the cursor — the basis of moving a section. */
  function splitAtCursor() {
    const clip = S.clipById(S.state.selectedClipId);
    const at = Math.round(S.state.playhead || 0);
    if (!clip) { toast('Tap a clip to select it first'); return; }
    if (at <= clip.start || at >= clip.start + clip.length) {
      toast('Put the cursor inside the clip — tap the bar ruler', 'err');
      return;
    }
    S.checkpoint();
    const right = S.splitClip(clip, at);
    if (right) S.state.selectedClipId = right.id;
    build();
    onChange && onChange();
    toast(`Split at bar ${Math.floor(at / S.STEPS_PER_BAR) + 1}`, 'ok');
  }

  /* ---------------------------------------------------------- playhead */

  function followPlayhead() {
    const p = S.project();
    if (!S.state.playing || p.mode !== 'song') {
      playhead.style.display = 'none';
      return;
    }
    const step = engine.playheadSteps();
    const x = HEAD_W + step * stepW();
    playhead.style.display = 'block';
    playhead.style.transform = `translateX(${x}px)`;
    playhead.style.height = `${inner.offsetHeight}px`;
    const left = scroller.scrollLeft;
    if (x > left + scroller.clientWidth - 40 || x < left + HEAD_W) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.4);
    }
  }

  build();

  return {
    build,
    followPlayhead,
    splitAtCursor,
    setCursor,
    zoom(factor) {
      prefs.barW = Math.max(16, Math.min(240, prefs.barW * factor));
      savePrefs();
      build();
    },
    setStretchMode(on) {
      prefs.stretch = !!on;
      savePrefs();
    },
    setSnap(steps) {
      prefs.snap = steps;
      savePrefs();
      build();
    },
    setLaneHeight(px) {
      prefs.laneH = Math.max(38, Math.min(120, px));
      savePrefs();
      build();
    },
    prefs,
    addClipAt,
    destroy() { life.abort(); clear(container); },
  };
}
