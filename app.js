// WalkPlayer — Web Audio batch scheduling for iOS lock-screen continuity
// Assumes audio files are served from /songs on the same origin.

const SONGS = [
  { title: "Night Walk", artist: "Mock Artist", file: "/songs/01.mp3" },
  { title: "City Lights", artist: "Mock Artist", file: "/songs/02.mp3" },
  { title: "Low Pulse", artist: "Mock Artist", file: "/songs/03.mp3" },
  { title: "Soft Neon", artist: "Mock Artist", file: "/songs/04.mp3" },
  { title: "Midnight Loop", artist: "Mock Artist", file: "/songs/05.mp3" },
  { title: "Deep Focus", artist: "Mock Artist", file: "/songs/06.mp3" },
  { title: "Long Road", artist: "Mock Artist", file: "/songs/07.mp3" },
  { title: "Calm Steps", artist: "Mock Artist", file: "/songs/08.mp3" },
  { title: "After Rain", artist: "Mock Artist", file: "/songs/09.mp3" },
  { title: "Late Train", artist: "Mock Artist", file: "/songs/10.mp3" },
  { title: "Quiet Motion", artist: "Mock Artist", file: "/songs/11.mp3" },
  { title: "Home Stretch", artist: "Mock Artist", file: "/songs/12.mp3" },
];

const $ = (id) => document.getElementById(id);

const ui = {
  npTitle: $("npTitle"),
  npArtist: $("npArtist"),
  npMeta: $("npMeta"),
  progressBar: $("progressBar"),
  timeCur: $("timeCur"),
  timeTot: $("timeTot"),
  statusLine: $("statusLine"),

  btnPrev: $("btnPrev"),
  btnPlay: $("btnPlay"),
  btnNext: $("btnNext"),
  playIcon: $("playIcon"),
  playText: $("playText"),

  batchSize: $("batchSize"),
  btnReseed: $("btnReseed"),

  list: $("list"),
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

    this.batchSize = 5; // default
    this.scheduled = []; // [{ index, startTime, endTime, source, duration }]
    this.batchFromIndex = 0;

    // decoded buffers cache (keep it small; decoded PCM is large)
    this.bufferCache = new Map(); // url -> AudioBuffer
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

    // iOS requires a user gesture to start audio: play() is called from button click.
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }

    // If nothing is scheduled, build & schedule a fresh batch starting at this.idx
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
    await this.rebuildBatchFrom(this.idx, { autostart: this.isPlaying || (this.ctx?.state === "running") });
  }

  async prev() {
    // If we're > ~3s into the current track, restart it; else go to previous track.
    const cur = this.getCurrent();
    if (cur && (this.ctx.currentTime - cur.startTime) > 3) {
      await this.rebuildBatchFrom(cur.index, { autostart: true });
      return;
    }

    this.idx = (this.idx - 1 + this.songs.length) % this.songs.length;
    await this.rebuildBatchFrom(this.idx, { autostart: this.isPlaying || (this.ctx?.state === "running") });
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

    // If paused/suspended but user requested rebuild, keep state and only resume if autostart true.
    const shouldResume = autostart;

    this.isLoading = true;
    setStatus(`Loading + decoding batch…`);

    // Stop anything currently scheduled
    this.stopAllScheduled();

    // Build the batch indices
    const batchCount = (this.batchSize === Infinity) ? this.songs.length : this.batchSize;
    const indices = [];
    for (let i = 0; i < Math.min(batchCount, this.songs.length); i++) {
      indices.push((startIndex + i) % this.songs.length);
    }

    // Decode ALL buffers in the batch before scheduling (simpler + reliable scheduling)
    // Note: decoded PCM is large; keep batch sizes reasonable on mobile.
    const buffers = [];
    for (const i of indices) {
      const url = this.songs[i].file;
      const buf = await this.loadDecodedBuffer(url);
      buffers.push({ index: i, buffer: buf });
    }

    // Schedule them sequentially
    const startAt = this.ctx.currentTime + 0.18; // small lead time
    let t = startAt;

    for (const item of buffers) {
      const source = this.ctx.createBufferSource();
      source.buffer = item.buffer;
      source.connect(this.gain);

      const duration = item.buffer.duration;
      const startTime = t;
      const endTime = t + duration;

      // Schedule sample-accurate playback
      source.start(startTime);

      this.scheduled.push({
        index: item.index,
        source,
        startTime,
        endTime,
        duration,
      });

      t = endTime;
    }

    this.batchFromIndex = startIndex;
    this.idx = startIndex;

    this.isLoading = false;
    setStatus(`Scheduled ${this.scheduled.length} track(s).`);

    // Start or remain paused depending on autostart
    if (shouldResume) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.isPlaying = true;
      this.setPlaybackState("playing");
    } else {
      this.isPlaying = false;
      this.setPlaybackState("paused");
    }

    // Update metadata for the first track in the batch
    this.updateNowPlayingMetadata(startIndex);
  }

  async loadDecodedBuffer(url) {
    if (this.bufferCache.has(url)) {
      return this.bufferCache.get(url);
    }

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status}`);
    }
    const arr = await res.arrayBuffer();

    // decodeAudioData signature differences across browsers
    const buf = await new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(arr, resolve, reject);
    });

    this.bufferCache.set(url, buf);
    this.cacheOrder.push(url);

    // Simple LRU-ish eviction
    while (this.cacheOrder.length > this.maxCached) {
      const oldest = this.cacheOrder.shift();
      this.bufferCache.delete(oldest);
    }

    return buf;
  }

  // Determine which scheduled track is currently playing (when JS is awake).
  getCurrent() {
    if (!this.ctx || this.scheduled.length === 0) return null;
    const t = this.ctx.currentTime;

    // find the active scheduled segment
    for (const seg of this.scheduled) {
      if (t >= seg.startTime && t < seg.endTime) return seg;
    }
    // if past end, return last (useful for UI)
    return this.scheduled[this.scheduled.length - 1] ?? null;
  }

  getProgress() {
    const cur = this.getCurrent();
    if (!cur) return { ratio: 0, pos: 0, dur: 0, index: this.idx };

    const t = this.ctx.currentTime;
    const pos = Math.max(0, t - cur.startTime);
    const dur = cur.duration;
    const ratio = dur > 0 ? clamp01(pos / dur) : 0;
    return { ratio, pos, dur, index: cur.index };
  }

  // --- Media Session (lock screen / Bluetooth) ---
  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler("play", async () => {
        await this.play();
        render(); // refresh UI quickly if woken up by OS
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
    } catch {
      // Some Safari versions throw on unsupported actions.
    }
  }

  updateNowPlayingMetadata(index) {
    if (!("mediaSession" in navigator)) return;

    const song = this.songs[index];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: "WalkPlayer",
        // Optional artwork (add real files to /icons or /artwork)
        artwork: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    } catch {}

    // Safari may ignore this, but it’s harmless elsewhere.
    this.setPlaybackState(this.isPlaying ? "playing" : "paused");
  }

  setPlaybackState(state) {
    if (!("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = state; } catch {}
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
  const items = ui.list.querySelectorAll(".item");
  items.forEach((el) => el.classList.remove("active"));
  const active = ui.list.querySelector(`.item[data-index="${index}"]`);
  if (active) active.classList.add("active");
}

function render(forceMetadata = false) {
  const cur = player.getCurrent();
  const p = player.getProgress();

  // Determine which track to display
  const idx = cur ? cur.index : player.idx;
  const song = SONGS[idx];

  ui.npTitle.textContent = song ? song.title : "Not playing";
  ui.npArtist.textContent = song ? song.artist : "—";
  ui.npMeta.textContent = song ? `Track ${idx + 1} / ${SONGS.length}` : "—";

  ui.progressBar.style.width = `${Math.round(p.ratio * 100)}%`;
  ui.timeCur.textContent = fmtTime(p.pos);
  ui.timeTot.textContent = fmtTime(p.dur);

  ui.playIcon.textContent = player.isPlaying && player.ctx?.state === "running" ? "⏸" : "▶️";
  ui.playText.textContent = player.isPlaying && player.ctx?.state === "running" ? "Pause" : "Play";

  markActive(idx);

  // Update MediaSession metadata when awake + track has changed
  if (forceMetadata && song) player.updateNowPlayingMetadata(idx);
}

function parseBatchValue(v) {
  if (v === "all") return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// Controls
ui.btnPlay.addEventListener("click", async () => {
  try {
    await player.toggle();
    // When starting from idle, toggle() will schedule and start.
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

  // If already scheduled, rebuilding ensures the new batch size takes effect immediately.
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

// Keep UI fresh when visible (timers may be throttled when locked; that's OK)
let raf = null;
function tick() {
  render(false);

  // If we detect track changed (while awake), update metadata
  // (This won’t reliably run while screen is locked, due to iOS throttling.)
  const cur = player.getCurrent();
  if (cur && cur.index !== lastRenderedTrackIndex) {
    lastRenderedTrackIndex = cur.index;
    player.updateNowPlayingMetadata(cur.index);
    markActive(cur.index);
  }

  raf = requestAnimationFrame(tick);
}
let lastRenderedTrackIndex = -1;

// visibility helper: when returning from lock screen, refresh metadata/UI
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    const cur = player.getCurrent();
    if (cur) player.updateNowPlayingMetadata(cur.index);
    render(true);
  }
});

// Initial UI
buildList();
player.setBatchSize(parseBatchValue(ui.batchSize.value));
render(true);
raf = requestAnimationFrame(tick);

// --- PWA service worker registration ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
      // no-op; keep UI quiet
    } catch {
      // ignore
    }
  });
}