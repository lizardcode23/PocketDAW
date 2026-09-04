#!/usr/bin/env node
// Write `samples/index.json` — the list `js/audio/folder.js` reads *instead*
// of a directory listing.
//
// `npx http-server` lists directories, so the development setup needs no
// manifest. Static hosts (GitHub Pages, Netlify, Cloudflare Pages) do not,
// and there the sample browser has nothing to crawl: without this file the
// "Browse folders" sheet is simply empty.
//
//   node tools/make-sample-manifest.mjs
//   node tools/make-sample-manifest.mjs --root dist/samples --dry-run
//
// Also used by `tools/stage-deploy.mjs`, which imports `collect()`.

import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Mirrors AUDIO in js/audio/folder.js — a file the app cannot read has no
// business in the manifest. Keep the two in step.
const AUDIO = /\.(wav|mp3|ogg|m4a|aac|flac|aiff?|opus|webm)$/i;

/**
 * Every audio file under `root`, as the `{ path, size }` records folder.js
 * expects: paths relative to the folder, forward slashes, no leading slash.
 *
 * Dot-files are skipped, which is also what drops macOS AppleDouble forks —
 * `._Kick.wav` matches the audio pattern, is four kilobytes of resource fork,
 * and would show up in the app as a sample that will not decode.
 */
export async function collect(root) {
  const files = [];
  const skipped = { hidden: 0, other: 0 };

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;                                   // unreadable folder is "empty"
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) { skipped.hidden++; continue; }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.isFile()) continue;       // symlinks, sockets, devices
      else if (!AUDIO.test(entry.name)) skipped.other++;
      else {
        const { size } = await stat(full);
        files.push({ path: relative(root, full).split(sep).join('/'), size });
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { files, skipped };
}

/** The manifest document itself, in the shape folder.js reads. */
export const manifest = (files) => ({
  generated: new Date().toISOString(),
  count: files.length,
  files,
});

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function main(argv) {
  const opt = { root: 'samples', out: null, dry: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') opt.root = argv[++i];
    else if (arg === '--out') opt.out = argv[++i];
    else if (arg === '--dry-run') opt.dry = true;
    else if (arg === '--quiet') opt.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: make-sample-manifest.mjs [--root samples] [--out <file>] [--dry-run] [--quiet]');
      return 0;
    } else {
      console.error(`unknown argument "${arg}"`);
      return 2;
    }
  }
  const out = opt.out || join(opt.root, 'index.json');

  const { files, skipped } = await collect(opt.root);
  if (!files.length) {
    console.error(`no audio found under ${opt.root}/ — nothing written`);
    return 1;
  }

  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (!opt.dry) await writeFile(out, `${JSON.stringify(manifest(files), null, 1)}\n`);
  if (!opt.quiet) {
    console.log(`${opt.dry ? 'would write' : 'wrote'} ${out}`);
    console.log(`  ${files.length} audio files, ${mb(bytes)} MB`);
    console.log(`  skipped ${skipped.other} non-audio, ${skipped.hidden} hidden/AppleDouble`);
  }
  return 0;
}

// Only when run as a script: tools/stage-deploy.mjs imports collect() and
// would otherwise parse *its* arguments and write a manifest of its own.
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
