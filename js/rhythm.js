// Drum patterns, generated.
//
// The melody wizard reasons about pitch; a kit has none, so this reasons
// about *roles* instead. A style is a probability per 16th for each role —
// kick, snare, hat and the rest — which is enough to make one style sound
// like itself while no two bars come out identical. Density thins or
// thickens the whole thing, variation decides how far later bars may drift
// from the first, and the fill is a deliberate break in the last bar.
//
// The seeded RNG is shared with the melody wizard, so "Another" behaves the
// same way in both: a new seed, a repeatable result.

import { rng } from './harmony.js';
import { PAD_COUNT } from './state.js';

/** The parts a kit plays, in the order the default pads are laid out. */
export const KIT_ROLES = ['kick', 'snare', 'perc', 'hat', 'kick2', 'clap', 'openhat', 'ride'];

export const ROLE_NAMES = {
  kick: 'Kick', snare: 'Snare', perc: 'Tom / perc', hat: 'Closed hat',
  kick2: 'Sub kick', clap: 'Clap', openhat: 'Open hat', ride: 'Ride / shaker',
};

/** Words in a pad's name that give away what it is meant to be. */
const ROLE_WORDS = {
  kick: ['kick', 'bd', 'bass drum', 'boom'],
  snare: ['snare', 'sd', 'sn '],
  perc: ['tom', 'perc', 'conga', 'bongo', 'rim', 'block'],
  hat: ['closed', 'chh', 'hat', 'hh'],
  kick2: ['sub', '808', 'kick 2'],
  clap: ['clap', 'cp', 'snap'],
  openhat: ['open', 'ohh'],
  ride: ['ride', 'shaker', 'cymbal', 'crash', 'tamb'],
};

/**
 * Which pad plays a role. A pad whose name says what it is wins — a kit
 * loaded from a sample folder rarely lands in the default order — and
 * anything unclaimed falls back to its position in KIT_ROLES.
 */
export function mapRoles(track) {
  const pads = track?.pads || [];
  const out = {};
  const taken = new Set();

  for (const role of KIT_ROLES) {
    const words = ROLE_WORDS[role] || [];
    for (let i = 0; i < pads.length; i++) {
      if (taken.has(i)) continue;
      const name = String(pads[i]?.name || '').toLowerCase();
      if (!words.some((wrd) => name.includes(wrd))) continue;
      out[role] = i;
      taken.add(i);
      break;
    }
  }
  KIT_ROLES.forEach((role, i) => {
    if (out[role] != null) return;
    if (i < PAD_COUNT && !taken.has(i)) { out[role] = i; taken.add(i); }
  });
  return out;
}

/* --------------------------------------------------------------- styles */

// Probability that a role hits each 16th of a bar. Reading a row aloud is
// the pattern: 1 is "always", 0.2 is "sometimes, as a ghost".
const P = (...v) => v;

export const STYLES = {
  fourFloor: {
    name: 'Four to the floor',
    blurb: 'House and techno — a kick on every beat, hats between them',
    roles: {
      kick:    P(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, .15),
      clap:    P(0, 0, 0, 0, .9, 0, 0, 0, 0, 0, 0, 0, .9, 0, 0, 0),
      hat:     P(0, 0, .5, 0, 0, 0, .5, 0, 0, 0, .5, 0, 0, 0, .5, .2),
      openhat: P(0, 0, .6, 0, 0, 0, .6, 0, 0, 0, .6, 0, 0, 0, .6, 0),
      perc:    P(0, 0, 0, .15, 0, .1, 0, .2, 0, 0, 0, .15, 0, .1, 0, .25),
    },
  },
  boomBap: {
    name: 'Boom bap',
    blurb: 'Head-nod hip hop — lazy kick, snare on 2 and 4, ghosted hats',
    roles: {
      kick:    P(1, 0, 0, .3, 0, 0, .2, .5, 0, 0, .55, 0, 0, .2, 0, 0),
      snare:   P(0, 0, 0, 0, 1, 0, 0, .12, 0, .1, 0, 0, 1, 0, 0, .18),
      hat:     P(.9, 0, .7, 0, .9, 0, .7, .2, .9, 0, .7, 0, .9, 0, .7, .3),
      perc:    P(0, 0, 0, 0, 0, 0, .12, 0, 0, 0, 0, .15, 0, 0, 0, .2),
    },
  },
  rock: {
    name: 'Rock',
    blurb: 'Straight backbeat — kick, snare, eighth-note hats',
    roles: {
      kick:    P(1, 0, 0, 0, 0, 0, .25, 0, .9, 0, 0, .2, 0, 0, .3, 0),
      snare:   P(0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, .15),
      hat:     P(1, 0, .95, 0, 1, 0, .95, 0, 1, 0, .95, 0, 1, 0, .95, .2),
      ride:    P(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, .1),
    },
  },
  breakbeat: {
    name: 'Breakbeat',
    blurb: 'Chopped funk break — syncopated kick and a busy snare',
    roles: {
      kick:    P(1, 0, .2, .5, 0, 0, .3, 0, 0, .55, .3, 0, .2, 0, .35, 0),
      snare:   P(0, .12, 0, 0, 1, 0, .2, .25, 0, .15, 0, .3, .85, 0, .25, .4),
      hat:     P(.8, .3, .8, .3, .8, .3, .8, .3, .8, .3, .8, .3, .8, .3, .8, .35),
      openhat: P(0, 0, .25, 0, 0, 0, .2, 0, 0, 0, .25, 0, 0, 0, .3, 0),
      perc:    P(0, 0, .2, 0, 0, .15, 0, .2, 0, 0, .2, 0, 0, .15, 0, .25),
    },
  },
  trap: {
    name: 'Trap',
    blurb: 'Sparse sub kick, snare on the three, rolling hats',
    roles: {
      kick:    P(1, 0, 0, .25, 0, 0, .3, 0, 0, 0, .5, 0, 0, .3, 0, .2),
      kick2:   P(.5, 0, 0, 0, 0, 0, 0, 0, .3, 0, 0, 0, 0, 0, 0, 0),
      snare:   P(0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, .12),
      hat:     P(1, .35, .9, .35, 1, .35, .9, .55, 1, .35, .9, .35, 1, .45, .9, .65),
      openhat: P(0, 0, 0, 0, 0, 0, 0, .2, 0, 0, 0, 0, 0, 0, 0, .3),
    },
  },
  halfTime: {
    name: 'Half time',
    blurb: 'Wide and heavy — one snare a bar, space around it',
    roles: {
      kick:    P(1, 0, 0, 0, 0, 0, .2, 0, 0, 0, .35, 0, 0, 0, .2, 0),
      snare:   P(0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, .1),
      hat:     P(.7, 0, 0, 0, .7, 0, 0, 0, .7, 0, 0, 0, .7, 0, 0, .2),
      ride:    P(0, 0, .3, 0, 0, 0, .3, 0, 0, 0, .3, 0, 0, 0, .3, 0),
    },
  },
  latin: {
    name: 'Latin',
    blurb: 'Clave-led — busy percussion over a steady pulse',
    roles: {
      kick:    P(1, 0, 0, .4, 0, 0, .5, 0, .5, 0, 0, .4, 0, 0, .35, 0),
      perc:    P(.9, 0, 0, .8, 0, 0, .85, 0, 0, 0, .8, 0, 0, .75, 0, .3),
      ride:    P(.8, .4, .8, .4, .8, .4, .8, .4, .8, .4, .8, .4, .8, .4, .8, .45),
      clap:    P(0, 0, 0, 0, .3, 0, 0, 0, 0, 0, 0, 0, .5, 0, 0, 0),
      openhat: P(0, 0, .2, 0, 0, 0, .2, 0, 0, 0, .2, 0, 0, 0, .25, 0),
    },
  },
  minimal: {
    name: 'Minimal',
    blurb: 'Almost nothing — a pulse and one accent to hang a track on',
    roles: {
      kick:    P(1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, .1),
      hat:     P(0, 0, 0, 0, .8, 0, 0, 0, 0, 0, 0, 0, .8, 0, 0, .15),
      perc:    P(0, 0, 0, 0, 0, 0, .2, 0, 0, 0, 0, 0, 0, 0, .25, 0),
    },
  },
};

export const STYLE_KEYS = Object.keys(STYLES);

/** How hard the kit is played, per role, before accents. */
const ROLE_LEVEL = {
  kick: 1, kick2: 0.95, snare: 1, clap: 0.9,
  hat: 0.62, openhat: 0.7, perc: 0.72, ride: 0.6,
};

/** Density scales the *optional* hits and leaves the backbone alone. */
function densityScale(p, density) {
  if (p >= 0.9) return p;                     // the pattern's skeleton
  return Math.max(0, Math.min(1, p * (0.35 + density * 1.5)));
}

/**
 * Build a drum pattern.
 * Returns notes in project form, where `pitch` is the pad index.
 */
export function generateRhythm({
  bars = 2, style = 'boomBap', density = 0.5, variation = 0.25,
  fill = true, humanise = 0.3, roles = null, seed = Date.now(),
} = {}) {
  const random = rng(seed);
  const shape = STYLES[style] || STYLES.boomBap;
  const padOf = roles || Object.fromEntries(KIT_ROLES.map((r, i) => [r, i]));
  const notes = [];

  // Bar one is the pattern; later bars redraw only the steps variation lets
  // them touch, so the groove stays recognisable while it breathes.
  const first = new Map();

  for (let bar = 0; bar < bars; bar++) {
    const lastBar = bar === bars - 1;
    for (const [role, probs] of Object.entries(shape.roles)) {
      const pad = padOf[role];
      if (pad == null || pad >= PAD_COUNT) continue;
      const level = ROLE_LEVEL[role] ?? 0.8;

      for (let step = 0; step < 16; step++) {
        const key = `${role}:${step}`;
        const p = densityScale(probs[step] || 0, density);
        let hit;
        if (bar === 0 || random() < variation) {
          hit = random() < p;
          if (bar === 0) first.set(key, hit);
        } else {
          hit = first.get(key) || false;
        }
        // The last beat belongs to the fill, which writes its own notes.
        if (fill && lastBar && bars > 1 && step >= 12 && role !== 'kick') continue;
        if (!hit) continue;

        const onBeat = step % 4 === 0;
        const accent = step === 0 ? 1.05 : onBeat ? 0.95 : step % 2 === 0 ? 0.82 : 0.66;
        const jitter = 1 + (random() - 0.5) * humanise * 0.5;
        notes.push({
          pitch: pad,
          t: bar * 16 + step,
          len: 1,
          vel: Math.max(0.2, Math.min(1, level * accent * jitter)),
        });
      }
    }

    if (fill && lastBar && bars > 1) {
      // The fill is written in bar-local time; it lands on the last bar here.
      for (const n of makeFill(padOf, random, density)) {
        notes.push({ pitch: n.pitch, t: bar * 16 + n.t, len: n.len, vel: n.vel });
      }
    }
  }

  notes.sort((a, b) => a.t - b.t || a.pitch - b.pitch);
  return notes;
}

/**
 * A fill over the last beat: a run down the kit that gets busier the denser
 * the pattern already is. It is written in bar-local time and moved by the
 * caller, so the shape does not have to know where the bar starts.
 */
function makeFill(padOf, random, density) {
  const out = [];
  const voices = [padOf.snare, padOf.perc, padOf.snare, padOf.perc]
    .map((p) => (p == null ? padOf.snare : p));
  const busy = random() < 0.35 + density * 0.4;
  const steps = busy ? [12, 13, 14, 15] : [12, 14, 15];

  steps.forEach((step, i) => {
    const pad = voices[i % voices.length];
    if (pad == null) return;
    out.push({
      pitch: pad, t: step, len: 1,
      vel: Math.max(0.3, Math.min(1, 0.55 + (i / steps.length) * 0.45)),
    });
  });
  if (padOf.openhat != null && random() < 0.5) {
    out.push({ pitch: padOf.openhat, t: 15, len: 1, vel: 0.7 });
  }
  return out;
}

/** One-line description of what the settings will produce. */
export function describeRhythm(style, bars, density) {
  const shape = STYLES[style] || STYLES.boomBap;
  const weight = density < 0.3 ? 'sparse' : density < 0.65 ? 'steady' : 'busy';
  return `${shape.name} · ${weight} · ${bars} bar${bars === 1 ? '' : 's'}`;
}
