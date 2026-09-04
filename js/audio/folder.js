// Reading the audio that is sitting in the app's own `samples/` folder.
//
// Drop files (and folders of files) next to `index.html` and they show up in
// the browser inside the app, in the structure you filed them under. Nothing
// is copied into IndexedDB until you actually use one, so a big shared kit
// costs nothing but the listing.
//
// Two ways of finding out what is there, in order of trust:
//
//   1. `samples/index.json` — a list the author wrote (or generated). Works on
//      any host, including ones that refuse to list directories.
//   2. The server's own directory listing. `npx http-server` produces one, so
//      the development setup needs no extra step: drop a file in, reload.
//
// Neither can be assumed, so a failure here is "nothing to show", never an
// error the user has to deal with.

export const ROOT = 'samples/';

const AUDIO = /\.(wav|mp3|ogg|m4a|aac|flac|aiff?|opus|webm)$/i;
const MAX_DEPTH = 5;
const MAX_FILES = 600;

let cache = null;         // the last successful scan
let scanning = null;

export const isAudioName = (name) => AUDIO.test(name);
export const baseName = (path) => path.split('/').pop() || path;
export const dirName = (path) => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};

/* --------------------------------------------------------------- the scan */

/** A hand-written or generated manifest. Accepts a few obvious shapes. */
async function readManifest() {
  const res = await fetch(`${ROOT}index.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.files || data.samples || []);
  const out = [];
  for (const item of list) {
    const path = typeof item === 'string' ? item : item.path || item.file || item.name;
    if (!path || !isAudioName(path)) continue;
    const clean = String(path).replace(/^\.?\//, '').replace(/^samples\//, '');
    out.push({ path: clean, name: baseName(clean), size: item.size || 0 });
  }
  return out.length ? out : null;
}

/**
 * Parse one directory listing page. Anchors that stay inside the folder and
 * are not the "up" link are entries; a trailing slash means a directory.
 */
function parseListing(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A server that rewrites unknown paths to the app shell hands us our own
  // page back. Nothing in it is a sample, and following it would recurse.
  if (doc.querySelector('#app, #sheetRoot')) return null;

  const here = new URL(base, location.href);
  const out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('?') || href.startsWith('#')) continue;
    let url;
    try { url = new URL(href, here); } catch { continue; }
    if (url.origin !== location.origin) continue;
    if (!url.pathname.startsWith(here.pathname)) continue;      // "up" links
    const rest = decodeURIComponent(url.pathname.slice(here.pathname.length));
    if (!rest || rest === '/') continue;
    const isDir = rest.endsWith('/');
    const name = isDir ? rest.slice(0, -1) : rest;
    if (!name || name.includes('/')) continue;                  // one level only
    out.push({ name, isDir });
  }
  return out;
}

async function crawl(prefix, depth, found) {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
  let entries = null;
  try {
    const res = await fetch(`${ROOT}${prefix}`, { cache: 'no-store' });
    if (!res.ok) return;
    entries = parseListing(await res.text(), `${ROOT}${prefix}`);
  } catch { return; }
  if (!entries) return;

  for (const entry of entries) {
    if (found.length >= MAX_FILES) return;
    if (entry.isDir) await crawl(`${prefix}${entry.name}/`, depth + 1, found);
    else if (isAudioName(entry.name)) {
      found.push({ path: `${prefix}${entry.name}`, name: entry.name, size: 0 });
    }
  }
}

/**
 * Everything the app folder holds, as flat `{ path, name, size }` records.
 * Cached; pass `force` after the user has added files.
 */
export async function scanAppFolder({ force = false } = {}) {
  if (cache && !force) return cache;
  if (scanning && !force) return scanning;

  scanning = (async () => {
    let files = null;
    try { files = await readManifest(); } catch { /* no manifest is normal */ }
    if (!files) {
      const found = [];
      await crawl('', 0, found);
      files = found;
    }
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    cache = files;
    return files;
  })();

  try { return await scanning; } finally { scanning = null; }
}

/** Was the folder readable at all? Distinguishes "empty" from "not listable". */
export const lastScan = () => cache;

/* ------------------------------------------------------------ fetching */

/** One file from the folder, as a File so the library can import it as usual. */
export async function fetchFile(path) {
  const res = await fetch(ROOT + path.split('/').map(encodeURIComponent).join('/'));
  if (!res.ok) throw new Error(`Could not read "${path}" (${res.status})`);
  const blob = await res.blob();
  return new File([blob], baseName(path), { type: blob.type || 'audio/wav' });
}

/* --------------------------------------------------------------- trees */

/**
 * Fold flat paths into a folder tree. Entries can come from the app folder or
 * from the library (anything imported remembers where it came from), so both
 * appear in one structure instead of two half-views of the same kit.
 */
export function buildTree(entries) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    const file = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          dirs: new Map(),
          files: [],
        });
      }
      node = node.dirs.get(part);
    }
    node.files.push({ ...entry, name: entry.name || file });
  }
  return root;
}

/** Walk to a folder inside a tree, or null when the path has gone. */
export function nodeAt(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split('/').filter(Boolean)) {
    node = node.dirs.get(part);
    if (!node) return null;
  }
  return node;
}

/** How many files sit under a folder, at any depth — the row's subtitle. */
export function countFiles(node) {
  let n = node.files.length;
  for (const dir of node.dirs.values()) n += countFiles(dir);
  return n;
}
