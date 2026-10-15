import { RELAY_URL, REPO_URL } from './config.js';
import { QUALITY, qualityFor as baseQualityFor, episodeFilename, episodeMetadata } from './episodes.js';

const qualityFor = (ep, quality = state.quality) => baseQualityFor(ep, quality);
const filenameFor = (ep, quality) => episodeFilename(state.catalog, ep, quality);
const metadataFor = (ep, quality) => episodeMetadata(state.catalog, ep, quality);

function sourceUrls(ep, quality) {
  const relay = relayUrl();
  if (ep.source === 'archive') {
    const path = (file) => file.split('/').map(encodeURIComponent).join('/');
    const { item, file, thumb } = ep.archive;
    return {
      fileUrl: `${relay}/v1/ia/${encodeURIComponent(item)}/${path(file)}`,
      artUrl: thumb ? `${relay}/v1/ia/${encodeURIComponent(item)}/${path(thumb)}` : null,
    };
  }
  return { fileUrl: `${relay}/v1/file/${ep.id}/${quality}`, artUrl: `${relay}/v1/art/${ep.id}` };
}

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const state = {
  catalog: null,
  season: store.get('season', 1),
  quality: store.get('quality', 'VIDEO_1080P'),
  search: '',
  selected: new Set(), // episode ids
  lastClicked: null,
  saved: store.get('saved', {}), // { [quality]: [ids] }
  folder: null, // FileSystemDirectoryHandle (Chrome/Edge)
  queue: [], // jobs
  running: null,
};

const canPickFolder = typeof window.showDirectoryPicker === 'function';

function relayUrl() {
  const fromQuery = new URLSearchParams(location.search).get('relay');
  if (fromQuery) store.set('relay', fromQuery);
  return (store.get('relay', '') || RELAY_URL || '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Formatting

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function fmtSize(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}

function estimateMb(ep, quality = state.quality) {
  if (ep.size) return ep.size / 1048576;
  return (ep.duration / 60) * QUALITY[qualityFor(ep, quality)].mbPerMin;
}

// ---------------------------------------------------------------------------
// Rendering

// Search ignores case, accents and Hebrew vowel points / cantillation, so
// "דברים", "דְּבָרִים" and "introduccion" all match.
function fold(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f\u0591-\u05c7]/g, '').toLowerCase();
}

function visibleEpisodes() {
  const q = fold(state.search.trim());
  return state.catalog.episodes.filter((ep) => {
    if (q) return fold(ep.title).includes(q) || fold(ep.label || '') === q || String(ep.episode) === q;
    return ep.season === state.season;
  });
}

function isSaved(id) { return (state.saved[state.quality] || []).includes(id); }

function renderSeasons() {
  const el = $('seasons');
  el.replaceChildren(...state.catalog.seasons.map((s) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(s.number === state.season && !state.search));
    b.innerHTML = `${s.name}<span class="count">${s.count}</span>`;
    b.addEventListener('click', () => {
      state.season = s.number;
      state.search = '';
      $('search').value = '';
      store.set('season', s.number);
      render();
    });
    return b;
  }));
}

function renderEpisodes() {
  const list = visibleEpisodes();
  const frag = document.createDocumentFragment();
  for (const ep of list) {
    const li = document.createElement('li');
    li.className = 'ep' + (state.selected.has(ep.id) ? ' selected' : '');
    li.dataset.id = ep.id;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.selected.has(ep.id);
    box.setAttribute('aria-label', `Select ${ep.title}`);

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    if (ep.thumbnail) img.src = ep.thumbnail;

    const text = document.createElement('div');
    const season = state.catalog.seasons.find((s) => s.number === ep.season);
    text.innerHTML = '<div class="num"></div><div class="title"></div><div class="desc"></div>';
    text.children[0].textContent = `${state.search ? `${season.name} · ` : ''}Episode ${ep.episode}`;
    text.children[1].textContent = ep.title;
    text.children[2].textContent = ep.description;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `${fmtDuration(ep.duration)}<br>~${fmtSize(estimateMb(ep))}`;
    if (ep.source === 'torrent') {
      meta.innerHTML = '<span class="badge" title="Only in the creators’ torrent; fetched by a GitHub workflow">Torrent · via GitHub</span>';
    }
    if (ep.source === 'archive') {
      meta.insertAdjacentHTML('beforeend', '<br><span class="badge" title="Not on Lets.Church; downloaded from the Internet Archive as 720p video">Internet Archive · 720p</span>');
    }
    if (isSaved(ep.id)) meta.insertAdjacentHTML('beforeend', '<br><span class="saved">✓ saved</span>');

    li.append(box, img, text, meta);
    li.addEventListener('click', (e) => toggle(ep.id, e.shiftKey, e.target === box ? box.checked : !state.selected.has(ep.id)));
    frag.append(li);
  }
  $('episodes').replaceChildren(frag);
  $('empty').hidden = list.length > 0;

  const season = state.catalog.seasons.find((s) => s.number === state.season);
  $('range-to').placeholder = String(season?.count || 20);
}

function renderBar() {
  const eps = state.catalog.episodes.filter((e) => state.selected.has(e.id));
  $('bar').hidden = eps.length === 0;
  $('sel-count').textContent = String(eps.length);
  const mb = eps.reduce((sum, e) => sum + estimateMb(e), 0);
  const min = eps.reduce((sum, e) => sum + e.duration, 0);
  $('sel-size').textContent = `${fmtDuration(min)} · about ${fmtSize(mb)} (${QUALITY[state.quality].label})`;
  $('pick-folder').hidden = !canPickFolder;
  $('pick-folder').textContent = state.folder ? `Folder: ${state.folder.name}` : 'Save to folder…';
}

function render() {
  renderSeasons();
  renderEpisodes();
  renderBar();
}

// ---------------------------------------------------------------------------
// Selection

function toggle(id, shift, on) {
  const list = visibleEpisodes();
  if (shift && state.lastClicked) {
    const a = list.findIndex((e) => e.id === state.lastClicked);
    const b = list.findIndex((e) => e.id === id);
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (on) state.selected.add(list[i].id); else state.selected.delete(list[i].id);
      }
    }
  } else if (on) state.selected.add(id); else state.selected.delete(id);
  state.lastClicked = id;
  renderEpisodes();
  renderBar();
}

function selectWhere(pred) {
  for (const ep of visibleEpisodes()) if (pred(ep)) state.selected.add(ep.id);
  render();
}

// ---------------------------------------------------------------------------
// Downloads

let worker = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./download-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => {
    if (state.running) finishJob(state.running, 'error', e.message || 'The download worker crashed');
  };
  return worker;
}

function renderQueue() {
  $('queue-panel').hidden = state.queue.length === 0;
  const frag = document.createDocumentFragment();
  for (const job of state.queue) {
    const li = document.createElement('li');
    li.className = 'job';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = job.ep.title;
    const status = document.createElement('div');
    status.className = 'status' + (job.state === 'done' ? ' ok' : job.state === 'error' ? ' err' : '');
    status.textContent = job.status;
    li.append(name);
    if (job.state === 'running') {
      const bar = document.createElement('progress');
      bar.max = 1;
      bar.value = Math.min(0.99, job.bytes / (job.estimateMb * 1024 * 1024));
      li.append(bar);
    }
    li.append(status);
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (job.state === 'running' || job.state === 'waiting') {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = 'Cancel';
      b.onclick = () => cancelJob(job);
      actions.append(b);
    }
    if (job.state === 'error') {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Retry';
      b.onclick = () => { job.state = 'waiting'; job.status = 'Waiting…'; job.bytes = 0; renderQueue(); pump(); };
      actions.append(b);
    }
    li.append(actions);
    frag.append(li);
  }
  $('queue').replaceChildren(frag);
}

function cancelJob(job) {
  if (job.state === 'waiting') { finishJob(job, 'error', 'Cancelled'); return; }
  if (job.state === 'running') getWorker().postMessage({ type: 'cancel', id: job.id });
}

async function pump() {
  if (state.running) return;
  const job = state.queue.find((j) => j.state === 'waiting');
  if (!job) return;
  state.running = job;
  job.state = 'running';
  job.status = 'Starting…';
  renderQueue();

  let target = { mode: 'opfs', tempName: `${job.id}-${Date.now()}.part` };
  if (state.folder) {
    target = { mode: 'dir', handle: state.folder };
  } else if (navigator.storage?.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < job.estimateMb * 1.2 * 1024 * 1024) {
      finishJob(job, 'error', 'Not enough browser storage for this file — use “Save to folder…” (Chrome/Edge) or free up disk space');
      return;
    }
  }
  job.tempName = target.tempName;
  getWorker().postMessage({
    type: 'start',
    target,
    job: {
      id: job.id,
      ...sourceUrls(job.ep, job.quality),
      audioOnly: qualityFor(job.ep, job.quality) === 'AUDIO',
      filename: job.filename,
      metadata: metadataFor(job.ep, job.quality),
    },
  });
}

function finishJob(job, result, message) {
  job.state = result;
  job.status = message;
  if (state.running === job) state.running = null;
  renderQueue();
  pump();
}

async function handOff(tempName, filename) {
  // The finished file sits in the browser's private storage; hand it to Downloads.
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(tempName)).getFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    root.removeEntry(tempName).catch(() => {});
  }, 5 * 60 * 1000);
}

async function onWorkerMessage(msg) {
  const job = state.queue.find((j) => j.id === msg.id);
  if (!job) return;
  if (msg.type === 'progress') {
    job.bytes = msg.bytes;
    job.status = `Downloading… ${fmtSize(msg.bytes / 1048576)} of about ${fmtSize(job.estimateMb)}`;
    renderQueue();
  } else if (msg.type === 'done') {
    try {
      if (msg.mode === 'opfs') await handOff(job.tempName, job.filename);
      const list = new Set(state.saved[job.quality] || []);
      list.add(job.ep.id);
      state.saved[job.quality] = [...list];
      store.set('saved', state.saved);
      finishJob(job, 'done', `Saved ${fmtSize(msg.bytes / 1048576)}${msg.mode === 'dir' ? ` to ${state.folder.name}` : ' to Downloads'}`);
      renderEpisodes();
    } catch (err) {
      finishJob(job, 'error', `Could not save: ${err.message}`);
    }
  } else if (msg.type === 'error') {
    finishJob(job, 'error', msg.message);
  }
}

let jobSeq = 0;
function startDownloads() {
  if (!relayUrl()) {
    $('settings').open = true;
    $('relay').focus();
    showNotice('Add the relay address in Settings first (see the README for the one-time setup).', true);
    return;
  }
  const picked = state.catalog.episodes.filter((e) => state.selected.has(e.id));
  const fromTorrent = picked.filter((e) => e.source === 'torrent');
  const eps = picked.filter((e) => e.source !== 'torrent');
  if (fromTorrent.length) {
    const lessons = fromTorrent.map((e) => e.lesson).join(',');
    showNotice(`Lesson${fromTorrent.length > 1 ? 's' : ''} ${lessons} only exist in the creators’ torrent, which a browser can’t download.
      Open <a href="${REPO_URL}/actions/workflows/fetch-missing.yml" target="_blank" rel="noopener">Fetch missing lessons</a>,
      click <strong>Run workflow</strong> (it fetches every missing lesson by default, or type <code>${lessons}</code>),
      then download the zip from the finished run. The files are tagged just like these.`);
  }
  for (const ep of eps) {
    if (state.queue.some((j) => j.ep.id === ep.id && j.quality === state.quality && (j.state === 'waiting' || j.state === 'running'))) continue;
    state.queue.push({
      id: `job${++jobSeq}`,
      ep,
      quality: state.quality,
      filename: filenameFor(ep, state.quality),
      estimateMb: estimateMb(ep),
      state: 'waiting',
      status: 'Waiting…',
      bytes: 0,
    });
  }
  state.selected.clear();
  render();
  renderQueue();
  if (eps.length) $('queue-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  else $('notice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  pump();
}

// ---------------------------------------------------------------------------
// Setup

function showNotice(html, warn = false) {
  const n = $('notice');
  n.innerHTML = html;
  n.className = 'notice' + (warn ? ' warn' : '');
  n.hidden = false;
}

function supported() {
  return typeof Worker !== 'undefined' && typeof ReadableStream !== 'undefined' && (canPickFolder || !!navigator.storage?.getDirectory);
}

async function cleanLeftovers() {
  // Files from an earlier visit that never got handed off (tab closed mid-way).
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) if (name.endsWith('.part')) await root.removeEntry(name).catch(() => {});
  } catch { /* not supported */ }
}

async function init() {
  const res = await fetch('catalog.json', { cache: 'no-cache' });
  state.catalog = await res.json();
  if (!state.catalog.seasons.some((s) => s.number === state.season)) state.season = 1;

  $('quality').value = state.quality;
  $('relay').value = store.get('relay', '') || RELAY_URL;
  $('catalog-date').textContent = `Episode list updated ${new Date(state.catalog.generatedAt).toLocaleDateString()}.`;

  if (!supported()) {
    showNotice('This browser can’t save large files from a web page. Please use a current Chrome, Edge, Safari or Firefox.', true);
  } else if (state.catalog.missingLessons?.length) {
    showNotice(`Lessons ${state.catalog.missingLessons.join(', ')} aren’t on Lets.Church or the Internet Archive, so they come from the creators’ <a href="https://freehebrew.online/offline/" target="_blank" rel="noopener">torrent</a>
      through a one-click <a href="${REPO_URL}/actions/workflows/fetch-missing.yml" target="_blank" rel="noopener">GitHub workflow</a>. They’re marked “Torrent” in the list.`);
  }

  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderSeasons(); renderEpisodes(); });
  $('quality').addEventListener('change', (e) => { state.quality = e.target.value; store.set('quality', state.quality); renderEpisodes(); renderBar(); });
  $('relay').addEventListener('change', (e) => { store.set('relay', e.target.value.trim()); });
  $('range-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = Number($('range-from').value || 1);
    const to = Number($('range-to').value || $('range-to').placeholder);
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    if (state.search) { state.search = ''; $('search').value = ''; }
    selectWhere((ep) => ep.episode >= lo && ep.episode <= hi);
  });
  $('select-all').addEventListener('click', () => selectWhere(() => true));
  $('select-new').addEventListener('click', () => selectWhere((ep) => !isSaved(ep.id)));
  $('clear').addEventListener('click', () => { state.selected.clear(); render(); });
  $('download').addEventListener('click', startDownloads);
  $('cancel-all').addEventListener('click', () => { for (const j of state.queue) cancelJob(j); });
  $('pick-folder').addEventListener('click', async () => {
    try {
      state.folder = await window.showDirectoryPicker({ id: 'aleph-with-beth', mode: 'readwrite', startIn: 'downloads' });
      renderBar();
    } catch { /* dismissed */ }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.running) { e.preventDefault(); e.returnValue = ''; }
  });

  render();
  cleanLeftovers();
}

init().catch((err) => showNotice(`Couldn’t load the episode list: ${err.message}`, true));
