// Offline shell cache. Bump CACHE when shipping changes.
const CACHE = 'pocket-daw-v9';

const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'js/main.js',
  'js/state.js',
  'js/db.js',
  'js/theory.js',
  'js/harmony.js',
  'js/rhythm.js',
  'js/audio/autotune.js',
  'js/audio/context.js',
  'js/audio/clips.js',
  'js/audio/folder.js',
  'js/audio/edit.js',
  'js/audio/effects.js',
  'js/audio/engine.js',
  'js/audio/export.js',
  'js/audio/instruments.js',
  'js/audio/synthpresets.js',
  'js/audio/voicepreview.js',
  'js/audio/recorder.js',
  'js/audio/recorder-worklet.js',
  'js/audio/pitchedit.js',
  'js/audio/samples.js',
  'js/audio/sidechain.js',
  'js/audio/stretch.js',
  'js/ui/automation.js',
  'js/ui/clipsheet.js',
  'js/ui/copynotes.js',
  'js/ui/dom.js',
  'js/ui/fxrack.js',
  'js/ui/drumgrid.js',
  'js/ui/library.js',
  'js/ui/mixer.js',
  'js/ui/notemini.js',
  'js/ui/notesheet.js',
  'js/ui/pianoroll.js',
  'js/ui/pitcheditor.js',
  'js/ui/playlist.js',
  'js/ui/playlistview.js',
  'js/ui/rhythmwizard.js',
  'js/ui/scalepicker.js',
  'js/ui/synthscope.js',
  'js/ui/sequencer.js',
  'js/ui/song.js',
  'js/ui/samplebrowser.js',
  'js/ui/sampleeditor.js',
  'js/ui/sounds.js',
  'js/ui/waveform.js',
  'js/ui/tunesheet.js',
  'js/ui/wizard.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // The user's own sample folder is edited from outside the app: serving a
  // stale listing (or a stale file) would hide something they just added.
  if (new URL(req.url).pathname.includes('/samples/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Navigations: try the network so a new build is picked up immediately,
  // fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
    );
    return;
  }

  // Everything else: serve from cache for speed, refresh it in the
  // background so the next load has the newer file.
  e.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
