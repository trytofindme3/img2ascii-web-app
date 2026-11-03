// img2ascii — converts an image to ASCII art right in the browser.
// No libraries, no server: the image is read, shrunk on a canvas,
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

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  fileInput: $("fileInput"), demoBtn: $("demoBtn"), dropzone: $("dropzone"),
  canvasWrap: $("canvasWrap"), canvas: $("canvas"), output: document.querySelector(".output"),
  cols: $("cols"), colsOut: $("colsOut"), charset: $("charset"), customChars: $("customChars"),
  colorMode: $("colorMode"), tintRow: $("tintRow"), tint: $("tint"), tintHex: $("tintHex"),
  bgMode: $("bgMode"), bright: $("bright"), brightOut: $("brightOut"),
  contrast: $("contrast"), contrastOut: $("contrastOut"),
  fontSize: $("fontSize"), fontOut: $("fontOut"), invert: $("invert"), resetBtn: $("resetBtn"),
  statCols: $("statCols"), statRows: $("statRows"), statChars: $("statChars"), statSize: $("statSize"),
  outPath: $("outPath"), outTag: $("outTag"), statusDot: $("statusDot"), statusText: $("statusText"),
  exportButtons: document.querySelectorAll("[data-export]"), toast: $("toast"),
};
const ctx = el.canvas.getContext("2d");

// ---------- State ----------
let source = null;          // loaded image (HTMLImageElement or canvas)
let sourceName = "image";   // file name without extension, used for exports
let result = null;          // last conversion: { lines, colors, cols, rows, settings }
let renderQueued = false;

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
// Shrinking in steps of 2× averages the pixels much better than one big jump,
// so each character represents the average of its whole block, not one random pixel.
function downscale(img, targetW, targetH) {
  let current = img;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;

  while (w / 2 >= targetW * 2 && h / 2 >= targetH * 2) {
    w = Math.floor(w / 2);
    h = Math.floor(h / 2);
    const step = document.createElement("canvas");
    step.width = w; step.height = h;
    const sctx = step.getContext("2d");
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(current, 0, 0, w, h);
    current = step;
  }

  const out = document.createElement("canvas");
  out.width = targetW; out.height = targetH;
  const octx = out.getContext("2d", { willReadFrequently: true });
  octx.imageSmoothingQuality = "high";
  octx.drawImage(current, 0, 0, targetW, targetH);
  return octx.getImageData(0, 0, targetW, targetH).data;
}

// ---------- Pixel grid → characters ----------
function convert(img, s) {
  ctx.font = `${s.fontSize}px ${FONT_FAMILY}`;
  const charW = ctx.measureText("M").width;
  const lineH = s.fontSize * LINE_HEIGHT;

  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;
  const cols = s.cols;
  // characters are taller than wide, so we need fewer rows than columns
  const rows = Math.max(1, Math.round(cols * (imgH / imgW) * (charW / lineH)));

  const px = downscale(img, cols, rows);
  const n = s.chars.length;
  // contrast: -1 → flat grey, 0 → unchanged, +1 → 4× steeper
  const contrastFactor = s.contrast >= 0 ? 1 + s.contrast * 3 : 1 + s.contrast;
  const lightBg = s.bgMode === "light";

  const lines = [];
  const colors = [];   // per-cell color, only filled in "color" mode
  for (let y = 0; y < rows; y++) {
    let line = "";
    const rowColors = [];
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3] / 255;

      // perceived brightness (green looks brighter to us than blue)
      let lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lum = (lum - 0.5) * contrastFactor + 0.5 + s.bright * 0.6;
      lum = Math.min(1, Math.max(0, lum));

      // "ink" = how dense the character should be.
      // On a dark background bright pixels need dense chars; on light — the opposite.
      let ink = lightBg ? 1 - lum : lum;
      if (s.invert) ink = 1 - ink;
      ink *= a;                                 // transparent pixels become spaces

      const idx = Math.min(n - 1, Math.round(ink * (n - 1)));
      line += s.chars[idx];
      if (s.colorMode === "color") {
        // On a dark background the char density already shows brightness,
        // so the color itself is pushed to full brightness to look vivid.
        const max = Math.max(r, g, b);
        if (!lightBg && max < 24) {
          // pure black has no hue to boost (happens with Invert) → plain ink color
          rowColors.push(INK_COLORS.dark);
        } else {
          const k = lightBg ? 1 : 255 / max;
          rowColors.push(`rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`);
        }
      }
    }
    lines.push(line);
    colors.push(rowColors);
  }

  return { lines, colors, cols, rows, charW, lineH, settings: s };
}

// ---------- Characters → canvas ----------
function draw(res) {
  const s = res.settings;
  const pad = Math.round(s.fontSize);
  const width = Math.ceil(res.cols * res.charW) + pad * 2;
  const height = Math.ceil(res.rows * res.lineH) + pad * 2;

  el.canvas.width = width;
  el.canvas.height = height;

  if (s.bgMode !== "none") {
    ctx.fillStyle = BG_COLORS[s.bgMode];
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  ctx.font = `${s.fontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = "top";

  if (s.colorMode === "color") {
    // one fillText per character, each with its own color
    for (let y = 0; y < res.rows; y++) {
      const line = [...res.lines[y]];
      const ty = pad + y * res.lineH;
      for (let x = 0; x < line.length; x++) {
        if (line[x] === " ") continue;
        ctx.fillStyle = res.colors[y][x];
        ctx.fillText(line[x], pad + x * res.charW, ty);
      }
    }
  } else {
    // same color everywhere → set it once. Chars are still placed one by one,
    // so the grid stays exact even if a symbol (like ░) comes from a fallback font.
    ctx.fillStyle = s.colorMode === "tint" ? s.tint : INK_COLORS[s.bgMode];
    for (let y = 0; y < res.rows; y++) {
      const line = [...res.lines[y]];
      for (let x = 0; x < line.length; x++) {
        if (line[x] !== " ") ctx.fillText(line[x], pad + x * res.charW, pad + y * res.lineH);
      }
    }
  }
}

// ---------- Render loop ----------
function requestRender() {
  updateLabels();
  if (!source || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const t0 = performance.now();
    result = convert(source, readSettings());
    draw(result);
    const ms = Math.round(performance.now() - t0);
    updateStats(ms);
    hintIfEmpty();
  });
}

// e.g. a black logo on a transparent background disappears on a dark background
let hintShown = false;
function hintIfEmpty() {
  const filled = result.lines.join("").replace(/ /g, "").length;
  if (filled < result.cols * result.rows * 0.01) {
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
  el.statusText.textContent = `ready · ${ms} ms`;
}

// ---------- Loading images ----------
function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("That's not an image file");
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    setSource(img, file.name.replace(/\.[^.]+$/, "") || "image");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast("Couldn't read this image");
  };
  img.src = url;
}

function setSource(img, name) {
  source = img;
  sourceName = name.replace(/[^\w\-]+/g, "_").slice(0, 60) || "image";
  el.dropzone.classList.add("hidden");
  el.canvasWrap.classList.remove("hidden");
  el.outPath.textContent = `~$ output/${sourceName}.png`;
  el.outTag.textContent = "Live";
  el.outTag.classList.add("live");
  el.statusDot.classList.add("on");
  el.exportButtons.forEach((b) => (b.disabled = false));
  requestRender();
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
  return result.lines.map((l) => l.replace(/\s+$/, "")).join("\n");
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml() {
  const s = result.settings;
  const bg = s.bgMode === "none" ? "transparent" : BG_COLORS[s.bgMode];
  let body;

  if (s.colorMode === "color") {
    // merge neighbouring chars of the same color into one <span>
    body = result.lines.map((line, y) => {
      const chars = [...line];
      let out = "", run = "", runColor = null;
      chars.forEach((ch, x) => {
        const color = ch === " " ? runColor : result.colors[y][x];
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
    body = escapeHtml(result.lines.join("\n"));
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

function handleExport(type) {
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
  }
}

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
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
    if (!btn) return;
    setSegmented(group, btn.dataset.value);
    requestRender();
  });
});

el.fileInput.addEventListener("change", () => {
  loadFile(el.fileInput.files[0]);
  el.fileInput.value = "";          // allows choosing the same file again
});
el.dropzone.addEventListener("click", () => el.fileInput.click());
el.demoBtn.addEventListener("click", () => setSource(makeDemo(), "demo"));
el.resetBtn.addEventListener("click", resetSettings);
el.exportButtons.forEach((b) => b.addEventListener("click", () => handleExport(b.dataset.export)));

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
document.fonts.load(`12px ${FONT_FAMILY}`).finally(requestRender);
updateLabels();
