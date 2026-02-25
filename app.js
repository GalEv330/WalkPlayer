// WalkPlayer — multi-screen PWA with playlist management

// ── Gradients ──
const TRACK_GRADIENTS = [
  ['#0f3460','#533483'], ['#1a2e4a','#0f3460'],
  ['#1a472a','#2d6a4f'], ['#4a1942','#c94b4b'],
  ['#0f2027','#2c5364'], ['#3c1053','#ad5389'],
  ['#0d2137','#11998e'], ['#2c003e','#a855f7'],
];

// Gradient assigned to each user playlist by its creation order
const PL_GRADIENTS = [
  ['#1e3a5f','#60a5fa'], ['#1a472a','#22c55e'],
  ['#3b1a4a','#a855f7'], ['#4a2a0a','#f97316'],
  ['#1e3a3a','#06b6d4'], ['#3a1a2a','#ec4899'],
  ['#2c003e','#a855f7'], ['#0f2027','#2c5364'],
];

// ── Song utils ──
function parseSongMeta(filename) {
  const name = filename.replace(/\.mp3$/i, '');
  const dash = name.indexOf(' - ');
  if (dash !== -1) return { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() };
  return { artist: '—', title: name };
}

async function scanSongsDir() {
  try {
    const res = await fetch('songs/');
    if (!res.ok) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const songs = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href.toLowerCase().endsWith('.mp3')) continue;
      const filename = decodeURIComponent(href.split('/').pop());
      const { title, artist } = parseSongMeta(filename);
      songs.push({ title, artist, file: `songs/${href.split('/').pop()}` });
    }
    return songs.length ? songs : null;
  } catch { return null; }
}

function buildSongs(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Track ${i + 1}`, artist: '—',
    file: `songs/${String(i + 1).padStart(2, '0')}.mp3`,
  }));
}

// ── Playlist store ──
const PL_KEY = 'walkplayer_playlists';

function loadPlaylists() {
  try { return JSON.parse(localStorage.getItem(PL_KEY) || '[]'); } catch { return []; }
}
function savePlaylists(pls) { localStorage.setItem(PL_KEY, JSON.stringify(pls)); }

function createPlaylist(name, songFiles) {
  const pl = { id: Date.now().toString(), name, songFiles, createdAt: Date.now() };
  const all = loadPlaylists();
  all.push(pl);
  savePlaylists(all);
  return pl;
}

function deletePlaylist(id) {
  savePlaylists(loadPlaylists().filter(p => p.id !== id));
}

function getPlaylistSongs(pl) {
  return pl.songFiles
    .map(f => allSongs.find(s => s.file === f))
    .filter(Boolean);
}

// ── State ──
let allSongs = [];   // full scanned list — never mutated
let SONGS    = [];   // currently active playlist songs

let activePlaylistId = '__all__'; // which playlist detail is open

const $ = id => document.getElementById(id);

const ui = {
  // Now playing
  npTitle: $('npTitle'), npArtist: $('npArtist'), npMeta: $('npMeta'),
  albumArt: $('albumArt'),
  progressTrack: $('progressTrack'), progressBar: $('progressBar'), progressThumb: $('progressThumb'),
  timeCur: $('timeCur'), timeTot: $('timeTot'),
  batchPos: $('batchPos'), batchTot: $('batchTot'),
  nextUpTrack: $('nextUpTrack'),
  statusLine: $('statusLine'),

  // Playback buttons
  btnPlay: $('btnPlay'), playIcon: $('playIcon'), playText: $('playText'),
  btnPrev: $('btnPrev'), btnNext: $('btnNext'),
  btnSeekBack: $('btnSeekBack'), btnSeekFwd: $('btnSeekFwd'),
  batchCustom: $('batchCustom'),
  list: $('list'), playerListLabel: $('playerListLabel'),

  // Mini-player
  miniPlayer: $('miniPlayer'), miniArt: $('miniArt'),
  miniTitle: $('miniTitle'), miniArtist: $('miniArtist'),
  miniProgressBar: $('miniProgressBar'),
  miniBtnPlay: $('miniBtnPlay'), miniBtnNext: $('miniBtnNext'),

  // Home
  searchInput: $('searchInput'),
  searchPane: $('searchPane'), searchList: $('searchList'),
  browsePane: $('browsePane'), plGrid: $('plGrid'),

  // Playlist detail
  detailTitle: $('detailTitle'), detailList: $('detailList'),
  btnDeletePlaylist: $('btnDeletePlaylist'),

  // Player screen label
  playerPlaylistName: $('playerPlaylistName'),

  // Modal
  modalNewPlaylist: $('modalNewPlaylist'),
  newPlaylistName: $('newPlaylistName'),
  pickerSearch: $('pickerSearch'), pickerList: $('pickerList'),
  pickerCount: $('pickerCount'),
};

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
function clamp01(x) { return Math.min(1, Math.max(0, x)); }
function escapeHtml(s) {
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

// ── Navigation ──
let navStack = ['screenHome'];

function navigateTo(id) {
  const curr = navStack[navStack.length - 1];
  if (curr === id) return;
  document.getElementById(curr).className = 'screen screen-left';
  document.getElementById(id).className   = 'screen screen-active';
  navStack.push(id);
  updateMiniPlayer();
}

function navigateBack() {
  if (navStack.length <= 1) return;
  const curr = navStack.pop();
  const prev = navStack[navStack.length - 1];
  document.getElementById(curr).className = 'screen screen-right';
  document.getElementById(prev).className = 'screen screen-active';
  updateMiniPlayer();
}

// ── Audio Engine ──
class BatchScheduledPlayer {
  constructor(songs) {
    this.songs = songs; this.idx = 0;
    this.ctx = null; this.gain = null;
    this.isPlaying = false; this.isLoading = false;
    this.batchSize = 5; this.scheduled = [];
    this.bufferCache = new Map(); this.cacheOrder = []; this.maxCached = 8;
  }

  async ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(this.ctx.destination);
    this.setupMediaSession();
  }

  setBatchSize(v) { this.batchSize = v; }

  async play() {
    await this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.scheduled.length) { await this.rebuildBatchFrom(this.idx, { autostart: true }); return; }
    this.isPlaying = true; this.setPlaybackState('playing');
  }
  async pause() {
    if (!this.ctx) return;
    if (this.ctx.state === 'running') await this.ctx.suspend();
    this.isPlaying = false; this.setPlaybackState('paused');
  }
  async toggle() {
    if (!this.ctx || this.ctx.state !== 'running' || !this.isPlaying) await this.play();
    else await this.pause();
  }
  async next() {
    this.idx = (this.idx + 1) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, { autostart: this.isPlaying || this.ctx?.state === 'running' });
  }
  async prev() {
    const cur = this.getCurrent();
    if (cur && this.ctx.currentTime - cur.startTime > 3) { await this.rebuildBatchFrom(cur.index, { autostart: true }); return; }
    this.idx = (this.idx - 1 + this.songs.length) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, { autostart: this.isPlaying || this.ctx?.state === 'running' });
  }

  stopAllScheduled() {
    for (const s of this.scheduled) { try { s.source.stop(0); } catch {} try { s.source.disconnect(); } catch {} }
    this.scheduled = [];
  }

  async rebuildBatchFrom(startIndex, { autostart }) {
    await this.ensureContext();
    this.isLoading = true;
    setStatus('Loading + decoding batch…');
    this.stopAllScheduled();

    const batchCount = Math.min(this.batchSize, this.songs.length);
    const buffers = [];
    for (let i = 0; i < batchCount; i++) {
      const idx = (startIndex + i) % this.songs.length;
      const buf = await this.loadDecodedBuffer(this.songs[idx].file);
      buffers.push({ index: idx, buffer: buf });
    }

    const startAt = this.ctx.currentTime + 0.18;
    let t = startAt;
    for (const item of buffers) {
      const src = this.ctx.createBufferSource();
      src.buffer = item.buffer; src.connect(this.gain); src.start(t);
      const dur = item.buffer.duration;
      this.scheduled.push({ index: item.index, source: src, startTime: t, endTime: t + dur, duration: dur, startOffset: 0 });
      t += dur;
    }

    this.idx = startIndex; this.isLoading = false;
    setStatus(`Scheduled ${this.scheduled.length} track(s).`);

    if (autostart) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.isPlaying = true; this.setPlaybackState('playing');
    } else {
      this.isPlaying = false; this.setPlaybackState('paused');
    }
    this.updateNowPlayingMetadata(startIndex);
    scheduleMetadataUpdates();
  }

  async seekTo(positionSeconds) {
    await this.ensureContext();
    if (this.isLoading) return;
    const cur = this.getCurrent();
    const songIdx = cur ? cur.index : this.idx;
    const buf = await this.loadDecodedBuffer(this.songs[songIdx].file);
    const trackDur = buf.duration;
    const offset = Math.max(0, Math.min(positionSeconds, trackDur - 0.05));
    this.stopAllScheduled();

    const startAt = this.ctx.currentTime + 0.05;
    let t = startAt;
    const src0 = this.ctx.createBufferSource();
    src0.buffer = buf; src0.connect(this.gain); src0.start(startAt, offset);
    const remaining = trackDur - offset;
    this.scheduled.push({ index: songIdx, source: src0, startTime: startAt, endTime: startAt + remaining, duration: trackDur, startOffset: offset });
    t += remaining;

    const slots = Math.min(this.batchSize - 1, this.songs.length - 1);
    for (let i = 1; i <= slots; i++) {
      const nextIdx = (songIdx + i) % this.songs.length;
      const nb = await this.loadDecodedBuffer(this.songs[nextIdx].file);
      const ns = this.ctx.createBufferSource();
      ns.buffer = nb; ns.connect(this.gain); ns.start(t);
      this.scheduled.push({ index: nextIdx, source: ns, startTime: t, endTime: t + nb.duration, duration: nb.duration, startOffset: 0 });
      t += nb.duration;
    }
    this.idx = songIdx;
    if (this.isPlaying && this.ctx.state === 'suspended') await this.ctx.resume();
    this.updateNowPlayingMetadata(songIdx);
    scheduleMetadataUpdates();
  }

  async seekRelative(delta) {
    const p = this.getProgress();
    const np = p.pos + delta;
    if (np < 0) await this.seekTo(0);
    else if (np >= p.dur) await this.next();
    else await this.seekTo(np);
  }

  async loadDecodedBuffer(url) {
    if (this.bufferCache.has(url)) return this.bufferCache.get(url);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await new Promise((resolve, reject) => this.ctx.decodeAudioData(arr, resolve, reject));
    this.bufferCache.set(url, buf); this.cacheOrder.push(url);
    while (this.cacheOrder.length > this.maxCached) this.bufferCache.delete(this.cacheOrder.shift());
    return buf;
  }

  getCurrent() {
    if (!this.ctx || !this.scheduled.length) return null;
    const t = this.ctx.currentTime;
    for (const seg of this.scheduled) if (t >= seg.startTime && t < seg.endTime) return seg;
    return this.scheduled[this.scheduled.length - 1] ?? null;
  }

  getProgress() {
    const cur = this.getCurrent();
    if (!cur) return { ratio: 0, pos: 0, dur: 0, index: this.idx };
    const elapsed = Math.max(0, this.ctx.currentTime - cur.startTime);
    const pos = (cur.startOffset || 0) + elapsed;
    const dur = cur.duration;
    return { ratio: dur > 0 ? clamp01(pos / dur) : 0, pos, dur, index: cur.index };
  }

  getBatchProgress() {
    if (!this.ctx || !this.scheduled.length) return { pos: 0, dur: 0 };
    const t = this.ctx.currentTime;
    let totalDur = 0, curPos = 0;
    for (const seg of this.scheduled) {
      totalDur += seg.duration;
      if (t >= seg.endTime) curPos += seg.duration;
      else if (t >= seg.startTime) curPos += (seg.startOffset || 0) + (t - seg.startTime);
    }
    return { pos: curPos, dur: totalDur };
  }

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('play',          async () => { await this.play();  render(); });
      navigator.mediaSession.setActionHandler('pause',         async () => { await this.pause(); render(); });
      navigator.mediaSession.setActionHandler('nexttrack',     async () => { await this.next();  render(); });
      navigator.mediaSession.setActionHandler('previoustrack', async () => { await this.prev();  render(); });
    } catch {}
  }

  updateNowPlayingMetadata(index) {
    if (!('mediaSession' in navigator)) return;
    const song = this.songs[index]; if (!song) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title, artist: song.artist, album: 'WalkPlayer',
        artwork: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
    } catch {}
    this.setPlaybackState(this.isPlaying ? 'playing' : 'paused');
  }

  setPlaybackState(state) { try { navigator.mediaSession.playbackState = state; } catch {} }
}

// ── Metadata timers ──
const metadataTimers = [];
function scheduleMetadataUpdates() {
  metadataTimers.forEach(id => clearTimeout(id)); metadataTimers.length = 0;
  if (!player.ctx || !player.scheduled.length) return;
  const audioNow = player.ctx.currentTime;
  for (const seg of player.scheduled) {
    const delayMs = (seg.startTime - audioNow) * 1000 - 50;
    if (delayMs <= 0) continue;
    const { index } = seg;
    metadataTimers.push(setTimeout(() => player.updateNowPlayingMetadata(index), delayMs));
  }
}

// ── Player instance ──
const player = new BatchScheduledPlayer([]);

function setStatus(msg) { ui.statusLine.textContent = msg; }

// ── Build in-player song list ──
function buildList() {
  ui.list.innerHTML = '';
  SONGS.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'item'; li.dataset.index = String(i);
    li.innerHTML = `
      <div class="l">
        <div class="t">${escapeHtml(s.title)}</div>
        <div class="a">${escapeHtml(s.artist)}</div>
      </div>
      <div class="r">#${i + 1}</div>`;
    li.addEventListener('click', async () => {
      player.idx = i;
      await player.rebuildBatchFrom(i, { autostart: true });
      render(true);
    });
    ui.list.appendChild(li);
  });
}

function markActive(index) {
  ui.list.querySelectorAll('.item').forEach(el => el.classList.remove('active'));
  const el = ui.list.querySelector(`.item[data-index="${index}"]`);
  if (el) el.classList.add('active');
}

function scrollToActive(index) {
  const el = ui.list.querySelector(`.item[data-index="${index}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Progress UI ──
function setProgressUI(ratio, pos, dur) {
  const pct = `${Math.round(ratio * 100)}%`;
  ui.progressBar.style.width = pct;
  ui.progressThumb.style.left = pct;
  ui.timeCur.textContent = fmtTime(pos);
  ui.timeTot.textContent = fmtTime(dur);
  ui.progressTrack.setAttribute('aria-valuenow', Math.round(ratio * 100));
}

// ── Render (player screen) ──
function render(forceMetadata = false) {
  const cur = player.getCurrent();
  const p = player.getProgress();
  const idx = cur ? cur.index : player.idx;
  const song = SONGS[idx];

  ui.npTitle.textContent  = song ? song.title  : 'Not playing';
  ui.npArtist.textContent = song ? song.artist : 'Tap Play to start';
  ui.npMeta.textContent   = song ? `Track ${idx + 1} / ${SONGS.length}` : '—';

  const [c1, c2] = TRACK_GRADIENTS[idx % TRACK_GRADIENTS.length];
  ui.albumArt.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  const nextIdx  = (idx + 1) % SONGS.length;
  const nextSong = SONGS[nextIdx];
  ui.nextUpTrack.textContent = (nextSong && SONGS.length > 1)
    ? (nextSong.artist !== '—' ? `${nextSong.title} · ${nextSong.artist}` : nextSong.title)
    : '—';

  if (!isScrubbing) setProgressUI(p.ratio, p.pos, p.dur);

  const bp = player.getBatchProgress();
  ui.batchPos.textContent = bp.dur > 0 ? fmtTime(bp.pos) : '—';
  ui.batchTot.textContent = bp.dur > 0 ? fmtTime(bp.dur) : '—';

  const playing = player.isPlaying && player.ctx?.state === 'running';
  ui.playIcon.textContent = playing ? '⏸' : '▶️';
  ui.playText.textContent = playing ? 'Pause' : 'Play';

  markActive(idx);

  if (player.ctx && player.isPlaying && p.dur > 0) {
    try { navigator.mediaSession?.setPositionState({ duration: p.dur, playbackRate: 1, position: Math.min(p.pos, p.dur) }); } catch {}
  }

  if (forceMetadata && song) player.updateNowPlayingMetadata(idx);
  updateMiniPlayer();
}

// ── Mini-player ──
function updateMiniPlayer() {
  const activeScreen = navStack[navStack.length - 1];
  const hasAudio = player.scheduled.length > 0;
  const show = hasAudio && activeScreen !== 'screenPlayer';

  ui.miniPlayer.classList.toggle('mini-hidden', !show);
  if (!show) return;

  const p   = player.getProgress();
  const cur = player.getCurrent();
  const idx  = cur ? cur.index : player.idx;
  const song = SONGS[idx];

  ui.miniTitle.textContent  = song ? song.title  : '—';
  ui.miniArtist.textContent = song ? song.artist : '';
  ui.miniProgressBar.style.width = `${Math.round(p.ratio * 100)}%`;

  const [c1, c2] = TRACK_GRADIENTS[idx % TRACK_GRADIENTS.length];
  ui.miniArt.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  const playing = player.isPlaying && player.ctx?.state === 'running';
  ui.miniBtnPlay.textContent = playing ? '⏸' : '▶️';
}

// ── Home screen ──
function renderHome() {
  const userPlaylists = loadPlaylists();
  ui.plGrid.innerHTML = '';

  // "All Songs" card (built-in)
  const allCard = document.createElement('div');
  allCard.className = 'pl-card';
  allCard.innerHTML = `
    <div class="pl-card-art" style="background:linear-gradient(135deg,#1a2e4a,#0f3460);font-size:32px">🎵</div>
    <div class="pl-card-name">All Songs</div>
    <div class="pl-card-count">${allSongs.length} track${allSongs.length !== 1 ? 's' : ''}</div>`;
  allCard.addEventListener('click', () => openPlaylistDetail('__all__'));
  ui.plGrid.appendChild(allCard);

  // User playlist cards
  userPlaylists.forEach((pl, i) => {
    const [g1, g2] = PL_GRADIENTS[i % PL_GRADIENTS.length];
    const card = document.createElement('div');
    card.className = 'pl-card';
    const count = pl.songFiles.length;
    card.innerHTML = `
      <div class="pl-card-art" style="background:linear-gradient(135deg,${g1},${g2})">♪</div>
      <div class="pl-card-name">${escapeHtml(pl.name)}</div>
      <div class="pl-card-count">${count} track${count !== 1 ? 's' : ''}</div>
      <button class="pl-card-del" aria-label="Delete ${escapeHtml(pl.name)}">✕</button>`;
    card.querySelector('.pl-card-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${pl.name}"?`)) return;
      deletePlaylist(pl.id);
      renderHome();
    });
    card.addEventListener('click', () => openPlaylistDetail(pl.id));
    ui.plGrid.appendChild(card);
  });
}

// ── Playlist detail ──
function openPlaylistDetail(id) {
  activePlaylistId = id;
  let songs, title, isUser;

  if (id === '__all__') {
    songs = allSongs; title = 'All Songs'; isUser = false;
  } else {
    const pl = loadPlaylists().find(p => p.id === id);
    if (!pl) return;
    songs = getPlaylistSongs(pl); title = pl.name; isUser = true;
  }

  ui.detailTitle.textContent = title;
  ui.btnDeletePlaylist.classList.toggle('hidden', !isUser);

  ui.detailList.innerHTML = '';
  songs.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'item';
    // Highlight if currently playing this song
    if (player.scheduled.length > 0 && SONGS === songs && player.idx === i) {
      li.classList.add('active');
    }
    li.innerHTML = `
      <div class="l">
        <div class="t">${escapeHtml(s.title)}</div>
        <div class="a">${escapeHtml(s.artist)}</div>
      </div>
      <div class="r">#${i + 1}</div>`;
    li.addEventListener('click', () => startFromPlaylist(songs, i, title));
    ui.detailList.appendChild(li);
  });

  navigateTo('screenDetail');
}

// ── Start playback from a playlist ──
function startFromPlaylist(songs, startIdx, playlistName) {
  SONGS = songs;
  player.songs = SONGS;
  player.idx = startIdx;
  ui.playerPlaylistName.textContent = playlistName;
  ui.playerListLabel.textContent    = playlistName;
  buildList();
  scrollToActive(startIdx);
  navigateTo('screenPlayer');
  player.rebuildBatchFrom(startIdx, { autostart: true })
    .then(() => render(true))
    .catch(e => setStatus(`Error: ${e.message}`));
}

// ── Search ──
function handleSearch(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    ui.searchPane.classList.add('hidden');
    ui.browsePane.classList.remove('hidden');
    return;
  }
  ui.browsePane.classList.add('hidden');
  ui.searchPane.classList.remove('hidden');

  // Songs matching title or artist
  const results = allSongs.filter(s =>
    s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q));

  // Also filter user playlists by name
  const matchedPlaylists = loadPlaylists().filter(p =>
    p.name.toLowerCase().includes(q));

  ui.searchList.innerHTML = '';

  if (matchedPlaylists.length) {
    const hdr = document.createElement('li');
    hdr.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:8px 2px 4px';
    hdr.textContent = 'Playlists';
    ui.searchList.appendChild(hdr);

    matchedPlaylists.forEach(pl => {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `<div class="l"><div class="t">${escapeHtml(pl.name)}</div><div class="a">${pl.songFiles.length} tracks</div></div><div class="r">›</div>`;
      li.addEventListener('click', () => { ui.searchInput.blur(); openPlaylistDetail(pl.id); });
      ui.searchList.appendChild(li);
    });
  }

  if (results.length) {
    const hdr = document.createElement('li');
    hdr.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:8px 2px 4px';
    hdr.textContent = 'Songs';
    ui.searchList.appendChild(hdr);

    results.forEach(s => {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `<div class="l"><div class="t">${escapeHtml(s.title)}</div><div class="a">${escapeHtml(s.artist)}</div></div><div class="r">▶</div>`;
      li.addEventListener('click', () => {
        ui.searchInput.blur();
        const idx = allSongs.findIndex(x => x.file === s.file);
        startFromPlaylist(allSongs, idx, 'All Songs');
      });
      ui.searchList.appendChild(li);
    });
  }

  if (!results.length && !matchedPlaylists.length) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:16px 2px;color:var(--muted);font-size:13px';
    li.textContent = 'No results found.';
    ui.searchList.appendChild(li);
  }
}

// ── Modal: create playlist ──
let pickerSelected = new Set();

function openModal() {
  pickerSelected.clear();
  ui.newPlaylistName.value = '';
  ui.pickerSearch.value = '';
  ui.pickerCount.textContent = 'Select songs';
  renderPickerList('');
  ui.modalNewPlaylist.classList.remove('modal-hidden');
  setTimeout(() => ui.newPlaylistName.focus(), 80);
}

function closeModal() {
  ui.modalNewPlaylist.classList.add('modal-hidden');
}

function renderPickerList(filter) {
  const songs = filter
    ? allSongs.filter(s => s.title.toLowerCase().includes(filter) || s.artist.toLowerCase().includes(filter))
    : allSongs;

  ui.pickerList.innerHTML = '';
  songs.forEach(s => {
    const sel = pickerSelected.has(s.file);
    const li = document.createElement('li');
    li.className = 'picker-item' + (sel ? ' selected' : '');
    li.innerHTML = `
      <div class="picker-check">${sel ? '✓' : ''}</div>
      <div class="picker-info">
        <div class="picker-title">${escapeHtml(s.title)}</div>
        <div class="picker-artist">${escapeHtml(s.artist)}</div>
      </div>`;
    li.addEventListener('click', () => {
      if (pickerSelected.has(s.file)) pickerSelected.delete(s.file);
      else pickerSelected.add(s.file);
      updatePickerCount();
      renderPickerList(ui.pickerSearch.value.toLowerCase().trim());
    });
    ui.pickerList.appendChild(li);
  });
}

function updatePickerCount() {
  const n = pickerSelected.size;
  ui.pickerCount.textContent = n > 0 ? `${n} selected` : 'Select songs';
}

function savePlaylist() {
  const name = ui.newPlaylistName.value.trim();
  if (!name) { ui.newPlaylistName.focus(); return; }
  if (pickerSelected.size === 0) { alert('Pick at least one song.'); return; }

  // Preserve the order songs appear in allSongs (not insertion order)
  const songFiles = allSongs
    .filter(s => pickerSelected.has(s.file))
    .map(s => s.file);

  createPlaylist(name, songFiles);
  closeModal();
  renderHome();
}

// ── Batch size controls ──
let currentBatchSize = 5;

function applyBatchSize(val) {
  currentBatchSize = val;
  player.setBatchSize(val);
  document.querySelectorAll('.batch-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.val) === val);
  });
  if (ui.batchCustom.value !== String(val)) ui.batchCustom.value = val;
}

document.querySelectorAll('.batch-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const val = Math.max(1, parseInt(btn.dataset.val, 10));
    applyBatchSize(val);
    if (player.ctx && player.scheduled.length) {
      try { await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying }); render(true); }
      catch (e) { setStatus(`Error: ${e.message}`); }
    } else { setStatus(`Batch size set to ${val}.`); }
  });
});

ui.batchCustom.addEventListener('change', async (ev) => {
  const val = Math.max(1, Math.min(999, parseInt(ev.target.value, 10) || 1));
  ev.target.value = val; applyBatchSize(val);
  if (player.ctx && player.scheduled.length) {
    try { await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying }); render(true); }
    catch (e) { setStatus(`Error: ${e.message}`); }
  }
});

// ── Scrubbing ──
let isScrubbing = false;
function ratioFromPointer(ev) {
  const rect = ui.progressTrack.getBoundingClientRect();
  return clamp01((ev.clientX - rect.left) / rect.width);
}

ui.progressTrack.addEventListener('pointerdown', ev => {
  ev.preventDefault(); ui.progressTrack.setPointerCapture(ev.pointerId);
  isScrubbing = true; ui.progressTrack.classList.add('scrubbing');
  setProgressUI(ratioFromPointer(ev), ratioFromPointer(ev) * player.getProgress().dur, player.getProgress().dur);
});
ui.progressTrack.addEventListener('pointermove', ev => {
  if (!isScrubbing) return;
  const dur = player.getProgress().dur;
  setProgressUI(ratioFromPointer(ev), ratioFromPointer(ev) * dur, dur);
});
ui.progressTrack.addEventListener('pointerup', async ev => {
  if (!isScrubbing) return;
  isScrubbing = false; ui.progressTrack.classList.remove('scrubbing');
  const dur = player.getProgress().dur;
  if (dur > 0) { try { await player.seekTo(ratioFromPointer(ev) * dur); render(true); } catch (e) { setStatus(`Error: ${e.message}`); } }
});
ui.progressTrack.addEventListener('pointercancel', () => {
  isScrubbing = false; ui.progressTrack.classList.remove('scrubbing');
});

// ── Playback buttons ──
ui.btnPlay.addEventListener('click', async () => {
  try { await player.toggle(); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});
ui.btnNext.addEventListener('click', async () => {
  try { await player.next(); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});
ui.btnPrev.addEventListener('click', async () => {
  try { await player.prev(); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});
ui.btnSeekBack.addEventListener('click', async () => {
  try { await player.seekRelative(-5); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});
ui.btnSeekFwd.addEventListener('click', async () => {
  try { await player.seekRelative(5); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});
$('btnReseed').addEventListener('click', async () => {
  try { await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying }); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

// ── Navigation buttons ──
$('btnBackDetail').addEventListener('click', navigateBack);
$('btnBackPlayer').addEventListener('click', navigateBack);
$('btnDeletePlaylist').addEventListener('click', () => {
  const pl = loadPlaylists().find(p => p.id === activePlaylistId);
  if (!pl || !confirm(`Delete "${pl.name}"?`)) return;
  deletePlaylist(activePlaylistId);
  renderHome();
  navigateBack();
});

// ── Mini-player buttons ──
ui.miniPlayer.addEventListener('click', ev => {
  if (ev.target === ui.miniBtnPlay || ev.target === ui.miniBtnNext) return;
  if (navStack[navStack.length - 1] !== 'screenPlayer') navigateTo('screenPlayer');
});
ui.miniBtnPlay.addEventListener('click', async ev => {
  ev.stopPropagation();
  try { await player.toggle(); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});
ui.miniBtnNext.addEventListener('click', async ev => {
  ev.stopPropagation();
  try { await player.next(); render(true); } catch (e) { setStatus(`Error: ${e.message}`); }
});

// ── Home buttons ──
$('btnNewPlaylist').addEventListener('click', openModal);
$('btnCloseModal').addEventListener('click', closeModal);
$('btnCancelModal').addEventListener('click', closeModal);
$('btnSavePlaylist').addEventListener('click', savePlaylist);
ui.pickerSearch.addEventListener('input', ev => renderPickerList(ev.target.value.toLowerCase().trim()));
ui.searchInput.addEventListener('input', ev => handleSearch(ev.target.value));

// Close modal when tapping the backdrop
ui.modalNewPlaylist.addEventListener('click', ev => { if (ev.target === ui.modalNewPlaylist) closeModal(); });

// ── Animation loop ──
let lastRenderedTrackIndex = -1;

function tick() {
  render(false);
  const cur = player.getCurrent();
  if (cur && cur.index !== lastRenderedTrackIndex) {
    lastRenderedTrackIndex = cur.index;
    player.updateNowPlayingMetadata(cur.index);
    markActive(cur.index);
    scrollToActive(cur.index);
  }
  requestAnimationFrame(tick);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const cur = player.getCurrent();
    if (cur) player.updateNowPlayingMetadata(cur.index);
    render(true);
  }
});

// ── Init ──
async function init() {
  allSongs = (await scanSongsDir()) || buildSongs(12);
  SONGS = allSongs;
  player.songs = SONGS;
  setStatus(`Found ${allSongs.length} song(s).`);
  renderHome();
  applyBatchSize(5);
  render(true);
  requestAnimationFrame(tick);
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  });
}
