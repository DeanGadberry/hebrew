// Streaming MP4 rewriter: fragmented MP4 in, standard (non-fragmented) MP4 out,
// with iTunes-style metadata (TV show / episode tags, artwork) added.
//
// Lets.Church serves downloads as fragmented MP4 generated on the fly. Apple's
// TV app and most players handle a plain MP4 with full sample tables best, so
// we copy every mdat payload through untouched and rebuild the moov at the end.
// Works in browsers and Node (uses only Web Streams + typed arrays).
//
// Output layout: ftyp | mdat (64-bit size, patched at the end) | moov
//
// sink: { write(Uint8Array): Promise|void, writeAt(position, Uint8Array): Promise|void }

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'udta']);

// ---------------------------------------------------------------------------
// Byte helpers

function fourcc(s) {
  // latin1, so '©nam' becomes A9 6E 61 6D
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function typeOf(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; }

function box(type, ...payload) {
  const body = concat(payload);
  return concat([u32(body.length + 8), fourcc(type), body]);
}

function fullBox(type, version, flags, ...payload) {
  return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);
}

// Parse a box buffer into a tree: { type, data (whole box), children? }
function parseBoxes(bytes, start = 0, end = bytes.length) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off);
    let size = dv.getUint32(0);
    const type = typeOf(bytes, off + 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) throw new Error(`Malformed box ${type} at ${off}`);
    const node = { type, data: bytes.subarray(off, off + size), header };
    if (CONTAINERS.has(type)) node.children = parseBoxes(bytes, off + header, off + size);
    out.push(node);
    off += size;
  }
  return out;
}

function find(nodes, path) {
  let cur = nodes;
  let node = null;
  for (const t of path.split('/')) {
    node = (cur || []).find((n) => n.type === t);
    if (!node) return null;
    cur = node.children;
  }
  return node;
}

function serialize(node) {
  if (!node.children) return node.data;
  return box(node.type, ...node.children.map(serialize));
}

function payloadView(node) {
  const p = node.data.subarray(node.header);
  return { p, dv: new DataView(p.buffer, p.byteOffset, p.byteLength) };
}

// ---------------------------------------------------------------------------
// Stream reader

class ByteReader {
  constructor(stream, onBytes) {
    this.reader = stream.getReader();
    this.queue = [];
    this.buffered = 0;
    this.done = false;
    this.position = 0; // absolute offset of the next unread byte
    this.onBytes = onBytes;
  }

  async fill(n) {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) { this.done = true; break; }
      if (value && value.length) {
        this.queue.push(value);
        this.buffered += value.length;
        if (this.onBytes) this.onBytes(value.length);
      }
    }
    return this.buffered >= n;
  }

  take(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const head = this.queue[0];
      const k = Math.min(head.length, n - o);
      out.set(head.subarray(0, k), o);
      o += k;
      if (k === head.length) this.queue.shift(); else this.queue[0] = head.subarray(k);
    }
    this.buffered -= n;
    this.position += n;
    return out;
  }

  async read(n) {
    if (!(await this.fill(n))) {
      if (this.buffered === 0 && n > 0) return null;
      throw new Error('Unexpected end of stream (download cut off?)');
    }
    return this.take(n);
  }

  // Hand the next n bytes (or everything until EOF if n is Infinity) to fn in pieces.
  async pipe(n, fn) {
    let copied = 0;
    while (copied < n) {
      if (this.buffered === 0) {
        await this.fill(1);
        if (this.buffered === 0) {
          if (n === Infinity) return copied;
          throw new Error('Unexpected end of stream (download cut off?)');
        }
      }
      const head = this.queue[0];
      const k = Math.min(head.length, n - copied);
      const piece = head.subarray(0, k);
      if (k === head.length) this.queue.shift(); else this.queue[0] = head.subarray(k);
      this.buffered -= k;
      this.position += k;
      copied += k;
      await fn(piece);
    }
    return copied;
  }

  async skip(n) { await this.pipe(n, () => {}); }

  cancel() { try { this.reader.cancel(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Sample bookkeeping

class Track {
  constructor(trak) {
    this.trak = trak;
    const tkhd = payloadView(find([trak], 'trak/tkhd'));
    this.id = tkhd.dv.getUint32(tkhd.p[0] === 1 ? 20 : 12);
    const mdhd = payloadView(find([trak], 'trak/mdia/mdhd'));
    this.timescale = mdhd.dv.getUint32(mdhd.p[0] === 1 ? 20 : 12);
    const hdlr = payloadView(find([trak], 'trak/mdia/hdlr'));
    this.handler = typeOf(hdlr.p, 8);
    this.sizes = [];
    this.durations = [];
    this.ctos = [];
    this.nonSync = []; // 1-based indexes of non-sync samples
    this.chunks = []; // { src: absolute source offset, count }
    this.trex = { sdi: 1, duration: 0, size: 0, flags: 0 };
  }

  get sampleCount() { return this.sizes.length; }

  addSample(size, duration, cto, sync) {
    this.sizes.push(size);
    this.durations.push(duration);
    this.ctos.push(cto);
    if (!sync) this.nonSync.push(this.sizes.length);
  }

  // Expand the sample tables already present in the moov (some fragmented files
  // carry their first segment there).
  loadInitialSamples() {
    const stbl = find([this.trak], 'trak/mdia/minf/stbl');
    const get = (t) => stbl.children.find((n) => n.type === t);

    const stsz = get('stsz') || get('stz2');
    if (!stsz) return;
    const sz = payloadView(stsz);
    let sizes;
    if (stsz.type === 'stsz') {
      const constant = sz.dv.getUint32(4);
      const count = sz.dv.getUint32(8);
      sizes = new Array(count);
      for (let i = 0; i < count; i++) sizes[i] = constant || sz.dv.getUint32(12 + i * 4);
    } else {
      throw new Error('stz2 sample tables are not supported');
    }
    const count = sizes.length;
    if (!count) return;

    const durations = [];
    const st = payloadView(get('stts'));
    for (let i = 0, e = st.dv.getUint32(4); i < e; i++) {
      const n = st.dv.getUint32(8 + i * 8);
      const d = st.dv.getUint32(12 + i * 8);
      for (let k = 0; k < n; k++) durations.push(d);
    }

    const ctos = new Array(count).fill(0);
    const ctts = get('ctts');
    if (ctts) {
      const c = payloadView(ctts);
      let s = 0;
      for (let i = 0, e = c.dv.getUint32(4); i < e; i++) {
        const n = c.dv.getUint32(8 + i * 8);
        const v = c.p[0] === 1 ? c.dv.getInt32(12 + i * 8) : c.dv.getUint32(12 + i * 8);
        for (let k = 0; k < n && s < count; k++) ctos[s++] = v;
      }
    }

    let syncSet = null;
    const stss = get('stss');
    if (stss) {
      const s = payloadView(stss);
      syncSet = new Set();
      for (let i = 0, e = s.dv.getUint32(4); i < e; i++) syncSet.add(s.dv.getUint32(8 + i * 4));
    }

    for (let i = 0; i < count; i++) {
      this.addSample(sizes[i], durations[i] ?? durations[durations.length - 1] ?? 0, ctos[i], !syncSet || syncSet.has(i + 1));
    }

    // chunk offsets
    const offsets = [];
    const stco = get('stco');
    const co64 = get('co64');
    if (stco) {
      const c = payloadView(stco);
      for (let i = 0, e = c.dv.getUint32(4); i < e; i++) offsets.push(c.dv.getUint32(8 + i * 4));
    } else if (co64) {
      const c = payloadView(co64);
      for (let i = 0, e = c.dv.getUint32(4); i < e; i++) offsets.push(Number(c.dv.getBigUint64(8 + i * 8)));
    }
    const stsc = payloadView(get('stsc'));
    const entries = [];
    for (let i = 0, e = stsc.dv.getUint32(4); i < e; i++) {
      entries.push({ first: stsc.dv.getUint32(8 + i * 12), spc: stsc.dv.getUint32(12 + i * 12) });
    }
    let remaining = count;
    for (let c = 0; c < offsets.length && remaining > 0; c++) {
      let spc = 0;
      for (const e of entries) if (e.first <= c + 1) spc = e.spc;
      spc = Math.min(spc, remaining);
      this.chunks.push({ src: offsets[c], count: spc });
      remaining -= spc;
    }
    if (remaining > 0) throw new Error('Sample table describes more samples than its chunks hold');
  }
}

function parseMoof(moofBytes, moofStart, tracks) {
  const [moof] = parseBoxes(moofBytes);
  let prevEnd = moofStart;
  for (const traf of moof.children.filter((n) => n.type === 'traf')) {
    const tfhd = payloadView(traf.children.find((n) => n.type === 'tfhd'));
    const flags = (tfhd.p[1] << 16) | (tfhd.p[2] << 8) | tfhd.p[3];
    const trackId = tfhd.dv.getUint32(4);
    const track = tracks.get(trackId);
    if (!track) throw new Error(`Fragment for unknown track ${trackId}`);
    let o = 8;
    let base;
    if (flags & 0x1) { base = Number(tfhd.dv.getBigUint64(o)); o += 8; } else if (flags & 0x20000) base = moofStart; else base = prevEnd;
    if (flags & 0x2) o += 4; // sample description index: single stsd entry assumed
    const defDur = flags & 0x8 ? tfhd.dv.getUint32((o += 4) - 4) : track.trex.duration;
    const defSize = flags & 0x10 ? tfhd.dv.getUint32((o += 4) - 4) : track.trex.size;
    const defFlags = flags & 0x20 ? tfhd.dv.getUint32((o += 4) - 4) : track.trex.flags;

    let next = base;
    for (const trun of traf.children.filter((n) => n.type === 'trun')) {
      const t = payloadView(trun);
      const v = t.p[0];
      const tf = (t.p[1] << 16) | (t.p[2] << 8) | t.p[3];
      const count = t.dv.getUint32(4);
      let q = 8;
      let start = next;
      if (tf & 0x1) { start = base + t.dv.getInt32(q); q += 4; }
      let firstFlags = null;
      if (tf & 0x4) { firstFlags = t.dv.getUint32(q); q += 4; }
      let bytes = 0;
      for (let i = 0; i < count; i++) {
        const dur = tf & 0x100 ? t.dv.getUint32((q += 4) - 4) : defDur;
        const size = tf & 0x200 ? t.dv.getUint32((q += 4) - 4) : defSize;
        let sflags = tf & 0x400 ? t.dv.getUint32((q += 4) - 4) : defFlags;
        if (i === 0 && firstFlags !== null) sflags = firstFlags;
        let cto = 0;
        if (tf & 0x800) { cto = v === 1 ? t.dv.getInt32(q) : t.dv.getUint32(q); q += 4; }
        track.addSample(size, dur, cto, !(sflags & 0x10000));
        bytes += size;
      }
      if (count) track.chunks.push({ src: start, count });
      next = start + bytes;
    }
    prevEnd = next;
  }
}

// ---------------------------------------------------------------------------
// moov rebuild

function runLength(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++; else out.push([1, v]);
  }
  return out;
}

// Pack rows of 32-bit values into one buffer (tables can have 100k+ rows,
// too many to pass around as separate arguments).
function u32Table(rows, width) {
  const out = new Uint8Array(4 + rows.length * width * 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, rows.length);
  let o = 4;
  for (const row of rows) {
    for (let k = 0; k < width; k++) { dv.setUint32(o, (width === 1 ? row : row[k]) >>> 0); o += 4; }
  }
  return out;
}

function buildStbl(track, stsd, outOffsets) {
  const parts = [stsd.data];

  const stts = runLength(track.durations);
  parts.push(fullBox('stts', 0, 0, u32Table(stts, 2)));

  if (track.ctos.some((c) => c !== 0)) {
    const ctts = runLength(track.ctos);
    const negative = track.ctos.some((c) => c < 0);
    parts.push(fullBox('ctts', negative ? 1 : 0, 0, u32Table(ctts, 2)));
  }

  if (track.nonSync.length) {
    const nonSync = new Set(track.nonSync);
    const sync = [];
    for (let i = 1; i <= track.sampleCount; i++) if (!nonSync.has(i)) sync.push(i);
    parts.push(fullBox('stss', 0, 0, u32Table(sync, 1)));
  }

  const stsc = [];
  track.chunks.forEach((c, i) => {
    if (!stsc.length || stsc[stsc.length - 1][1] !== c.count) stsc.push([i + 1, c.count]);
  });
  parts.push(fullBox('stsc', 0, 0, u32Table(stsc.map(([first, n]) => [first, n, 1]), 3)));

  const constant = track.sizes.every((s) => s === track.sizes[0]) ? track.sizes[0] || 0 : 0;
  if (constant) {
    parts.push(fullBox('stsz', 0, 0, u32(constant), u32(track.sampleCount)));
  } else {
    const table = new Uint8Array(track.sampleCount * 4);
    const dv = new DataView(table.buffer);
    track.sizes.forEach((s, i) => dv.setUint32(i * 4, s));
    parts.push(fullBox('stsz', 0, 0, u32(0), u32(track.sampleCount), table));
  }

  const co = new Uint8Array(outOffsets.length * 8);
  const cdv = new DataView(co.buffer);
  outOffsets.forEach((o, i) => cdv.setBigUint64(i * 8, BigInt(o)));
  parts.push(fullBox('co64', 0, 0, u32(outOffsets.length), co));

  return box('stbl', ...parts);
}

// Overwrite the duration field of mvhd/mdhd/tkhd in a copy of the box.
function withDuration(node, duration) {
  const data = node.data.slice();
  const dv = new DataView(data.buffer);
  const h = node.header;
  const v = data[h];
  let off;
  if (node.type === 'tkhd') off = h + (v === 1 ? 28 : 20);
  else off = h + (v === 1 ? 24 : 16);
  if (v === 1) dv.setBigUint64(off, BigInt(duration));
  else dv.setUint32(off, Math.min(duration, 0xffffffff));
  return { ...node, data };
}

function withEditDuration(edts, duration) {
  const elst = edts.children.find((n) => n.type === 'elst');
  if (!elst) return edts;
  const data = elst.data.slice();
  const dv = new DataView(data.buffer);
  const h = elst.header;
  const v = data[h];
  if (dv.getUint32(h + 4) !== 1) return edts; // only single-entry lists are adjusted
  if (v === 1) dv.setBigUint64(h + 8, BigInt(duration)); else dv.setUint32(h + 8, Math.min(duration, 0xffffffff));
  return { ...edts, children: [{ ...elst, data }] };
}

// ---------------------------------------------------------------------------
// iTunes metadata (moov/udta/meta/ilst)

function dataAtom(kind, payload) {
  return box('data', u32(kind), u32(0), payload);
}

const utf8 = (s) => new TextEncoder().encode(s);
const textItem = (type, s) => box(type, dataAtom(1, utf8(String(s))));
const int32Item = (type, n) => box(type, dataAtom(21, u32(n)));
const int8Item = (type, n) => box(type, dataAtom(21, new Uint8Array([n])));

export const MEDIA_KIND = { music: 1, audiobook: 2, musicVideo: 6, movie: 9, tvShow: 10, podcast: 21 };

export function buildIlst(meta = {}) {
  const items = [];
  if (meta.title) items.push(textItem('©nam', meta.title));
  if (meta.artist) items.push(textItem('©ART', meta.artist));
  if (meta.albumArtist) items.push(textItem('aART', meta.albumArtist));
  if (meta.album) items.push(textItem('©alb', meta.album));
  if (meta.genre) items.push(textItem('©gen', meta.genre));
  if (meta.date) items.push(textItem('©day', meta.date));
  if (meta.comment) items.push(textItem('©cmt', meta.comment));
  if (meta.track) {
    const t = new Uint8Array(8);
    const dv = new DataView(t.buffer);
    dv.setUint16(2, meta.track);
    dv.setUint16(4, meta.trackTotal || 0);
    items.push(box('trkn', dataAtom(0, t)));
  }
  if (meta.mediaKind != null) items.push(int8Item('stik', meta.mediaKind));
  if (meta.show) items.push(textItem('tvsh', meta.show));
  if (meta.showSort) items.push(textItem('sosn', meta.showSort));
  if (meta.season != null) items.push(int32Item('tvsn', meta.season));
  if (meta.episode != null) items.push(int32Item('tves', meta.episode));
  if (meta.episodeId) items.push(textItem('tven', meta.episodeId));
  if (meta.network) items.push(textItem('tvnn', meta.network));
  if (meta.hdVideo != null) items.push(int8Item('hdvd', meta.hdVideo));
  if (meta.description) items.push(textItem('desc', meta.description.slice(0, 255)));
  if (meta.longDescription) items.push(textItem('ldes', meta.longDescription));
  if (meta.copyright) items.push(textItem('cprt', meta.copyright));
  if (meta.encoder) items.push(textItem('©too', meta.encoder));
  if (meta.artwork && meta.artwork.length) {
    const png = meta.artwork[0] === 0x89 && meta.artwork[1] === 0x50;
    items.push(box('covr', dataAtom(png ? 14 : 13, meta.artwork)));
  }
  const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('mdir'), fourcc('appl'), u32(0), u32(0), new Uint8Array([0]));
  return box('udta', fullBox('meta', 0, 0, hdlr, box('ilst', ...items)));
}

// ---------------------------------------------------------------------------
// Main entry point

/**
 * @param {ReadableStream<Uint8Array>} stream source MP4 (fragmented or not)
 * @param {{write: Function, writeAt: Function}} sink
 * @param {{metadata?: object, audioOnly?: boolean, onProgress?: (bytesRead:number)=>void}} options
 * @returns {Promise<{bytesWritten:number, duration:number}>}
 */
export async function remux(stream, sink, options = {}) {
  let bytesRead = 0;
  const reader = new ByteReader(stream, (n) => {
    bytesRead += n;
    if (options.onProgress) options.onProgress(bytesRead);
  });

  let moov = null;
  const tracks = new Map();
  const mdats = []; // { srcStart, srcEnd, outStart } for payload bytes
  let out = 0;
  const write = async (bytes) => { await sink.write(bytes); out += bytes.length; };

  const audio = !!options.audioOnly;
  const ftyp = box('ftyp', fourcc(audio ? 'M4A ' : 'M4V '), u32(0), ...(audio ? ['M4A ', 'mp42', 'isom'] : ['M4V ', 'M4A ', 'mp42', 'isom']).map(fourcc));
  await write(ftyp);
  const mdatHeaderPos = out;
  await write(concat([u32(1), fourcc('mdat'), u64(0)]));

  try {
    for (;;) {
      const boxStart = reader.position;
      const head = await reader.read(8);
      if (!head) break;
      const dv = new DataView(head.buffer);
      let size = dv.getUint32(0);
      const type = typeOf(head, 4);
      let headerBytes = head;
      if (size === 1) {
        const ext = await reader.read(8);
        size = Number(new DataView(ext.buffer).getBigUint64(0));
        headerBytes = concat([head, ext]);
      }
      const toEnd = size === 0;
      const bodyLen = toEnd ? Infinity : size - headerBytes.length;
      if (bodyLen < 0) throw new Error(`Malformed box ${type}`);

      if (type === 'mdat') {
        const srcStart = reader.position;
        const outStart = out;
        const n = await reader.pipe(bodyLen, write);
        mdats.push({ srcStart, srcEnd: srcStart + n, outStart });
      } else if (type === 'moov' || type === 'moof') {
        if (bodyLen > 64 * 1024 * 1024) throw new Error(`${type} box is unreasonably large`);
        const body = await reader.read(bodyLen);
        const whole = concat([headerBytes, body]);
        if (type === 'moov') {
          [moov] = parseBoxes(whole);
          for (const trak of moov.children.filter((n) => n.type === 'trak')) {
            const t = new Track(trak);
            tracks.set(t.id, t);
          }
          for (const trex of (find([moov], 'moov/mvex')?.children || []).filter((n) => n.type === 'trex')) {
            const { dv: x } = payloadView(trex);
            const t = tracks.get(x.getUint32(4));
            if (t) t.trex = { sdi: x.getUint32(8), duration: x.getUint32(12), size: x.getUint32(16), flags: x.getUint32(20) };
          }
          for (const t of tracks.values()) t.loadInitialSamples();
        } else {
          if (!moov) throw new Error('Fragment found before the movie header');
          parseMoof(whole, boxStart, tracks);
        }
      } else if (toEnd) {
        break;
      } else {
        await reader.skip(bodyLen);
      }
    }
  } finally {
    reader.cancel();
  }

  if (!moov) throw new Error('No movie header (moov) found — is this an MP4?');

  // Map source chunk offsets to output offsets.
  const locate = (src, len) => {
    for (const m of mdats) {
      if (src >= m.srcStart && src + len <= m.srcEnd) return m.outStart + (src - m.srcStart);
    }
    throw new Error('Sample data lies outside any mdat (truncated download?)');
  };

  // Build the new moov.
  const mvhdNode = moov.children.find((n) => n.type === 'mvhd');
  const movieTimescale = payloadView(mvhdNode).dv.getUint32(mvhdNode.data[mvhdNode.header] === 1 ? 20 : 12);
  let movieDuration = 0;
  const trakBoxes = [];
  for (const track of tracks.values()) {
    if (!track.sampleCount) continue;
    let idx = 0;
    const outOffsets = track.chunks.map((c) => {
      let len = 0;
      for (let i = 0; i < c.count; i++) len += track.sizes[idx + i];
      idx += c.count;
      return locate(c.src, len);
    });
    const mediaDuration = track.durations.reduce((a, b) => a + b, 0);
    const trackDuration = Math.round((mediaDuration * movieTimescale) / track.timescale);
    movieDuration = Math.max(movieDuration, trackDuration);

    const stbl = find([track.trak], 'trak/mdia/minf/stbl');
    const stsd = stbl.children.find((n) => n.type === 'stsd');
    const newStbl = buildStbl(track, stsd, outOffsets);
    const rebuild = (node) => {
      if (node.type === 'stbl') return newStbl;
      if (node.type === 'tkhd') return serialize(withDuration(node, trackDuration));
      if (node.type === 'mdhd') return serialize(withDuration(node, mediaDuration));
      if (node.type === 'edts') return serialize(withEditDuration(node, trackDuration));
      if (!node.children) return node.data;
      return box(node.type, ...node.children.map(rebuild));
    };
    trakBoxes.push(rebuild(track.trak));
  }
  if (!trakBoxes.length) throw new Error('The file contains no samples');

  const newMoov = box(
    'moov',
    serialize(withDuration(mvhdNode, movieDuration)),
    ...trakBoxes,
    buildIlst(options.metadata),
  );
  const mdatSize = out - mdatHeaderPos;
  await write(newMoov);

  // Patch the mdat size (64-bit) now that we know it.
  await sink.writeAt(mdatHeaderPos + 8, u64(mdatSize));

  return { bytesWritten: out, duration: movieDuration / movieTimescale };
}
