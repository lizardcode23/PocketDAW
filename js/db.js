// IndexedDB persistence. Samples are stored as Blobs so they survive
// reloads, restarts and offline use; projects are stored as plain JSON.

const DB_NAME = 'pocket-daw';
const DB_VERSION = 1;
const STORE_SAMPLES = 'samples';
const STORE_PROJECTS = 'projects';
const STORE_META = 'meta';

let dbPromise = null;
let handle = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
        db.createObjectStore(STORE_SAMPLES, { keyPath: 'id' })
          .createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
          .createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      handle = req.result;
      // Another tab (or a delete request) needs us out of the way.
      handle.onversionchange = () => { closeDb(); };
      handle.onclose = () => { handle = null; dbPromise = null; };
      resolve(handle);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('Database is blocked by another tab')); };
  });
  return dbPromise;
}

/** Release the connection so a delete or upgrade elsewhere can proceed. */
export function closeDb() {
  if (handle) { try { handle.close(); } catch { /* already closed */ } }
  handle = null;
  dbPromise = null;
}

/** Wipe everything on this device. Closes our connection first. */
export function deleteEverything() {
  closeDb();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Pocket DAW tabs and try again'));
  });
}

// IndexedDB can stall indefinitely — a blocked upgrade, a delete waiting on
// another tab. Every operation is bounded so callers fail fast and can say so
// rather than hanging the whole app.
const OP_TIMEOUT = 8000;

function withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Storage is not responding (${what}) — close other tabs of this app and reload`)),
        OP_TIMEOUT);
    }),
  ]);
}

function tx(store, mode, fn) {
  return withTimeout(open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  })), `${mode} ${store}`);
}

/* ---------------------------------------------------------------- samples */

export const putSample = (rec) => tx(STORE_SAMPLES, 'readwrite', (s) => s.put(rec));
export const getSample = (id) => tx(STORE_SAMPLES, 'readonly', (s) => s.get(id));
export const allSamples = () => tx(STORE_SAMPLES, 'readonly', (s) => s.getAll());
export const deleteSample = (id) => tx(STORE_SAMPLES, 'readwrite', (s) => s.delete(id));

/* --------------------------------------------------------------- projects */

export const putProject = (rec) => tx(STORE_PROJECTS, 'readwrite', (s) => s.put(rec));
export const getProject = (id) => tx(STORE_PROJECTS, 'readonly', (s) => s.get(id));
export const allProjects = () => tx(STORE_PROJECTS, 'readonly', (s) => s.getAll());
export const deleteProject = (id) => tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id));

/* ------------------------------------------------------------------- meta */

export const setMeta = (key, value) => tx(STORE_META, 'readwrite', (s) => s.put({ key, value }));
export async function getMeta(key) {
  const rec = await tx(STORE_META, 'readonly', (s) => s.get(key));
  return rec ? rec.value : undefined;
}

/**
 * Ask the browser to make storage persistent so the OS does not evict
 * uploaded samples under disk pressure. Safe to call repeatedly.
 */
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  try { return await navigator.storage.persist(); } catch { return false; }
}

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
