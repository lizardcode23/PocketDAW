#!/usr/bin/env node
// Build the folder you hand to a static host.
//
// The app itself is a few hundred kilobytes; `samples/` on this machine is
// gigabytes, and no free static host wants that. So the default is the app
// alone — the phone imports its own samples — and sample folders are opted
// into one at a time:
//
//   node tools/stage-deploy.mjs
//   node tools/stage-deploy.mjs --samples "Produktion/Drums"
//   node tools/stage-deploy.mjs --samples Kits --samples Vocals --out dist
//
// Only files the app can actually decode are copied out of `samples/`; the
// zips and synth presets sitting in there would be dead weight on the host.
// A manifest is written whenever anything was copied, because a static host
// will not list directories for the sample browser to crawl.

import { cp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { collect, manifest } from './make-sample-manifest.mjs';

// Everything the service worker precaches lives under one of these.
const APP = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'icons',
];

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function copySamples(from, to, subdirs) {
  const picked = [];
  for (const sub of subdirs) {
    const src = join(from, sub);
    try {
      if (!(await stat(src)).isDirectory()) throw new Error('not a folder');
    } catch {
      console.error(`  ! "${sub}" is not a folder under ${from}/ — skipped`);
      continue;
    }
    const { files } = await collect(src);
    if (!files.length) {
      console.error(`  ! no audio under "${sub}" — skipped`);
      continue;
    }
    for (const file of files) {
      const dest = join(to, sub, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(src, file.path), dest);
      // collect() already yields forward slashes; `--all-samples` passes an
      // empty subfolder, so the prefix has to stay off in that case.
      picked.push({ path: sub ? `${sub}/${file.path}` : file.path, size: file.size });
    }
    console.log(`  + ${sub || 'samples/'} (${files.length} files, ${mb(files.reduce((n, f) => n + f.size, 0))} MB)`);
  }
  return picked;
}

async function main(argv) {
  const opt = { out: 'dist', samples: [], all: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opt.out = argv[++i];
    else if (arg === '--samples') opt.samples.push(argv[++i]);
    else if (arg === '--all-samples') opt.all = true;
    else if (arg === '--keep') opt.keep = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: stage-deploy.mjs [--out dist] [--samples <subfolder>]... [--all-samples] [--keep]');
      return 0;
    } else {
      console.error(`unknown argument "${arg}"`);
      return 2;
    }
  }

  if (!opt.keep) await rm(opt.out, { recursive: true, force: true });
  await mkdir(opt.out, { recursive: true });

  for (const entry of APP) {
    await cp(entry, join(opt.out, entry), { recursive: true });
  }
  console.log(`app staged in ${opt.out}/`);

  const subdirs = opt.all ? [''] : opt.samples;
  if (subdirs.length) {
    const picked = await copySamples('samples', join(opt.out, 'samples'), subdirs);
    if (picked.length) {
      await writeFile(
        join(opt.out, 'samples', 'index.json'),
        `${JSON.stringify(manifest(picked), null, 1)}\n`,
      );
      console.log(`  manifest: ${picked.length} files`);
    }
  } else {
    console.log('  no samples included — import them on the phone, or pass --samples <subfolder>');
  }

  console.log(`\nupload ${opt.out}/ to any static host over https, then open it on the phone`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
