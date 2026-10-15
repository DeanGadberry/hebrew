// Integration test for site/remux.js.
//
//   node --test tests/*.test.mjs                       # synthetic fixture only (needs ffmpeg)
//   REMUX_SAMPLE=/path/to/lets-church.mp4 node --test tests/*.test.mjs   # also a real download
//
// The synthetic fixture is a fragmented MP4 made by ffmpeg with the same layout
// Lets.Church serves (first segment in the moov, then moof/mdat pairs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, writeSync, closeSync, openAsBlob, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remux, MEDIA_KIND } from '../site/remux.js';

const dir = mkdtempSync(join(tmpdir(), 'remux-test-'));

function fileSink(path) {
  const fd = openSync(path, 'w');
  return {
    write(bytes) { writeSync(fd, bytes); },
    writeAt(pos, bytes) { writeSync(fd, bytes, 0, bytes.length, pos); },
    close() { closeSync(fd); },
  };
}

function probe(path, args) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, path], { encoding: 'utf8' }));
}

function packetCount(path, stream) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  return Number(out.trim());
}

function decodeErrors(path) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function topLevelBoxes(path) {
  const out = execFileSync('python3', ['-I', '-c', `
import struct,sys
f=open(sys.argv[1],'rb'); o=0; r=[]
while True:
    f.seek(o); h=f.read(16)
    if len(h)<8: break
    s,t=struct.unpack('>I4s',h[:8])
    if s==1: s=struct.unpack('>Q',h[8:16])[0]
    r.append(t.decode('latin1')); o+=s
print(' '.join(r))`, path], { encoding: 'utf8' });
  return out.trim().split(' ');
}

const ARTWORK = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=64x36', '-frames:v', '1', '-f', 'mjpeg', '-'], { maxBuffer: 1 << 20 });

const META = {
  title: 'Lesson 58b – Test Title',
  show: 'Aleph with Beth',
  season: 1,
  episode: 61,
  episodeId: 'Lesson 58b',
  mediaKind: MEDIA_KIND.tvShow,
  description: 'Short description',
  longDescription: 'Long description',
  date: '2026-10-07T00:00:00Z',
  genre: 'Education',
  hdVideo: 2,
  artwork: new Uint8Array(ARTWORK),
};

async function convert(src, dst, extra = {}) {
  const sink = fileSink(dst);
  const stream = (await openAsBlob(src)).stream();
  const result = await remux(stream, sink, { metadata: META, ...extra });
  sink.close();
  return result;
}

function checkOutput(src, dst) {
  const boxes = topLevelBoxes(dst);
  assert.deepEqual(boxes, ['ftyp', 'mdat', 'moov'], 'plain MP4 layout');

  for (const s of ['V', 'a']) {
    const before = packetCount(src, s);
    if (Number.isNaN(before) || before === 0) continue;
    assert.equal(packetCount(dst, s), before, `same number of ${s} packets`);
  }
  assert.equal(decodeErrors(dst), '', 'decodes without errors');

  const srcDur = Number(probe(src, ['-show_entries', 'format=duration']).format.duration);
  const dstDur = Number(probe(dst, ['-show_entries', 'format=duration']).format.duration);
  assert.ok(Math.abs(srcDur - dstDur) < 0.2, `duration kept (${srcDur} vs ${dstDur})`);
}

function checkTags(dst) {
  const info = probe(dst, ['-show_entries', 'format_tags:stream=codec_type:stream_disposition=attached_pic']);
  const tags = info.format.tags;
  assert.equal(tags.title, META.title);
  assert.equal(tags.show, META.show);
  assert.equal(tags.season_number, '1');
  assert.equal(tags.episode_sort, '61');
  assert.equal(tags.episode_id, 'Lesson 58b');
  assert.equal(tags.media_type, '10');
  assert.equal(tags.description, 'Short description');
  assert.equal(tags.synopsis, 'Long description');
  assert.equal(tags.hd_video, '2');
  assert.ok(info.streams.some((s) => s.disposition?.attached_pic === 1), 'cover art present');
}

test('synthetic fragmented MP4 (video + audio)', async () => {
  const src = join(dir, 'frag.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30000/1001:d=12',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=12',
    '-c:v', 'libx264', '-bf', '2', '-g', '60', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+default_base_moof', '-frag_duration', '2000000', src]);
  const dst = join(dir, 'frag-out.m4v');
  const { duration } = await convert(src, dst);
  assert.ok(duration > 11 && duration < 13);
  checkOutput(src, dst);
  checkTags(dst);
});

test('plain (non-fragmented) MP4 passes through too', async () => {
  const src = join(dir, 'plain.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=3', '-c:v', 'libx264', src]);
  const dst = join(dir, 'plain-out.m4v');
  await convert(src, dst);
  checkOutput(src, dst);
});

test('truncated download is rejected', async () => {
  const src = join(dir, 'frag.mp4');
  const blob = await openAsBlob(src);
  const cut = blob.slice(0, Math.floor(blob.size * 0.6));
  const sink = fileSink(join(dir, 'cut.m4v'));
  await assert.rejects(remux(cut.stream(), sink, { metadata: META }), /end of stream|outside any mdat/);
  sink.close();
});

const real = process.env.REMUX_SAMPLE;
test('real Lets.Church download', { skip: !real || !existsSync(real) ? 'set REMUX_SAMPLE to run' : false }, async () => {
  const dst = join(dir, 'real-out.m4v');
  await convert(real, dst, { audioOnly: !!process.env.REMUX_AUDIO });
  checkOutput(real, dst);
  checkTags(dst);
});

test('scripts/tag.mjs tags a torrent lesson from the catalog', async () => {
  const src = join(dir, 'frag.mp4');
  const outDir = join(dir, 'tagged');
  const catalog = JSON.parse(execFileSync('cat', [new URL('../site/catalog.json', import.meta.url).pathname], { encoding: 'utf8' }));
  const ep = catalog.episodes.find((e) => e.source === 'torrent');
  const out = execFileSync('node', [new URL('../scripts/tag.mjs', import.meta.url).pathname, '--lesson', String(ep.lesson), '--title', 'Where Is Joseph', src, outDir], { encoding: 'utf8' }).trim();
  assert.match(out, new RegExp(`S01E\\d+ - Lesson ${ep.lesson} - Where Is Joseph\\.m4v$`));
  const tags = probe(out, ['-show_entries', 'format_tags']).format.tags;
  assert.equal(tags.show, 'Aleph with Beth');
  assert.equal(tags.episode_sort, String(ep.episode));
  assert.equal(tags.title, `Lesson ${ep.lesson} – Where Is Joseph`);
});
