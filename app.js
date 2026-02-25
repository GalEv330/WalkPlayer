// WalkPlayer — Web Audio batch scheduling for iOS lock-screen continuity
// Audio files are served from /songs on the same origin, named 01.mp3, 02.mp3, …

// Gradient pairs for the album-art placeholder; cycles per track index.
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

function buildSongs(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Track ${i + 1}`,
    artist: "—",
    file: `/songs/${String(i + 1).padStart(2, "0")}.mp3`,
  }));
}

let SONGS = buildSongs(12);

const $ = (id) => document.getElementById(id);

const ui = {
  npTitle:      $("npTitle"),
  npArtist:     $("npArtist"),
  npMeta:       $("npMeta"),
  albumArt:     $("albumArt"),
  nextUpTrack:  $("nextUpTrack"),
  progressBar:  $("progressBar"),
  timeCur:      $("timeCur"),
  timeTot:      $("timeTot"),
  statusLine:   $("statusLine"),

  btnPrev:      $("btnPrev"),
  btnPlay:      $("btnPlay"),
  btnNext:      $("btnNext"),
  playIcon:     $("playIcon"),
  playText:     $("playText"),

  playlistSize: $("playlistSize"),
  batchSize:    $("batchSize"),
  btnReseed:    $("btnReseed"),

  list:         $("list"),
};

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// --- Audio Engine (Web Audio API) ---
class BatchScheduledPlayer {
  constructor(songs) {
    this.songs = songs;
    this.idx = 0;

    this.ctx = null;
    this.gain = null;

    this.isPlaying = false;
    this.isLoading = false;

    this.batchSize = 5;
    this.scheduled = []; // [{ index, startTime, endTime, source, duration }]

    // decoded buffer cache (decoded PCM is large; keep it bounded)
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

  setBatchSize(v) {
    this.batchSize = v;
  }

  async play() {
    await this.ensureContext();

    // iOS requires a user gesture; play() is always called from a button click.
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    if (this.scheduled.length === 0) {
      await this.rebuildBatchFrom(this.idx, { autostart: true });
      return;
    }

    this.isPlaying = true;
    this.setPlaybackState("playing");
  }

  async pause() {
    if (!this.ctx) return;
    if (this.ctx.state === "running") {
      await this.ctx.suspend();
    }
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

  async rebuildBatchFrom(startIndex, { autostart }) {
    await this.ensureContext();

    this.isLoading = true;
    setStatus("Loading + decoding batch…");

    this.stopAllScheduled();

    const batchCount = this.batchSize === Infinity
      ? this.songs.length
      : this.batchSize;

    const indices = [];
    for (let i = 0; i < Math.min(batchCount, this.songs.length); i++) {
      indices.push((startIndex + i) % this.songs.length);
    }

    // Decode all buffers first, then schedule sample-accurately.
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

      const duration = item.buffer.duration;
      source.start(t);

      this.scheduled.push({
        index: item.index,
        source,
        startTime: t,
        endTime: t + duration,
        duration,
      });

      t += duration;
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

    // Schedule wall-clock timers to update lock-screen metadata at each
    // track boundary. May be throttled on iOS when screen is off, but still
    // helps on wake-up and when the app is in the foreground.
    scheduleMetadataUpdates();
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

  getProgress() {
    const cur = this.getCurrent();
    if (!cur) return { ratio: 0, pos: 0, dur: 0, index: this.idx };

    const t = this.ctx.currentTime;
    const pos = Math.max(0, t - cur.startTime);
    const dur = cur.duration;
    return { ratio: dur > 0 ? clamp01(pos / dur) : 0, pos, dur, index: cur.index };
  }

  // --- Media Session (lock screen / Bluetooth) ---
  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", async () => {
        await this.play();
        render();
      });
      navigator.mediaSession.setActionHandler("pause", async () => {
        await this.pause();
        render();
      });
      navigator.mediaSession.setActionHandler("nexttrack", async () => {
        await this.next();
        render();
      });
      navigator.mediaSession.setActionHandler("previoustrack", async () => {
        await this.prev();
        render();
      });
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

// --- Scheduled metadata timers ---
// Best-effort: fires on wake-up even if throttled while screen is off.
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

// --- UI wiring ---
const player = new BatchScheduledPlayer(SONGS);

function setStatus(msg) {
  ui.statusLine.textContent = msg;
}

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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function markActive(index) {
  ui.list.querySelectorAll(".item").forEach(el => el.classList.remove("active"));
  const active = ui.list.querySelector(`.item[data-index="${index}"]`);
  if (active) {
    active.classList.add("active");
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function render(forceMetadata = false) {
  const cur = player.getCurrent();
  const p = player.getProgress();

  const idx = cur ? cur.index : player.idx;
  const song = SONGS[idx];

  // Now playing text
  ui.npTitle.textContent  = song ? song.title  : "Not playing";
  ui.npArtist.textContent = song ? song.artist : "Tap Play to start";
  ui.npMeta.textContent   = song ? `Track ${idx + 1} / ${SONGS.length}` : "—";

  // Album art gradient
  const [c1, c2] = TRACK_GRADIENTS[idx % TRACK_GRADIENTS.length];
  ui.albumArt.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  // Next up
  const nextIdx  = (idx + 1) % SONGS.length;
  const nextSong = SONGS[nextIdx];
  if (nextSong && SONGS.length > 1) {
    ui.nextUpTrack.textContent = `${nextSong.title}`;
    if (nextSong.artist !== "—") {
      ui.nextUpTrack.textContent += ` · ${nextSong.artist}`;
    }
  } else {
    ui.nextUpTrack.textContent = "—";
  }

  // Progress
  ui.progressBar.style.width = `${Math.round(p.ratio * 100)}%`;
  ui.timeCur.textContent = fmtTime(p.pos);
  ui.timeTot.textContent = fmtTime(p.dur);

  // Buttons
  const playing = player.isPlaying && player.ctx?.state === "running";
  ui.playIcon.textContent = playing ? "⏸" : "▶️";
  ui.playText.textContent = playing ? "Pause" : "Play";

  markActive(idx);

  // MediaSession position state — helps lock-screen scrubber show progress.
  if (player.ctx && player.isPlaying && p.dur > 0) {
    try {
      navigator.mediaSession?.setPositionState({
        duration: p.dur,
        playbackRate: 1,
        position: Math.min(p.pos, p.dur),
      });
    } catch {}
  }

  if (forceMetadata && song) player.updateNowPlayingMetadata(idx);
}

function parseBatchValue(v) {
  if (v === "all") return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// --- Controls ---
ui.btnPlay.addEventListener("click", async () => {
  try {
    await player.toggle();
    render(true);
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});

ui.btnNext.addEventListener("click", async () => {
  try {
    await player.next();
    render(true);
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});

ui.btnPrev.addEventListener("click", async () => {
  try {
    await player.prev();
    render(true);
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});

ui.batchSize.addEventListener("change", async (ev) => {
  const bs = parseBatchValue(ev.target.value);
  player.setBatchSize(bs);

  if (player.ctx && player.scheduled.length) {
    try {
      await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
      render(true);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    }
  } else {
    setStatus(`Batch size set to ${bs === Infinity ? "ALL" : bs}.`);
  }
});

ui.btnReseed.addEventListener("click", async () => {
  try {
    await player.rebuildBatchFrom(player.idx, { autostart: player.isPlaying });
    render(true);
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});

ui.playlistSize.addEventListener("change", (ev) => {
  const n = Math.max(1, Math.min(999, parseInt(ev.target.value, 10) || 1));
  ev.target.value = n;

  SONGS = buildSongs(n);
  player.songs = SONGS;
  player.idx = Math.min(player.idx, SONGS.length - 1);

  // Stop any in-progress batch (files may no longer exist)
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

// Refresh metadata / UI when returning from the lock screen or app switcher.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const cur = player.getCurrent();
    if (cur) player.updateNowPlayingMetadata(cur.index);
    render(true);
  }
});

// --- Init ---
buildList();
player.setBatchSize(parseBatchValue(ui.batchSize.value));
render(true);
requestAnimationFrame(tick);

// PWA service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("/sw.js"); } catch {}
  });
}
