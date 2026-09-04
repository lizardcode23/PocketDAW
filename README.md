# Pocket DAW

A touch-first digital audio workstation that runs entirely in the browser. No
build step, no server, no account — open `index.html` from any static host and
start writing music. Everything you make (projects *and* the samples you
upload) is stored on the device and survives reloads and offline use.

## Highlights

**Your own samples, kept for good.** Upload WAV / MP3 / OGG / M4A / FLAC from
the Song tab or by dropping files onto the window. Each file is decoded once to
validate it, then the original bytes are stored in IndexedDB as a Blob, so a
sample loaded today is still there next week with the browser offline. The app
also asks for persistent storage so the OS will not evict the library under
disk pressure. Samples can be assigned to drum pads or to a sampler track that
plays them chromatically across the piano roll.

**Samples know what key they are in.** On import, the filename is checked for a
note name (`Lead_G#5.wav`) and, failing that, the sample is analysed with YIN.
A one-shot recorded at G5 is mapped at G5, so playing G5 on the roll plays it
back untransposed instead of stretching it up from middle C — the difference
between 784 Hz and 2348 Hz for the same key press. Load a sample onto a sampler
track and its root note follows automatically; **Match** and **Detect key** in
the Sound tab redo it on demand, and the key is shown next to every sample in
the library.

**A sample editor.** Tap the scissors on any library sample (or *Edit sample…*
on a clip or drum pad) for a waveform with a draggable selection: trim to the
selection, cut a stretch out, silence it, trim the quiet ends, fade in or out,
normalise, reverse, and transpose by semitones. Every cut and join is
cross-faded over 3 ms, because slicing a waveform at an arbitrary point is what
makes edited samples click. There is an undo stack inside the editor, nothing
is written until you save, and **Save as copy** leaves the original alone.

**A sample browser for your own folder.** Drop audio into the app's `samples/`
folder — subfolders and all — and it appears in the app under **Browse
folders**, in the structure you filed it under. Browsing and auditioning cost
nothing: a file is only copied into the app's storage when you actually use
it, so a shared kit of a thousand one-shots is free to look through. **From
device…** does the same for a folder on the machine you are sitting at, and
whatever you import keeps its place in the tree. On a host that will not list
directories, drop a `samples/index.json` next to the files and the app reads
that instead.

**A project-wide scale.** Pick a root note and a scale once (top bar → scale
chip) and it applies to the whole project:

- in-scale rows in the piano roll are tinted, the tonic is marked in the
  accent colour, and out-of-scale rows recede into the background;
- **Snap input to scale** pulls new and dragged notes onto the nearest scale
  degree, so it is hard to play a wrong note;
- **Fold to scale** hides out-of-scale rows entirely — on a phone that turns a
  cramped 12-row octave into 5 or 7 comfortable ones;
- **Snap all notes into this scale** re-fits a part you already wrote when you
  change your mind about the key.

19 scales ship with it, from the church modes through pentatonics and blues to
Hijaz, Insen and the whole-tone/diminished symmetric scales.

**Suggestions from the circle of fifths.** Turn on **Suggest** in the sequence
toolbar and the piano roll draws five ranked ghost notes after your last one.
The ranking comes from the classic rules: motion by a fifth is the strongest
relationship and the tritone the weakest; a leading tone wants to rise to the
tonic, the fourth to fall to the third, the fifth to come home; melodies mostly
move by step and recover from a leap by stepping back the other way. Tap a
ghost to place it — the toast tells you *why* it was suggested ("C5 — fifth
falling home to the root").

**A melody wizard.** Open **Melody** and configure a phrase against the current
scale: length, rhythmic density, contour (arch, rising, falling, wave, level),
phrase structure (A A B A, A B A B, A A A B, A B A C or through-composed),
range, and how adventurous the note choices should be. Repeated letters replay
the *same* motif, and each section targets a chord drawn from the circle of
fifths — the tonic, its dominant and subdominant — with the phrase resolving
home at the end. A thumbnail shows the shape, **Preview** plays it through the
track's own instrument, and **Insert** writes it in (adding to or replacing
what is there).

The rhythm is yours as well: seven feels (straight, driving, offbeat,
syncopated, dotted, shuffle, long notes), four note lengths from legato to
staccato, and a **Rests** control that punches real gaps instead of just
holding notes longer. **Repeated notes** decides how often the melody says the
same note again — most hooks and every chant do — from never through
"occasional" to "insistent", with a run cap that scales from two notes to five
so it never turns into a drone.

**A rhythm wizard for the kit.** The melody wizard's twin, on the Sequence
toolbar of any drum track. Pick a feel — four to the floor, boom bap, rock,
breakbeat, trap, half time, latin, minimal — and **Density**, **Variation**
and **Human feel** shape it: density thins or thickens the optional hits and
leaves the backbone of the style alone, variation decides how far later bars
may drift from the first (at zero it is a strict loop), and human feel puts
the velocities back off the grid. A fill lands on the last bar. Nothing is a
canned pattern: a style is a set of odds per 16th note per part of the kit, so
**Another** keeps giving you a different take on the same groove.

It works out which pad is the kick and which is the hat from the pad *names*,
falling back to pad order — so rename a pad after whatever you loaded onto it
and the wizard follows. As with melodies, the preview shows the shape,
**Preview** plays it, and **Insert** adds or replaces.

**A synth with room to move, and a display that shows it.** Two oscillators
with eight waves each (saw, square, triangle, sine, pulse, organ, hollow,
bright), up to seven unison voices spread across the detune, a sub oscillator,
a noise source and a drive stage, into a low/high/band/notch filter with its
*own* attack and decay, an ADSR, an LFO you can point at pitch, filter or
amplitude, and glide. Nine presets — pad, pluck, bass, reed, organ, bell,
sweep, air — are starting points rather than the whole instrument.

Above the controls is the note itself: the whole envelope on top with the
key-up marked, a few cycles of the tone below. It is not a diagram of the
settings — it is the actual voice, rendered offline through the same code that
plays it, so what you see is what you will hear.

**A playlist, patterns and audio.** The Sequence tab edits a *pattern*; the
Playlist tab arranges copies of it. Pattern clips show their notes, so a
timeline of four clips reads as music rather than as four labelled boxes — and
a clip you trimmed looks trimmed, because it draws the same window the
scheduler plays. Drag clips to move them, drag *either* edge
to trim, long-press for the clip sheet, right-click to remove. Editing a
pattern updates every clip that uses it, and a clip longer than its pattern
simply repeats it. Which tab you are on decides what you hear: the playlist
plays the song, the sequencer loops the pattern.

The grid is as fine as you need it. **Snap** switches between bar, half-bar,
beat and 16th; zoom and lane height are separate controls; tapping the ruler
drops a cursor, and **Split** cuts the selected clip there. The clip sheet
nudges position and length by bar, beat or single 16th, and shows where the
clip sits as bar.beat.tick.

**Audio clips are editable, not fixed.** Trimming the front of an audio clip
moves its window into the sample rather than shifting the sound, so nothing
slides out of time. A clip can loop when it outlasts its sample, take fades at
either end, and carry a **Sections** strip — tap or drag across it to silence a
breath or a bad bar. Muting is not destructive: the audio is still there, and
unmuting brings it back. Split a take and drag the halves apart to move a
phrase somewhere else. Everything the playlist does is honoured by the offline
bounce, which runs the same clip player as the transport.

**Automation on the playlist.** Every track has four lanes — volume, pan, high
pass and low pass. Tap the slider button on a track's header to open the ones
you want; they appear directly under the track, so a curve is read against the
clips it is shaping. Tap a lane to drop a point, drag it to shape the curve,
right-click or double-tap a point to remove it. Points land on the playlist's
current snap, so a filter sweep can be locked to bars or drawn at 16ths.

Volume and pan automation sit *underneath* the mixer's own controls rather
than fighting them: the fader still does what you expect and the lane trims
beneath it. Lanes play in song mode, and the offline bounce writes the same
curves, so an export carries every fade and sweep.

**Stretch instead of trim.** Turn on **Stretch** in the playlist toolbar and
dragging an audio clip's right edge fits the audio to the new length rather
than cutting it off — drop a one-bar phrase onto two bars and it plays at half
speed, in key. The pitch is held by default; **Tape** resamples instead, so
the pitch moves with the speed the way a slowed record does. Trimming the
front still keeps the rest of the take where it was, splitting a stretched
clip gives both halves the right share of the audio, and the offline bounce
renders the stretched version rather than an approximation of it.

**A pitch editor, note by note.** Long-press an audio clip and choose **Pitch
editor…** for the take cut into notes on a piano roll. Drag a note up or down
to retune it — snapped to the project scale unless you ask for free pitch —
and left or right to move it in time. **Straighten** pulls a wobbling note
onto its own centre, **Fine** trims it by cents, **Silence** takes a note out,
and **Split** cuts one note into two so you can retune half of a slide.
**Tune all** drops the whole phrase onto the scale in one tap.

A note you have not touched is passed through untouched — only the notes you
moved are rebuilt, so the take does not acquire that processed sheen
everywhere. Each rebuilt note is matched to the level it had, and the edit is
saved as a new sample, so **Revert** on the clip sheet is always there.

Audio channels live on the same playlist. Press **Record** and the transport
rolls while the input is captured through an AudioWorklet, so the take lands
where you played it rather than wherever the callback happened to fire; silence
at the head and tail is trimmed and the clip appears on the lane. Recordings
become library samples like any other, so they survive a reload.

**Effects on every channel.** Each track has its own chain — EQ, filter, drive,
chorus, tempo-synced delay, synthesised reverb and a compressor. Add, reorder
and bypass them per channel from the Sound tab. The export renders through the
identical chain, so a bounce sounds like what you heard.

**Autotune.** Any audio clip can be retuned to the project scale. It is a clip
processor rather than a live effect: the take is analysed with YIN, each note is
snapped to a scale degree, and the audio is rebuilt with TD-PSOLA so the length
never changes. Strength sets how much of the error to remove and retune speed
goes from a hard snap to a slow glide — full strength with a fast speed is the
familiar hard-tuned sound. The pitch graph shows the original against the
correction, and the tuned take is saved as a *new* sample, so the original
recording is always one tap away.

## The rest of it

- **Four channel types** — a drum kit (8 pads on a step grid), a sampler (one
  sample pitched across the keyboard), a two-oscillator subtractive synth with
  unison, sub, noise, drive, a filter envelope of its own and an LFO, and audio
  channels for recordings. Pads with no sample loaded fall back to synthesised
  drums, so a new kit makes sound immediately.
- **Sample-accurate transport** — a lookahead scheduler queues every voice with
  an exact `AudioContext` timestamp, so timing does not drift with the UI.
  Tempo 40–220 BPM, swing, metronome, loop, up to 32 bars.
- **Mixer** — per-track level, pan, mute and solo, plus a master fader into a
  limiter. Every strip has a live meter beside its fader, read after the fader
  and the pan control, with a peak marker that holds for a moment so a
  transient you looked away from is still readable and a clipping channel
  turns red.
- **Export** — bounces the whole song or just the current pattern through an
  `OfflineAudioContext` (much faster than real time) and saves a 16-bit WAV.
- **Installable and offline** — a PWA manifest and a service worker that caches
  the whole shell. Add it to the home screen and it launches without a network.

## Running it

Any static file server works; the app is plain ES modules with no dependencies.

```bash
npx http-server . -p 5173 -c-1
```

Then open <http://localhost:5173>. In this repo `.claude/launch.json` already
defines that server under the name `pocket-daw`.

A secure context (`https://` or `localhost`) is required — the service worker
and persistent storage both need one.

### On a phone

The same requirement is what makes `http://192.168.x.x:5173` a poor way to
reach the app from a handset: it is not a secure context, so the service
worker never registers (no offline, no installing to the home screen),
`navigator.storage.persist()` is unavailable and the sample library can be
evicted, and there is no microphone. Everything degrades quietly — nothing
breaks, but it is not what you want to work in.

Put it on a static host over `https://` instead. `tools/stage-deploy.mjs`
builds the folder to upload:

```bash
node tools/stage-deploy.mjs
```

That is `dist/`, about 700 KB — the app alone, no samples. Drag it into
Netlify Drop or run `wrangler pages deploy dist`.

On GitHub Pages you do not need it at all: there is no build step, so the
repository root *is* the site. Push, then **Settings -> Pages -> Deploy from a
branch -> `main` / `/ (root)`**, and the app is served at
<https://lizardcode23.github.io/PocketDAW/>. Everything is referenced
relatively, so the `/PocketDAW/` subpath works unchanged.

Either way: open the URL on the phone once and *Add to home screen*. After
that it is installed, offline, and its projects and samples live on the
phone.

The samples on the machine you build from are **not** included by default —
there are gigabytes of them here and no free host wants that. Import what you
need on the phone itself, or take a folder along:

```bash
node tools/stage-deploy.mjs --samples "Produktion/Drums"
```

Only files the app can decode are copied (the zips and synth presets in
`samples/` are left behind), and a `samples/index.json` is written for them,
because a static host will not list directories for the sample browser to
crawl. `tools/make-sample-manifest.mjs` writes that manifest on its own if you
are deploying `samples/` some other way.

## Touch gestures

| Where | Gesture | Result |
| --- | --- | --- |
| Piano roll | tap empty cell | add a note at the current length |
| Piano roll | drag from a new note | stretch it (the length becomes the new default) |
| Piano roll | drag a note | move it in time and pitch |
| Piano roll | drag a note's right edge | resize |
| Piano roll | press and hold a note | velocity / length / delete sheet |
| Piano roll | two fingers | pan; pinch horizontally to zoom |
| Piano roll | left key strip | audition a pitch, slide to glide |
| Piano roll | top ruler | scrub the playhead |
| Piano roll | tap a ghost note | place the suggested pitch, with the reason |
| Step grid | tap / drag | paint and erase steps |
| Step grid | press and hold a step | velocity / delete sheet |
| Track chip | press and hold | mute / unmute |
| Playlist | tap an empty lane | drop the current pattern there (an audio lane opens the sample picker) |
| Playlist | tap the bar ruler | move the cursor — where Split cuts and play starts |
| Playlist | drag a clip | move it in time, or onto another lane |
| Playlist | drag the clip's right edge | resize, snapped to the Snap setting |
| Playlist | drag the right edge, Stretch on | fit the audio to the new length |
| Playlist | drag the clip's left edge | trim the front without moving the audio |
| Playlist | press and hold a clip | clip sheet: position, length, level, sections, fades, autotune |
| Playlist | tap a track header's slider button | choose its automation lanes |
| Automation lane | tap | drop a point, snapped to the Snap setting |
| Automation lane | drag a point | shape the curve; the header shows the value |
| Automation lane | right-click or double-tap a point | remove it |
| Clip sheet | tap or drag the sections strip | mute and unmute stretches of the clip |
| Sample editor | drag across the waveform | select; drag an edge to adjust it |
| Pitch editor | tap a note | select it and show its controls |
| Pitch editor | drag a note up or down | retune it, snapped to the scale |
| Pitch editor | drag a note left or right | move it in time |
| Pitch editor | tap the background | drop the cursor that Split cuts at |

With a mouse, click and drag paints in both editors and **right-click erases**
without switching tools.

Keyboard, when one is attached: <kbd>Space</kbd> play/stop, <kbd>Ctrl/⌘+Z</kbd>
undo, <kbd>Shift</kbd> to redo, <kbd>1</kbd>–<kbd>4</kbd> switch tabs,
<kbd>Ctrl</kbd>+wheel to zoom the roll.

## Where things live

```
index.html            app shell — top bar, track strip, four tab views
css/style.css         the whole stylesheet, mobile-first
js/state.js           the project document, undo stack, autosave
js/db.js              IndexedDB: samples, projects, metadata
js/theory.js          scales, note names, in-scale tests, circle of fifths
js/harmony.js         note scoring, suggestions, melody generation
js/rhythm.js          drum styles as odds per 16th, and the kit role mapping
js/audio/             context, samples, voices, effects, scheduler, WAV export
js/audio/synthpresets.js  the synth's starting points
js/audio/voicepreview.js  one note rendered offline, for the wave display
js/audio/autotune.js  YIN pitch detection, TD-PSOLA retuning, key identification
js/audio/clips.js     one audio clip: window, loop, fades, muted sections
js/audio/stretch.js   WSOLA time-stretching, cached per sample and speed
js/audio/pitchedit.js note segmentation and per-note pitch/time rebuilding
js/audio/folder.js    reading the app's own samples/ folder
js/audio/edit.js      destructive buffer edits behind the sample editor
js/audio/recorder.js  input capture (AudioWorklet, ScriptProcessor fallback)
js/ui/                one module per view, plus the roll, grid and playlist
js/ui/automation.js   the playlist's automation lanes
js/ui/notemini.js     a pattern's notes drawn small, on clips and in previews
js/ui/rhythmwizard.js the drum kit's generator
js/ui/synthscope.js   the synth's envelope and waveform display
js/ui/sampleeditor.js the waveform editor
js/ui/pitcheditor.js  the note-by-note pitch editor
js/ui/samplebrowser.js the folder browser
samples/              drop your own audio in here; see samples/README.txt
js/ui/waveform.js     peak computation and waveform drawing
sw.js                 offline shell cache
```

## Limits worth knowing

- Storage is per-browser and per-device. Clearing site data deletes your
  projects and samples — export anything you want to keep.
- Samples are capped at 40 MB each; the practical library size depends on the
  browser's quota, shown live in the Song tab.
- Recording needs microphone permission and a secure context. Use headphones
  when monitoring — the input is routed to the master and will feed back.
- Autotune leaves formants where they are, which is right for the small
  corrections it is built for; pull something several semitones and it will
  start to sound synthetic.
- Editing a sample rewrites it for everything that uses it — pads, sampler
  slots and clips alike. The editor says so before overwriting, and *Save as
  copy* is there when you only want the edit in one place.
- Key detection is for pitched, roughly monophonic material under 20 seconds.
  A chord, a drum loop or a long stem is left unmapped rather than guessed at;
  set the root by hand in that case.
- Transposing in the sample editor resamples, so the sample changes length as
  it changes pitch. That is the tape-speed sound, and it is deliberate.
- Stretching runs between an eighth and eight times. Well past two or three
  the grains start to smear, which is the honest cost of doing it in the
  browser; use **Tape** if the artefacts bother you more than the pitch change
  would.
- The pitch editor wants pitched, roughly monophonic material — a voice, a
  bass, a lead. It will find nothing useful in a chord or a drum loop, and it
  says so rather than inventing notes.
- There is no live MIDI input yet; note parts are drawn, not played in.
