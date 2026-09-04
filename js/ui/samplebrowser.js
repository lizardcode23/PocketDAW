// The sample browser: the app's `samples/` folder, in its own structure.
//
// The library sheet is a flat alphabetical list, which is the right shape for
// twelve samples and the wrong one for a kit somebody filed into folders.
// This walks the folder tree instead, and folds two sources into one view:
// files sitting in the app folder (fetched on demand) and files already in
// the library that remember where they came from.
//
// Nothing is copied into IndexedDB by browsing or auditioning — only by
// choosing a sample, which is what keeps a large shared folder cheap.

import * as lib from '../audio/samples.js';
import * as engine from '../audio/engine.js';
import * as db from '../db.js';
import * as S from '../state.js';
import { getContext } from '../audio/context.js';
import {
  scanAppFolder, fetchFile, buildTree, nodeAt, countFiles, isAudioName, baseName,
} from '../audio/folder.js';
import { noteLabel } from '../theory.js';
import { el, clear, icon, ICONS, sheet, toast, fmtSize } from './dom.js';

const MAX_DEVICE_FILES = 200;
const previews = new Map();      // folder path -> AudioBuffer

const keyLabel = (root) => (root != null ? ` · ${noteLabel(root)}` : '');

/** Decode a folder file just far enough to hear it. Never stored. */
async function previewBuffer(path) {
  if (previews.has(path)) return previews.get(path);
  const file = await fetchFile(path);
  const arr = await file.arrayBuffer();
  const buf = await getContext().decodeAudioData(arr);
  previews.set(path, buf);
  return buf;
}

/**
 * Everything worth showing, as flat records the tree builder can fold.
 * A file that has been imported carries its sample id, so the row can offer
 * to use it instead of importing it again.
 */
async function collect({ force = false } = {}) {
  let folder = [];
  // A host that will not list directories is not an error here — it just
  // means the app folder contributes nothing and the library carries the view.
  try { folder = await scanAppFolder({ force }); } catch { folder = []; }

  const seen = new Set();
  const entries = folder.map((f) => {
    seen.add(f.path);
    const known = lib.sampleByPath(f.path);
    return { ...f, sampleId: known ? known.id : null, remote: true };
  });

  // Samples imported from a folder on the device have no file to fetch, but
  // they do have a place in the structure.
  for (const s of lib.listSamples()) {
    if (!s.sourcePath || seen.has(s.sourcePath)) continue;
    entries.push({
      path: s.sourcePath,
      name: baseName(s.sourcePath),
      size: s.size,
      sampleId: s.id,
      remote: false,
    });
  }
  return { tree: buildTree(entries), count: entries.length };
}

/**
 * Open the browser.
 * `onPick(sampleId)` turns it into a chooser: a tapped file is imported if it
 * has to be, then handed over. Without it, files are added to the library.
 */
export function openFolderBrowser({ title = 'Sample browser', onPick = null } = {}) {
  sheet(title, (body, close) => {
    const crumbs = el('div', { class: 'crumbs' });
    const list = el('div', { class: 'slist' });
    const note = el('p', { class: 'hint' }, 'Reading the app folder…');

    let tree = null;
    let path = '';
    let busy = false;

    async function reload({ force = false } = {}) {
      const found = await collect({ force });
      tree = found.tree;
      if (!nodeAt(tree, path)) path = '';
      note.textContent = found.count
        ? `${found.count} file${found.count === 1 ? '' : 's'} · app folder “samples/”, plus anything imported from a folder`
        : 'Nothing found. Put audio files in the app’s “samples/” folder (subfolders are fine) and tap Rescan — or import a folder from this device.';
      paint();
    }

    /* ------------------------------------------------------------ rows */

    function paintCrumbs() {
      clear(crumbs);
      const parts = path ? path.split('/') : [];
      crumbs.append(el('button', {
        class: `crumb${path ? '' : ' here'}`,
        onclick: () => { path = ''; paint(); },
      }, icon(ICONS.folder, 15), 'samples'));
      parts.forEach((part, i) => {
        const to = parts.slice(0, i + 1).join('/');
        crumbs.append(
          el('span', { class: 'crumbsep' }, '/'),
          el('button', {
            class: `crumb${i === parts.length - 1 ? ' here' : ''}`,
            onclick: () => { path = to; paint(); },
          }, part),
        );
      });
    }

    async function useFile(entry) {
      if (busy) return;
      busy = true;
      try {
        let id = entry.sampleId;
        if (!id) {
          if (!entry.remote) throw new Error('That sample is no longer in the library');
          await db.requestPersistence();
          const file = await fetchFile(entry.path);
          const meta = await lib.importFile(file, { sourcePath: entry.path });
          id = meta.id;
          S.emit('samples');
          toast(`Added “${meta.name}”${keyLabel(meta.rootNote)}`, 'ok');
        }
        if (onPick) { onPick(id); close(); return; }
        await reload();
      } catch (e) {
        toast(e.message || 'Could not add that sample', 'err');
      } finally {
        busy = false;
      }
    }

    function fileRow(entry) {
      const meta = entry.sampleId ? lib.sampleMeta(entry.sampleId) : null;
      const detail = meta
        ? `${meta.duration.toFixed(2)}s · ${fmtSize(meta.size)}${keyLabel(meta.rootNote)} · in the library`
        : entry.size ? `${fmtSize(entry.size)} · in the app folder` : 'in the app folder';

      return el('div', { class: 'sitem' },
        el('button', {
          class: 'play', 'aria-label': `Play ${entry.name}`,
          onclick: async (e) => {
            e.stopPropagation();
            try {
              const buf = entry.sampleId
                ? await lib.getBuffer(entry.sampleId)
                : await previewBuffer(entry.path);
              if (buf) engine.auditionBuffer(buf);
            } catch (err) {
              toast(err.message || 'Could not play that file', 'err');
            }
          },
        }, icon(ICONS.play, 16)),
        el('button', {
          class: 'meta',
          onclick: () => useFile(entry),
        }, el('b', {}, entry.name), el('span', {}, detail)),
        el('button', {
          class: 'kill', 'aria-label': onPick ? `Use ${entry.name}` : `Add ${entry.name}`,
          onclick: () => useFile(entry),
        }, icon(entry.sampleId && !onPick ? ICONS.check : ICONS.plus, 18)),
      );
    }

    function paint() {
      paintCrumbs();
      clear(list);
      const node = tree ? nodeAt(tree, path) : null;
      if (!node) { list.append(el('div', { class: 'empty' }, el('div', {}, 'That folder has gone.'))); return; }

      if (path) {
        const up = path.split('/').slice(0, -1).join('/');
        list.append(el('button', {
          class: 'sitem folderrow',
          onclick: () => { path = up; paint(); },
        },
          el('span', { class: 'play' }, icon(ICONS.up, 16)),
          el('span', { class: 'meta' }, el('b', {}, '..'), el('span', {}, 'up one folder')),
        ));
      }

      for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const n = countFiles(dir);
        list.append(el('button', {
          class: 'sitem folderrow',
          onclick: () => { path = dir.path; paint(); },
        },
          el('span', { class: 'play' }, icon(ICONS.folder, 16)),
          el('span', { class: 'meta' },
            el('b', {}, dir.name),
            el('span', {}, `${n} sample${n === 1 ? '' : 's'}`)),
        ));
      }

      for (const file of node.files) list.append(fileRow(file));

      if (!node.dirs.size && !node.files.length) {
        list.append(el('div', { class: 'empty' },
          icon(ICONS.folder, 34),
          el('div', {}, 'This folder is empty.')));
      }
    }

    /* ---------------------------------------------------- device folder */

    function importDeviceFolder() {
      const input = el('input', { type: 'file', multiple: true, accept: 'audio/*' });
      // Not in the HTML spec, but every engine that matters honours it, and
      // the fallback is simply a multi-file pick.
      input.webkitdirectory = true;
      input.style.display = 'none';
      document.body.append(input);
      input.addEventListener('change', async () => {
        const files = [...input.files].filter((f) => isAudioName(f.name));
        input.remove();
        if (!files.length) { toast('No audio files in that folder', 'err'); return; }
        const take = files.slice(0, MAX_DEVICE_FILES);
        toast(`Importing ${take.length} file${take.length === 1 ? '' : 's'}…`);
        await db.requestPersistence();
        let done = 0;
        for (const file of take) {
          const rel = file.webkitRelativePath || file.name;
          try {
            await lib.importFile(file, { sourcePath: `device/${rel}` });
            done++;
          } catch (e) {
            toast(e.message || `Could not import ${file.name}`, 'err');
          }
        }
        S.emit('samples');
        toast(`Imported ${done} sample${done === 1 ? '' : 's'}`, 'ok');
        await reload();
      }, { once: true });
      input.click();
    }

    async function addFolder() {
      const node = tree ? nodeAt(tree, path) : null;
      if (!node || !node.files.length) { toast('No files in this folder'); return; }
      const missing = node.files.filter((f) => !f.sampleId && f.remote);
      if (!missing.length) { toast('Everything here is already in the library'); return; }
      busy = true;
      toast(`Adding ${missing.length} sample${missing.length === 1 ? '' : 's'}…`);
      for (const entry of missing) {
        try {
          const file = await fetchFile(entry.path);
          await lib.importFile(file, { sourcePath: entry.path });
        } catch (e) {
          toast(e.message || `Could not add ${entry.name}`, 'err');
        }
      }
      busy = false;
      S.emit('samples');
      await reload();
      toast('Folder added to the library', 'ok');
    }

    /* ----------------------------------------------------------- build */

    body.append(
      el('div', { class: 'btnrow', style: { marginBottom: '8px' } },
        el('button', { class: 'btn', onclick: () => reload({ force: true }) },
          icon(ICONS.power, 18), 'Rescan'),
        el('button', { class: 'btn', onclick: addFolder },
          icon(ICONS.down, 18), 'Add folder'),
        el('button', { class: 'btn', onclick: importDeviceFolder },
          icon(ICONS.folder, 18), 'From device…'),
      ),
      crumbs,
      list,
      note,
    );

    reload();
  });
}
