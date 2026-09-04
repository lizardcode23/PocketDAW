// Canvas piano roll with project-scale highlighting.
//
// Gestures are handled manually rather than leaning on native scrolling so
// that one finger always draws and two fingers always pan/zoom — on a phone
// that distinction matters more than momentum scrolling.

import * as S from '../state.js';
import * as engine from '../audio/engine.js';
import { inScale, isRoot, snapToScale, noteLabel, pitchClass, NOTE_NAMES } from '../theory.js';
import { openNoteSheet } from './notesheet.js';
import { suggestNext } from '../harmony.js';
import { toast } from './dom.js';

const GUTTER = 54;      // key strip on the left
const RULER = 22;       // bar numbers along the top
const MIN_PITCH = 24;   // C1
const MAX_PITCH = 107;  // B7
const MIN_STEP_W = 12;
const MAX_STEP_W = 64;
const BLACK = new Set([1, 3, 6, 8, 10]);

const prefs = loadPrefs();

function loadPrefs() {
  try {
    return Object.assign(
      { stepW: 26, rowH: 26, fold: false, snap: 1, drawLen: 4, mode: 'draw', suggest: false, ghosts: false },
      JSON.parse(localStorage.getItem('pdaw.roll') || '{}'),
    );
  } catch {
    return { stepW: 26, rowH: 26, fold: false, snap: 1, drawLen: 4, mode: 'draw', suggest: false, ghosts: false };
  }
}
function savePrefs() {
  try { localStorage.setItem('pdaw.roll', JSON.stringify(prefs)); } catch { /* private mode */ }
}

export function createPianoRoll(canvas, { getTrack, onEdit }) {
  const ctx = canvas.getContext('2d');
  let scrollX = 0;
  let scrollY = 0;
  let w = 0, h = 0, dpr = 1;
  let rows = [];
  let centred = false;

  /* ------------------------------------------------------------ layout */

  function computeRows() {
    const sc = S.project().scale;
    rows = [];
    for (let p = MAX_PITCH; p >= MIN_PITCH; p--) {
      if (prefs.fold && !inScale(p, sc.root, sc.type)) continue;
      rows.push(p);
    }
    if (!rows.length) rows.push(60);
  }

  const contentW = () => S.totalSteps() * prefs.stepW;
  const contentH = () => rows.length * prefs.rowH;
  const viewW = () => Math.max(10, w - GUTTER);
  const viewH = () => Math.max(10, h - RULER);

  function clampScroll() {
    scrollX = Math.max(0, Math.min(scrollX, Math.max(0, contentW() - viewW())));
    scrollY = Math.max(0, Math.min(scrollY, Math.max(0, contentH() - viewH())));
  }

  const xForStep = (s) => GUTTER + s * prefs.stepW - scrollX;
  const yForRow = (i) => RULER + i * prefs.rowH - scrollY;
  const stepAtX = (x) => (x - GUTTER + scrollX) / prefs.stepW;
  const rowAtY = (y) => Math.floor((y - RULER + scrollY) / prefs.rowH);
  const pitchAtY = (y) => rows[Math.max(0, Math.min(rows.length - 1, rowAtY(y)))];
  const rowOfPitch = (p) => rows.indexOf(p);

  function centreOnContent() {
    const track = getTrack();
    let target = 60;
    const notes = track ? S.notesOf(track) : [];
    if (notes.length) {
      const avg = notes.reduce((a, n) => a + n.pitch, 0) / notes.length;
      target = Math.round(avg);
    }
    let idx = rowOfPitch(target);
    if (idx < 0) {
      // Folded view may not contain the exact pitch; find the closest row.
      idx = rows.reduce((best, p, i) => (Math.abs(p - target) < Math.abs(rows[best] - target) ? i : best), 0);
    }
    scrollY = idx * prefs.rowH - viewH() / 2 + prefs.rowH / 2;
    clampScroll();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    w = rect.width; h = rect.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeRows();
    if (!centred && w > 0) { centreOnContent(); centred = true; }
    clampScroll();
    render();
  }

  /* -------------------------------------------------------- suggestions */

  let suggestion = null;      // { at, items[] }
  let suggestKey = '';

  /** Recompute only when the notes or the scale actually changed. */
  function refreshSuggestions() {
    const track = getTrack();
    if (!prefs.suggest || !track || track.type === 'drum') {
      suggestion = null;
      suggestKey = '';
      return;
    }
    const sc = S.project().scale;
    const notes = S.notesOf(track);
    const last = notes.reduce((a, n) => (a && a.t + a.len >= n.t + n.len ? a : n), null);
    const key = [track.id, S.project().activePatternId, notes.length,
      last && last.pitch, last && last.t, last && last.len,
      sc.root, sc.type, S.totalSteps()].join('|');
    if (key === suggestKey) return;
    suggestKey = key;
    suggestion = suggestNext(notes, S.project(), { count: 5, totalSteps: S.totalSteps() });
  }

  /** The ghost note under a point, if any. */
  function hitSuggestion(x, y) {
    if (!suggestion) return null;
    const step = stepAtX(x);
    if (step < suggestion.at || step >= suggestion.at + prefs.drawLen) return null;
    const pitch = pitchAtY(y);
    return suggestion.items.find((i) => i.pitch === pitch) || null;
  }

  function drawSuggestions(color) {
    if (!suggestion || !suggestion.items.length) return;
    const x = xForStep(suggestion.at);
    const nw = Math.max(8, prefs.drawLen * prefs.stepW - 2);
    if (x + nw < GUTTER || x > w) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER, w - GUTTER, h - RULER);
    ctx.clip();

    suggestion.items.forEach((item, rank) => {
      const i = rowOfPitch(item.pitch);
      if (i < 0) return;
      const y = yForRow(i);
      if (y + prefs.rowH < RULER || y > h) return;

      const strength = 1 - rank / (suggestion.items.length + 1);
      ctx.globalAlpha = 0.18 + 0.3 * strength;
      ctx.fillStyle = color;
      roundRect(ctx, x + 1, y + 2, nw, prefs.rowH - 5, 4);
      ctx.fill();

      ctx.globalAlpha = 0.55 + 0.45 * strength;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (nw > 24 && prefs.rowH >= 18) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.font = '700 10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rank + 1), x + 6, y + prefs.rowH / 2);
      }
    });
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* -------------------------------------------------- other tracks */

  /**
   * The notes every *other* track plays in this pattern, drawn behind the
   * ones being edited so a line can be written against what is already
   * there. They are painted from the pattern directly rather than through
   * `S.notesOf`, which would create an empty list for every track that has
   * never played in it — a render must not grow the document.
   *
   * Drum tracks are left out on purpose: a drum note's `pitch` is a pad
   * index, so its row here would be a lie.
   */
  function ghostTracks() {
    const cur = getTrack();
    const pattern = S.activePattern();
    if (!prefs.ghosts || !pattern) return [];
    return S.project().tracks
      .filter((t) => t !== cur && t.type !== 'drum' && t.type !== 'audio')
      .map((t) => ({ track: t, notes: (pattern.notes && pattern.notes[t.id]) || [] }))
      .filter((g) => g.notes.length);
  }

  function drawGhostNotes(groups, first, last) {
    if (!groups.length) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER, w - GUTTER, h - RULER);
    ctx.clip();

    for (const { track: t, notes } of groups) {
      for (const n of notes) {
        const i = rowOfPitch(n.pitch);
        if (i < 0 || i < first - 1 || i > last + 1) continue;
        const x = xForStep(n.t);
        const nw = Math.max(6, n.len * prefs.stepW - 2);
        if (x + nw < GUTTER || x > w) continue;
        const y = yForRow(i);

        // Hollow and dim: a ghost has to read as "somebody else's note" at a
        // glance, or it competes with the ones you are actually editing.
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = t.color;
        roundRect(ctx, x + 1, y + 2, nw, prefs.rowH - 5, 4);
        ctx.fill();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Names of the tracks showing through, drawn in the ruler's spare room. */
  function drawGhostLegend(groups) {
    if (!groups.length) return;
    ctx.save();
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    let x = w - 8;
    for (const { track: t } of [...groups].reverse()) {
      const label = t.name;
      const tw = ctx.measureText(label).width;
      if (x - tw - 14 < GUTTER + 40) break;      // no room left in the ruler
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = t.color;
      ctx.fillText(label, x - tw, RULER / 2);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x - tw - 9, RULER / 2 - 3, 5, 6);
      x -= tw + 18;
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------- paint */

  const C = {
    bg: '#0b0d12',
    rowIn: '#1b2130',     // belongs to the scale
    rowOut: '#0a0c11',    // outside the scale — pushed well back
    rowRoot: '#232c45',   // the tonic
    lineFaint: '#191e29',
    lineBeat: '#252c3c',
    lineBar: '#44506f',
  };

  function render() {
    if (!w || !h) return;
    const project = S.project();
    const track = getTrack();
    const sc = project.scale;
    const highlight = sc.highlight !== false;
    const total = S.totalSteps();
    const color = track ? track.color : '#6ee7ff';
    // Gathered once: this runs on every animation frame while the transport does.
    const ghosts = ghostTracks();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    const first = Math.max(0, Math.floor(scrollY / prefs.rowH));
    const last = Math.min(rows.length - 1, Math.ceil((scrollY + viewH()) / prefs.rowH));

    // --- row bands -----------------------------------------------------
    for (let i = first; i <= last; i++) {
      const p = rows[i];
      const y = yForRow(i);
      const inS = inScale(p, sc.root, sc.type);
      const root = isRoot(p, sc.root);
      let fill;
      if (!highlight) fill = BLACK.has(pitchClass(p)) ? C.rowOut : C.rowIn;
      else if (root) fill = C.rowRoot;
      else if (inS) fill = C.rowIn;
      else fill = C.rowOut;
      ctx.fillStyle = fill;
      ctx.fillRect(GUTTER, y, w - GUTTER, prefs.rowH - 1);

      if (highlight && root) {
        ctx.fillStyle = 'rgba(167,139,250,.18)';
        ctx.fillRect(GUTTER, y, w - GUTTER, prefs.rowH - 1);
      }
      // Octave separator under every B.
      if (pitchClass(p) === 0) {
        ctx.fillStyle = '#2a3040';
        ctx.fillRect(GUTTER, y + prefs.rowH - 1, w - GUTTER, 1);
      }
    }

    // --- vertical grid -------------------------------------------------
    const s0 = Math.max(0, Math.floor(scrollX / prefs.stepW));
    const s1 = Math.min(total, Math.ceil((scrollX + viewW()) / prefs.stepW));
    for (let s = s0; s <= s1; s++) {
      const x = Math.round(xForStep(s)) + 0.5;
      if (x < GUTTER - 1) continue;
      const isBar = s % S.STEPS_PER_BAR === 0;
      const isBeat = s % S.STEPS_PER_BEAT === 0;
      if (!isBeat && prefs.stepW < 16) continue;
      ctx.strokeStyle = isBar ? '#44506f' : isBeat ? C.lineBeat : C.lineFaint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Dim everything past the end of the song.
    const endX = xForStep(total);
    if (endX < w) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(Math.max(GUTTER, endX), RULER, w - Math.max(GUTTER, endX), h - RULER);
    }

    // --- notes ---------------------------------------------------------
    drawGhostNotes(ghosts, first, last);
    if (track) {
      for (const n of S.notesOf(track)) {
        const i = rowOfPitch(n.pitch);
        if (i < 0) continue;                 // hidden by fold
        if (i < first - 1 || i > last + 1) continue;
        const x = xForStep(n.t);
        const nw = Math.max(6, n.len * prefs.stepW - 2);
        if (x + nw < GUTTER || x > w) continue;
        const y = yForRow(i);
        const vel = n.vel ?? 0.9;

        ctx.save();
        ctx.beginPath();
        ctx.rect(GUTTER, RULER, w - GUTTER, h - RULER);
        ctx.clip();

        ctx.globalAlpha = 0.35 + 0.65 * vel;
        ctx.fillStyle = color;
        roundRect(ctx, x + 1, y + 2, nw, prefs.rowH - 5, 4);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,.32)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (nw > 34 && prefs.rowH >= 20) {
          ctx.fillStyle = 'rgba(0,0,0,.72)';
          ctx.font = '600 10px system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(noteLabel(n.pitch), x + 6, y + prefs.rowH / 2);
        }
        ctx.restore();
      }
    }

    refreshSuggestions();
    drawSuggestions(color);

    // --- playhead ------------------------------------------------------
    const ph = S.state.playing ? engine.playheadSteps() : (S.state.playhead || 0);
    const px = xForStep(ph);
    if (px >= GUTTER && px <= w) {
      ctx.strokeStyle = '#6ee7ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, RULER);
      ctx.lineTo(px, h);
      ctx.stroke();
    }

    drawRuler(total);
    drawGhostLegend(ghosts);
    drawKeys(first, last, sc, highlight);
  }

  function drawRuler(total) {
    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, 0, w, RULER);
    ctx.fillStyle = '#2a3040';
    ctx.fillRect(0, RULER - 1, w, 1);
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const bars = total / S.STEPS_PER_BAR;
    for (let b = 0; b < bars; b++) {
      const x = xForStep(b * S.STEPS_PER_BAR);
      if (x < GUTTER - 20 || x > w) continue;
      ctx.fillStyle = '#9aa4bb';
      ctx.fillText(String(b + 1), x + 4, RULER / 2);
      ctx.fillStyle = '#44506f';
      ctx.fillRect(Math.round(x), 4, 1, RULER - 8);
    }
  }

  function drawKeys(first, last, sc, highlight) {
    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, RULER, GUTTER, h - RULER);

    for (let i = first; i <= last; i++) {
      const p = rows[i];
      const y = yForRow(i);
      const black = BLACK.has(pitchClass(p));
      const inS = inScale(p, sc.root, sc.type);
      const root = isRoot(p, sc.root);

      ctx.fillStyle = black ? '#171b26' : '#232937';
      ctx.fillRect(0, y, GUTTER - 1, prefs.rowH - 1);

      if (highlight && inS) {
        ctx.fillStyle = root ? '#a78bfa' : 'rgba(167,139,250,.34)';
        ctx.fillRect(0, y, 4, prefs.rowH - 1);
      }
      if (prefs.rowH >= 18 && (pitchClass(p) === 0 || prefs.fold || prefs.rowH >= 24)) {
        ctx.fillStyle = root && highlight ? '#c4b5fd' : black ? '#6b7488' : '#c8d0e2';
        ctx.font = `${root ? 700 : 500} 10px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(noteLabel(p), 10, y + prefs.rowH / 2);
      }
    }
    ctx.fillStyle = '#2a3040';
    ctx.fillRect(GUTTER - 1, 0, 1, h);

    // Corner badge showing the active scale.
    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, 0, GUTTER, RULER);
    ctx.fillStyle = '#a78bfa';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(NOTE_NAMES[sc.root], 8, RULER / 2);
    ctx.fillStyle = '#6b7488';
    ctx.fillText(prefs.fold ? 'fold' : 'all', 26, RULER / 2);
  }

  function roundRect(c, x, y, rw, rh, r) {
    const rr = Math.min(r, rw / 2, rh / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + rw, y, x + rw, y + rh, rr);
    c.arcTo(x + rw, y + rh, x, y + rh, rr);
    c.arcTo(x, y + rh, x, y, rr);
    c.arcTo(x, y, x + rw, y, rr);
    c.closePath();
  }

  /* ---------------------------------------------------------- gestures */

  const pointers = new Map();
  let drag = null;          // { kind, note, ... }
  let pinch = null;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function snapStep(step) {
    return Math.max(0, Math.round(step / prefs.snap) * prefs.snap);
  }

  /** New notes start at the beginning of the cell that was tapped. */
  function snapDown(step) {
    return Math.max(0, Math.floor(step / prefs.snap) * prefs.snap);
  }

  function hitNote(track, x, y) {
    const pitch = pitchAtY(y);
    const step = stepAtX(x);
    const notes = S.notesOf(track);
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch !== pitch) continue;
      if (step >= n.t && step < n.t + n.len) return n;
    }
    return null;
  }

  function onDown(e) {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.set(e.pointerId, local(e));

    if (pointers.size === 2) {
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
        stepW: prefs.stepW, scrollX, scrollY,
        anchorStep: stepAtX((a.x + b.x) / 2),
      };
      return;
    }
    if (pointers.size > 2) return;

    const { x, y } = local(e);
    const track = getTrack();
    if (!track) return;

    if (y < RULER) {                        // ruler: scrub
      const s = Math.max(0, Math.min(S.totalSteps() - 0.01, stepAtX(x)));
      S.state.playhead = s;
      if (S.state.playing) engine.start(s);
      drag = { kind: 'scrub' };
      render();
      return;
    }

    if (x < GUTTER) {                       // keyboard: audition
      const p = pitchAtY(y);
      engine.preview(track, p, 'roll');
      drag = { kind: 'key', pitch: p };
      render();
      return;
    }

    const ghost = prefs.suggest && !(e.button === 2 || e.buttons === 2) ? hitSuggestion(x, y) : null;
    if (ghost && !hitNote(track, x, y)) {
      S.checkpoint();
      const note = S.addNote(track, { pitch: ghost.pitch, t: suggestion.at, len: prefs.drawLen, vel: 0.9 });
      engine.preview(track, ghost.pitch, 'roll');
      toast(`${noteLabel(ghost.pitch)} — ${ghost.reason}`);
      drag = { kind: 'resize', note, created: true };
      onEdit && onEdit();
      suggestKey = '';
      render();
      return;
    }

    const existing = hitNote(track, x, y);
    const erasing = prefs.mode === 'erase' || e.button === 2 || e.buttons === 2;

    if (erasing) {
      // One checkpoint per stroke, so a swipe-erase undoes in a single step.
      S.checkpoint();
      if (existing) { S.removeNote(track, existing.id); onEdit && onEdit(); }
      drag = { kind: 'erase' };
      render();
      return;
    }

    if (existing) {
      const noteEndX = xForStep(existing.t + existing.len);
      const nearEnd = Math.abs(x - noteEndX) < Math.max(14, prefs.stepW * 0.4);
      S.checkpoint();
      drag = nearEnd
        ? { kind: 'resize', note: existing }
        : { kind: 'move', note: existing, grabStep: stepAtX(x) - existing.t, grabPitch: pitchAtY(y), moved: false };
      drag.startX = x;
      drag.startY = y;
      drag.hold = setTimeout(() => {
        if (!drag) return;
        drag.opened = true;
        engine.stopPreview('roll');
        openNoteSheet(track, existing, { onChange: () => { computeRows(); render(); onEdit && onEdit(); } });
      }, 500);
      engine.preview(track, existing.pitch, 'roll');
      render();
      return;
    }

    // Empty cell -> create a note and let the same drag stretch it.
    const sc = S.project().scale;
    let pitch = pitchAtY(y);
    if (!prefs.fold && sc.lock) pitch = snapToScale(pitch, sc.root, sc.type);
    const t = Math.max(0, Math.min(S.totalSteps() - prefs.snap, snapDown(stepAtX(x))));
    S.checkpoint();
    const note = S.addNote(track, { pitch, t, len: prefs.drawLen, vel: 0.9 });
    engine.preview(track, pitch, 'roll');
    drag = { kind: 'resize', note, created: true };
    onEdit && onEdit();
    render();
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const ratio = dist / Math.max(1, pinch.dist);
      prefs.stepW = Math.max(MIN_STEP_W, Math.min(MAX_STEP_W, pinch.stepW * ratio));
      // Keep the pinch centre anchored to the same musical position.
      scrollX = pinch.anchorStep * prefs.stepW - (cx - GUTTER);
      scrollY = pinch.scrollY - (cy - pinch.cy);
      clampScroll();
      render();
      return;
    }
    if (!drag) return;

    const { x, y } = local(e);
    const track = getTrack();
    if (!track) return;

    if (drag.kind === 'scrub') {
      const s = Math.max(0, Math.min(S.totalSteps() - 0.01, stepAtX(x)));
      S.state.playhead = s;
      render();
      return;
    }
    if (drag.kind === 'key') {
      const p = pitchAtY(y);
      if (p !== drag.pitch) { drag.pitch = p; engine.preview(track, p, 'roll'); }
      return;
    }
    if (drag.kind === 'erase') {
      const n = hitNote(track, x, y);
      if (n) { S.removeNote(track, n.id); onEdit && onEdit(); render(); }
      return;
    }
    if (drag.hold && Math.hypot(x - drag.startX, y - drag.startY) > 8) {
      clearTimeout(drag.hold);
      drag.hold = null;
    }
    if (drag.opened) return;

    if (drag.kind === 'resize') {
      const n = drag.note;
      const end = snapStep(stepAtX(x) + prefs.snap * 0.5);
      n.len = Math.max(prefs.snap, Math.min(S.totalSteps() - n.t, end - n.t));
      S.touch();
      render();
      return;
    }
    if (drag.kind === 'move') {
      const n = drag.note;
      const sc = S.project().scale;
      let pitch = pitchAtY(y);
      if (!prefs.fold && sc.lock) pitch = snapToScale(pitch, sc.root, sc.type);
      const t = Math.max(0, Math.min(S.totalSteps() - n.len, snapStep(stepAtX(x) - drag.grabStep)));
      if (pitch !== n.pitch) { n.pitch = pitch; engine.preview(track, pitch, 'roll'); drag.moved = true; }
      if (t !== n.t) { n.t = t; drag.moved = true; }
      S.touch();
      render();
    }
  }

  function onUp(e) {
    if (drag && drag.hold) { clearTimeout(drag.hold); drag.hold = null; }
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (pointers.size < 2) pinch = null;

    if (drag && drag.kind === 'key') engine.stopPreview('roll');
    if (drag && (drag.kind === 'move' || drag.kind === 'resize')) {
      engine.stopPreview('roll');
      // Remember the length the user just dialled in as the new default.
      if (drag.kind === 'resize' && drag.note && !drag.opened) { prefs.drawLen = drag.note.len; savePrefs(); }
      onEdit && onEdit();
    }
    if (pointers.size === 0) drag = null;
    render();
  }

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const before = stepAtX(local(e).x);
      prefs.stepW = Math.max(MIN_STEP_W, Math.min(MAX_STEP_W, prefs.stepW * (e.deltaY < 0 ? 1.12 : 0.89)));
      scrollX = before * prefs.stepW - (local(e).x - GUTTER);
      savePrefs();
    } else if (e.shiftKey) {
      scrollX += e.deltaY;
    } else {
      scrollY += e.deltaY;
      scrollX += e.deltaX;
    }
    clampScroll();
    render();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  /* ---------------------------------------------------------- exports */

  return {
    render,
    resize,
    prefs,
    savePrefs,
    refreshRows() { computeRows(); suggestKey = ''; clampScroll(); render(); },

    /** Bring the suggested notes into view — they often sit past the last bar. */
    revealSuggestions() {
      suggestKey = '';
      refreshSuggestions();
      if (!suggestion || !suggestion.items.length) { render(); return; }
      if (suggestion.full) toast('The song is full — add bars in the Song tab to keep writing');
      // Always centre on the anchor: the ghosts usually sit past the last
      // note, so leaving the view where it was tends to hide them.
      scrollX = Math.max(0, suggestion.at * prefs.stepW - viewW() * 0.5);
      const rowIdxs = suggestion.items.map((i) => rowOfPitch(i.pitch)).filter((i) => i >= 0);
      if (rowIdxs.length) {
        const mid = (Math.min(...rowIdxs) + Math.max(...rowIdxs)) / 2;
        scrollY = mid * prefs.rowH - viewH() / 2 + prefs.rowH / 2;
      }
      clampScroll();
      render();
    },
    recentre() { computeRows(); centreOnContent(); render(); },
    followPlayhead() {
      if (!S.state.playing) return;
      const px = xForStep(engine.playheadSteps());
      if (px > w - 60 || px < GUTTER) {
        scrollX = Math.max(0, engine.playheadSteps() * prefs.stepW - viewW() * 0.25);
        clampScroll();
      }
    },
    destroy() { ro.disconnect(); },
  };
}
