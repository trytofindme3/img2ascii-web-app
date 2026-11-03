// img2ascii — converts images, GIFs and videos to ASCII art right in the browser.
// No libraries, no server: every frame is shrunk on a canvas,
// and every tiny pixel becomes one character.

// ---------- Character sets (always ordered from "empty" to "dense") ----------
const CHARSETS = {
  standard: " .:-=+*#%@",
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks:   " ░▒▓█",
  classic:  " .-~:+!*#$@",   // the ramp from the original C# console version
  binary:   " 01",
};

const DEFAULTS = {
  cols: 120, charset: "standard", customChars: "", colorMode: "mono",
  tint: "#7CFF6B", bgMode: "dark", bright: 0, contrast: 0, fontSize: 12, invert: false,
};

const FONT_FAMILY = '"JetBrains Mono", "Space Mono", monospace';
const LINE_HEIGHT = 1.15;            // line height relative to the font size
const BG_COLORS = { dark: "#0a0a0a", light: "#f4f1ea" };
const INK_COLORS = { dark: "#e8e8e8", light: "#141414", none: "#e8e8e8" };

const WEBM_FPS = 30;
const GIF_FPS = 12.5;                // for videos; GIF delays are in 1/100 s, so 8 → 12.5 fps
const GIF_MAX_SECONDS = 15;          // longer videos are cut, GIFs get huge very fast

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $("fileInput"), demoBtn: $("demoBtn"), dropzone: $("dropzone"),
  canvasWrap: $("canvasWrap"), canvas: $("canvas"), output: document.querySelector(".output"),
  settingsFields: $("settingsFields"),
  cols: $("cols"), colsOut: $("colsOut"), charset: $("charset"), customChars: $("customChars"),
  colorMode: $("colorMode"), tintRow: $("tintRow"), tint: $("tint"), tintHex: $("tintHex"),
  bgMode: $("bgMode"), bright: $("bright"), brightOut: $("brightOut"),
  contrast: $("contrast"), contrastOut: $("contrastOut"),
  fontSize: $("fontSize"), fontOut: $("fontOut"), invert: $("invert"), resetBtn: $("resetBtn"),
  playerBar: $("playerBar"), playBtn: $("playBtn"), seek: $("seek"), timeText: $("timeText"),
  statCols: $("statCols"), statRows: $("statRows"), statChars: $("statChars"), statSize: $("statSize"),
  outPath: $("outPath"), outTag: $("outTag"), statusDot: $("statusDot"), statusText: $("statusText"),
  exportButtons: document.querySelectorAll("[data-export]"), toast: $("toast"),
};
const ctx = el.canvas.getContext("2d");

// ---------- State ----------
let player = null;          // what is shown: an image, a GIF or a video (see "Players" below)
let sourceName = "image";   // file name without extension, used for exports
let result = null;          // last converted frame: { cells, colors, cols, rows, charW, lineH, settings }
let dirty = false;          // settings or frame changed → needs a redraw
let renderQueued = false;
let loopRunning = false;    // the playback loop is active
let busy = null;            // running WebM/GIF export: { type, btn, label, stop }
let scrubbing = false;      // user is dragging the timeline

// ---------- Reading settings from the UI ----------
function segmentedValue(group) {
  return group.querySelector("button.active").dataset.value;
}

function readSettings() {
  let chars = CHARSETS[el.charset.value];
  if (el.charset.value === "custom") {
    // keep unique characters only, and always have at least 2
    chars = [...new Set(el.customChars.value)].join("") || CHARSETS.standard;
    if (chars.length < 2) chars = " " + chars;
  }
  return {
    cols: +el.cols.value,
    chars: [...chars],                 // spread handles multi-byte chars like ░
    colorMode: segmentedValue(el.colorMode),
    bgMode: segmentedValue(el.bgMode),
    tint: el.tint.value,
    bright: +el.bright.value / 100,    // -1 … 1
    contrast: +el.contrast.value / 100,// -1 … 1
    fontSize: +el.fontSize.value,
    invert: el.invert.checked,
  };
}

function updateLabels() {
  el.colsOut.textContent = `${el.cols.value} cols`;
  el.brightOut.textContent = el.bright.value;
  el.contrastOut.textContent = el.contrast.value;
  el.fontOut.textContent = `${el.fontSize.value} px`;
  el.tintHex.textContent = el.tint.value.toUpperCase();
  el.customChars.classList.toggle("hidden", el.charset.value !== "custom");
  el.tintRow.classList.toggle("hidden", segmentedValue(el.colorMode) !== "tint");
}

// ---------- Image → small pixel grid ----------
function sizeOf(src) {
  return {
    w: src.videoWidth || src.naturalWidth || src.width,
    h: src.videoHeight || src.naturalHeight || src.height,
  };
}

// Reusable canvases, so playing a video doesn't create new ones every frame.
// Slot 0 is the final one we read pixels from.
const scratch = [];
function scratchCanvas(slot, w, h) {
  if (!scratch[slot]) {
    const c = document.createElement("canvas");
    scratch[slot] = { c, g: c.getContext("2d", slot === 0 ? { willReadFrequently: true } : undefined) };
  }
  const s = scratch[slot];
  if (s.c.width !== w || s.c.height !== h) { s.c.width = w; s.c.height = h; }
  else s.g.clearRect(0, 0, w, h);
  s.g.imageSmoothingQuality = "high";
  return s;
}

// Shrinking in steps of 2× averages the pixels much better than one big jump,
// so each character represents the average of its whole block, not one random pixel.
function downscale(src, targetW, targetH) {
  let { w, h } = sizeOf(src);
  let current = src, slot = 1;

  while (w / 2 >= targetW * 2 && h / 2 >= targetH * 2) {
    w = Math.floor(w / 2);
    h = Math.floor(h / 2);
    const step = scratchCanvas(slot++, w, h);
    step.g.drawImage(current, 0, 0, w, h);
    current = step.c;
  }

  const out = scratchCanvas(0, targetW, targetH);
  out.g.drawImage(current, 0, 0, targetW, targetH);
  return out.g.getImageData(0, 0, targetW, targetH).data;
}

// ---------- Pixel grid → characters ----------
// cells[i] = index of the character in s.chars; colors = RGBA per cell (color mode only)
function convert(src, s) {
  ctx.font = `${s.fontSize}px ${FONT_FAMILY}`;
  const charW = ctx.measureText("M").width;
  const lineH = s.fontSize * LINE_HEIGHT;

  const { w: imgW, h: imgH } = sizeOf(src);
  const cols = s.cols;
  // characters are taller than wide, so we need fewer rows than columns
  const rows = Math.max(1, Math.round(cols * (imgH / imgW) * (charW / lineH)));

  const px = downscale(src, cols, rows);
  const n = s.chars.length;
  // contrast: -1 → flat grey, 0 → unchanged, +1 → 4× steeper
  const contrastFactor = s.contrast >= 0 ? 1 + s.contrast * 3 : 1 + s.contrast;
  const lightBg = s.bgMode === "light";

  const cells = new Uint16Array(cols * rows);
  const colors = s.colorMode === "color" ? new Uint8ClampedArray(cols * rows * 4) : null;

  for (let i = 0, p = 0; i < cells.length; i++, p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2], a = px[p + 3] / 255;

    // perceived brightness (green looks brighter to us than blue)
    let lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    lum = (lum - 0.5) * contrastFactor + 0.5 + s.bright * 0.6;
    lum = Math.min(1, Math.max(0, lum));

    // "ink" = how dense the character should be.
    // On a dark background bright pixels need dense chars; on light — the opposite.
    let ink = lightBg ? 1 - lum : lum;
    if (s.invert) ink = 1 - ink;
    ink *= a;                                   // transparent pixels become spaces
    cells[i] = Math.min(n - 1, Math.round(ink * (n - 1)));

    if (colors) {
      // On a dark background the char density already shows brightness,
      // so the color itself is pushed to full brightness to look vivid.
      const max = Math.max(r, g, b);
      if (!lightBg && max < 24) {
        // pure black has no hue to boost (happens with Invert) → plain ink color
        colors[p] = colors[p + 1] = colors[p + 2] = 0xe8;
      } else {
        const k = lightBg ? 1 : 255 / max;
        colors[p] = r * k; colors[p + 1] = g * k; colors[p + 2] = b * k;
      }
      colors[p + 3] = 255;
    }
  }

  return { cells, colors, cols, rows, charW, lineH, settings: s };
}

function textLines(res) {
  const { cells, cols, rows } = res, chars = res.settings.chars;
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) line += chars[cells[y * cols + x]];
    lines.push(line);
  }
  return lines;
}

// ---------- Characters → canvas ----------
// Every character is rendered once into a strip ("atlas") and then copied with drawImage —
// many times faster than fillText per cell, which matters for video.
const ATLAS_PAD = 2;
let atlas = null;

function glyphAtlas(chars, fontSize, color, charW, lineH) {
  const key = `${chars.join("")}|${fontSize}|${color}`;
  if (atlas && atlas.key === key) return atlas;

  const cw = Math.ceil(charW) + ATLAS_PAD * 2, ch = Math.ceil(lineH) + ATLAS_PAD * 2;
  const c = document.createElement("canvas");
  c.width = cw * chars.length;
  c.height = ch;
  const g = c.getContext("2d");
  g.font = `${fontSize}px ${FONT_FAMILY}`;
  g.textBaseline = "top";
  g.fillStyle = color;
  chars.forEach((chr, i) => { if (chr !== " ") g.fillText(chr, i * cw + ATLAS_PAD, ATLAS_PAD); });

  atlas = { key, c, cw, ch, blank: chars.map((chr) => chr === " ") };
  return atlas;
}

// offscreen layer + tiny "one pixel per cell" canvas, used by color mode
let layer = null;
const colorGrid = document.createElement("canvas");
const colorGridCtx = colorGrid.getContext("2d");

function getLayer(w, h) {
  if (!layer) {
    const c = document.createElement("canvas");
    layer = { c, g: c.getContext("2d") };
  }
  if (layer.c.width !== w || layer.c.height !== h) { layer.c.width = w; layer.c.height = h; }
  else layer.g.clearRect(0, 0, w, h);
  return layer.g;
}

function paintBackground(s, w, h) {
  if (s.bgMode !== "none") {
    ctx.fillStyle = BG_COLORS[s.bgMode];
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.clearRect(0, 0, w, h);
  }
}

function draw(res) {
  const s = res.settings;
  const pad = Math.round(s.fontSize);
  const width = Math.ceil(res.cols * res.charW) + pad * 2;
  const height = Math.ceil(res.rows * res.lineH) + pad * 2;
  if (el.canvas.width !== width || el.canvas.height !== height) {
    el.canvas.width = width;
    el.canvas.height = height;
  }

  const colorMode = s.colorMode === "color";
  const ink = colorMode ? "#ffffff" : s.colorMode === "tint" ? s.tint : INK_COLORS[s.bgMode];
  const a = glyphAtlas(s.chars, s.fontSize, ink, res.charW, res.lineH);

  // in color mode glyphs go to a separate layer first, to be colored there
  const target = colorMode ? getLayer(width, height) : ctx;
  if (!colorMode) paintBackground(s, width, height);

  for (let y = 0; y < res.rows; y++) {
    const dy = Math.round(pad + y * res.lineH) - ATLAS_PAD;
    const row = y * res.cols;
    for (let x = 0; x < res.cols; x++) {
      const ci = res.cells[row + x];
      if (a.blank[ci]) continue;
      target.drawImage(a.c, ci * a.cw, 0, a.cw, a.ch,
        Math.round(pad + x * res.charW) - ATLAS_PAD, dy, a.cw, a.ch);
    }
  }

  if (colorMode) {
    // stretch the cols×rows color grid over the white glyphs: "source-in" keeps
    // the glyph shapes and takes the color from the grid underneath each one
    if (colorGrid.width !== res.cols || colorGrid.height !== res.rows) {
      colorGrid.width = res.cols;
      colorGrid.height = res.rows;
    }
    colorGridCtx.putImageData(new ImageData(res.colors, res.cols, res.rows), 0, 0);
    target.globalCompositeOperation = "source-in";
    target.imageSmoothingEnabled = false;
    target.drawImage(colorGrid, pad, pad, res.cols * res.charW, res.rows * res.lineH);
    target.globalCompositeOperation = "source-over";
    target.imageSmoothingEnabled = true;

    paintBackground(s, width, height);
    ctx.drawImage(layer.c, 0, 0);
  }
}

// ---------- Render loop ----------
function renderNow() {
  if (!player) return;
  dirty = false;
  const t0 = performance.now();
  result = convert(player.frame(), readSettings());
  draw(result);
  updateStats(Math.round(performance.now() - t0));
  if (player.kind === "image") hintIfEmpty();
}

// settings changed → redraw once on the next frame (or the playback loop picks it up)
function requestRender() {
  updateLabels();
  if (!player) return;
  dirty = true;
  if (loopRunning || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (dirty) renderNow();
  });
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  requestAnimationFrame(tick);
}

function tick(now) {
  if (!player || !player.playing) {
    loopRunning = false;
    if (dirty) renderNow();
    updatePlayerUI();
    return;
  }
  if (player.update(now) || dirty) renderNow();
  updatePlayerUI();
  requestAnimationFrame(tick);
}

// e.g. a black logo on a transparent background disappears on a dark background
let hintShown = false;
function hintIfEmpty() {
  const chars = result.settings.chars;
  let filled = 0;
  for (const c of result.cells) if (chars[c] !== " ") filled++;
  if (filled < result.cells.length * 0.01) {
    if (!hintShown) toast("Looks empty — try Invert or another background");
    hintShown = true;
  } else {
    hintShown = false;
  }
}

function updateStats(ms) {
  el.statCols.textContent = result.cols;
  el.statRows.textContent = result.rows;
  el.statChars.textContent = (result.cols * result.rows).toLocaleString("en-US");
  el.statSize.textContent = `${el.canvas.width}×${el.canvas.height}`;
  if (!busy) el.statusText.textContent = `${player.playing ? "playing" : "ready"} · ${ms} ms`;
}

// ---------- Players: one interface for images, GIFs and videos ----------
//   frame()      → what to convert right now
//   update(now)  → true when playback moved on to a new frame
//   play/pause/seek, playing, currentTime, duration (seconds), loop, onended

function imagePlayer(img) {
  return {
    kind: "image", animated: false, playing: false,
    frame: () => img, update: () => false,
    play() {}, pause() {}, seek: async () => {}, destroy() {},
  };
}

function gifPlayer(frames) {
  const starts = [];
  let total = 0;
  for (const f of frames) { starts.push(total); total += f.delay; }
  const indexAt = (t) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= t) i++;
    return i;
  };

  const p = {
    kind: "gif", animated: true, playing: false, loop: true, onended: null,
    frames, starts, duration: total, currentTime: 0, index: 0, last: 0,
    frame: () => frames[p.index].canvas,
    play() {
      if (p.currentTime >= total) p.seek(0);
      p.playing = true;
      p.last = performance.now();
    },
    pause() { p.playing = false; },
    async seek(t) {
      p.currentTime = Math.min(Math.max(0, t), total);
      p.index = indexAt(Math.min(p.currentTime, total - 1e-6));
    },
    update(now) {
      if (!p.playing) return false;
      let t = p.currentTime + Math.max(0, now - p.last) / 1000;
      p.last = now;
      if (t >= total) {
        if (p.loop) {
          t %= total;
        } else {
          p.currentTime = total;
          p.playing = false;
          p.onended?.();
          return false;
        }
      }
      p.currentTime = t;
      const i = indexAt(t);
      if (i === p.index) return false;
      p.index = i;
      return true;
    },
    destroy() {},
  };
  return p;
}

function videoPlayer(video, url) {
  // requestVideoFrameCallback tells us exactly when a new video frame is ready;
  // without it, fall back to "has the time changed?"
  let fresh = true, lastTime = -1, dead = false;
  const hasRVFC = "requestVideoFrameCallback" in video;
  if (hasRVFC) {
    const onFrame = () => { fresh = true; if (!dead) video.requestVideoFrameCallback(onFrame); };
    video.requestVideoFrameCallback(onFrame);
  }

  const p = {
    kind: "video", animated: true, loop: true, onended: null,
    get playing() { return !video.paused && !video.ended; },
    get duration() { return Number.isFinite(video.duration) ? video.duration : 0; },
    get currentTime() { return video.currentTime; },
    frame: () => video,
    play() {
      video.loop = p.loop;
      if (video.ended) video.currentTime = 0;
      video.play().catch(() => {});
    },
    pause() { video.pause(); },
    seek(t) {
      return new Promise((resolve) => {
        t = Math.min(Math.max(0, t), p.duration);
        if (Math.abs(video.currentTime - t) < 1e-4) return resolve();
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.currentTime = t;
      });
    },
    update() {
      if (hasRVFC) { const f = fresh; fresh = false; return f; }
      if (video.currentTime === lastTime) return false;
      lastTime = video.currentTime;
      return true;
    },
    destroy() {
      dead = true;
      video.dataset.dead = "1";
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    },
  };
  video.addEventListener("ended", () => p.onended?.());
  return p;
}

// ---------- Loading files ----------
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;

function loadFile(file) {
  if (!file) return;
  if (busy) { toast("Wait until the export is finished"); return; }
  if (file.type.startsWith("video/") || (!file.type && VIDEO_EXT.test(file.name))) loadVideo(file);
  else if (file.type === "image/gif") loadGif(file);
  else if (file.type.startsWith("image/")) loadImage(file);
  else toast("That's not an image or a video");
}

const baseName = (file) => file.name.replace(/\.[^.]+$/, "") || "image";

function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    setPlayer(imagePlayer(img), baseName(file));
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast("Couldn't read this image");
  };
  img.src = url;
}

async function loadGif(file) {
  el.statusText.textContent = "decoding gif…";
  try {
    const gif = await GIF.decode(await file.arrayBuffer());
    if (gif.truncated) toast(`Huge GIF — loaded the first ${gif.frames.length} frames`);
    const p = gif.frames.length > 1 ? gifPlayer(gif.frames) : imagePlayer(gif.frames[0].canvas);
    setPlayer(p, baseName(file));
  } catch {
    loadImage(file);   // broken animation → let the browser show it as a still image
  }
}

function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.loop = true;
  video.preload = "auto";
  // kept in the page (but invisible): some browsers stop decoding detached videos
  video.className = "video-source";

  video.addEventListener("loadeddata", async () => {
    // WebM files from MediaRecorder often don't know their length until seeked to the end
    if (video.duration === Infinity) await fixDuration(video);
    setPlayer(videoPlayer(video, url), baseName(file));
  }, { once: true });
  video.addEventListener("error", () => {
    if (video.dataset.dead) return;
    URL.revokeObjectURL(url);
    video.remove();
    toast("Your browser can't play this video format");
  }, { once: true });
  video.addEventListener("seeked", () => { if (player?.frame() === video) requestRender(); });
  video.addEventListener("play", startLoop);
  video.addEventListener("pause", updatePlayerUI);

  document.body.appendChild(video);
  video.src = url;
}

function fixDuration(video) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("durationchange", onChange);
      video.currentTime = 0;
      resolve();
    };
    const onChange = () => { if (Number.isFinite(video.duration)) finish(); };
    video.addEventListener("durationchange", onChange);
    video.currentTime = 1e101;
    setTimeout(finish, 3000);
  });
}

function setPlayer(p, name) {
  player?.destroy();
  player = p;
  sourceName = name.replace(/[^\w\-]+/g, "_").slice(0, 60) || "image";
  hintShown = false;

  const ext = { image: "png", gif: "gif", video: "webm" }[p.kind];
  el.dropzone.classList.add("hidden");
  el.canvasWrap.classList.remove("hidden");
  el.playerBar.classList.toggle("hidden", !p.animated);
  el.outPath.textContent = `~$ output/${sourceName}.${ext}`;
  el.outTag.textContent = p.animated ? p.kind.toUpperCase() : "Live";
  el.outTag.classList.add("live");
  el.statusDot.classList.add("on");
  refreshExportButtons();

  requestRender();
  if (p.animated) {
    p.play();
    startLoop();
  }
  updatePlayerUI();
}

// A generated picture so the app can be tried without uploading anything
function makeDemo() {
  const c = document.createElement("canvas");
  c.width = 800; c.height = 600;
  const g = c.getContext("2d");

  // planet
  const planet = g.createRadialGradient(330, 240, 20, 400, 300, 220);
  planet.addColorStop(0, "#ffe2a8");
  planet.addColorStop(0.35, "#ff8a5c");
  planet.addColorStop(0.75, "#8b3fd1");
  planet.addColorStop(1, "#1b0b3a");
  g.fillStyle = planet;
  g.beginPath(); g.arc(400, 300, 210, 0, Math.PI * 2); g.fill();

  // ring
  g.save();
  g.translate(400, 300); g.rotate(-0.35); g.scale(1, 0.28);
  g.lineWidth = 34;
  const ring = g.createLinearGradient(-360, 0, 360, 0);
  ring.addColorStop(0, "rgba(80,200,255,0.5)");
  ring.addColorStop(0.5, "rgba(124,255,107,1)");
  ring.addColorStop(1, "rgba(80,200,255,0.5)");
  g.strokeStyle = ring;
  g.beginPath(); g.arc(0, 0, 330, 0.05 * Math.PI, 0.95 * Math.PI); g.stroke();
  g.restore();

  // stars
  for (let i = 0; i < 90; i++) {
    const x = (i * 97) % 800, y = (i * 53 + i * i) % 600;
    const d = Math.hypot(x - 400, y - 300);
    if (d < 230) continue;
    g.fillStyle = `rgba(255,255,255,${0.3 + (i % 7) / 10})`;
    g.fillRect(x, y, 3 + (i % 3), 3 + (i % 3));
  }
  return c;
}

// ---------- Player controls ----------
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function updatePlayerUI() {
  if (!player?.animated) return;
  el.playBtn.textContent = player.playing ? "❚❚" : "▶";
  el.playBtn.setAttribute("aria-label", player.playing ? "Pause" : "Play");
  if (!scrubbing) el.seek.value = player.duration ? (player.currentTime / player.duration) * 1000 : 0;
  let text = `${fmtTime(player.currentTime)} / ${fmtTime(player.duration)}`;
  if (player.kind === "gif") text += ` · ${player.index + 1}/${player.frames.length}`;
  el.timeText.textContent = text;
}

function togglePlay() {
  if (!player?.animated || busy) return;
  if (player.playing) player.pause();
  else { player.play(); startLoop(); }
  requestRender();
  updatePlayerUI();
}

async function seekTo(fraction) {
  if (!player?.animated || busy) return;
  await player.seek(fraction * player.duration);
  requestRender();
  updatePlayerUI();
}

// ---------- Export ----------
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Saved ${filename}`);
}

function plainText() {
  return textLines(result).map((l) => l.replace(/\s+$/, "")).join("\n");
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml() {
  const s = result.settings;
  const bg = s.bgMode === "none" ? "transparent" : BG_COLORS[s.bgMode];
  const lines = textLines(result);
  let body;

  if (s.colorMode === "color") {
    const { colors, cols } = result;
    const rgb = (i) => `rgb(${colors[i * 4]},${colors[i * 4 + 1]},${colors[i * 4 + 2]})`;
    // merge neighbouring chars of the same color into one <span>
    body = lines.map((line, y) => {
      const chars = [...line];
      let out = "", run = "", runColor = null;
      chars.forEach((ch, x) => {
        const color = ch === " " ? runColor : rgb(y * cols + x);
        if (color !== runColor && run) {
          out += runColor ? `<span style="color:${runColor}">${escapeHtml(run)}</span>` : escapeHtml(run);
          run = "";
        }
        runColor = color;
        run += ch;
      });
      if (run) out += runColor ? `<span style="color:${runColor}">${escapeHtml(run)}</span>` : escapeHtml(run);
      return out;
    }).join("\n");
  } else {
    body = escapeHtml(lines.join("\n"));
  }

  const color = s.colorMode === "tint" ? s.tint : INK_COLORS[s.bgMode];
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${sourceName} — ASCII</title></head>
<body style="margin:0;background:${bg}">
<pre style="margin:0;padding:24px;font:${s.fontSize}px/${LINE_HEIGHT} ui-monospace,Consolas,monospace;color:${color}">${body}</pre>
</body></html>`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback for browsers that block the clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied to clipboard");
}

function refreshExportButtons() {
  el.exportButtons.forEach((b) => {
    b.disabled = !player || ("anim" in b.dataset && !player.animated);
  });
}

// While a WebM/GIF is being made, settings and playback are locked
// and the pressed button turns into "Stop" (which saves what's done so far).
function beginBusy(type, btn) {
  busy = { type, btn, label: btn.textContent, stop: null, stopped: false };
  btn.textContent = "Stop";
  el.settingsFields.disabled = true;
  el.playBtn.disabled = el.seek.disabled = true;
  el.exportButtons.forEach((b) => { if (b !== btn) b.disabled = true; });
  return busy;
}

function endBusy() {
  busy.btn.textContent = busy.label;
  busy = null;
  el.settingsFields.disabled = false;
  el.playBtn.disabled = el.seek.disabled = false;
  refreshExportButtons();
  updatePlayerUI();
}

function pickRecorderType() {
  if (!window.MediaRecorder || !el.canvas.captureStream) return null;
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

// WebM: play the animation once from the start and record the canvas in real time
async function exportWebm(btn) {
  const type = pickRecorderType();
  if (!type) { toast("Your browser can't record video"); return; }

  const job = beginBusy("webm", btn);
  const p = player;
  let progress;
  try {
    p.pause();
    await p.seek(0);
    renderNow();

    const stream = el.canvas.captureStream(WEBM_FPS);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const recorded = new Promise((r) => (rec.onstop = r));
    const finished = new Promise((r) => { p.onended = r; job.stop = r; });

    rec.start(500);
    p.loop = false;
    p.play();
    startLoop();
    progress = setInterval(() => {
      el.statusText.textContent = `recording · ${fmtTime(p.currentTime)} / ${fmtTime(p.duration)}`;
    }, 200);

    await finished;
    p.pause();
    rec.stop();
    await recorded;
    stream.getTracks().forEach((t) => t.stop());

    const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
    if (chunks.length) download(new Blob(chunks, { type }), `${sourceName}-ascii.${ext}`);
  } catch (err) {
    console.error(err);
    toast("Recording failed");
  } finally {
    clearInterval(progress);
    p.onended = null;
    p.loop = true;
    endBusy();
    p.play();
    startLoop();
  }
}

// GIF: step through the animation frame by frame, convert each one and encode it
async function exportGif(btn) {
  const job = beginBusy("gif", btn);
  const p = player;
  const wasPlaying = p.playing;
  job.stop = () => {};   // checked through job.stopped inside the loop
  try {
    p.pause();

    // which moments to capture: every frame of a GIF, or a fixed frame rate for videos
    let shots;
    if (p.kind === "gif") {
      shots = p.frames.map((f, i) => ({ t: p.starts[i], delay: f.delay }));
    } else {
      const length = Math.min(p.duration, GIF_MAX_SECONDS);
      if (p.duration > GIF_MAX_SECONDS) toast(`GIF is limited to the first ${GIF_MAX_SECONDS} s`);
      shots = [];
      for (let i = 0; i * (1 / GIF_FPS) < length; i++) shots.push({ t: i / GIF_FPS, delay: 1 / GIF_FPS });
    }

    let enc = null;
    for (let i = 0; i < shots.length && !job.stopped; i++) {
      await p.seek(shots[i].t);
      renderNow();
      const { width, height } = el.canvas;
      if (!enc) enc = new GIF.Encoder(width, height);
      enc.addFrame(ctx.getImageData(0, 0, width, height).data, shots[i].delay);
      el.statusText.textContent = `encoding gif · ${i + 1}/${shots.length}`;
      await new Promise((r) => setTimeout(r));   // let the page update
    }
    if (enc) download(enc.finish(), `${sourceName}-ascii.gif`);
  } catch (err) {
    console.error(err);
    toast("GIF export failed");
  } finally {
    endBusy();
    if (wasPlaying) { p.play(); startLoop(); }
    else requestRender();
  }
}

function handleExport(type, btn) {
  if (busy) {
    if (busy.type === type) { busy.stopped = true; busy.stop?.(); }
    return;
  }
  if (!result) return;
  const base = `${sourceName}-ascii`;
  if (type === "png") {
    el.canvas.toBlob((blob) => download(blob, `${base}.png`), "image/png");
  } else if (type === "txt") {
    download(new Blob([plainText()], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
  } else if (type === "html") {
    download(new Blob([buildHtml()], { type: "text/html;charset=utf-8" }), `${base}.html`);
  } else if (type === "copy") {
    copyText(plainText());
  } else if (type === "webm") {
    exportWebm(btn);
  } else if (type === "gif") {
    exportGif(btn);
  }
}

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
}

// ---------- Reset ----------
function setSegmented(group, value) {
  group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

function resetSettings() {
  el.cols.value = DEFAULTS.cols;
  el.charset.value = DEFAULTS.charset;
  el.customChars.value = DEFAULTS.customChars;
  el.tint.value = DEFAULTS.tint;
  el.bright.value = DEFAULTS.bright;
  el.contrast.value = DEFAULTS.contrast;
  el.fontSize.value = DEFAULTS.fontSize;
  el.invert.checked = DEFAULTS.invert;
  setSegmented(el.colorMode, DEFAULTS.colorMode);
  setSegmented(el.bgMode, DEFAULTS.bgMode);
  requestRender();
}

// ---------- Events ----------
[el.cols, el.charset, el.customChars, el.tint, el.bright, el.contrast, el.fontSize, el.invert]
  .forEach((input) => input.addEventListener("input", requestRender));

[el.colorMode, el.bgMode].forEach((group) => {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    setSegmented(group, btn.dataset.value);
    requestRender();
  });
});

el.fileInput.addEventListener("change", () => {
  loadFile(el.fileInput.files[0]);
  el.fileInput.value = "";          // allows choosing the same file again
});
el.dropzone.addEventListener("click", () => el.fileInput.click());
el.demoBtn.addEventListener("click", () => { if (!busy) setPlayer(imagePlayer(makeDemo()), "demo"); });
el.resetBtn.addEventListener("click", resetSettings);
el.exportButtons.forEach((b) => b.addEventListener("click", () => handleExport(b.dataset.export, b)));

el.playBtn.addEventListener("click", togglePlay);
el.seek.addEventListener("pointerdown", () => (scrubbing = true));
window.addEventListener("pointerup", () => (scrubbing = false));
el.seek.addEventListener("input", () => seekTo(el.seek.value / 1000));

// drag & drop anywhere on the page
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  el.dropzone.classList.add("drag");
  el.output.classList.add("drag");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.dropzone.classList.remove("drag");
    el.output.classList.remove("drag");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.dropzone.classList.remove("drag");
  el.output.classList.remove("drag");
  loadFile(e.dataTransfer.files[0]);
});

// paste an image with Ctrl+V
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) loadFile(item.getAsFile());
});

// redraw once the web fonts are ready (canvas needs them loaded to measure correctly)
document.fonts.load(`12px ${FONT_FAMILY}`).finally(() => {
  atlas = null;      // glyphs drawn with a fallback font must be redrawn
  requestRender();
});
updateLabels();
