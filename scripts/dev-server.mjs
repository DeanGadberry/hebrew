// Local preview: serves site/ on :8000 and runs relay/worker.js on :8787,
// so the page can be tried end to end without deploying anything.
//
//   node scripts/dev-server.mjs
//   open http://localhost:8000/?relay=http://localhost:8787

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import worker from '../relay/worker.js';

const SITE = new URL('../site/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const env = { ALLOWED_ORIGINS: 'http://localhost:8000,http://127.0.0.1:8000' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(SITE, path.endsWith('/') ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(8000, () => console.log('site   http://localhost:8000/?relay=http://localhost:8787'));

createServer(async (req, res) => {
  const request = new Request(new URL(req.url, 'http://localhost:8787'), { method: req.method, headers: req.headers });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
}).listen(8787, () => console.log('relay  http://localhost:8787/v1/health'));
