// Per-note pitch editing for an audio clip — the Melodyne/NewTone idea.
//
// `autotune.js` corrects a take frame by frame against a scale. This does the
// other half: it cuts the pitch track into *notes* you can pick up and move,
// in pitch and in time, one at a time.
//
// Three rules shape the implementation:
//
//   1. A note nobody touched is copied through untouched. Resynthesising a
//      whole take to move one note is how editors get their reputation for
//      sounding processed; here the artefacts stay where the edits are.
//   2. Duration is preserved per note. Grains come from the time-aligned
//      input while output marks are spaced by period/ratio (TD-PSOLA), so a
//      note lands on the same beat it was sung on unless you move it.
//   3. Nothing is destructive. The editor hands back a note list; the render
//      writes a new sample and the clip keeps `sourceSampleId`, exactly as
//      autotune does, so "revert" is free.

import { detectPitch, freqToMidi } from './autotune.js';

const MIN_NOTE = 0.09;        // shorter than this is a consonant, not a note
const GAP_FRAMES = 0.06;      // unvoiced for this long ends a note
const SPLIT_CENTS = 65;       // pitch move that starts a new note
const CROSSFADE = 1 / 40;     // seconds of overlap where a note meets the take

let seq = 0;
const noteId = () => `pn_${(seq++).toString(36)}`;

/** The pitch a note is asked to end up at, in (fractional) MIDI. */
export const targetMidi = (note) =>
  note.midi + (note.semitones || 0) + (note.cents || 0) / 100;

/** Has this note been touched at all? Untouched ones are copied verbatim. */
export const isEdited = (note) => !!(note.semitones || note.cents || note.shift
  || note.flatten || note.mute);

export const anyEdits = (notes) => (notes || []).some(isEdited);

/* ------------------------------------------------------------ analysis */

/** Median of a numeric array, ignoring zeroes. */
function median(values) {
  const v = values.filter(Boolean).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.floor(v.length / 2)];
}

/**
 * Cut a pitch track into notes inside [from, to] seconds.
 *
 * A note ends when the voice drops out for long enough, or when it settles
 * more than a comma away from where this note has been sitting — judged
 * against the note's running median rather than the previous frame, so
 * vibrato does not shred a held note into fragments.
 */
export function segmentNotes(track, from = 0, to = Infinity) {
  const { f0, confidence, hopSeconds, frames } = track;
  const notes = [];
  let cur = null;
  let silence = 0;

  const close = () => {
    if (!cur) return;
    const dur = cur.to - cur.from;
    if (dur >= MIN_NOTE && cur.pitches.length) {
      notes.push({
        id: noteId(),
        from: cur.from,
        to: cur.to,
        midi: median(cur.pitches),
        confidence: cur.conf / cur.pitches.length,
        semitones: 0, cents: 0, shift: 0, flatten: 0, mute: false,
      });
    }
    cur = null;
  };

  for (let i = 0; i < frames; i++) {
    const t = i * hopSeconds;
    if (t < from) continue;
    if (t > to) break;

    if (!f0[i]) {
      silence += hopSeconds;
      if (silence >= GAP_FRAMES) close();
      continue;
    }
    silence = 0;
    const m = freqToMidi(f0[i]);

    if (cur) {
      const centre = median(cur.pitches);
      if (Math.abs(m - centre) * 100 > SPLIT_CENTS && cur.to - cur.from >= MIN_NOTE) {
        close();
      }
    }
    if (!cur) cur = { from: t, to: t, pitches: [], conf: 0 };
    cur.to = t + hopSeconds;
    cur.pitches.push(m);
    cur.conf += confidence[i] || 0;
  }
  close();
  return notes;
}

/** Analyse a buffer window and cut it into notes. Slow-ish; call it once. */
export function analyseNotes(buffer, { from = 0, to = Infinity } = {}) {
  const track = detectPitch(buffer);
  return { track, notes: segmentNotes(track, from, Math.min(to, buffer.duration)) };
}

/** Split one note in two at `at` seconds, keeping both halves usable. */
export function splitNote(notes, id, at) {
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0) return notes;
  const n = notes[i];
  if (at - n.from < MIN_NOTE || n.to - at < MIN_NOTE) return notes;
  const left = { ...n, to: at };
  const right = { ...n, id: noteId(), from: at };
  return [...notes.slice(0, i), left, right, ...notes.slice(i + 1)];
}

/** Merge a note with the one after it — the undo for an unwanted split. */
export function mergeNote(notes, id) {
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0 || i + 1 >= notes.length) return notes;
  const a = notes[i];
  const b = notes[i + 1];
  const merged = { ...a, to: b.to, midi: (a.midi + b.midi) / 2 };
  return [...notes.slice(0, i), merged, ...notes.slice(i + 2)];
}

/* -------------------------------------------------------------- render */

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}
const windows = new Map();
const windowOf = (n) => {
  if (!windows.has(n)) windows.set(n, hann(n));
  return windows.get(n);
};

/**
 * Take a note's original audio out of the output.
 *
 * The ramps sit *outside* the note and are linear, because the rendered note
 * fades in over exactly the same window with the complementary gain: the two
 * sum to one. Fading the original out *inside* the note instead leaves both
 * playing at full level on the boundary, which shows up as a spike of nearly
 * double amplitude one frame wide.
 */
function erase(channels, fromFrame, toFrame, ramp) {
  for (const data of channels) {
    const a = fromFrame;
    const b = toFrame;
    const lo = Math.max(0, a - ramp);
    const hi = Math.min(data.length, b + ramp);
    for (let i = lo; i < hi; i++) {
      let g = 0;
      if (i < a) g = (a - i) / ramp;
      else if (i >= b) g = (i - b + 1) / ramp;
      data[i] *= Math.min(1, g);
    }
  }
}

/** RMS and peak of one region — how loud the note was, and now is. */
function regionLevel(data, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(data.length, to);
  if (b <= a) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = a; i < b; i++) {
    sum += data[i] * data[i];
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  return { rms: Math.sqrt(sum / (b - a)), peak };
}

/**
 * Lay one note back down: grains cut around its pitch marks, respaced by the
 * pitch ratio and written at `dstStart`. Duration is preserved because the
 * grain source tracks output time; only the spacing changes.
 *
 * The note is built in its own scratch buffer and matched to the level it had
 * before it was moved. Overlap-add at a new spacing does not preserve energy —
 * an octave up comes back about 9 dB down — and a retuned note that changes
 * loudness reads as a mistake even when the pitch is right.
 */
function renderNote(ins, outs, note, { track, rate, gain }) {
  const fromFrame = Math.round(note.from * rate);
  const toFrame = Math.round(note.to * rate);
  const length = toFrame - fromFrame;
  if (length <= 0) return;

  const dstStart = Math.round((note.from + (note.shift || 0)) * rate);
  const framesPerSample = 1 / (track.hopSeconds * rate);
  const frameAt = (sample) => Math.max(0, Math.min(track.frames - 1,
    Math.round(sample * framesPerSample)));
  const defaultPeriod = rate / 150;
  const periodAt = (sample) => {
    const f = track.f0[frameAt(sample)];
    return f > 0 ? rate / f : defaultPeriod;
  };

  const want = targetMidi(note);
  const flatten = Math.max(0, Math.min(1, note.flatten || 0));
  const ratioAt = (sample) => {
    const f = track.f0[frameAt(sample)];
    const heard = f > 0 ? freqToMidi(f) : note.midi;
    // Pull the sung pitch toward the note's own centre, then move the whole
    // note to where it was dragged. flatten 0 keeps every wobble.
    const corrected = heard * (1 - flatten) + note.midi * flatten + (want - note.midi);
    return Math.pow(2, (corrected - heard) / 12);
  };

  // Input pitch marks, one per local period. Grains have to be cut *at* these
  // — a grain taken from a sliding position and laid down at a new spacing
  // keeps its own period, so the pitch never moves.
  const marks = [];
  for (let pos = fromFrame; pos < toFrame; pos += periodAt(pos)) marks.push(Math.round(pos));
  if (marks.length < 2) return;

  // Scratch space for this note alone, with room for the grains that hang off
  // either end. Writing straight into the output would mean a level match
  // could not tell this note from whatever it lands on top of.
  const pad = Math.round(CROSSFADE * rate);
  const scratchLen = length + pad * 2;
  const scratch = outs.map(() => new Float32Array(scratchLen));

  let markIndex = 0;
  let outPos = 0;
  let guard = 0;
  while (outPos < length && guard++ < 200000) {
    // The time-aligned input mark: grains keep coming from where output time
    // has reached, which is what preserves the note's duration while the
    // output marks below get denser or sparser.
    const align = fromFrame + outPos;
    while (markIndex + 1 < marks.length && marks[markIndex + 1] < align) markIndex++;
    let i = markIndex;
    if (i + 1 < marks.length && Math.abs(marks[i + 1] - align) < Math.abs(marks[i] - align)) i++;

    const centre = marks[i];
    const period = Math.max(8, periodAt(centre));
    const T = Math.max(8, Math.round(period));
    const grain = 2 * T;
    const w = windowOf(grain);
    const ratio = Math.max(0.25, Math.min(4, ratioAt(centre)));
    // Hann grains overlap-added at period/ratio sum to `ratio`, so a note
    // dragged up an octave would come back twice as loud without this.
    const amp = gain / ratio;

    // A fractional index on a typed array *reads* undefined and *writes* a
    // property, and neither throws — one NaN from here poisons the whole
    // note. Both ends are rounded before they are ever used as indices.
    const src = centre - T;
    const dst = pad + Math.round(outPos) - T;
    for (let c = 0; c < scratch.length; c++) {
      const from = ins[Math.min(c, ins.length - 1)];
      const to = scratch[c];
      for (let k = 0; k < grain; k++) {
        const s = src + k;
        const d = dst + k;
        if (s < 0 || s >= from.length || d < 0 || d >= to.length) continue;
        to[d] += from[s] * w[k] * amp;
      }
    }
    // Advance on the unrounded period: rounding here would quantise the
    // achievable move to a few cents.
    outPos += Math.max(4, period / ratio);
  }

  // Match the level the note had, then add it in. A near-silent note must not
  // be dragged up to full scale by the ratio, hence the clamp.
  // Grains hang off both ends of the note. Left alone they would sound on top
  // of whatever the neighbouring note is doing, so the overhang is faded out:
  // a note contributes inside its own span and nowhere else.
  for (const data of scratch) {
    for (let i = 0; i < pad; i++) {
      const g = i / pad;                 // complementary to the erase ramp
      data[i] *= g;
      data[scratchLen - 1 - i] *= g;
    }
  }

  // Grains that line up constructively can push the peak well past where it
  // was even when the RMS is right, and the WAV encoder clips at full scale.
  // Whichever of the two matches is quieter wins.
  let match = 1;
  const was = regionLevel(ins[0], fromFrame, toFrame);
  const is = regionLevel(scratch[0], pad, pad + length);
  const all = regionLevel(scratch[0], 0, scratchLen);
  if (was.rms > 1e-5 && is.rms > 1e-5) {
    const byRms = was.rms / is.rms;
    const byPeak = all.peak > 1e-5 ? was.peak / all.peak : byRms;
    match = Math.max(0.25, Math.min(4, Math.min(byRms, byPeak)));
  }

  for (let c = 0; c < outs.length; c++) {
    const to = outs[c];
    const from = scratch[c];
    for (let i = 0; i < scratchLen; i++) {
      const d = dstStart - pad + i;
      if (d < 0 || d >= to.length) continue;
      to[d] += from[i] * match;
    }
  }
}

/**
 * Apply a note arrangement to a buffer. Returns a new buffer of the same
 * length and layout; untouched notes are the original samples, bit for bit.
 */
export function renderPitchEdits(ctx, buffer, { track, notes }) {
  const rate = buffer.sampleRate;
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, rate);
  const ins = [];
  const outs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    ins.push(buffer.getChannelData(c));
    const data = out.getChannelData(c);
    data.set(buffer.getChannelData(c));
    outs.push(data);
  }

  const edited = (notes || []).filter(isEdited);
  if (!edited.length) return out;

  // Clear every edited note's original place first: a note that moved must
  // not still be sounding where it was.
  const ramp = Math.max(1, Math.round(CROSSFADE * rate));   // matches the pad
  for (const note of edited) {
    erase(outs, Math.round(note.from * rate), Math.round(note.to * rate), ramp);
  }
  for (const note of edited) {
    if (note.mute) continue;
    renderNote(ins, outs, note, { track, rate, gain: note.gain ?? 1 });
  }
  return out;
}

/** A one-line summary of what an arrangement does, for the editor's status. */
export function describeEdits(notes) {
  const edited = (notes || []).filter(isEdited);
  if (!edited.length) return 'nothing moved yet';
  const moved = edited.filter((n) => n.semitones || n.cents).length;
  const timed = edited.filter((n) => n.shift).length;
  const muted = edited.filter((n) => n.mute).length;
  const parts = [];
  if (moved) parts.push(`${moved} retuned`);
  if (timed) parts.push(`${timed} moved in time`);
  if (muted) parts.push(`${muted} silenced`);
  return parts.join(' · ');
}
