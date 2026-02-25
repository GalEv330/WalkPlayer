// WalkPlayer — Web Audio batch scheduling for iOS lock-screen continuity
// Audio files are served from /songs on the same origin.

const TRACK_GRADIENTS = [
  ['#0f3460', '#533483'],
  ['#1a2e4a', '#0f3460'],
  ['#1a472a', '#2d6a4f'],
  ['#4a1942', '#c94b4b'],
  ['#0f2027', '#2c5364'],
  ['#3c1053', '#ad5389'],
  ['#0d2137', '#11998e'],
  ['#2c003e', '#a855f7'],
];

function parseSongMeta(filename) {
  const name = filename.replace(/\.mp3$/i, "");
  const dash = name.indexOf(" - ");
  if (dash !== -1) {
    return { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() };
  }
  return { artist: "—", title: name };
}

async function scanSongsDir() {
  try {
    const res = await fetch("/songs/");
    if (!res.ok) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const songs = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (!href.toLowerCase().endsWith(".mp3")) continue;
      const filename = decodeURIComponent(href.split("/").pop());
      const { title, artist } = parseSongMeta(filename);
      songs.push({ title, artist, file: `/songs/${href.split("/").pop()}` });
    }
    return songs.length ? songs : null;
  } catch {
    return null;
  }
}

function buildSongs(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Track ${i + 1}`,
    artist: "—",
    file: `/songs/${String(i + 1).padStart(2, "0")}.mp3`,
  }));
}

let SONGS = buildSongs(1);

const $ = (id) => document.getElementById(id);

const ui = {
  npTitle:       $("npTitle"),
  npArtist:      $("npArtist"),
  npMeta:        $("npMeta"),
  albumArt:      $("albumArt"),
  nextUpTrack:   $("nextUpTrack"),
  progressTrack: $("progressTrack"),
  progressBar:   $("progressBar"),
  progressThumb: $("progressThumb"),
  timeCur:       $("timeCur"),
  timeTot:       $("timeTot"),
  batchPos:      $("batchPos"),
  batchTot:      $("batchTot"),
  statusLine:    $("statusLine"),

  btnSeekBack:   $("btnSeekBack"),
  btnSeekFwd:    $("btnSeekFwd"),
  btnPrev:       $("btnPrev"),
  btnPlay:       $("btnPlay"),
  btnNext:       $("btnNext"),
  playIcon:      $("playIcon"),
  playText:      $("playText"),

  playlistSize:  $("playlistSize"),
  batchCustom:   $("batchCustom"),
  list:          $("list"),
};

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clamp01(x) { return Math.min(1, Math.max(0, x)); }

// --- Audio Engine ---
class BatchScheduledPlayer {
  constructor(songs) {
    this.songs = songs;
    this.idx = 0;
    this.ctx = null;
    this.gain = null;
    this.isPlaying = false;
    this.isLoading = false;
    this.batchSize = 5;
    this.scheduled = [];
    // scheduled entry shape:
    //   { index, source, startTime, endTime, duration, startOffset }
    //   duration    = full track duration (for progress %)
    //   startOffset = seconds into the track we actually started from (after a seek)

    this.bufferCache = new Map();
    this.cacheOrder = [];
    this.maxCached = 8;
  }

  async ensureContext() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: "playback" });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(this.ctx.destination);
    this.setupMediaSession();
  }

  setBatchSize(v) { this.batchSize = v; }

  async play() {
    await this.ensureContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.scheduled.length === 0) {
      await this.rebuildBatchFrom(this.idx, { autostart: true });
      return;
    }
    this.isPlaying = true;
    this.setPlaybackState("playing");
  }

  async pause() {
    if (!this.ctx) return;
    if (this.ctx.state === "running") await this.ctx.suspend();
    this.isPlaying = false;
    this.setPlaybackState("paused");
  }

  async toggle() {
    if (!this.ctx || this.ctx.state !== "running" || !this.isPlaying) {
      await this.play();
    } else {
      await this.pause();
    }
  }

  async next() {
    this.idx = (this.idx + 1) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, {
      autostart: this.isPlaying || this.ctx?.state === "running",
    });
  }

  async prev() {
    const cur = this.getCurrent();
    if (cur && this.ctx.currentTime - cur.startTime > 3) {
      await this.rebuildBatchFrom(cur.index, { autostart: true });
      return;
    }
    this.idx = (this.idx - 1 + this.songs.length) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, {
      autostart: this.isPlaying || this.ctx?.state === "running",
    });
  }

  stopAllScheduled() {
    for (const s of this.scheduled) {
      try { s.source.stop(0); } catch {}
      try { s.source.disconnect(); } catch {}
    }
    this.scheduled = [];
  }

  // Rebuild the batch starting from track startIndex, beginning of track.
  async rebuildBatchFrom(startIndex, { autostart }) {
    await this.ensureContext();
    this.isLoading = true;
    setStatus("Loading + decoding batch…");
    this.stopAllScheduled();

    const batchCount = Math.min(this.batchSize, this.songs.length);
    const indices = Array.from({ length: batchCount },
      (_, i) => (startIndex + i) % this.songs.length);

    const buffers = [];
    for (const i of indices) {
      const buf = await this.loadDecodedBuffer(this.songs[i].file);
      buffers.push({ index: i, buffer: buf });
    }

    const startAt = this.ctx.currentTime + 0.18;
    let t = startAt;

    for (const item of buffers) {
      const source = this.ctx.createBufferSource();
      source.buffer = item.buffer;
      source.connect(this.gain);
      source.start(t);
      const dur = item.buffer.duration;
      this.scheduled.push({
        index: item.index, source,
        startTime: t, endTime: t + dur,
        duration: dur, startOffset: 0,
      });
      t += dur;
    }

    this.idx = startIndex;
    this.isLoading = false;
    setStatus(`Scheduled ${this.scheduled.length} track(s).`);

    if (autostart) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.isPlaying = true;
      this.setPlaybackState("playing");
    } else {
      this.isPlaying = false;
      this.setPlaybackState("paused");
    }

    this.updateNowPlayingMetadata(startIndex);
    scheduleMetadataUpdates();
  }

  // Seek to a specific second within the current track, then re-schedule the rest.
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

    // Current track from offset
    const src0 = this.ctx.createBufferSource();
    src0.buffer = buf;
    src0.connect(this.gain);
    src0.start(startAt, offset);
    const remaining = trackDur - offset;
    this.scheduled.push({
      index: songIdx, source: src0,
      startTime: startAt, endTime: startAt + remaining,
      duration: trackDur, startOffset: offset,
    });
    t += remaining;

    // Remaining batch slots
    const slots = Math.min(this.batchSize - 1, this.songs.length - 1);
    for (let i = 1; i <= slots; i++) {
      const nextIdx = (songIdx + i) % this.songs.length;
      const nextBuf = await this.loadDecodedBuffer(this.songs[nextIdx].file);
      const nextSrc = this.ctx.createBufferSource();
      nextSrc.buffer = nextBuf;
      nextSrc.connect(this.gain);
      nextSrc.start(t);
      this.scheduled.push({
        index: nextIdx, source: nextSrc,
        startTime: t, endTime: t + nextBuf.duration,
        duration: nextBuf.duration, startOffset: 0,
      });
      t += nextBuf.duration;
    }

    this.idx = songIdx;
    if (this.isPlaying && this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.updateNowPlayingMetadata(songIdx);
    scheduleMetadataUpdates();
  }

  // Seek relative to current position; clamps to track boundaries.
  async seekRelative(deltaSeconds) {
    const p = this.getProgress();
    const newPos = p.pos + deltaSeconds;
    if (newPos < 0) {
      await this.seekTo(0);
    } else if (newPos >= p.dur) {
      await this.next();
    } else {
      await this.seekTo(newPos);
    }
  }

  async loadDecodedBuffer(url) {
    if (this.bufferCache.has(url)) return this.bufferCache.get(url);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const arr = await res.arrayBuffer();
    const buf = await new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(arr, resolve, reject);
    });
    this.bufferCache.set(url, buf);
    this.cacheOrder.push(url);
    while (this.cacheOrder.length > this.maxCached) {
      this.bufferCache.delete(this.cacheOrder.shift());
    }
    return buf;
  }

  getCurrent() {
    if (!this.ctx || !this.scheduled.length) return null;
    const t = this.ctx.currentTime;
    for (const seg of this.scheduled) {
      if (t >= seg.startTime && t < seg.endTime) return seg;
    }
    return this.scheduled[this.scheduled.length - 1] ?? null;
  }

  // Progress within the current track (accounts for startOffset after a seek).
  getProgress() {
    const cur = this.getCurrent();
    if (!cur) return { ratio: 0, pos: 0, dur: 0, index: this.idx };
    const elapsed = Math.max(0, this.ctx.currentTime - cur.startTime);
    const pos = (cur.startOffset || 0) + elapsed;
    const dur = cur.duration;
    return { ratio: dur > 0 ? clamp01(pos / dur) : 0, pos, dur, index: cur.index };
  }

  // Position and total duration across the entire scheduled batch.
  getBatchProgress() {
    if (!this.ctx || !this.scheduled.length) return { pos: 0, dur: 0 };
    const t = this.ctx.currentTime;
    let totalDur = 0;
    let curPos = 0;
    for (const seg of this.scheduled) {
      totalDur += seg.duration;
      if (t >= seg.endTime) {
        // Fully past this segment
        curPos += seg.duration;
      } else if (t >= seg.startTime) {
        // Currently in this segment
        curPos += (seg.startOffset || 0) + (t - seg.startTime);
      }
      // upcoming segment: contributes nothing to curPos
    }
    return { pos: curPos, dur: totalDur };
  }

  // --- Media Session ---
  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", async () => { await this.play(); render(); });
      navigator.mediaSession.setActionHandler("pause", async () => { await this.pause(); render(); });
      navigator.mediaSession.setActionHandler("nexttrack", async () => { await this.next(); render(); });
      navigator.mediaSession.setActionHandler("previoustrack", async () => { await this.prev(); render(); });
    } catch {}
  }

  updateNowPlayingMetadata(index) {
    if (!("mediaSession" in navigator)) return;
    const song = this.songs[index];
    if (!song) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: "WalkPlayer",
        artwork: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    } catch {}
    this.setPlaybackState(this.isPlaying ? "playing" : "paused");
  }

  setPlaybackState(state) {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = state; } catch {}
  }
}

// --- Metadata timers ---
const metadataTimers = [];

function scheduleMetadataUpdates() {
  metadataTimers.forEach(id => clearTimeout(id));
  metadataTimers.length = 0;
  if (!player.ctx || !player.scheduled.length) return;
  const audioNow = player.ctx.currentTime;
  for (const seg of player.scheduled) {
    const delayMs = (seg.startTime - audioNow) * 1000 - 50;
    if (delayMs <= 0) continue;
    const { index } = seg;
    metadataTimers.push(setTimeout(() => {
      player.updateNowPlayingMetadata(index);
    }, delayMs));
  }
}

// --- UI ---
const player = new BatchScheduledPlayer(SONGS);

function setStatus(msg) { ui.statusLine.textContent = msg; }

function buildList() {
  ui.list.innerHTML = "";
  SONGS.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "item";
    li.dataset.index = String(i);
    li.innerHTML = `
      <div class="l">
        <div class="t">${escapeHtml(s.title)}</div>
        <div class="a">${escapeHtml(s.artist)}</div>
      </div>
      <div class="r">#${i + 1}</div>
    `;
    li.addEventListener("click", async () => {
      player.idx = i;
      await player.rebuildBatchFrom(i, { autostart: true });
      render(true);
    });
    ui.list.appendChild(li);
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function markActive(index) {
  ui.list.querySelectorAll(".item").forEach(el => el.classList.remove("active"));
  const active = ui.list.querySelector(`.item[data-index="${index}"]`);
  if (active) {
    active.classList.add("active");
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// Set the visual progress state (ratio 0-1) without touching the player.
function setProgressUI(ratio, posSec, durSec) {
  const pct = `${Math.round(ratio * 100)}%`;
  ui.progressBar.style.width = pct;
  ui.progressThumb.style.left = pct;
  ui.timeCur.textContent = fmtTime(posSec);
  ui.timeTot.textContent = fmtTime(durSec);
  ui.progressTrack.setAttribute("aria-valuenow", Math.round(ratio * 100));
}

function render(forceMetadata = false) {
  const cur = player.getCurrent();
  const p = player.getProgress();
  const idx = cur ? cur.index : player.idx;
  const song = SONGS[idx];

  ui.npTitle.textContent  = song ? song.title  : "Not playing";
  ui.npArtist.textContent = song ? song.artist : "Tap Play to start";
  ui.npMeta.textContent   = song ? `Track ${idx + 1} / ${SONGS.length}` : "—";

  const [c1, c2] = TRACK_GRADIENTS[idx % TRACK_GRADIENTS.length];
  ui.albumArt.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  const nextIdx = (idx + 1) % SONGS.length;
  const nextSong = SONGS[nextIdx];
  ui.nextUpTrack.textContent = (nextSong && SONGS.length > 1)
    ? (nextSong.artist !== "—" ? `${nextSong.title} · ${nextSong.artist}` : nextSong.title)
    : "—";

  if (!isScrubbing) setProgressUI(p.ratio, p.pos, p.dur);

  // Batch progress
  const bp = player.getBatchProgress();
  if (bp.dur > 0) {
    ui.batchPos.textContent = fmtTime(bp.pos);
    ui.batchTot.textContent = fmtTime(bp.dur);
  } else {
    ui.batchPos.textContent = "—";
    ui.batchTot.textContent = "—";
  }

  const playing = player.isPlaying && player.ctx?.state === "running";
  ui.playIcon.textContent = playing ? "⏸" : "▶️";
  ui.playText.textContent = playing ? "Pause" : "Play";

  markActive(idx);

  if (player.ctx && player.isPlaying && p.dur > 0) {
    try {
      navigator.mediaSession?.setPositionState({
        duration: p.dur, playbackRate: 1, position: Math.min(p.pos, p.dur),
      });
    } catch {}
  }

  if (forceMetadata && song) player.updateNowPlayingMetadata(idx);
}

// --- Progress bar scrubbing ---
let isScrubbing = false;

function ratioFromPointer(ev) {
  const rect = ui.progressTrack.getBoundingClientRect();
  return clamp01((ev.clientX - rect.left) / rect.width);
}

ui.progressTrack.addEventListener("pointerdown", (ev) => {
  if (!player.ctx && !player.scheduled.length) return;
  ev.preventDefault();
  ui.progressTrack.setPointerCapture(ev.pointerId);
  isScrubbing = true;
  ui.progressTrack.classList.add("scrubbing");

  const dur = player.getProgress().dur;
  const ratio = ratioFromPointer(ev);
  setProgressUI(ratio, ratio * dur, dur);
});

ui.progressTrack.addEventListener("pointermove", (ev) => {
  if (!isScrubbing) return;
  const dur = player.getProgress().dur;
  const ratio = ratioFromPointer(ev);
  setProgressUI(ratio, ratio * dur, dur);
});

ui.progressTrack.addEventListener("pointerup", async (ev) => {
  if (!isScrubbing) return;
  isScrubbing = false;
  ui.progressTrack.classList.remove("scrubbing");

  const dur = player.getProgress().dur;
  if (dur > 0) {
    const ratio = ratioFromPointer(ev);
    try {
      await player.seekTo(ratio * dur);
      render(true);
    } catch (e) { setStatus(`Error: ${e.message}`); }
  }
});

ui.progressTrack.addEventListener("pointercancel", () => {
  isScrubbing = false;
  ui.progressTrack.classList.remove("scrubbing");
});

// --- Seek ±5s ---
ui.btnSeekBack.addEventListener("click", async () => {
  try { await player.seekRelative(-5); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

ui.btnSeekFwd.addEventListener("click", async () => {
  try { await player.seekRelative(5); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

// --- Playback controls ---
ui.btnPlay.addEventListener("click", async () => {
  try { await player.toggle(); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

ui.btnNext.addEventListener("click", async () => {
  try { await player.next(); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

ui.btnPrev.addEventListener("click", async () => {
  try { await player.prev(); render(true); }
  catch (e) { setStatus(`Error: ${e.message}`); }
});

$("btnReseed").addEventListener("click", async () => {
  try {
    await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
    render(true);
  } catch (e) { setStatus(`Error: ${e.message}`); }
});

// --- Batch size controls ---
let currentBatchSize = 5;

function applyBatchSize(val) {
  currentBatchSize = val;
  player.setBatchSize(val);
  document.querySelectorAll(".batch-btn").forEach(btn => {
    btn.classList.toggle("active", Number(btn.dataset.val) === val);
  });
  if (ui.batchCustom.value !== String(val)) ui.batchCustom.value = val;
}

document.querySelectorAll(".batch-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const val = Math.max(1, parseInt(btn.dataset.val, 10));
    applyBatchSize(val);
    if (player.ctx && player.scheduled.length) {
      try {
        await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
        render(true);
      } catch (e) { setStatus(`Error: ${e.message}`); }
    } else {
      setStatus(`Batch size set to ${val}.`);
    }
  });
});

ui.batchCustom.addEventListener("change", async (ev) => {
  const val = Math.max(1, Math.min(999, parseInt(ev.target.value, 10) || 1));
  ev.target.value = val;
  applyBatchSize(val);
  if (player.ctx && player.scheduled.length) {
    try {
      await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
      render(true);
    } catch (e) { setStatus(`Error: ${e.message}`); }
  } else {
    setStatus(`Batch size set to ${val}.`);
  }
});

// --- Playlist size ---
ui.playlistSize.addEventListener("change", (ev) => {
  const n = Math.max(1, Math.min(999, parseInt(ev.target.value, 10) || 1));
  ev.target.value = n;
  SONGS = buildSongs(n);
  player.songs = SONGS;
  player.idx = Math.min(player.idx, SONGS.length - 1);
  player.stopAllScheduled();
  player.isPlaying = false;
  player.setPlaybackState("paused");
  buildList();
  setStatus(`Playlist set to ${n} track(s). Press Play to start.`);
  render(true);
});

// --- Animation loop ---
let lastRenderedTrackIndex = -1;

function tick() {
  render(false);
  const cur = player.getCurrent();
  if (cur && cur.index !== lastRenderedTrackIndex) {
    lastRenderedTrackIndex = cur.index;
    player.updateNowPlayingMetadata(cur.index);
    markActive(cur.index);
  }
  requestAnimationFrame(tick);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const cur = player.getCurrent();
    if (cur) player.updateNowPlayingMetadata(cur.index);
    render(true);
  }
});

// --- Init ---
async function init() {
  const scanned = await scanSongsDir();
  if (scanned) {
    SONGS = scanned;
    player.songs = SONGS;
    ui.playlistSize.value = SONGS.length;
    setStatus(`Found ${SONGS.length} song(s) in /songs/.`);
  } else {
    const n = Math.max(1, parseInt(ui.playlistSize.value, 10) || 12);
    SONGS = buildSongs(n);
    player.songs = SONGS;
    setStatus("Could not scan /songs/. Set playlist size manually.");
  }

  buildList();
  applyBatchSize(currentBatchSize);
  render(true);
  requestAnimationFrame(tick);
}

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("/sw.js"); } catch {}
  });
}
