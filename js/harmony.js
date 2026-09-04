// Melodic reasoning built on the circle of fifths.
//
// Two things live here and share one scoring function: the "what could come
// next" suggestions drawn as ghost notes in the piano roll, and the melody
// wizard's generator. Both rank a candidate pitch against the note before it
// using the classic rules — motion by fifths is the strongest relationship,
// the tritone is the weakest, tendency tones want to resolve, and a melody
// mostly moves by step and recovers from leaps in the opposite direction.

import {
  SCALES, pitchClass, inScale, fifthsDistance, scaleDegree,
  circlePosition, CIRCLE_OF_FIFTHS, snapToScale, noteLabel, NOTE_NAMES,
} from './theory.js';

/**
 * How closely two pitch classes are related, indexed by their distance
 * around the circle of fifths.
 *   0 unison · 1 P5/P4 · 2 M2/m7 · 3 M6/m3 · 4 M3/m6 · 5 M7/m2 · 6 tritone
 */
const FIFTHS_AFFINITY = [0.70, 1.00, 0.82, 0.80, 0.78, 0.45, 0.12];

const FIFTH_NAMES = ['same note', 'a fifth away', 'two fifths away', 'three fifths away',
  'four fifths away', 'five fifths away', 'a tritone away'];

/* ------------------------------------------------------------- helpers */

/** Every scale member between lo and hi inclusive. */
export function scalePitches(root, type, lo, hi) {
  const out = [];
  for (let m = lo; m <= hi; m++) if (inScale(m, root, type)) out.push(m);
  return out;
}

/** Seeded RNG so "regenerate" is repeatable when you keep the seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Does this scale contain a semitone below the tonic? Only then does the
 * 7th degree behave as a leading tone that wants to rise.
 */
const hasLeadingTone = (type) => (SCALES[type]?.steps || []).includes(11);

/** The triad on a scale degree, as pitch classes, using only scale members. */
export function chordTones(chordRootPc, root, type) {
  const steps = (SCALES[type] || SCALES.chromatic).steps;
  const members = steps.map((s) => pitchClass(root + s));
  const idx = members.indexOf(pitchClass(chordRootPc));
  if (idx < 0) return [pitchClass(chordRootPc)];
  // Stack thirds by skipping a scale degree — works for 5-, 6- and 7-note scales.
  const at = (n) => members[(idx + n) % members.length];
  return [at(0), at(2), at(4)];
}

/* ------------------------------------------------------------- scoring */

/**
 * Rate one candidate pitch as the next note.
 * `prev` and `prev2` are MIDI numbers (or null at the start of a phrase).
 * Returns { score 0..1, reason, tag }.
 */
export function scoreCandidate(candidate, {
  prev = null, prev2 = null, root = 0, type = 'major',
  chordRootPc = null, targetPitch = null, atPhraseEnd = false,
  repeatBias = 0,
} = {}) {
  const degree = scaleDegree(candidate, root, type);
  const reasons = [];

  // --- 1. relatedness on the circle of fifths --------------------------
  let affinity = 0.8;
  let fifths = null;
  if (prev != null) {
    fifths = fifthsDistance(prev, candidate);
    affinity = FIFTHS_AFFINITY[fifths];
    if (fifths === 1) reasons.push({ w: 3, text: `a fifth from ${noteLabel(prev)}` });
    if (fifths === 6) reasons.push({ w: -3, text: 'a tritone away — tense' });
  }

  // --- 2. tendency tones want to resolve -------------------------------
  let tendency = 0;
  if (prev != null) {
    const prevDegree = scaleDegree(prev, root, type);
    const up = candidate - prev;
    const isTonic = pitchClass(candidate) === pitchClass(root);
    if (prevDegree === 7 && hasLeadingTone(type) && isTonic && up > 0 && up <= 2) {
      tendency = 1; reasons.push({ w: 5, text: 'leading tone resolving up to the root' });
    } else if (prevDegree === 5 && isTonic) {
      tendency = 0.95; reasons.push({ w: 4, text: 'fifth falling home to the root' });
    } else if (prevDegree === 4 && degree === 3 && up < 0) {
      tendency = 0.8; reasons.push({ w: 3, text: 'fourth settling onto the third' });
    } else if (prevDegree === 6 && degree === 5 && up < 0) {
      tendency = 0.6; reasons.push({ w: 2, text: 'sixth leaning onto the fifth' });
    } else if (prevDegree === 2 && isTonic) {
      tendency = 0.6; reasons.push({ w: 2, text: 'second stepping to the root' });
    }
  }

  // --- 3. melodic contour ----------------------------------------------
  let contour = 0.7;
  if (prev != null) {
    const leap = Math.abs(candidate - prev);
    // A repeated note is normally the dullest move, which is why it scores
    // low by default. `repeatBias` is what the wizard turns up when the point
    // *is* to hammer one note — it changes nothing at 0, so the piano roll's
    // suggestions are unaffected.
    if (leap === 0) contour = 0.35 + 0.6 * repeatBias;
    else if (leap <= 2) { contour = 1; reasons.push({ w: 1, text: 'a step away' }); }
    else if (leap <= 4) contour = 0.80;
    else if (leap <= 7) contour = 0.50;
    else if (leap <= 12) contour = 0.20;
    else contour = 0.04;

    if (prev2 != null) {
      const lastLeap = prev - prev2;
      if (Math.abs(lastLeap) >= 5) {
        const sameWay = Math.sign(candidate - prev) === Math.sign(lastLeap);
        if (sameWay) contour *= 0.5;
        else if (leap <= 2) { contour = Math.min(1, contour * 1.3); reasons.push({ w: 2, text: 'stepping back after the leap' }); }
      }
    }
  }

  // --- 4. where it sits in the scale / current chord --------------------
  let weight = degree === 1 ? 1 : degree === 5 ? 0.92 : degree === 3 ? 0.86 : 0.72;
  if (chordRootPc != null) {
    const tones = chordTones(chordRootPc, root, type);
    if (tones.includes(pitchClass(candidate))) {
      weight = Math.min(1, weight + 0.25);
      reasons.push({ w: 2, text: `chord tone of ${NOTE_NAMES[pitchClass(chordRootPc)]}` });
    }
  }
  if (atPhraseEnd) {
    weight = pitchClass(candidate) === pitchClass(root) ? 1
      : degree === 5 ? 0.8 : 0.35;
    if (pitchClass(candidate) === pitchClass(root)) reasons.push({ w: 4, text: 'lands on the root' });
  }

  // --- 5. stay in a comfortable register --------------------------------
  let fit = 1;
  if (targetPitch != null) fit = Math.max(0.1, 1 - Math.abs(candidate - targetPitch) / 12);

  const score = 0.26 * affinity + 0.22 * tendency + 0.30 * contour + 0.14 * weight + 0.08 * fit;

  reasons.sort((a, b) => b.w - a.w);
  const reason = reasons.length
    ? reasons[0].text
    : prev != null ? FIFTH_NAMES[fifths] : 'in the scale';

  return { score, reason, degree, fifths };
}

/* ---------------------------------------------------------- suggestions */

/**
 * Suggest the notes that could follow what is already on the track.
 * Returns the anchor step plus a ranked list of candidates.
 */
export function suggestNext(trackNotes, project, { count = 5, span = 14, totalSteps = 64 } = {}) {
  const { root, type } = project.scale;
  const notes = [...trackNotes].sort((a, b) => (a.t + a.len) - (b.t + b.len));
  const total = totalSteps;

  const last = notes[notes.length - 1] || null;
  const prevNote = last;
  const prev2Note = notes.length > 1 ? notes[notes.length - 2] : null;

  const wanted = last ? last.t + last.len : 0;
  const at = Math.min(total - 1, wanted);
  const full = wanted >= total;              // nothing left to write into
  const anchorPitch = prevNote ? prevNote.pitch : 60;

  // An empty track has nothing to relate to, so open on the tonic triad.
  if (!prevNote) {
    const tonic = snapToScale(60, root, type);
    const opening = [tonic, ...chordTones(root, root, type)
      .map((pc) => nearestPitchWithClass(pc, tonic))
      .filter((p) => p !== tonic)];
    const seen = new Set();
    const items = [];
    for (const pitch of opening) {
      if (seen.has(pitch)) continue;
      seen.add(pitch);
      items.push({
        pitch,
        score: pitchClass(pitch) === pitchClass(root) ? 1 : 0.8,
        reason: pitchClass(pitch) === pitchClass(root) ? 'the root — a safe place to start' : 'tonic chord tone',
      });
    }
    return { at, full, items: items.slice(0, count), prev: null };
  }

  const lo = Math.max(24, anchorPitch - span);
  const hi = Math.min(107, anchorPitch + span);
  const atPhraseEnd = at >= total - 4;

  const items = scalePitches(root, type, lo, hi)
    .map((pitch) => {
      const r = scoreCandidate(pitch, {
        prev: prevNote.pitch,
        prev2: prev2Note ? prev2Note.pitch : null,
        root, type, targetPitch: anchorPitch, atPhraseEnd,
      });
      return { pitch, ...r };
    })
    .sort((a, b) => b.score - a.score);

  // Keep the list varied: at most two candidates per pitch class.
  const perClass = new Map();
  const picked = [];
  for (const item of items) {
    const pc = pitchClass(item.pitch);
    const n = perClass.get(pc) || 0;
    if (n >= 1) continue;
    perClass.set(pc, n + 1);
    picked.push(item);
    if (picked.length >= count) break;
  }

  return { at, full, items: picked, prev: prevNote };
}

function nearestPitchWithClass(pc, near) {
  let best = near;
  let bestDist = Infinity;
  for (let m = near - 12; m <= near + 12; m++) {
    if (pitchClass(m) !== pitchClass(pc)) continue;
    const d = Math.abs(m - near);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return best;
}

/* ------------------------------------------------------ melody wizard */

export const DENSITIES = {
  sparse: { name: 'Sparse', onsets: [2, 4] },
  medium: { name: 'Medium', onsets: [4, 6] },
  busy: { name: 'Busy', onsets: [6, 9] },
};

export const CONTOURS = {
  arch: { name: 'Arch', curve: (x) => Math.sin(Math.PI * x) },
  rise: { name: 'Rising', curve: (x) => x },
  fall: { name: 'Falling', curve: (x) => 1 - x },
  wave: { name: 'Wave', curve: (x) => 0.5 + 0.5 * Math.sin(2 * Math.PI * x) },
  flat: { name: 'Level', curve: () => 0.5 },
};

export const STRUCTURES = {
  AABA: { name: 'A A B A', letters: ['A', 'A', 'B', 'A'] },
  ABAB: { name: 'A B A B', letters: ['A', 'B', 'A', 'B'] },
  AAAB: { name: 'A A A B', letters: ['A', 'A', 'A', 'B'] },
  ABAC: { name: 'A B A C', letters: ['A', 'B', 'A', 'C'] },
  free: { name: 'Through-composed', letters: null },
};

// How likely each 16th of a bar is to carry a note — downbeats first.
const ONSET_WEIGHTS = [10, 1, 3, 1, 7, 1, 3, 2, 9, 1, 3, 1, 7, 1, 4, 3];

/**
 * Rhythm styles. A style either weights the sixteen 16ths of a bar (onsets
 * are then drawn from that distribution) or names a fixed grid to draw from
 * in order, which is how the dotted and triplet-feel patterns keep their
 * shape instead of dissolving into a random scatter.
 */
export const RHYTHMS = {
  straight:   { name: 'Straight',   weights: ONSET_WEIGHTS },
  driving:    { name: 'Driving',    weights: [10, 1, 8, 1, 9, 1, 8, 1, 10, 1, 8, 1, 9, 1, 8, 2] },
  offbeat:    { name: 'Offbeat',    weights: [4, 1, 9, 1, 3, 1, 9, 2, 4, 1, 9, 1, 3, 1, 9, 3] },
  syncopated: { name: 'Syncopated', weights: [9, 1, 2, 7, 2, 1, 8, 2, 7, 1, 2, 7, 2, 1, 8, 5] },
  dotted:     { name: 'Dotted',     grid: [0, 3, 6, 9, 12, 15] },
  shuffle:    { name: 'Shuffle',    grid: [0, 3, 4, 7, 8, 11, 12, 15] },
  longs:      { name: 'Long notes', grid: [0, 4, 8, 12], cap: 3 },
};

/** How long each note is held, relative to the gap before the next one. */
export const SUSTAINS = {
  legato:    { name: 'Legato',    hold: () => 1 },
  detached:  { name: 'Detached',  hold: () => 0.7 },
  staccato:  { name: 'Staccato',  hold: () => 0.35 },
  mixed:     { name: 'Mixed',     hold: (r) => 0.4 + r() * 0.6 },
};

/**
 * A chord plan drawn from the circle of fifths: every section targets the
 * tonic or one of its immediate neighbours (dominant, subdominant, relative),
 * and the phrase ends back on the tonic.
 */
export function chordPlan(root, type, sections, random) {
  const pos = circlePosition(root);
  const neighbour = (offset) => CIRCLE_OF_FIFTHS[(pos + offset + 12) % 12];
  const dominant = neighbour(1);
  const subdominant = neighbour(-1);
  const relative = pitchClass(root + (SCALES[type]?.steps.includes(4) ? 9 : 3));
  const options = [dominant, subdominant, relative];

  const plan = [];
  for (let i = 0; i < sections; i++) {
    const isLast = i === sections - 1;
    const isFirst = i === 0;
    if (isFirst || isLast) plan.push(pitchClass(root));
    else if (i === sections - 2) plan.push(dominant);        // set up the return
    else plan.push(options[Math.floor(random() * options.length)]);
  }
  return plan;
}

/**
 * Choose the 16th-note positions inside one bar.
 * Returns [{ step, rest }] — a rest keeps its slot so the note before it is
 * not simply stretched over the gap, which is the difference between a
 * breathing phrase and a wall of sound.
 */
function makeRhythm(density, style, random, { rest = 0 } = {}) {
  const shape = RHYTHMS[style] || RHYTHMS.straight;
  const [lo, hi] = DENSITIES[density]?.onsets || DENSITIES.medium.onsets;
  let wanted = lo + Math.floor(random() * (hi - lo + 1));
  if (shape.cap) wanted = Math.min(wanted, shape.cap + Math.round(random()));

  let steps;
  if (shape.grid) {
    // Keep the grid's own order, thinning it from the back so the downbeat
    // survives and the pattern stays recognisable.
    const grid = [...shape.grid];
    while (grid.length > wanted) grid.splice(1 + Math.floor(random() * (grid.length - 1)), 1);
    steps = grid;
  } else {
    const pool = shape.weights.map((w, step) => ({ step, w: w * (0.6 + random() * 0.8) }))
      .sort((a, b) => b.w - a.w);
    steps = pool.slice(0, wanted).map((p) => p.step).sort((a, b) => a - b);
    if (!steps.includes(0) && random() < 0.8) {
      steps.pop();
      steps.unshift(0);
    }
  }

  return steps.map((step, i) => ({
    step,
    // Never rest on the very first onset of a bar — that reads as a mistake.
    rest: i > 0 && random() < rest,
  }));
}

/** Weighted pick, sharpened by `focus` — higher means more predictable. */
function pickWeighted(items, random, focus = 3) {
  let total = 0;
  const weights = items.map((i) => {
    const w = Math.pow(Math.max(0.0001, i.score), focus);
    total += w;
    return w;
  });
  let r = random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Build a melody for the given scale.
 * Returns notes in project form: { pitch, t, len, vel }.
 */
export function generateMelody({
  root = 0, type = 'major', bars = 4, baseNote = 60,
  density = 'medium', contour = 'arch', structure = 'AABA',
  octaves = 1, resolve = true, adventurous = 0.35, seed = Date.now(),
  rhythm = 'straight', sustain = 'legato', rest = 0, repeat = 0.25,
} = {}) {
  const random = rng(seed);
  const lo = snapToScale(baseNote - 2, root, type);
  const hi = snapToScale(baseNote + 12 * octaves, root, type);
  const pool = scalePitches(root, type, lo, hi);
  if (!pool.length) return [];

  const letters = STRUCTURES[structure]?.letters;
  const sections = Math.max(1, bars);
  const plan = chordPlan(root, type, sections, random);
  const curve = (CONTOURS[contour] || CONTOURS.arch).curve;
  const focus = 7 - adventurous * 4;           // 7 = predictable, 3 = surprising
  // How far the melody may jump in one move. Real tunes mostly walk.
  const reach = 7 + Math.round(adventurous * 5);

  // A repeated letter replays the same motif — that is what A A B A means.
  const motifs = new Map();
  const notes = [];
  let prev = null;
  let prev2 = null;
  let sameCount = 0;                   // length of the current run of one note

  for (let bar = 0; bar < sections; bar++) {
    const letter = letters ? letters[bar % letters.length] : null;
    const chordRootPc = plan[bar % plan.length];
    const lastBar = bar === sections - 1;
    const cached = letter ? motifs.get(letter) : null;

    let motif;
    if (cached) {
      motif = cached.map((n) => ({ ...n }));
    } else {
      motif = [];
      const slots = makeRhythm(density, rhythm, random, { rest });
      const hold = (SUSTAINS[sustain] || SUSTAINS.legato).hold;
      // How long a run of one note may get: two at the mildest setting, five
      // when the point is to chant. Past that the melody stops moving.
      const maxRun = 2 + Math.round(repeat * 3);

      for (let i = 0; i < slots.length; i++) {
        const at = slots[i].step;
        const nextStep = i + 1 < slots.length ? slots[i + 1].step : 16;
        const gap = Math.max(1, nextStep - at);
        if (slots[i].rest) { sameCount = 0; continue; }
        const len = Math.max(1, Math.round(gap * hold(random)));

        // Where the contour wants this note, in the pool's index space.
        const progress = (bar + at / 16) / sections;
        const target = pool[Math.min(pool.length - 1,
          Math.round(curve(progress) * (pool.length - 1)))];

        let pitch;
        if (!prev) {
          // Open on the tonic or the fifth — both are strong starts.
          const openers = pool.filter((p) => [1, 5].includes(scaleDegree(p, root, type)));
          const from = openers.length ? openers : pool;
          pitch = from[Math.floor(random() * from.length)];
        } else if (repeat > 0 && sameCount < maxRun - 1 && random() < repeat * 0.55) {
          // A deliberate repeat: the same note again, which is how most
          // hooks and every chant work.
          pitch = prev;
        } else {
          const within = pool.filter((p) => Math.abs(p - prev) <= reach);
          const candidates = (within.length ? within : pool).map((p) => ({
            pitch: p,
            ...scoreCandidate(p, {
              prev, prev2, root, type, chordRootPc, targetPitch: target,
              atPhraseEnd: lastBar && i >= slots.length - 2,
              repeatBias: sameCount < maxRun - 1 ? repeat : 0,
            }),
          }));
          pitch = pickWeighted(candidates, random, focus).pitch;
        }

        sameCount = pitch === prev ? sameCount + 1 : 0;
        const onBeat = at % 4 === 0;
        // A repeat that keeps the same accent sounds mechanical; leaning on
        // the first of a run is what makes it read as one gesture.
        const vel = Math.min(1, (onBeat ? 0.9 : 0.7) + random() * 0.12 - sameCount * 0.06);
        motif.push({ pitch, t: at, len, vel: Math.max(0.35, vel) });
        prev2 = prev;
        prev = pitch;
      }
      if (letter) motifs.set(letter, motif.map((n) => ({ ...n })));
    }

    // The phrase has to come home, even when the last bar is a repeat.
    if (lastBar && resolve && motif.length) {
      const tail = motif[motif.length - 1];
      const before = motif.length > 1 ? motif[motif.length - 2].pitch : tail.pitch;
      tail.pitch = nearestPitchWithClass(root, before);
      if (!inScale(tail.pitch, root, type)) tail.pitch = snapToScale(tail.pitch, root, type);
    }

    for (const n of motif) notes.push({ ...n, t: bar * 16 + n.t });
    if (motif.length) {
      prev = motif[motif.length - 1].pitch;
      prev2 = motif.length > 1 ? motif[motif.length - 2].pitch : null;
    }
  }

  // Repeating a motif can glue two runs of the same note together, so the
  // cap has to be enforced on the finished melody, not just while writing it.
  breakLongRuns(notes, pool, 2 + Math.round(repeat * 3), random);

  return notes;
}

/**
 * Walk the melody and bend any run of one pitch that outstays `maxRun` onto
 * a neighbouring scale tone, alternating direction so the fix reads as a
 * turn rather than a drift.
 */
function breakLongRuns(notes, pool, maxRun, random) {
  if (pool.length < 2) return;
  let run = 1;
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].pitch !== notes[i - 1].pitch) { run = 1; continue; }
    run++;
    if (run <= maxRun) continue;
    let at = pool.indexOf(notes[i].pitch);
    if (at < 0) at = nearestIndex(pool, notes[i].pitch);
    const up = pool[Math.min(pool.length - 1, at + 1)];
    const down = pool[Math.max(0, at - 1)];
    // At the top or bottom of the pool one neighbour *is* the current note,
    // and picking it would leave the run untouched and growing.
    const options = [down, up].filter((p) => p !== notes[i].pitch);
    if (!options.length) continue;
    notes[i].pitch = options[Math.floor(random() * options.length)];
    run = 1;
  }
}

const nearestIndex = (pool, pitch) => {
  let best = 0;
  for (let i = 1; i < pool.length; i++) {
    if (Math.abs(pool[i] - pitch) < Math.abs(pool[best] - pitch)) best = i;
  }
  return best;
};

/** One-line explanation of the plan, for the wizard's summary. */
export function describePlan(root, type, structure, bars) {
  const plan = chordPlan(root, type, Math.max(1, bars), rng(1));
  const names = plan.map((pc) => NOTE_NAMES[pc]);
  const shape = STRUCTURES[structure]?.name || 'free';
  return `${shape} over ${names.join(' → ')}`;
}
