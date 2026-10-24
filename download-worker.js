// Runs one download at a time off the main thread:
// relay → remux (fragmented MP4 → tagged MP4) → file on disk.
//
// Two places a file can go:
//   dir  — a folder the user picked (Chrome/Edge): written there directly.
//   opfs — the browser's private storage (Safari/Firefox, or no folder picked);
//          the page then hands the finished file to the browser's Downloads.

import { remux } from './remux.js';

const FLUSH_BYTES = 8 * 1024 * 1024;
const controllers = new Map();

// Coalesce the many small network chunks into large disk writes.
function buffered(raw) {
  let pending = [];
  let pendingBytes = 0;
  let position = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const block = new Uint8Array(pendingBytes);
    let o = 0;
    for (const p of pending) { block.set(p, o); o += p.length; }
    pending = [];
    pendingBytes = 0;
    await raw.writeAt(position, block);
    position += block.length;
  };
  return {
    async write(bytes) {
      pending.push(bytes.slice());
      pendingBytes += bytes.length;
      if (pendingBytes >= FLUSH_BYTES) await flush();
    },
    async writeAt(pos, bytes) { await flush(); await raw.writeAt(pos, bytes); },
    async close() { await flush(); await raw.close(); },
    async abort() { pending = []; await raw.abort(); },
  };
}

async function openTarget(target, filename) {
  if (target.mode === 'dir') {
    const handle = await target.handle.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    return buffered({
      writeAt: (position, data) => writable.write({ type: 'write', position, data }),
      close: () => writable.close(),
      abort: () => writable.abort(),
    });
  }
  // Private storage is picky about names (Chromium rejects non-ASCII), so use the
  // plain internal name the page gave us; the real name is applied on hand-off.
  const root = await navigator.storage.getDirectory();
  const name = target.tempName;
  const handle = await root.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  return buffered({
    writeAt: (at, data) => {
      const n = access.write(data, { at });
      if (n !== data.length) throw new Error('Not enough disk space in browser storage');
    },
    close: () => { access.flush(); access.close(); },
    abort: async () => { access.close(); await root.removeEntry(name).catch(() => {}); },
  });
}

async function fetchArtwork(url, signal) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (jpeg || png) return bytes;
    // Some other format (e.g. WebP): re-encode as JPEG.
    if (typeof OffscreenCanvas === 'undefined') return null;
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch (err) {
    if (signal.aborted) throw err;
    return null; // artwork is nice to have, never fatal
  }
}

async function run(job, target) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const { signal } = controller;
  let sink = null;
  try {
    const artwork = await fetchArtwork(job.artUrl, signal);
    const res = await fetch(job.fileUrl, { signal });
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = (await res.json()).error; } catch { /* not JSON */ }
      throw new Error(detail || `Download failed (HTTP ${res.status})`);
    }
    sink = await openTarget(target, job.filename);
    let last = 0;
    const result = await remux(res.body, sink, {
      audioOnly: job.audioOnly,
      metadata: { ...job.metadata, artwork },
      onProgress: (bytes) => {
        const now = Date.now();
        if (now - last > 250) { last = now; postMessage({ type: 'progress', id: job.id, bytes }); }
      },
    });
    await sink.close();
    sink = null;
    postMessage({ type: 'done', id: job.id, bytes: result.bytesWritten, mode: target.mode });
  } catch (err) {
    if (sink) await sink.abort().catch(() => {});
    let message = signal.aborted ? 'Cancelled' : (err && err.message) || String(err);
    // fetch() reports an unreachable host (before any response) as a TypeError.
    const relayUnreachable = !signal.aborted && !sink && err instanceof TypeError;
    if (relayUnreachable) message = 'Couldn’t reach the relay — check the address under Settings, or try again';
    postMessage({ type: 'error', id: job.id, message, cancelled: signal.aborted, relayUnreachable });
  } finally {
    controllers.delete(job.id);
  }
}

onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'start') run(msg.job, msg.target);
  if (msg.type === 'cancel') controllers.get(msg.id)?.abort();
};
