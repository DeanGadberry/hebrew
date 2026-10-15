#!/usr/bin/env node
// Tag a lesson video for the Apple TV app, exactly like the web page does.
//
//   node scripts/tag.mjs --lesson 68 [--title "Name"] [--art cover.jpg] input.mp4 out-dir/
//
// The episode (season/episode number, show name…) is looked up in
// site/catalog.json, so files fetched from the torrent sort in with the rest.

import { openAsBlob, openSync, writeSync, closeSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { remux } from '../site/remux.js';
import { episodeFilename, episodeMetadata } from '../site/episodes.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lesson: { type: 'string' },
    title: { type: 'string' },
    art: { type: 'string' },
    catalog: { type: 'string', default: new URL('../site/catalog.json', import.meta.url).pathname },
  },
});

const [input, outDir] = positionals;
if (!input || !outDir || !values.lesson) {
  console.error('usage: node scripts/tag.mjs --lesson 68 [--title "Name"] [--art cover.jpg] input.mp4 out-dir/');
  process.exit(2);
}

const catalog = JSON.parse(readFileSync(values.catalog, 'utf8'));
const label = `Lesson ${values.lesson}`.toLowerCase();
const ep = catalog.episodes.find((e) => e.season === 1 && (e.label || '').toLowerCase() === label);
if (!ep) {
  console.error(`Lesson ${values.lesson} is not in the catalog`);
  process.exit(1);
}

const episode = { ...ep };
if (values.title) episode.title = `${ep.label} – ${values.title}`;

const metadata = episodeMetadata(catalog, episode, 'VIDEO_1080P');
if (values.art) metadata.artwork = new Uint8Array(readFileSync(values.art));

mkdirSync(outDir, { recursive: true });
const out = join(outDir, episodeFilename(catalog, episode, 'VIDEO_1080P'));
const fd = openSync(out, 'w');
try {
  await remux((await openAsBlob(input)).stream(), {
    write: (b) => { writeSync(fd, b); },
    writeAt: (pos, b) => { writeSync(fd, b, 0, b.length, pos); },
  }, { metadata });
} finally {
  closeSync(fd);
}
console.log(out);
