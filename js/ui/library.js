// Sample library UI: upload, audition, rename, delete, and pick.
// Samples live in IndexedDB, so anything imported here is still there
// after a reload, a restart, or offline.

import * as lib from '../audio/samples.js';
import * as engine from '../audio/engine.js';
import * as db from '../db.js';
import * as S from '../state.js';
import { noteLabel } from '../theory.js';
import { el, clear, icon, ICONS, sheet, toast, confirmSheet, fmtSize } from './dom.js';
import { openSampleEditor } from './sampleeditor.js';
import { openFolderBrowser } from './samplebrowser.js';

/** "· G5" when the sample knows what key it is in. */
const keyLabel = (s) => (s.rootNote != null ? ` · ${noteLabel(s.rootNote)}` : '');

/** Open the OS file picker; resolves with the chosen files. */
export function pickFiles() {
  return new Promise((resolve) => {
    const input = document.getElementById('fileInput');
    const onChange = () => {
      input.removeEventListener('change', onChange);
      const files = [...input.files];
      input.value = '';
      resolve(files);
    };
    input.addEventListener('change', onChange);
    input.click();
  });
}

/** Import a list of files, reporting successes and failures. */
export async function importFiles(files) {
  const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|m4a|aac|flac|aiff?|opus|webm)$/i.test(f.name));
  if (!audio.length) {
    toast('No audio files in that selection', 'err');
    return [];
  }
  await db.requestPersistence();
  const done = [];
  for (const file of audio) {
    try {
      done.push(await lib.importFile(file));
    } catch (e) {
      toast(e.message || `Could not import ${file.name}`, 'err');
    }
  }
  if (done.length) {
    const keyed = done.filter((d) => d.rootNote != null);
    toast(`Added ${done.length} sample${done.length === 1 ? '' : 's'}${keyed.length
      ? ` · ${keyed.length === 1 ? `${keyed[0].name} is ${noteLabel(keyed[0].rootNote)}` : `${keyed.length} mapped to their key`}`
      : ''}`, 'ok');
  }
  S.emit('samples');
  return done;
}

async function audition(id) {
  const buf = await lib.getBuffer(id);
  if (buf) engine.auditionBuffer(buf);
}

/**
 * Sample chooser sheet. `onPick(id|null)` fires on selection;
 * pass allowNone to offer a "no sample" row.
 */
export function openSampleSheet({ title = 'Choose a sample', selectedId = null, onPick, allowNone = false } = {}) {
  sheet(title, (body, close) => {
    const list = el('div', { class: 'slist' });

    const paint = () => {
      const samples = lib.listSamples();
      clear(list);

      if (allowNone) {
        list.append(el('button', {
          class: `sitem${selectedId ? '' : ' sel'}`,
          onclick: () => { onPick(null); close(); },
        },
          el('span', { class: 'play' }, icon(ICONS.minus, 18)),
          el('span', { class: 'meta' }, el('b', {}, 'No sample'), el('span', {}, 'Use the built-in sound')),
        ));
      }

      if (!samples.length) {
        list.append(el('div', { class: 'empty' },
          icon(ICONS.wave, 34),
          el('div', {}, 'Your library is empty.'),
          el('div', {}, 'Upload a WAV, MP3, OGG, M4A or FLAC to get started.')));
      }

      for (const s of samples) {
        list.append(el('div', { class: `sitem${s.id === selectedId ? ' sel' : ''}` },
          el('button', { class: 'play', 'aria-label': `Play ${s.name}`, onclick: (e) => { e.stopPropagation(); audition(s.id); } }, icon(ICONS.play, 16)),
          el('button', {
            class: 'meta',
            onclick: () => { onPick(s.id); close(); },
          },
            el('b', {}, s.name),
            el('span', {}, `${s.duration.toFixed(2)}s · ${fmtSize(s.size)}${keyLabel(s)}`)),
          el('button', {
            class: 'kill', 'aria-label': `Edit ${s.name}`,
            onclick: (e) => { e.stopPropagation(); openSampleEditor(s.id, { onSaved: paint }); },
          }, icon(ICONS.cut, 17)),
        ));
      }
    };

    body.append(
      el('div', { class: 'btnrow', style: { marginBottom: '12px' } },
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            const files = await pickFiles();
            if (files.length) { await importFiles(files); paint(); }
          },
        }, icon(ICONS.plus, 18), 'Upload'),
        el('button', {
          class: 'btn',
          onclick: () => {
            close();
            openFolderBrowser({ title: title === 'Choose a sample' ? 'Browse samples' : title, onPick });
          },
        }, icon(ICONS.folder, 18), 'Browse folders'),
      ),
      list,
    );
    paint();
  });
}

/** Full library manager used by the Song tab. */
export function renderLibraryManager(container) {
  const list = el('div', { class: 'slist' });
  const usage = el('div', { class: 'hint' }, 'Checking storage…');
  const bar = el('div', { class: 'bar-meter' }, el('i'));

  const drop = el('div', { class: 'dropzone' }, 'Tap “Upload”, or drop audio files here.');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('hot');
    await importFiles(e.dataTransfer.files);
    paint();
  });

  async function paintUsage() {
    const est = await db.storageEstimate();
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const samples = lib.listSamples();
    const bytes = samples.reduce((a, s) => a + (s.size || 0), 0);
    if (est && est.quota) {
      bar.firstChild.style.width = `${Math.min(100, (est.usage / est.quota) * 100).toFixed(1)}%`;
      usage.textContent = `${samples.length} sample${samples.length === 1 ? '' : 's'} · ${fmtSize(bytes)} of audio · ${fmtSize(est.usage)} used of ${fmtSize(est.quota)} available${persisted ? ' · storage is persistent' : ''}`;
    } else {
      bar.firstChild.style.width = '0%';
      usage.textContent = `${samples.length} sample${samples.length === 1 ? '' : 's'} · ${fmtSize(bytes)}`;
    }
  }

  function usedBy(id) {
    const names = [];
    for (const t of S.project().tracks) {
      if (t.sampleId === id) names.push(t.name);
      for (const pad of t.pads || []) if (pad.sampleId === id) names.push(`${t.name} · ${pad.name}`);
    }
    // Playlist clips point at samples too, and a clip whose sample vanished
    // is silent with nothing on screen to explain why.
    const clips = S.project().clips.filter((c) => c.sampleId === id || c.sourceSampleId === id).length;
    if (clips) names.push(`${clips} playlist clip${clips === 1 ? '' : 's'}`);
    return names;
  }

  function paint() {
    const samples = lib.listSamples();
    clear(list);
    if (!samples.length) {
      list.append(el('div', { class: 'empty' }, icon(ICONS.wave, 34), el('div', {}, 'No samples yet.')));
    }
    for (const s of samples) {
      const uses = usedBy(s.id);
      list.append(el('div', { class: 'sitem' },
        el('button', { class: 'play', 'aria-label': `Play ${s.name}`, onclick: () => audition(s.id) }, icon(ICONS.play, 16)),
        el('button', {
          class: 'meta',
          onclick: () => renameSheet(s, paint),
        },
          el('b', {}, s.name),
          el('span', {}, `${s.duration.toFixed(2)}s · ${fmtSize(s.size)}${keyLabel(s)}${uses.length ? ` · used by ${uses.join(', ')}` : ''}`)),
        el('button', {
          class: 'kill', 'aria-label': `Edit ${s.name}`,
          onclick: () => openSampleEditor(s.id, { onSaved: paint }),
        }, icon(ICONS.cut, 17)),
        el('button', {
          class: 'kill', 'aria-label': `Delete ${s.name}`,
          onclick: async () => {
            const warn = uses.length
              ? `“${s.name}” is used by ${uses.join(', ')}. Those slots will fall back to the built-in sound.`
              : `“${s.name}” will be removed from this device permanently.`;
            if (!await confirmSheet('Delete sample?', warn)) return;
            await lib.removeSample(s.id);
            detachSample(s.id);
            paint();
            paintUsage();
            S.emit('samples');
            toast('Sample deleted');
          },
        }, icon(ICONS.trash, 18)),
      ));
    }
    paintUsage();
  }

  clear(container).append(
    el('div', { class: 'btnrow', style: { marginBottom: '10px' } },
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const files = await pickFiles();
          if (files.length) { await importFiles(files); paint(); }
        },
      }, icon(ICONS.plus, 18), 'Upload samples'),
      el('button', {
        class: 'btn',
        onclick: () => openFolderBrowser({ title: 'Sample browser' }),
      }, icon(ICONS.folder, 18), 'Browse folders'),
    ),
    drop,
    bar,
    usage,
    el('div', { style: { height: '10px' } }),
    list,
  );
  paint();
  return { refresh: paint };
}

function renameSheet(sample, done) {
  sheet('Rename sample', (body, close) => {
    const input = el('input', { type: 'text', value: sample.name, maxlength: '48' });
    body.append(
      el('div', { class: 'row' }, input),
      el('div', { class: 'btnrow', style: { marginTop: '12px' } },
        el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            const name = input.value.trim();
            if (name) { await lib.renameSample(sample.id, name); S.emit('samples'); }
            close();
            done && done();
          },
        }, 'Save'),
      ),
    );
    setTimeout(() => input.focus(), 60);
  });
}

/** Clear references to a deleted sample so tracks fall back gracefully. */
function detachSample(id) {
  let changed = false;
  for (const t of S.project().tracks) {
    if (t.sampleId === id) { t.sampleId = null; changed = true; }
    for (const pad of t.pads || []) if (pad.sampleId === id) { pad.sampleId = null; changed = true; }
  }
  // A clip with no audio left is an empty rectangle that plays nothing, so
  // take it off the playlist rather than leaving a ghost behind.
  const p = S.project();
  const keep = p.clips.filter((c) => !(c.kind === 'audio' && (c.sampleId === id || c.sourceSampleId === id)));
  if (keep.length !== p.clips.length) { p.clips = keep; changed = true; }
  if (changed) { S.touch(); S.emit('clips'); }
}
