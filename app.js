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
  order: store.get('order', 'course'), // 'course' (creators' watching order) or 'type'
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

// Two ways to browse: "course" groups everything the way the TV app will
// (Course / Worship & Songs / Extras, in watching order); "type" groups by kind.
const courseView = () => state.order === 'course' && !!state.catalog.tvSeasons;
const groups = () => (courseView() ? state.catalog.tvSeasons : state.catalog.seasons);
const groupOf = (ep) => (courseView() ? ep.tvSeason : ep.season);
const numberOf = (ep) => (courseView() ? ep.tvEpisode : ep.episode);
const KIND = { 2: 'Review game', 3: 'Story', 4: 'Song' };

function visibleEpisodes() {
  const q = fold(state.search.trim());
  return state.catalog.episodes
    .filter((ep) => {
      if (q) return fold(ep.title).includes(q) || fold(ep.label || '') === q || String(numberOf(ep)) === q;
      return groupOf(ep) === state.season;
    })
    .sort((a, b) => (groupOf(a) - groupOf(b)) || (numberOf(a) - numberOf(b)));
}

function isSaved(id) { return (state.saved[state.quality] || []).includes(id); }

function renderSeasons() {
  const el = $('seasons');
  el.replaceChildren(...groups().map((s) => {
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
    text.className = 'text';
    const num = document.createElement('span');
    num.className = 'num';
    const group = groups().find((g) => g.number === groupOf(ep));
    num.textContent = state.search ? `${group.name} · ${numberOf(ep)}` : String(numberOf(ep));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = ep.title;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = ep.description || '';
    text.append(num, title, desc);

    const tags = document.createElement('span');
    tags.className = 'tags';
    if (courseView() && KIND[ep.season]) tags.insertAdjacentHTML('beforeend', `<span class="badge kind">${KIND[ep.season]}</span>`);
    if (ep.source === 'torrent') tags.insertAdjacentHTML('beforeend', '<span class="badge" title="Not downloadable here; see the note by the Download button">Not here</span>');
    if (ep.source === 'archive') tags.insertAdjacentHTML('beforeend', '<span class="badge" title="Not on Lets.Church; downloaded from the Internet Archive as 720p video">Archive 720p</span>');
    if (isSaved(ep.id)) tags.insertAdjacentHTML('beforeend', '<span class="saved" title="Downloaded in this browser before (at this quality)">✓</span>');

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ep.source === 'torrent' ? '' : `${fmtDuration(ep.duration)} · ${fmtSize(estimateMb(ep))}`;

    li.append(box, img, text, tags, meta);
    li.addEventListener('click', (e) => {
      state.trimActive = false;
      toggle(ep.id, e.shiftKey, e.target === box ? box.checked : !state.selected.has(ep.id));
    });
    frag.append(li);
  }
  $('episodes').replaceChildren(frag);
  $('empty').hidden = list.length > 0;
  renderTrim();
}

function renderBar() {
  const picked = state.catalog.episodes.filter((e) => state.selected.has(e.id));
  const missing = picked.filter((e) => e.source === 'torrent');
  const eps = picked.filter((e) => e.source !== 'torrent');
  renderUnavailable(missing);
  $('sel-count').textContent = String(eps.length);
  $('sel-noun').textContent = eps.length === 1 ? 'episode selected' : 'episodes selected';
  const mb = eps.reduce((sum, e) => sum + estimateMb(e), 0);
  const min = eps.reduce((sum, e) => sum + e.duration, 0);
  // Always one line of text, so the pinned bar never changes height mid-drag.
  $('sel-size').textContent = eps.length ? `${fmtDuration(min)} · about ${fmtSize(mb)} · ${QUALITY[state.quality].label}` : 'Pick episodes with the range or the list below';
  $('download').disabled = eps.length === 0;
  $('pick-folder').hidden = !canPickFolder;
  $('pick-folder').textContent = state.folder ? `Folder: ${state.folder.name}` : 'Save to folder…';
}

// Lessons that only exist in the creators' torrent can't be downloaded in a
// browser. Mention them only when they're selected, with the details behind ⓘ.
function renderUnavailable(missing) {
  $('unavail').hidden = missing.length === 0;
  if (!missing.length) { setTip(false); return; }
  const lessons = missing.map((e) => e.lesson);
  $('unavail-text').innerHTML = `${missing.length === 1 ? 'One of these episodes isn’t' : `${missing.length} of these episodes aren’t`} available here —
    <a href="${REPO_URL}/actions/workflows/fetch-missing.yml" target="_blank" rel="noopener">get ${missing.length === 1 ? 'it' : 'them'} another way</a>`;
  $('unavail-tip').innerHTML = `<strong>Not included in this download:</strong> ${missing.map((e) => e.label).join(', ')}.<br>
    They exist only in the creators’ torrent. Open the link, press <em>Run workflow</em> and enter <code>${lessons.join(',')}</code>
    (or leave <code>missing</code> for all of them); a zip of tagged files appears on the run page a few minutes later.`;
}

function setTip(open) {
  $('unavail-info').setAttribute('aria-expanded', String(open));
  $('unavail-info').closest('.info').classList.toggle('open', open);
}

// ---------------------------------------------------------------------------
// Range slider ("trim"): two handles over the episodes shown; dragging
// selects everything between them.

function trimList() { return state.search ? [] : visibleEpisodes(); }

function renderTrim() {
  const list = trimList();
  const lo = $('trim-lo');
  const hi = $('trim-hi');
  $('trim').classList.toggle('disabled', list.length < 2);
  lo.disabled = hi.disabled = list.length < 2;
  if (list.length < 2) {
    $('trim-readout').textContent = state.search ? 'Clear the search to use the range' : '';
    return;
  }
  const max = list.length;
  const view = `${state.order}:${state.season}`;
  if (state.trimSeason !== view || Number(lo.max) !== max) {
    state.trimSeason = view;
    state.trimActive = false;
    lo.max = hi.max = String(max);
    lo.value = '1';
    hi.value = String(max);
  }
  const a = Number(lo.value);
  const b = Number(hi.value);
  const pct = (v) => ((v - 1) / (max - 1)) * 100;
  $('trim-fill').style.left = `${pct(a)}%`;
  $('trim-fill').style.right = `${100 - pct(b)}%`;
  $('trim').classList.toggle('active', !!state.trimActive);
  const name = (ep) => ep.label || (ep.title.length > 34 ? `${ep.title.slice(0, 32)}…` : ep.title);
  const count = b - a + 1;
  $('trim-readout').textContent = state.trimActive
    ? `${name(list[a - 1])} → ${name(list[b - 1])} · ${count} episode${count === 1 ? '' : 's'}`
    : `Drag to pick ${name(list[0])} → ${name(list[max - 1])}`;
}

// Pointer dragging (mouse, touch, pen) is handled on the track itself: stacked
// native range inputs don't take touch drags reliably. Pressing anywhere on the
// track grabs the nearest handle. The inputs remain for keyboard/screen readers.
function setupTrimDrag() {
  const track = $('trim-track');
  let which = null;
  const valueAt = (clientX) => {
    const max = Number($('trim-hi').max);
    const r = track.getBoundingClientRect();
    const usable = r.width - 22; // thumb width
    const f = Math.min(1, Math.max(0, (clientX - r.left - 11) / usable));
    return Math.round(1 + f * (max - 1));
  };
  track.addEventListener('pointerdown', (e) => {
    if ($('trim-lo').disabled) return;
    const v = valueAt(e.clientX);
    const lo = Number($('trim-lo').value);
    const hi = Number($('trim-hi').value);
    if (v < lo) which = 'lo';
    else if (v > hi) which = 'hi';
    else if (lo === hi) which = 'either'; // stacked handles: the drag direction decides
    else which = v - lo <= hi - v ? 'lo' : 'hi';
    startX = e.clientX;
    track.setPointerCapture(e.pointerId);
    if (which !== 'either') { $('trim-' + which).focus({ preventScroll: true }); move(e); }
    e.preventDefault();
  });
  let startX = 0;
  const move = (e) => {
    if (!which) return;
    if (which === 'either') {
      if (Math.abs(e.clientX - startX) < 3) return;
      which = e.clientX > startX ? 'hi' : 'lo';
      $('trim-' + which).focus({ preventScroll: true });
    }
    const input = $('trim-' + which);
    const v = String(valueAt(e.clientX));
    if (input.value !== v) { input.value = v; onTrim(which); }
  };
  track.addEventListener('pointermove', move);
  const end = () => { which = null; };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

function onTrim(which) {
  const lo = $('trim-lo');
  const hi = $('trim-hi');
  // Handles can meet but not cross.
  if (Number(lo.value) > Number(hi.value)) {
    if (which === 'lo') lo.value = hi.value; else hi.value = lo.value;
  }
  // Keep the active handle on top so a handle parked at an end can still be grabbed.
  lo.style.zIndex = which === 'lo' ? '3' : '2';
  hi.style.zIndex = which === 'hi' ? '3' : '2';
  const list = trimList();
  const a = Number(lo.value);
  const b = Number(hi.value);
  list.forEach((ep, i) => {
    if (i + 1 >= a && i + 1 <= b) state.selected.add(ep.id); else state.selected.delete(ep.id);
  });
  state.trimActive = true;
  renderEpisodes();
  renderBar();
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
  state.trimActive = false;
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
      b.onclick = () => { job.retried = false; job.useArchive = false; job.filename = filenameFor(job.ep, job.quality); job.state = 'waiting'; job.status = 'Waiting…'; job.bytes = 0; renderQueue(); pump(); };
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

// The episode as it will actually be fetched: after a Lets.Church failure the
// job switches to the Internet Archive copy (720p) when one exists.
function sourceEp(job) {
  if (!job.useArchive) return job.ep;
  const alt = job.ep.archiveAlt;
  return { ...job.ep, source: 'archive', archive: alt, size: alt.size, height: alt.height };
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
    // Resuming a batch: skip episodes whose finished file is already in the folder.
    try {
      const existing = await (await state.folder.getFileHandle(job.filename)).getFile();
      if (existing.size > 0) {
        markSaved(job);
        finishJob(job, 'done', `Already in ${state.folder.name} — skipped`);
        return;
      }
    } catch { /* not there yet */ }
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
      ...sourceUrls(sourceEp(job), job.quality),
      audioOnly: qualityFor(sourceEp(job), job.quality) === 'AUDIO',
      filename: job.filename,
      metadata: metadataFor(sourceEp(job), job.quality),
    },
  });
}

// Put a running job back at the front of the queue to run again right away.
function requeue(job, message) {
  job.state = 'waiting';
  job.status = message;
  job.bytes = 0;
  if (state.running === job) state.running = null;
  renderQueue();
  pump();
}

function finishJob(job, result, message) {
  job.state = result;
  job.status = message;
  if (state.running === job) state.running = null;
  renderQueue();
  pump();
}

// Remembered per browser only — shown as a hint (✓), never used to skip work.
function markSaved(job) {
  const list = new Set(state.saved[job.quality] || []);
  list.add(job.ep.id);
  state.saved[job.quality] = [...list];
  store.set('saved', state.saved);
  renderEpisodes();
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
      markSaved(job);
      finishJob(job, 'done', `Saved ${fmtSize(msg.bytes / 1048576)}${msg.mode === 'dir' ? ` to ${state.folder.name}` : ' to Downloads'}`);
      renderEpisodes();
    } catch (err) {
      finishJob(job, 'error', `Could not save: ${err.message}`);
    }
  } else if (msg.type === 'error') {
    if (msg.cancelled) { finishJob(job, 'error', 'Cancelled'); return; }
    // Unreachable relay: every source goes through it, so retrying won't help.
    const relayDown = !!msg.relayUnreachable;
    if (!relayDown && !job.retried) {
      job.retried = true;
      requeue(job, `Failed (${msg.message}) — retrying…`);
    } else if (!relayDown && !job.useArchive && job.ep.archiveAlt && job.quality !== 'AUDIO') {
      job.useArchive = true;
      job.retried = false;
      job.filename = filenameFor(sourceEp(job), job.quality);
      job.estimateMb = job.ep.archiveAlt.size / 1048576;
      requeue(job, 'Lets.Church didn’t work — trying the Internet Archive copy (720p)…');
    } else {
      finishJob(job, 'error', job.useArchive ? `Lets.Church and the Internet Archive both failed: ${msg.message}` : msg.message);
    }
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
  // Torrent-only lessons are left out; the note by the button explains them.
  const eps = state.catalog.episodes.filter((e) => state.selected.has(e.id) && e.source !== 'torrent');
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
  if (!groups().some((s) => s.number === state.season)) state.season = 1;
  for (const b of document.querySelectorAll('#order button')) {
    b.setAttribute('aria-pressed', String(b.dataset.order === state.order));
    b.addEventListener('click', () => {
      if (state.order === b.dataset.order) return;
      state.order = b.dataset.order;
      store.set('order', state.order);
      state.season = 1;
      store.set('season', 1);
      for (const x of document.querySelectorAll('#order button')) x.setAttribute('aria-pressed', String(x === b));
      render();
    });
  }

  $('quality').value = state.quality;
  $('relay').value = store.get('relay', '') || RELAY_URL;
  $('catalog-date').textContent = `Episode list updated ${new Date(state.catalog.generatedAt).toLocaleDateString()}.`;

  if (!supported()) {
    showNotice('This browser can’t save large files from a web page. Please use a current Chrome, Edge, Safari or Firefox.', true);
  }

  $('search').addEventListener('input', (e) => { state.search = e.target.value; renderSeasons(); renderEpisodes(); });
  $('quality').addEventListener('change', (e) => { state.quality = e.target.value; store.set('quality', state.quality); renderEpisodes(); renderBar(); });
  $('relay').addEventListener('change', (e) => { store.set('relay', e.target.value.trim()); });
  $('trim-lo').addEventListener('input', () => onTrim('lo'));
  $('trim-hi').addEventListener('input', () => onTrim('hi'));
  setupTrimDrag();
  $('select-all').addEventListener('click', () => selectWhere(() => true));
  $('unavail-info').addEventListener('click', (e) => {
    e.stopPropagation();
    setTip($('unavail-info').getAttribute('aria-expanded') !== 'true');
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.info')) setTip(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTip(false); });
  $('clear').addEventListener('click', () => {
    state.selected.clear();
    state.trimSeason = null; // reset the range handles too
    render();
  });
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
