// Central project store: a single plain-JSON document, a subscribe/notify
// bus, an undo stack of structural snapshots, and debounced autosave.

import * as db from './db.js';

export const STEPS_PER_BEAT = 4;   // 16th-note grid
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BAR = STEPS_PER_BEAT * BEATS_PER_BAR;
export const PAD_COUNT = 8;

export const TRACK_COLORS = [
  '#6ee7ff', '#a78bfa', '#fb7185', '#fbbf24',
  '#4ade80', '#f472b6', '#38bdf8', '#facc15',
];

let seq = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export function defaultSynth() {
  return {
    // oscillator 1
    wave: 'sawtooth',
    octave: 0,
    detune: 8,
    voices: 2,              // unison voices on osc 1 (1 = no detune pair)
    // oscillator 2 — 'off' keeps an old project sounding exactly as it did
    wave2: 'off',
    osc2Semi: -12,
    osc2Level: 0.5,
    // extras mixed in alongside the oscillators
    subLevel: 0,            // sine an octave below osc 1
    noiseLevel: 0,
    drive: 0,               // waveshaper before the filter
    // filter and its own envelope
    filterType: 'lowpass',
    cutoff: 3200, resonance: 6, filterEnv: 0.4,
    filterAttack: 0.005, filterDecay: 0.18,
    // amp envelope
    attack: 0.005, decay: 0.18, sustain: 0.55, release: 0.22,
    // modulation
    lfoTarget: 'off',       // 'off' | 'pitch' | 'filter' | 'amp'
    lfoRate: 5,
    lfoDepth: 0.3,
    glide: 0,               // seconds of portamento from the previous note
    level: 1,
  };
}

/**
 * Ducking: the channel's own gain is pulled down whenever a *trigger* fires,
 * which is how a bass makes room for a kick. The trigger is a track and, for
 * a drum track, one of its pads — a kit's kick is a pad, not a channel, so
 * pointing at the track alone would pump on every hat as well.
 * `sourcePad` is null for "any note on that track".
 */
export function defaultSidechain() {
  return {
    on: false,
    sourceId: null,
    sourcePad: null,
    amount: 0.7,        // 0..1, how far down the duck goes at full velocity
    attack: 0.012,      // seconds to reach the bottom
    release: 0.18,      // seconds back to unity
  };
}

const TRACK_NAMES = { drum: 'Drums', sampler: 'Sampler', synth: 'Synth', audio: 'Audio' };

export function makeTrack(type = 'synth', index = 0) {
  const base = {
    id: uid('trk'),
    name: TRACK_NAMES[type] || 'Track',
    type,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    fx: [],                 // effect chain, in order
  };
  if (type === 'audio') {
    base.armed = false;
    base.monitor = false;
  }
  if (type === 'synth') base.synth = defaultSynth();
  if (type === 'sampler') {
    base.sampleId = null;
    base.rootNote = 60;
    base.attack = 0.002;
    base.release = 0.08;
    base.loop = false;
    base.reverse = false;
  }
  if (type === 'drum') {
    base.pads = Array.from({ length: PAD_COUNT }, (_, i) => ({
      name: `Pad ${i + 1}`, sampleId: null, gain: 0.9, pitch: 0, pan: 0,
    }));
  }
  base.automation = {};     // lane key -> [{ t, v }], see AUTO_LANES
  base.sidechain = defaultSidechain();
  return base;
}

/* ----------------------------------------------------------- automation
 *
 * A lane is a list of breakpoints in song time, `t` in 16th steps, `v`
 * always normalised 0..1. Keeping every lane on the same 0..1 axis is what
 * lets one canvas draw all four and one editor edit all four; the lane
 * itself owns the mapping back to hertz, decibels or a pan position.
 */

const expMap = (lo, hi) => ({
  value: (n) => lo * Math.pow(hi / lo, Math.max(0, Math.min(1, n))),
  norm: (v) => Math.log(Math.max(lo, Math.min(hi, v)) / lo) / Math.log(hi / lo),
});

const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

export const AUTO_LANES = {
  volume: {
    name: 'Volume', short: 'Vol', colour: '#4ade80', def: 1,
    // Square law: a straight line drawn on the lane fades the way an ear
    // expects, instead of dropping most of the loudness in the top quarter.
    value: (n) => n * n,
    format: (n) => (n <= 0.001 ? '−∞ dB' : `${(20 * Math.log10(n * n)).toFixed(1)} dB`),
  },
  pan: {
    name: 'Pan', short: 'Pan', colour: '#a78bfa', def: 0.5,
    value: (n) => n * 2 - 1,
    format: (n) => {
      const v = n * 2 - 1;
      return Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`;
    },
  },
  hpf: {
    name: 'High pass', short: 'HP', colour: '#fbbf24', def: 0,
    ...expMap(20, 8000),
    format(n) { return n <= 0.001 ? 'off' : `${hz(this.value(n))} Hz`; },
  },
  lpf: {
    name: 'Low pass', short: 'LP', colour: '#6ee7ff', def: 1,
    ...expMap(200, 20000),
    format(n) { return n >= 0.999 ? 'off' : `${hz(this.value(n))} Hz`; },
  },
};

export const AUTO_KEYS = Object.keys(AUTO_LANES);

/** The lane's breakpoints, created lazily so untouched tracks stay small. */
export function autoLane(track, key, create = false) {
  if (!track) return [];
  if (!track.automation) track.automation = {};
  if (!track.automation[key]) {
    if (!create) return [];
    track.automation[key] = [];
  }
  return track.automation[key];
}

export const hasAutomation = (track, key) => (track?.automation?.[key] || []).length > 0;

export const anyAutomation = (track) => AUTO_KEYS.some((k) => hasAutomation(track, k));

/**
 * The lane's normalised value at a step: flat before the first point and
 * after the last, straight lines between. An empty lane is its default,
 * which is what makes "no points" mean "this parameter is not in play".
 */
export function autoNormAt(track, key, step) {
  const pts = autoLane(track, key);
  const def = AUTO_LANES[key]?.def ?? 1;
  if (!pts.length) return def;
  if (step <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (step >= last.t) return last.v;
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (step > b.t) continue;
    const a = pts[i - 1];
    const span = b.t - a.t;
    if (span <= 0) return b.v;
    return a.v + (b.v - a.v) * ((step - a.t) / span);
  }
  return last.v;
}

/** The lane's real value (gain, pan position, hertz) at a step. */
export function autoValueAt(track, key, step) {
  const lane = AUTO_LANES[key];
  const n = autoNormAt(track, key, step);
  return lane ? lane.value(n) : n;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Add or move a breakpoint. One point per step — a lane is a function. */
export function setAutoPoint(track, key, t, v) {
  const pts = autoLane(track, key, true);
  const at = Math.max(0, Math.round(t));
  const point = { t: at, v: clamp01(v) };
  const i = pts.findIndex((p) => p.t === at);
  if (i >= 0) pts[i] = point; else pts.push(point);
  pts.sort((a, b) => a.t - b.t);
  touch();
  return point;
}

export function removeAutoPoint(track, key, t) {
  const pts = autoLane(track, key);
  const i = pts.findIndex((p) => p.t === t);
  if (i < 0) return false;
  pts.splice(i, 1);
  touch();
  return true;
}

export function clearAutoLane(track, key) {
  if (track?.automation) delete track.automation[key];
  touch();
}

/* ------------------------------------------------------------ sidechain */

/** The track a channel is ducked by, or null when nothing valid is set. */
export function duckSource(track) {
  const sc = track && track.sidechain;
  if (!sc || !sc.on || !sc.sourceId || sc.sourceId === track.id) return null;
  return trackById(sc.sourceId);
}

/** Is this channel actually being ducked by something that still exists? */
export const isDucked = (track) => !!duckSource(track);

export const anyDucked = () => state.project.tracks.some(isDucked);

/** A pattern holds notes per track; the playlist places copies of it in time. */
export function makePattern(name = 'Pattern 1', bars = 4) {
  return { id: uid('pat'), name, bars, color: TRACK_COLORS[0], notes: {} };
}

export function makeProject(name = 'Untitled') {
  const first = makePattern('Pattern 1', 4);
  const p = {
    id: uid('prj'),
    name,
    bpm: 100,
    swing: 0,
    masterVolume: 0.85,
    metronome: false,
    loop: true,
    scale: { root: 0, type: 'minorPentatonic', lock: true, highlight: true },
    mode: 'pattern',            // 'pattern' loops the editor's pattern, 'song' plays the playlist
    patterns: [first],
    activePatternId: first.id,
    clips: [],                  // playlist clips, positions in 16th steps
    songBars: 16,
    tracks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  p.tracks.push(makeTrack('drum', 0));
  p.tracks.push(makeTrack('synth', 1));
  return p;
}

/**
 * A playlist clip: either a pattern placed at a bar position, or a piece of
 * recorded/imported audio. `start` and `length` are in 16th steps.
 */
export function makeClip({ trackId, kind, patternId = null, sampleId = null, start = 0, length = 16 }) {
  return {
    id: uid('clip'),
    trackId, kind, patternId, sampleId,
    start, length,
    gain: 1,
    offset: 0,          // seconds into the sample (audio clips)
    offsetSteps: 0,     // steps into the pattern (pattern clips)
    fadeIn: 0,          // seconds
    fadeOut: 0,         // seconds
    mutes: [],          // muted local steps, sorted — silenced, not removed
    loop: false,        // repeat the sample when the clip outlasts it
    stretch: false,     // resizing fits the audio instead of trimming it
    stretchSrc: 0,      // source seconds the clip spans while stretched
    tape: false,        // stretch by resampling (pitch moves) instead of WSOLA
    pitchEdits: null,   // the pitch editor's note arrangement, if any
    sourceSampleId: sampleId,   // kept so tuning can be undone
  };
}

/** Defaults for clip fields added after a project was saved. */
export function clipDefaults(c) {
  return {
    gain: 1, offset: 0, offsetSteps: 0, fadeIn: 0, fadeOut: 0, loop: false,
    stretch: false, stretchSrc: 0, tape: false, pitchEdits: null,
    ...c,
    mutes: Array.isArray(c.mutes) ? c.mutes : [],
    sourceSampleId: c.sourceSampleId || c.sampleId || null,
  };
}

/* --------------------------------------------------------------- stretch */

// The window a clip may be stretched into. Past these the grains smear
// audibly, but the limit still has to be generous: a clip stretched past it
// simply runs out part way through, which reads as the app losing the audio
// rather than as a quality ceiling.
export const MIN_SPEED = 0.125;   // eight times longer
export const MAX_SPEED = 8;       // eight times shorter

/**
 * How much faster than real time a clip plays its source: 1 is untouched, 2
 * squeezes two seconds of sample into one of song. The geometry lives here
 * because the document owns it — `audio/stretch.js` only does the DSP.
 */
export function clipSpeed(clip, stepDur = secondsPerStep()) {
  if (!clip || !clip.stretch) return 1;
  const out = (clip.length || 1) * stepDur;
  const src = clip.stretchSrc || out;
  if (out <= 0 || src <= 0) return 1;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, src / out));
}

/** Seconds of source a clip covers, stretched or not. */
export const clipSourceSeconds = (clip, stepDur = secondsPerStep()) =>
  (clip.stretch ? (clip.stretchSrc || clip.length * stepDur) : clip.length * stepDur);

/**
 * Turn stretching on or off without moving what you hear: the source span the
 * clip covers right now becomes the span it keeps.
 */
export function setClipStretch(clip, on, stepDur = secondsPerStep()) {
  if (on) {
    clip.stretchSrc = clipSourceSeconds(clip, stepDur);
    clip.stretch = true;
  } else {
    // Coming back out, the clip keeps its *sound* rather than its length:
    // the audio plays at 1x again, so the window is as long as the material.
    const src = clipSourceSeconds(clip, stepDur);
    clip.stretch = false;
    clip.stretchSrc = 0;
    clip.length = Math.max(1, Math.round(src / stepDur));
  }
  touch();
  return clip;
}

/* ---------------------------------------------------------------- store */

const listeners = new Set();
const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 60;

export const state = {
  project: makeProject(),
  selectedTrackId: null,
  playing: false,
  playhead: 0,          // in steps, float
  sampleIndex: [],      // cached sample records (without blobs where possible)
  dirty: false,
  saveError: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  for (const fn of listeners) fn(reason, state);
}

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

/** Record an undo checkpoint. Call *before* mutating. */
export function checkpoint() {
  undoStack.push(clone(state.project));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(clone(state.project));
  state.project = undoStack.pop();
  touch(false);
  emit('undo');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(clone(state.project));
  state.project = redoStack.pop();
  touch(false);
  emit('redo');
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/* ------------------------------------------------------------ selectors */

export const project = () => state.project;

/* --------------------------------------------------- patterns and clips */

export function activePattern() {
  const p = state.project;
  return p.patterns.find((x) => x.id === p.activePatternId) || p.patterns[0];
}

export function patternById(id) {
  return state.project.patterns.find((x) => x.id === id) || null;
}

/**
 * The note list for a track inside a pattern (the active one by default).
 * Created lazily so patterns only carry tracks that were actually used.
 */
export function notesOf(track, pattern = activePattern()) {
  if (!pattern || !track) return [];
  if (!pattern.notes[track.id]) pattern.notes[track.id] = [];
  return pattern.notes[track.id];
}

export function setActivePattern(id) {
  if (!patternById(id)) return;
  state.project.activePatternId = id;
  touch();
  emit('pattern');
}

export function addPattern(name) {
  const p = state.project;
  const bars = activePattern()?.bars || 4;
  const pat = makePattern(name || `Pattern ${p.patterns.length + 1}`, bars);
  pat.color = TRACK_COLORS[p.patterns.length % TRACK_COLORS.length];
  p.patterns.push(pat);
  p.activePatternId = pat.id;
  touch();
  emit('pattern');
  return pat;
}

export function duplicatePattern(id) {
  const src = patternById(id);
  if (!src) return null;
  const p = state.project;
  const copy = clone(src);
  copy.id = uid('pat');
  copy.name = `${src.name} copy`;
  copy.color = TRACK_COLORS[p.patterns.length % TRACK_COLORS.length];
  for (const key of Object.keys(copy.notes)) {
    copy.notes[key] = copy.notes[key].map((n) => ({ ...n, id: uid('n') }));
  }
  p.patterns.push(copy);
  p.activePatternId = copy.id;
  touch();
  emit('pattern');
  return copy;
}

export function removePattern(id) {
  const p = state.project;
  if (p.patterns.length <= 1) return false;
  const i = p.patterns.findIndex((x) => x.id === id);
  if (i < 0) return false;
  p.patterns.splice(i, 1);
  p.clips = p.clips.filter((c) => c.patternId !== id);
  if (p.activePatternId === id) p.activePatternId = p.patterns[0].id;
  touch();
  emit('pattern');
  return true;
}

export const clipsOfTrack = (trackId) => state.project.clips.filter((c) => c.trackId === trackId);

export function addClip(clip) {
  state.project.clips.push(clip);
  touch();
  return clip;
}

export function removeClip(id) {
  const p = state.project;
  const i = p.clips.findIndex((c) => c.id === id);
  if (i >= 0) { p.clips.splice(i, 1); touch(); }
}

export const clipById = (id) => state.project.clips.find((c) => c.id === id) || null;

export const clipEnd = (c) => c.start + c.length;

/** Is this local step inside the clip silenced? */
export const stepMuted = (clip, localStep) =>
  !!clip.mutes && clip.mutes.includes(localStep);

/** Toggle a run of local steps on or off, keeping the list sorted and unique. */
export function setClipMutes(clip, steps, muted) {
  const set = new Set(clip.mutes || []);
  for (const s of steps) { if (muted) set.add(s); else set.delete(s); }
  clip.mutes = [...set].sort((a, b) => a - b);
  touch();
}

/** Muted local steps collapsed into [from, to) ranges, for the scheduler. */
export function muteRanges(clip) {
  const steps = [...(clip.mutes || [])].sort((a, b) => a - b);
  const out = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (last && s === last[1]) last[1] = s + 1;
    else out.push([s, s + 1]);
  }
  return out;
}

/**
 * Cut a clip in two at an absolute step. Audio keeps playing through the cut
 * because the second half carries the offset the first half ended at, which
 * is what makes "split, then move the back half" work.
 */
export function splitClip(clip, atStep) {
  const local = Math.round(atStep - clip.start);
  if (local <= 0 || local >= clip.length) return null;

  const right = { ...clip, id: uid('clip') };
  right.start = clip.start + local;
  right.length = clip.length - local;
  right.mutes = (clip.mutes || []).filter((s) => s >= local).map((s) => s - local);
  if (clip.kind === 'audio') {
    // How much *source* the left half consumed — which is not the same as its
    // length once the clip is stretched.
    const consumed = local * secondsPerStep() * clipSpeed(clip);
    right.offset = (clip.offset || 0) + consumed;
    right.fadeIn = 0;
    clip.fadeOut = 0;
    if (clip.stretch) {
      const src = clipSourceSeconds(clip);
      right.stretchSrc = Math.max(0.01, src - consumed);
      clip.stretchSrc = Math.max(0.01, consumed);
    }
    // Each half keeps its own pitch arrangement; the notes are re-analysed
    // against the new window when the editor is next opened.
    right.pitchEdits = null;
    clip.pitchEdits = null;
  } else {
    right.offsetSteps = (clip.offsetSteps || 0) + local;
  }

  clip.length = local;
  clip.mutes = (clip.mutes || []).filter((s) => s < local);
  state.project.clips.push(right);
  touch();
  return right;
}

/** Steps in the pattern being edited. */
export const totalSteps = () => (activePattern()?.bars || 4) * STEPS_PER_BAR;
/** Steps in the whole arrangement. */
export const songSteps = () => state.project.songBars * STEPS_PER_BAR;
/** Whatever the transport is currently cycling over. */
export const transportSteps = () => (state.project.mode === 'song' ? songSteps() : totalSteps());
export const selectedTrack = () =>
  state.project.tracks.find((t) => t.id === state.selectedTrackId) || state.project.tracks[0] || null;

export function trackById(id) {
  return state.project.tracks.find((t) => t.id === id) || null;
}

export function anySolo() {
  return state.project.tracks.some((t) => t.solo);
}

export function isAudible(track) {
  if (track.mute) return false;
  if (anySolo() && !track.solo) return false;
  return true;
}

export const secondsPerStep = (bpm = state.project.bpm) => 60 / bpm / STEPS_PER_BEAT;

/* ------------------------------------------------------------- mutation */

let saveTimer = null;

export function touch(markDirty = true) {
  state.project.updatedAt = Date.now();
  if (markDirty) state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

export async function save() {
  clearTimeout(saveTimer);
  const rec = clone(state.project);
  try {
    // A blocked IndexedDB never settles, so a stalled save must not look like
    // a successful one — silently losing work is the worst failure here.
    await db.putProject(rec);
    await db.setMeta('lastProjectId', rec.id);
  } catch (e) {
    state.saveError = e.message || 'Could not save';
    emit('saveerror');
    return false;
  }
  state.saveError = null;
  state.dirty = false;
  emit('saved');
  return true;
}

export async function loadLastProject() {
  // Storage can be blocked (another tab mid-upgrade, a stuck delete). Never
  // let that stall start-up — boot with an empty project and say so instead.
  try {
    const id = await db.getMeta('lastProjectId');
    if (id) {
      const rec = await db.getProject(id);
      if (rec) { state.project = migrate(rec); return true; }
    }
    const all = await db.allProjects();
    if (all && all.length) {
      all.sort((a, b) => b.updatedAt - a.updatedAt);
      state.project = migrate(all[0]);
      return true;
    }
  } catch (e) {
    state.saveError = e.message || 'Could not read saved projects';
  }
  return false;
}

export async function loadProject(id) {
  const rec = await db.getProject(id);
  if (!rec) return false;
  state.project = migrate(rec);
  undoStack.length = 0; redoStack.length = 0;
  state.selectedTrackId = state.project.tracks[0]?.id || null;
  await db.setMeta('lastProjectId', id);
  emit('project');
  return true;
}

/** Fill in fields added after a project was first saved. */
function migrate(p) {
  const d = makeProject();
  const out = { ...d, ...p };
  out.scale = { ...d.scale, ...(p.scale || {}) };

  const legacyNotes = {};
  out.tracks = (p.tracks || []).map((t, i) => {
    const base = makeTrack(t.type || 'synth', i);
    const merged = { ...base, ...t };
    if (merged.type === 'synth') merged.synth = { ...defaultSynth(), ...(t.synth || {}) };
    if (merged.type === 'drum') {
      merged.pads = base.pads.map((pad, j) => ({ ...pad, ...((t.pads || [])[j] || {}) }));
    }
    merged.fx = (t.fx || []).map((f) => ({ id: f.id || uid('fx'), ...f }));
    // A partial sidechain block from an older build must not knock out the
    // fields it predates, so it is merged rather than taken whole.
    merged.sidechain = { ...defaultSidechain(), ...(t.sidechain || {}) };
    // Automation lanes: keep only known lanes, sorted, so a hand-edited or
    // older project can never feed the scheduler an unsorted list.
    merged.automation = {};
    for (const key of AUTO_KEYS) {
      const pts = (t.automation || {})[key];
      if (!Array.isArray(pts) || !pts.length) continue;
      merged.automation[key] = pts
        .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
        .map((p) => ({ t: Math.max(0, Math.round(p.t)), v: Math.max(0, Math.min(1, p.v)) }))
        .sort((a, b) => a.t - b.t);
    }
    // Projects from before patterns existed kept notes on the track itself.
    if (Array.isArray(t.notes) && t.notes.length) {
      legacyNotes[merged.id] = t.notes.map((n) => ({ id: n.id || uid('n'), ...n }));
    }
    delete merged.notes;
    return merged;
  });

  if (!Array.isArray(p.patterns) || !p.patterns.length) {
    const first = makePattern('Pattern 1', p.bars || 4);
    first.notes = legacyNotes;
    out.patterns = [first];
    out.activePatternId = first.id;
    out.clips = [];
  } else {
    out.patterns = p.patterns.map((pat) => ({
      ...makePattern(pat.name, pat.bars || 4),
      ...pat,
      notes: pat.notes || {},
    }));
    if (!out.patterns.some((x) => x.id === out.activePatternId)) {
      out.activePatternId = out.patterns[0].id;
    }
    out.clips = (p.clips || []).map((c) => clipDefaults({ ...c, id: c.id || uid('clip') }));
  }
  out.songBars = p.songBars || d.songBars;
  out.mode = p.mode === 'song' ? 'song' : 'pattern';
  delete out.bars;
  return out;
}

export function newProject(name) {
  checkpoint();
  state.project = makeProject(name || 'Untitled');
  state.selectedTrackId = state.project.tracks[0].id;
  touch();
  emit('project');
}

/* ---------------------------------------------------------------- notes */

export function addNote(track, { pitch, t, len = STEPS_PER_BEAT, vel = 0.9 }) {
  const note = { id: uid('n'), pitch, t, len, vel };
  notesOf(track).push(note);
  touch();
  return note;
}

export function removeNote(track, noteId) {
  const list = notesOf(track);
  const i = list.findIndex((n) => n.id === noteId);
  if (i >= 0) { list.splice(i, 1); touch(); }
}

/**
 * Copy one track's notes onto another inside the same pattern. Notes are the
 * pattern's, not the track's, so this is a copy between two lists in one
 * document — the ids are fresh, otherwise undo would see one note twice.
 *
 * `pitch` means a pad index on a drum track and a MIDI note everywhere else,
 * so the caller is responsible for only pairing like with like.
 */
export function copyNotes(from, to, { pattern = activePattern(), merge = false } = {}) {
  if (!from || !to || from === to || !pattern) return 0;
  const src = notesOf(from, pattern);
  const dst = notesOf(to, pattern);
  if (!merge) dst.length = 0;
  for (const n of src) dst.push({ ...n, id: uid('n') });
  dst.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
  touch();
  return src.length;
}

export function clearTrackNotes(track) {
  checkpoint();
  notesOf(track).length = 0;
  touch();
  emit('notes');
}
