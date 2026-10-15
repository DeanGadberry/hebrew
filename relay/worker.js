// Cloudflare Worker: a pass-through relay between the static page and Lets.Church.
//
// Lets.Church doesn't send CORS headers, so a page hosted elsewhere can't read
// its files directly. This Worker fetches them on the browser's behalf and
// streams them straight back — nothing is stored. It only talks to Lets.Church,
// only for Aleph with Beth media, and only answers pages listed in ALLOWED_ORIGINS.
//
//   GET /v1/file/:mediaId/:kind   kind = VIDEO_1080P | VIDEO_4K | AUDIO
//   GET /v1/art/:mediaId          1280×720 JPEG thumbnail (cover art)
//   GET /v1/ia/:item/:file        a file from an allow-listed Internet Archive item
//                                 (fills lessons Lets.Church doesn't have)
//   GET /v1/health

const API = 'https://lets.church/trpc/media.getMediaById';
const CHANNEL = 'AlephwithBeth';
const KINDS = new Set(['VIDEO_1080P', 'VIDEO_4K', 'AUDIO']);
const ID_RE = /^[A-Za-z0-9]{10,32}$/;
const UPSTREAM_HOSTS = new Set(['download.letschurch.cloud', 'images.letschurch.cloud', 'archive.org']);
const ARCHIVE_ITEMS = new Set(['aleph-with-beth-lessons-1-66-1080p']);
const ARCHIVE_FILE_RE = /\.(mp4|jpg)$/i;
const USER_AGENT = 'aleph-with-beth-offline-relay/1.0 (+https://github.com/DeanGadberry/hebrew)';

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return origin || '*';
  return origin && list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, X-Media-Title',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(origin ? corsHeaders(origin) : {}) },
  });
}

async function getMedia(mediaId) {
  const url = `${API}?input=${encodeURIComponent(JSON.stringify({ json: { mediaId } }))}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Lets.Church lookup failed (${res.status})`);
  const media = (await res.json())?.result?.data?.json;
  if (!media) throw new HttpError(404, 'Media not found');
  if (media.channel?.slug !== CHANNEL) throw new HttpError(403, 'Only Aleph with Beth media is relayed');
  return media;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function upstreamUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !UPSTREAM_HOSTS.has(url.hostname)) throw new HttpError(502, 'Unexpected upstream host');
  return url;
}

async function relay(upstream, origin, extraHeaders = {}) {
  if (!upstream.ok || !upstream.body) throw new HttpError(502, `Lets.Church returned ${upstream.status}`);
  const headers = new Headers(corsHeaders(origin));
  for (const h of ['Content-Type', 'Content-Length']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(upstream.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, origin);
    if (url.pathname === '/v1/health') return json({ ok: true }, 200, origin);
    if (!origin) return json({ error: 'This relay only serves the Aleph with Beth offline page' }, 403, null);

    try {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'v1' && parts[1] === 'file' && parts.length === 4) {
        const [, , mediaId, kind] = parts;
        if (!ID_RE.test(mediaId) || !KINDS.has(kind)) throw new HttpError(400, 'Bad media id or kind');
        const media = await getMedia(mediaId);
        if (!media.downloadsEnabled) throw new HttpError(403, 'Downloads are disabled for this video');
        const entry = (media.downloadUrls || []).find((d) => d.kind === kind);
        if (!entry) throw new HttpError(404, `No ${kind} download for this video`);
        const upstream = await fetch(upstreamUrl(entry.url), { headers: { 'User-Agent': USER_AGENT } });
        return relay(upstream, origin, { 'X-Media-Title': encodeURIComponent(media.title || '') });
      }
      if (parts[0] === 'v1' && parts[1] === 'art' && parts.length === 3) {
        const mediaId = parts[2];
        if (!ID_RE.test(mediaId)) throw new HttpError(400, 'Bad media id');
        const media = await getMedia(mediaId);
        const art = media.fullSizeThumbnailUrl || media.posterThumbnailUrl || media.thumbnailUrl;
        if (!art) throw new HttpError(404, 'No artwork');
        // The image service picks the format from Accept; Apple's tags want JPEG or PNG.
        const upstream = await fetch(upstreamUrl(art), { headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg,image/png;q=0.9' } });
        return relay(upstream, origin);
      }
      if (parts[0] === 'v1' && parts[1] === 'ia' && parts.length >= 4) {
        const item = decodeURIComponent(parts[2]);
        const file = parts.slice(3).map(decodeURIComponent).join('/');
        if (!ARCHIVE_ITEMS.has(item) || !ARCHIVE_FILE_RE.test(file) || file.split('/').includes('..')) {
          throw new HttpError(403, 'Only Aleph with Beth files on the Internet Archive are relayed');
        }
        const path = [item, ...file.split('/')].map(encodeURIComponent).join('/');
        // archive.org redirects to a storage node; fetch follows it.
        const upstream = await fetch(upstreamUrl(`https://archive.org/download/${path}`), { headers: { 'User-Agent': USER_AGENT } });
        return relay(upstream, origin);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      return json({ error: err.message || 'Relay error' }, status, origin);
    }
  },
};
