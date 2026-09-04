// Musical theory helpers: note naming, scales, and scale membership.
// Pitch numbers are MIDI note numbers (60 = C4).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Interval sets in semitones from the root.
export const SCALES = {
  chromatic:        { name: 'Chromatic',         steps: [0,1,2,3,4,5,6,7,8,9,10,11] },
  major:            { name: 'Major (Ionian)',    steps: [0,2,4,5,7,9,11] },
  naturalMinor:     { name: 'Natural Minor',     steps: [0,2,3,5,7,8,10] },
  harmonicMinor:    { name: 'Harmonic Minor',    steps: [0,2,3,5,7,8,11] },
  melodicMinor:     { name: 'Melodic Minor',     steps: [0,2,3,5,7,9,11] },
  dorian:           { name: 'Dorian',            steps: [0,2,3,5,7,9,10] },
  phrygian:         { name: 'Phrygian',          steps: [0,1,3,5,7,8,10] },
  lydian:           { name: 'Lydian',            steps: [0,2,4,6,7,9,11] },
  mixolydian:       { name: 'Mixolydian',        steps: [0,2,4,5,7,9,10] },
  locrian:          { name: 'Locrian',           steps: [0,1,3,5,6,8,10] },
  majorPentatonic:  { name: 'Major Pentatonic',  steps: [0,2,4,7,9] },
  minorPentatonic:  { name: 'Minor Pentatonic',  steps: [0,3,5,7,10] },
  blues:            { name: 'Blues',             steps: [0,3,5,6,7,10] },
  phrygianDominant: { name: 'Phrygian Dominant', steps: [0,1,4,5,7,8,10] },
  hungarianMinor:   { name: 'Hungarian Minor',   steps: [0,2,3,6,7,8,11] },
  wholeTone:        { name: 'Whole Tone',        steps: [0,2,4,6,8,10] },
  diminished:       { name: 'Diminished',        steps: [0,2,3,5,6,8,9,11] },
  japanese:         { name: 'Japanese (Insen)',  steps: [0,1,5,7,10] },
  arabic:           { name: 'Arabic (Hijaz)',    steps: [0,1,4,5,7,8,11] },
};

export const SCALE_KEYS = Object.keys(SCALES);

/** Semitone class (0-11) of a MIDI note. */
export const pitchClass = (midi) => ((midi % 12) + 12) % 12;

/** e.g. 60 -> "C4" */
export function noteLabel(midi) {
  return NOTE_NAMES[pitchClass(midi)] + (Math.floor(midi / 12) - 1);
}

/** True when the note belongs to the given scale. */
export function inScale(midi, root, scaleKey) {
  const scale = SCALES[scaleKey] || SCALES.chromatic;
  const rel = ((pitchClass(midi) - root) % 12 + 12) % 12;
  return scale.steps.includes(rel);
}

/** True when the note is the tonic of the scale. */
export function isRoot(midi, root) {
  return pitchClass(midi) === ((root % 12) + 12) % 12;
}

/**
 * Snap a note to the nearest scale member, searching outwards so the
 * result never drifts more than 6 semitones from the input.
 */
export function snapToScale(midi, root, scaleKey) {
  if (inScale(midi, root, scaleKey)) return midi;
  for (let d = 1; d <= 6; d++) {
    if (inScale(midi - d, root, scaleKey)) return midi - d;
    if (inScale(midi + d, root, scaleKey)) return midi + d;
  }
  return midi;
}

/** Ascending list of scale members within [lo, hi]. */
export function scaleNotesInRange(root, scaleKey, lo, hi) {
  const out = [];
  for (let m = lo; m <= hi; m++) if (inScale(m, root, scaleKey)) out.push(m);
  return out;
}

/* ------------------------------------------------- circle of fifths */

/** Pitch classes in fifth order: C G D A E B F# C# G# D# A# F. */
export const CIRCLE_OF_FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

const CIRCLE_POS = (() => {
  const map = new Array(12);
  CIRCLE_OF_FIFTHS.forEach((pc, i) => { map[pc] = i; });
  return map;
})();

/** Position of a pitch class on the circle, 0 = C. */
export const circlePosition = (midiOrPc) => CIRCLE_POS[pitchClass(midiOrPc)];

/**
 * Steps around the circle between two pitch classes, 0-6.
 * 0 = unison, 1 = perfect fifth/fourth, 6 = tritone (the far side).
 */
export function fifthsDistance(a, b) {
  const d = Math.abs(circlePosition(a) - circlePosition(b));
  return Math.min(d, 12 - d);
}

/** The keys sharing all but one note with this one: its circle neighbours and relative minor/major. */
export function relatedKeys(root, scaleKey = 'major') {
  const pos = circlePosition(root);
  const minor = scaleKey !== 'major';
  const at = (offset) => CIRCLE_OF_FIFTHS[(pos + offset + 12) % 12];
  return {
    dominant: at(1),                                   // a fifth up
    subdominant: at(-1),                               // a fifth down
    relative: pitchClass(root + (minor ? 3 : -3)),      // relative major/minor
  };
}

/** Scale degree of a note, 1-based, or 0 when it is outside the scale. */
export function scaleDegree(midi, root, scaleKey) {
  const scale = SCALES[scaleKey] || SCALES.chromatic;
  const rel = ((pitchClass(midi) - root) % 12 + 12) % 12;
  const i = scale.steps.indexOf(rel);
  return i < 0 ? 0 : i + 1;
}

/** Degree names used in the suggestion labels. */
export const DEGREE_NAMES = ['', 'root', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
