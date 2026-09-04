# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No build step, no package.json, no dependencies — the app is plain ES modules
served as static files. Serve the directory over `localhost` (a secure context
is required for the service worker and persistent storage):

```bash
npx http-server . -p 5173 -c-1
```

`.claude/launch.json` defines this server as `pocket-daw` for the preview tool.
`pocket-daw-alt` is the same server with the port left to the harness, for when
5173 is already taken by another session.

There is no test suite. To check that the modules parse, copy them to a scratch
directory, rename to `.mjs` and run `node --check` on each — Node treats a bare
`.js` file as CommonJS and will reject the `import`/`export` syntax.

Deploying to a static host is `node tools/stage-deploy.mjs`, which stages the
app (and nothing else, `samples/` here is gigabytes) into `dist/` and writes
`samples/index.json` for whatever `--samples <subfolder>` it was asked to take
along. `pocket-daw-dist` in `launch.json` serves that folder with directory
listings *off* (`-d false`), which is the condition the manifest exists for —
preview it there rather than from the project root, or the sample browser will
crawl a listing that the real host will not give it. `make-sample-manifest.mjs`
mirrors the audio-extension pattern from `folder.js`; keep the two in step, and
note that it skips dot-files because macOS AppleDouble forks (`._Kick.wav`)
match the pattern and do not decode.

`samples/` is the user's own drop folder, not part of the app. The browser
sheet reads it over HTTP — `samples/index.json` if the author wrote one,
otherwise the server's directory listing, which is why `npx http-server`
needs no extra step. `sw.js` deliberately serves that path network-first, so
a file dropped in shows up on the next Rescan instead of on the second one.
The missing-manifest `404` in the console is expected and handled.

After changing anything in `js/` or `css/`, bump `CACHE` in `sw.js`. The worker
serves navigations network-first but everything else stale-while-revalidate, so
an edit lands on the *second* reload. While iterating, clear the caches first —
`caches.keys().then(k => k.forEach(c => caches.delete(c)))` then reload — or you
will debug the previous version, which is easy to mistake for a logic bug.

The Browser pane must be visible for the piano roll to paint at all: the canvas
is driven by a `ResizeObserver` and `requestAnimationFrame`, both of which stall
when the pane is hidden. A blank roll and timed-out screenshots usually mean the
pane, not the code. The same pane also serves stale screenshot frames after a
DOM change — front the tab (`tabs_select`) or scroll it before believing what a
screenshot shows, and check the DOM when the two disagree. It refuses to
register the service worker as well (`An unknown error occurred when fetching
the script`), which is a pane limitation, not a bug in `sw.js`.

Verifying audio does not need ears: `renderProject()` into an
`OfflineAudioContext` and measure. RMS over a window proves a mute or a fade,
counting zero crossings proves a pitch — that is how clip mutes, fades, loops
and sample key mapping are checked. Zero crossings lie about anything with
strong harmonics, though: use `detectPitch()` to check a note moved down an
octave, or the harmonics will report it as having moved *up*. Measure peak as
well as RMS whenever grains are overlap-added — the two failures there are a
level that drifts and a boundary spike, and RMS alone hides the second.

## Architecture

**One project document, one store.** `js/state.js` holds the entire project as
a plain JSON object (`state.project`) — tempo, scale, bars, tracks, notes.
Everything else reads it through `S.project()` and mutates it directly, then
calls `S.touch()` (debounced autosave to IndexedDB) and optionally
`S.emit(reason)`. `main.js` subscribes once and re-renders whichever view is
active based on the reason string. `S.checkpoint()` snapshots the document
*before* a mutation for undo; call it once per gesture, not per frame.

The document is versioned only by `migrate()` in `state.js`, which merges a
loaded project over freshly built defaults. Any new field on a track or project
needs a default there or old saved projects will load with it undefined.

**Patterns hold the notes; the playlist holds copies of patterns.** A track no
longer owns a note list — `pattern.notes[trackId]` does, reached through
`S.notesOf(track, pattern?)` (defaults to the active pattern). Never touch
`track.notes`; it only exists in old saved projects and `migrate()` folds it
into Pattern 1. `project.clips` places patterns or audio on lanes, with `start`
and `length` in steps.

**A clip is a window, not a rectangle.** Beyond `start`/`length` a clip carries
`offset` (seconds into the sample), `offsetSteps` (steps into the pattern),
`fadeIn`/`fadeOut`, `loop`, `gain`, `mutes` — a sorted list of *local* step
indices that are silenced — plus `stretch`/`stretchSrc`/`tape` (below) and
`pitchEdits` (the pitch editor's note arrangement). `js/audio/clips.js` turns all of that into one gain
automation curve and is called by both `engine.js` and `export.js`, so a bounce
cannot drift from playback; add a clip field and it must be handled there once,
not in two schedulers. `S.splitClip()` carries the offset and the mutes into
the right-hand half, which is what makes "split, then drag the phrase" work.
Trimming a clip's left edge moves `start` *and* the matching offset, so the
material stays where it was in time.

**Stretching is geometry in the store, DSP in the cache.** `S.clipSpeed(clip)`
is the whole model: source seconds (`stretchSrc`) over clip seconds, clamped to
`MIN_SPEED`/`MAX_SPEED`. Resizing a stretched clip changes only `length`, so
the speed falls out of it — that is why "drag the edge and the audio follows"
needed no second code path. `js/audio/stretch.js` stretches a buffer *whole*
with WSOLA and caches it per `(sampleId, speed)`, so a clip's window into it
stays `offset / speed`; `clips.js` therefore spends one division on the whole
feature rather than growing a second scheduler. `resolveStretch()` falls back
to resampling (the tape sound) while a buffer is still being built, which is
why `export.js` and boot both call `ensureStretchesForProject()` first — a
bounce must never catch the fallback. Turning stretching *off* keeps the sound
and changes the length, not the other way round (`S.setClipStretch`).

**The pitch editor rearranges notes; autotune corrects frames.** They share
YIN and TD-PSOLA and nothing else. `js/audio/pitchedit.js` cuts the pitch track
into notes (`segmentNotes`, split on a real pitch move judged against the
note's running median, so vibrato does not shred a held note), and each note
carries `semitones`, `cents`, `shift` (time), `flatten` and `mute`. Three
rules hold the render together and are worth keeping:

- **an untouched note is copied through bit for bit** — only edited notes are
  resynthesised, so the artefacts stay where the edits are;
- **each note is built in its own scratch buffer and level-matched** to what it
  was, by whichever of RMS or peak is quieter. Overlap-add at a new spacing
  does not preserve energy (an octave up returns ~9 dB down) and the WAV
  encoder clips at full scale;
- **`erase()` and the note's fade-in are complementary linear ramps** over the
  same window. Fading the original out *inside* the note instead leaves both
  at full level on the boundary — a one-frame spike at nearly double
  amplitude, which is audible and clips.

Like autotune it writes a *new* sample and leaves `sourceSampleId` alone, and
it stores the arrangement on the clip so reopening resumes rather than
re-analysing.

**The app folder is a second sample source.** `js/audio/folder.js` lists
`samples/` (manifest first, directory listing second) and `buildTree()` folds
those paths together with library samples that carry a `sourcePath`, so files
on disk and files already imported appear in one structure instead of two
half-views. Nothing is copied into IndexedDB until a sample is actually used;
`sourcePath` is also what stops the same file being imported twice under one
name.

`project.mode` decides what the transport cycles: `'pattern'` loops the active
pattern, `'song'` walks the clips. `S.totalSteps()` is the pattern length (what
the editors draw), `S.songSteps()` the arrangement, and `S.transportSteps()`
whichever the engine should be looping right now — mixing these up is the
easiest way to break playback. Switching tabs sets the mode in `setTab()`.

**Automation is normalised in the store and mapped at the edge.** A track
carries `automation`, a lane key (`volume`, `pan`, `hpf`, `lpf`) to a sorted
list of `{ t, v }` breakpoints, `t` in song steps and **`v` always 0..1**.
`AUTO_LANES` in `state.js` owns the mapping back to a gain, a pan position or
a frequency, and its `def` is what an empty lane means — which is why one
canvas in `js/ui/automation.js` can draw and edit all four, and why adding a
lane is one entry plus one line in `autoParam()`. `autoNormAt()` is flat
before the first point and after the last.

The engine gives every track `hpf -> lpf -> autoGain -> fader -> panner`, so
automation and the mixer never share an AudioParam: the fader stays the thing
your finger moves and the lane trims underneath it. Pan is the exception —
there is only one panner — so `syncMixer()` leaves it alone when a pan lane
exists. Lanes are written one step at a time from `scheduleStep()`, which
makes looping free (the cursor wraps and the ramps follow); `export.js` has no
scheduler, so `writeAutomation()` lays the whole curve down up front from the
same `autoValueAt()`. Automation only applies in song mode — a pattern loop
has no song position — and `resetAutomation()` parks every param when the
transport stops.

**The synth's display is a render, not a drawing.** `js/audio/voicepreview.js`
renders one note through `playSynth` into an `OfflineAudioContext` and caches
it by a signature of the patch; `js/ui/synthscope.js` draws the envelope above
and a few cycles of the sustain below. Nothing in the display knows what a
filter or an LFO is, so it cannot drift from the sound — which is also how the
mid-decay release jump was found. Keep it that way: never draw the patch from
its parameters. The scope owns a `ResizeObserver`, so `renderSounds()` destroys
the previous one before rebuilding.

`playSynth` takes the context and a stateless patch; **glide is the one thing
it cannot know**, so the caller passes `opts.glideFrom` and both `engine.js`
and `export.js` keep their own `lastPitch` per track. Custom waves are
`PeriodicWave`s cached per context (`WAVE_HARMONICS`), which is why the offline
bounce builds its own rather than borrowing the live context's.

**Effects are rebuilt, parameters are not.** `js/audio/effects.js` builds each
effect from native nodes and returns `{ input, output, update }`. The engine
keeps one chain per track and compares a shape signature (`fxShape`): change a
parameter and `engine.syncFx(track)` pushes it onto the live node; add, remove,
reorder or bypass an effect and the chain is rebuilt. `buildChain` takes the
context as an argument so `export.js` constructs the identical chain offline —
a bounce that does not match playback almost always means a divergence here.

**Ducking is scheduled, not detected.** Web Audio's compressor has no
sidechain input, so `js/audio/sidechain.js` writes the pump from the trigger's
*notes*: `duckVelocityAt()` asks what the trigger fires at a step (clips in
song mode, the edited pattern otherwise) and `createDucker(param)` lays one
envelope on the channel's own `duck` gain — `hpf -> lpf -> duck -> autoGain ->
fader`. Both `engine.js` (per step, in **both** transport modes, unlike the
automation lanes) and `export.js` (the whole span up front) go through those
two functions, so a bounce cannot pump differently from playback. A track's
`sidechain` block is `{ on, sourceId, sourcePad, amount, attack, release }`;
`sourcePad` exists because a kit's kick is a *pad*, so pointing at the track
alone would duck on every hat as well. Ducking ignores mute and solo on
purpose — soloing the bass to work on it must not change its shape.

Two things there are worth keeping. The ducker remembers the geometry of the
envelope it last wrote, because **a `linearRampToValueAtTime` starts at the
previous event**: without an explicit `setValueAtTime` anchor *at* the trigger,
each attack ramp starts back at the last recovery and the channel slides
downhill for the whole gap between two hits instead of sitting at unity. That
is a real bug this feature shipped with once — measure the gap, not just the
hit. And `S.duckSource()` answers for the live store while `duckSourceIn()`
follows the project it is handed, which is the one a bounce may not share.

**Ghost notes are somebody else's part, drawn behind yours.** With
`prefs.ghosts` on, the piano roll paints every other *pitched* track's notes
in this pattern hollow and dim, with a legend of names in the ruler. Drum
tracks are left out because a drum note's `pitch` is a pad index — its row on
a piano roll would be a lie — and the notes are read straight off
`pattern.notes[id]` rather than through `S.notesOf()`, which would create an
empty list for every track that never played in the pattern: a render must not
grow the document. Ghosts are not hit-tested, so nothing in the gestures had
to change. Do not confuse them with the *suggestion* ghosts (`prefs.suggest`),
which are candidate notes from `harmony.js` and are tappable.

**Copying a part is a copy between two lists in one pattern.**
`S.copyNotes(from, to, { pattern, merge })` re-ids every note, because undo
would otherwise see one note twice. `js/ui/copynotes.js` owns the rule about
what may be paired: kits with kits, pitched with pitched, never audio — the
same numbers mean pad indices on one side and MIDI notes on the other.

**Samples carry their own key.** `sampleMeta(id).rootNote` is the MIDI note a
sample was recorded at, decided on import by `identifyRoot()`: a note name in
the filename wins (the author told us), otherwise `detectRootNote()` runs YIN
and takes a confidence-weighted median with octave folding. It is `null` when
nothing pitched was found — `null` means "unknown", never "middle C", and the
fallback to 60 happens at the point of use. Assigning a sample to a sampler
track copies its root into `track.rootNote`. Long or unpitched material is
deliberately left unmapped (`MAX_ANALYSE_SECONDS`) rather than guessed at.

**Sample edits are destructive and shared.** `js/audio/edit.js` holds pure
buffer operations — every one takes the context as an argument and returns a
*new* buffer, which is what lets the editor keep an undo stack and commit
nothing until save. `lib.replaceBuffer(id, …)` overwrites the audio under the
same id, so every pad, sampler slot and clip pointing at it changes at once;
warn before doing that, and offer `importBuffer` as "save as copy". Cuts and
joins are cross-faded (`JOIN`, 3 ms) — an unfaded splice clicks.

**Autotune is a clip processor, not a live effect.** `js/audio/autotune.js`
detects pitch with YIN on a decimated copy of the signal, picks a target note
per frame (median-filtered over ~200 ms with hysteresis, so vibrato does not
flip between neighbours), then rebuilds the audio with TD-PSOLA. It writes a
*new* sample and points `clip.sampleId` at it while `clip.sourceSampleId` keeps
the original, which is what makes "revert" free. Test it against synthetic
tones — a steady note that is 20 cents sharp should come back within a few
cents at full strength.

**Time is in 16th-note steps.** Note positions (`t`) and lengths (`len`) are
integers in steps; `STEPS_PER_BEAT = 4`, `STEPS_PER_BAR = 16`. Seconds only
appear at the audio boundary via `S.secondsPerStep()`. For drum tracks, a
note's `pitch` is the pad index (0–7), not a MIDI number.

**Audio is scheduled ahead, never on the UI thread's clock.**
`js/audio/engine.js` runs a 25 ms timer that queues every voice starting within
the next 120 ms using absolute `AudioContext` timestamps. Playhead position is
derived from `ctx.currentTime` against an anchor, not counted in the timer — so
call `engine.rebase()` after a tempo change instead of restarting playback.
`js/audio/instruments.js` takes the context as an argument precisely so
`js/audio/export.js` can re-render the same voices into an `OfflineAudioContext`
for WAV bouncing. Keep it that way: no module-level context references in the
voice code.

**Samples: Blob in IndexedDB, AudioBuffer in memory.** `js/audio/samples.js`
owns both caches. `importFile()` decodes once to validate, stores the original
bytes, and memoises the decoded buffer. Playback only ever reads
`cachedBuffer()` (synchronous, may be null) and kicks off `getBuffer()` in the
background if it misses — the note is skipped for one loop rather than delaying
the scheduler. `preloadForProject()` warms everything a project references.

**One scoring function drives both generative features.** `js/harmony.js`
holds `scoreCandidate()`, which rates a candidate pitch against the note before
it on five axes: circle-of-fifths affinity, tendency-tone resolution, melodic
contour (steps preferred, leaps recovered in the opposite direction), scale and
chord-tone weight, and register fit. `suggestNext()` ranks in-scale pitches
with it for the piano roll's ghost notes; `generateMelody()` samples from it
with a seeded RNG for the wizard. Change the weights and both features move
together — that is deliberate, but re-check the suggestion ordering afterwards
(V→I and the leading tone must stay on top) *and* the generated melodies
(average interval should stay near 3 semitones; it was 5–7 before the candidate
pool was limited to `reach` semitones around the previous note).

`repeatBias` is the one knob that only the generator turns: it lifts the unison
score so a melody can say the same note several times, and it is 0 for
`suggestNext()`, which is why the ghost-note ordering is unaffected. Repeats
are capped twice — while writing (`maxRun`, 2 at repeat 0 up to 5 at repeat 1)
and again on the finished melody by `breakLongRuns()`, because replaying a
cached motif can glue two runs together and produced drones of 19 notes before
that pass existed. Rhythm lives in `RHYTHMS`: a style either weights the
sixteen 16ths of a bar or names a fixed grid (the dotted and shuffle feels),
and `makeRhythm()` returns slots that may be rests, so a rest leaves a real
gap instead of lengthening the note before it.

`js/rhythm.js` is the drum kit's equivalent and deliberately shares only the
seeded RNG. A style is a probability per 16th **per role** (kick, snare, hat
and so on), not a fixed loop: `densityScale()` thins the optional hits and
leaves anything at or above 0.9 alone, so the backbone of a style always lands
while the rest is rolled. Bar one is remembered and later bars only redraw the
steps `variation` lets them touch — at 0 the pattern loops exactly, which is
worth keeping as a test. `mapRoles()` reads the pad *names* before falling back
to pad order, so renaming a pad "Kick" is how a user corrects a kit that was
loaded out of order.

`chordPlan()` is where the circle of fifths shapes structure: each section
targets the tonic or an immediate neighbour, the penultimate section takes the
dominant, and the phrase returns home. Repeated letters in a structure replay a
cached motif — repeating only the rhythm is not what "A A B A" means.

**The scale is project state, not a view setting.** `project.scale` is
`{ root, type, highlight, lock }`. `js/theory.js` is the only place that knows
what a scale is; the piano roll asks it per row when painting, note creation
asks it via `snapToScale()` when `lock` is on, and "fold" filters the row list.
Adding a scale means one entry in `SCALES` — nothing else changes.

**Views.** `main.js` owns the five tab views and the shared chrome. Each view
module exports a render function that rebuilds its container from scratch
(`renderSounds`, `renderMixer`, `renderSong`); the sequencer is stateful
(`createSequencer`) because the canvas and its gestures must survive re-renders.

`js/ui/notemini.js` draws a pattern's notes small and is used by both the
playlist clip and the rhythm wizard's preview, so a clip and the thing that
generated it look like the same music. It takes the clip's own window —
`steps`, `patSteps`, `offsetSteps` — and repeats the notes the way the
scheduler does, which is what makes a trimmed clip *look* trimmed.

**Meters read analysers, so they cost nothing when nobody is looking.** The
engine keeps one `AnalyserNode` per track after the panner and exposes
`trackLevel()` / `masterLevel()`; `mixer.js` runs its own `requestAnimation-
Frame` loop that parks itself the moment the container leaves layout — which
is exactly what switching tabs does. Do not move that loop into `main.js`'s
frame loop: that one only runs while the transport does, and a meter has to
move for a tapped pad too.
`js/ui/dom.js` has the `el()` builder, bottom sheets, and toasts — sheets are
the only modal pattern, use `sheet()` / `confirmSheet()` rather than `alert`.

## Conventions that have already caused bugs

- **CSS class names are global and collide.** `.empty` and `.pad` were both
  generic utilities *and* component modifiers, which silently restyled
  unrelated elements. Prefix component modifiers (`.dpad.nosample`,
  `.view.padded`) rather than reusing a bare word.
- **Custom properties need `setProperty`.** `el()` handles `--c` correctly now;
  plain `Object.assign(node.style, …)` drops them without erroring.
- **A stretched flex `<button>` collapses its children to zero height** in
  Chrome. The drum pad label is a `div[role=button]` for this reason.
- **`min-width: auto` on flex/grid items** floors them at min-content, which is
  how the top bar and mixer strips overflowed a 375 px viewport. Anything that
  must shrink needs an explicit `min-width: 0`.
- The animation loop must park when the transport stops (`startLoop()` in
  `main.js`). A permanently running `requestAnimationFrame` drains phone
  batteries and prevents the page from ever going idle.
- **Typed arrays silently ignore fractional indices — in both directions.**
  `out[12.5] = x` writes a property, not a sample, and `in[12.5]` *reads*
  `undefined`, which turns the next multiply into `NaN` and poisons the whole
  buffer. Neither throws. The first PSOLA produced near-silence this way and
  the pitch editor produced a silent, `NaN`-filled note the same way. Round
  every computed index, read or write.
- **Do not call `indexedDB.deleteDatabase` while a connection is open.** The
  delete blocks, and every later transaction on that origin queues behind it
  *permanently* — the app then reads fine but never writes, and a later boot
  hangs before the UI appears. `db.js` keeps a handle, closes it on
  `versionchange`, and exposes `deleteEverything()` which closes first. Every
  operation is also bounded by `OP_TIMEOUT`, so a blocked store surfaces as a
  toast and the app still starts with an in-memory project rather than a blank
  screen. If an origin does wedge, serving on a different port gives a clean
  one.
- **Typed-array edges cut both ways.** `edit.js` rounds every computed frame
  index, and `breakLongRuns()` had to check that the "neighbouring" scale tone
  it picks is not the same note — at the top of the pool `pool[at + 1]` is
  clamped back to `at`, so the repair silently did nothing and the run kept
  growing.
- **Snap down when placing, round when dragging.** The playlist cursor and new
  clips use `snapDown` (floor): rounding puts them in the next bar when you tap
  past the middle of a cell, which reads as the app ignoring you. Dragging
  still rounds, because there the nearest edge is what you mean.
- **`.card h3 .r` only matches a direct child of `.card`.** Wrapping a card's
  contents in an extra div silently loses the small right-hand label styling —
  the sections block is a `.card` itself for that reason.
- **A `setValueAtTime` inside a ramp truncates it.** The amp envelope schedules
  its decay to `a + d` and then writes the release start at key-up; when the
  gate ends *before* the decay does, that second event cancels the ramp and
  jumps the level. With the old 180 ms decay it was inaudible, with a one
  second one it is a click — so `playSynth` computes where the decay had
  actually got to and writes *that*. The same trap is waiting in any envelope
  with two scheduled stages.
- **A ramp with no event at its start begins at the *previous* event.** The
  other half of the same trap: `linearRampToValueAtTime(v, t)` interpolates
  from whatever event came last, however long ago that was, so an envelope
  scheduled fresh at `t` must write its own `setValueAtTime` at `t` first.
  `cancelAndHoldAtTime` only inserts that anchor when there is something after
  `t` left to cancel — on an idle param it does nothing at all, which is how
  the sidechain first ducked across the whole bar instead of on the hit.
- **An automation lane must stay a function of time.** Dragging one point onto
  another would leave two values at one step; `automation.js` absorbs the one
  being passed rather than letting the list hold both.
- **A canvas inside a playlist lane needs its own gestures.** The playlist's
  handler treats a bare `.pllane` as "drop a clip here", so the automation
  surface is a different class and stops `pointerdown` at the canvas.
- **Listeners on a reused host element must be lifetime-scoped.** The sequencer
  keeps one `host` div and swaps editors inside it, so `createDrumGrid` ties its
  listeners to an `AbortController` released in `destroy()`. Without that they
  stacked up on every track-type switch and an even number of handlers cancelled
  each other out — the grid silently stopped responding to clicks.

## Touch input model

The piano roll canvas sets `touch-action: none` and implements gestures itself:
one pointer edits, two pointers pan and pinch-zoom. Do not reintroduce native
scrolling there — the whole point is that a single finger is never ambiguous.
The drum grid and the playlist do the opposite: native scrolling with a sticky
label column, since painting cells or dragging clips does not conflict with it. Long-press (500 ms, cancelled
by 8 px of movement) opens the note editor in both.

Interactive targets are 44 px minimum. Layout uses `100dvh` with
`env(safe-area-inset-*)` padding; the app frame never scrolls, only the stage
inside it does.
