// gif.js — a tiny GIF decoder and encoder, written from scratch for img2ascii.
//   GIF.decode(buffer)   → { width, height, frames: [{ canvas, delay }], truncated }
//   new GIF.Encoder(w,h) → .addFrame(rgba, delaySeconds) … .finish() → Blob

const GIF = (() => {
  // ======================= Decoding =======================

  // Image data in a GIF is split into sub-blocks of up to 255 bytes; glue them together.
  function readSubBlocks(bytes, pos) {
    let total = 0;
    for (let p = pos; p < bytes.length && bytes[p] !== 0; p += bytes[p] + 1) total += bytes[p];
    const data = new Uint8Array(total);
    let o = 0, p = pos;
    while (p < bytes.length && bytes[p] !== 0) {
      const len = bytes[p];
      data.set(bytes.subarray(p + 1, p + 1 + len), o);
      o += len;
      p += len + 1;
    }
    return { data, pos: p + 1 };
  }

  // LZW → palette indices
  function lzwDecode(minCodeSize, data, pixelCount) {
    const out = new Uint8Array(pixelCount);
    const clear = 1 << minCodeSize, eoi = clear + 1;
    const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) suffix[i] = i;

    let codeSize = minCodeSize + 1, next = eoi + 1, old = -1, first = 0;
    let datum = 0, bits = 0, pos = 0, op = 0;

    while (op < pixelCount) {
      while (bits < codeSize) {
        if (pos >= data.length) return out;          // data ended early — keep what we have
        datum |= data[pos++] << bits;
        bits += 8;
      }
      let code = datum & ((1 << codeSize) - 1);
      datum >>>= codeSize;
      bits -= codeSize;

      if (code === clear) { codeSize = minCodeSize + 1; next = eoi + 1; old = -1; continue; }
      if (code === eoi) break;
      if (old === -1) { out[op++] = suffix[code]; old = first = code; continue; }

      const inCode = code;
      let sp = 0;
      if (code >= next) { stack[sp++] = first; code = old; }   // the "KwKwK" case
      while (code > eoi && sp < 4096) { stack[sp++] = suffix[code]; code = prefix[code]; }
      first = code;
      stack[sp++] = first;

      if (next < 4096) {
        prefix[next] = old;
        suffix[next] = first;
        next++;
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
      }
      old = inCode;
      while (sp > 0 && op < pixelCount) out[op++] = stack[--sp];
    }
    return out;
  }

  // Interlaced GIFs store rows in 4 passes; map "stored row" → "real row".
  function rowOrder(h, interlaced) {
    const rows = new Uint32Array(h);
    if (!interlaced) { for (let i = 0; i < h; i++) rows[i] = i; return rows; }
    let i = 0;
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
      for (let y = start; y < h; y += step) rows[i++] = y;
    }
    return rows;
  }

  // Walks through the file and calls onFrame(rgba, delay, width, height) with every
  // fully composed frame. Return false from onFrame to stop early.
  async function parse(buffer, onFrame) {
    const b = new Uint8Array(buffer);
    const sig = String.fromCharCode(...b.subarray(0, 6));
    if (!/^GIF8[79]a$/.test(sig)) throw new Error("Not a GIF");

    const u16 = (p) => b[p] | (b[p + 1] << 8);
    const width = u16(6), height = u16(8);
    if (!width || !height) throw new Error("Empty GIF");

    let pos = 13, globalTable = null;
    if (b[10] & 0x80) {
      const n = 2 << (b[10] & 7);
      globalTable = b.subarray(pos, pos + n * 3);
      pos += n * 3;
    }

    const screen = new Uint8ClampedArray(width * height * 4);   // the composed picture
    let gce = { disposal: 0, transparent: -1, delay: 0 };
    let count = 0;

    while (pos < b.length) {
      const block = b[pos++];

      if (block === 0x21) {                        // extension
        const label = b[pos++];
        const sub = readSubBlocks(b, pos);
        pos = sub.pos;
        if (label === 0xF9 && sub.data.length >= 4) {  // graphic control: delay, transparency
          const d = sub.data;
          gce = { disposal: (d[0] >> 2) & 7, transparent: d[0] & 1 ? d[3] : -1, delay: d[1] | (d[2] << 8) };
        }
      } else if (block === 0x2C) {                 // image
        const fx = u16(pos), fy = u16(pos + 2), fw = u16(pos + 4), fh = u16(pos + 6), flags = b[pos + 8];
        pos += 9;
        let table = globalTable;
        if (flags & 0x80) {
          const n = 2 << (flags & 7);
          table = b.subarray(pos, pos + n * 3);
          pos += n * 3;
        }
        const minCode = b[pos++];
        const sub = readSubBlocks(b, pos);
        pos = sub.pos;
        if (minCode < 1 || minCode > 11) break;    // corrupt

        const saved = gce.disposal === 3 ? screen.slice() : null;
        if (table) {
          const indices = lzwDecode(minCode, sub.data, fw * fh);
          const rows = rowOrder(fh, flags & 0x40);
          for (let r = 0; r < fh; r++) {
            const y = fy + rows[r];
            if (y >= height) continue;
            for (let c = 0; c < fw; c++) {
              const x = fx + c;
              if (x >= width) break;
              const ci = indices[r * fw + c];
              if (ci === gce.transparent) continue;
              const o = (y * width + x) * 4, t = ci * 3;
              screen[o] = table[t]; screen[o + 1] = table[t + 1]; screen[o + 2] = table[t + 2]; screen[o + 3] = 255;
            }
          }
        }

        // browsers treat delays of 0–1 (1/100 s) as 0.1 s
        const delay = gce.delay > 1 ? gce.delay / 100 : 0.1;
        if (onFrame(screen, delay, width, height) === false) break;
        count++;

        // prepare the screen for the next frame
        if (gce.disposal === 2) {
          for (let y = fy; y < Math.min(height, fy + fh); y++) {
            screen.fill(0, (y * width + fx) * 4, (y * width + Math.min(width, fx + fw)) * 4);
          }
        } else if (saved) {
          screen.set(saved);
        }
        gce = { disposal: 0, transparent: -1, delay: 0 };
        if (count % 10 === 0) await new Promise((r) => setTimeout(r));   // keep the page responsive
      } else {
        break;                                     // 0x3B = end of file, anything else = corrupt
      }
    }
    return { width, height };
  }

  // Decodes into canvases. Huge GIFs are scaled down (800 px is plenty for 300 columns),
  // and decoding stops once ~maxPixels are stored so memory doesn't explode.
  async function decode(buffer, { maxSide = 800, maxPixels = 120e6 } = {}) {
    const frames = [];
    let work, wctx, outW, outH, stored = 0, truncated = false;

    await parse(buffer, (rgba, delay, width, height) => {
      if (!work) {
        work = document.createElement("canvas");
        work.width = width; work.height = height;
        wctx = work.getContext("2d");
        const scale = Math.min(1, maxSide / Math.max(width, height));
        outW = Math.max(1, Math.round(width * scale));
        outH = Math.max(1, Math.round(height * scale));
      }
      wctx.putImageData(new ImageData(rgba, width, height), 0, 0);
      const canvas = document.createElement("canvas");
      canvas.width = outW; canvas.height = outH;
      const g = canvas.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(work, 0, 0, outW, outH);
      frames.push({ canvas, delay });

      stored += outW * outH;
      if (stored > maxPixels) { truncated = true; return false; }
    });

    if (!frames.length) throw new Error("No frames");
    return { width: outW, height: outH, frames, truncated };
  }

  // ======================= Encoding =======================

  // Growable byte buffer
  class Bytes {
    constructor(size) { this.buf = new Uint8Array(size); this.len = 0; }
    reserve(n) {
      if (this.len + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.len + n) size *= 2;
      const bigger = new Uint8Array(size);
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    byte(v) { this.reserve(1); this.buf[this.len++] = v; }
    u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
    bytes(arr) { this.reserve(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
    str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    result() { return this.buf.subarray(0, this.len); }
  }

  // Median cut: keep splitting the box of colors with the widest spread
  // until we have enough boxes; each box becomes one palette color.
  const CHANNEL = [(k) => (k >> 10) & 31, (k) => (k >> 5) & 31, (k) => k & 31];

  function medianCut(colors, hist, maxBoxes) {
    const describe = (start, end) => {
      const lo = [31, 31, 31], hi = [0, 0, 0];
      let weight = 0;
      for (let i = start; i < end; i++) {
        const k = colors[i];
        weight += hist[k];
        for (let c = 0; c < 3; c++) {
          const v = CHANNEL[c](k);
          if (v < lo[c]) lo[c] = v;
          if (v > hi[c]) hi[c] = v;
        }
      }
      let axis = 0;
      for (let c = 1; c < 3; c++) if (hi[c] - lo[c] > hi[axis] - lo[axis]) axis = c;
      return { start, end, axis, range: hi[axis] - lo[axis], weight };
    };

    const boxes = colors.length ? [describe(0, colors.length)] : [];
    while (boxes.length < maxBoxes) {
      let best = -1, bestScore = 0;
      boxes.forEach((box, i) => {
        const score = box.end - box.start > 1 ? box.range * box.weight : 0;
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) break;

      const box = boxes[best], f = CHANNEL[box.axis];
      colors.subarray(box.start, box.end).sort((a, b) => f(a) - f(b));
      // split where half of the box's pixels are on each side
      let acc = 0, mid = box.end - 1;
      for (let i = box.start; i < box.end; i++) {
        acc += hist[colors[i]];
        if (acc >= box.weight / 2) { mid = i + 1; break; }
      }
      mid = Math.min(box.end - 1, Math.max(box.start + 1, mid));
      boxes.splice(best, 1, describe(box.start, mid), describe(mid, box.end));
    }
    return boxes;
  }

  // RGBA → up to 256 palette colors + one index per pixel.
  // Colors are grouped by 5 bits per channel; the palette uses their exact averages.
  function quantize(rgba, count) {
    const TRANSPARENT = 32768;
    const hist = new Uint32Array(32768);
    const sum = new Float64Array(32768 * 3);
    const keys = new Uint16Array(count);
    let hasAlpha = false;

    for (let i = 0, p = 0; i < count; i++, p += 4) {
      if (rgba[p + 3] < 128) { keys[i] = TRANSPARENT; hasAlpha = true; continue; }
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      keys[i] = k;
      hist[k]++;
      sum[k * 3] += r; sum[k * 3 + 1] += g; sum[k * 3 + 2] += b;
    }

    let n = 0;
    for (let k = 0; k < 32768; k++) if (hist[k]) n++;
    const colors = new Uint16Array(n);
    n = 0;
    for (let k = 0; k < 32768; k++) if (hist[k]) colors[n++] = k;

    const offset = hasAlpha ? 1 : 0;                 // index 0 = transparent
    const boxes = medianCut(colors, hist, 256 - offset);
    const lut = new Uint8Array(32768);
    const palette = new Uint8Array((boxes.length + offset) * 3);

    boxes.forEach((box, bi) => {
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = box.start; i < box.end; i++) {
        const k = colors[i];
        r += sum[k * 3]; g += sum[k * 3 + 1]; b += sum[k * 3 + 2]; w += hist[k];
        lut[k] = bi + offset;
      }
      const o = (bi + offset) * 3;
      palette[o] = Math.round(r / w); palette[o + 1] = Math.round(g / w); palette[o + 2] = Math.round(b / w);
    });

    const indices = new Uint8Array(count);
    for (let i = 0; i < count; i++) indices[i] = keys[i] === TRANSPARENT ? 0 : lut[keys[i]];
    return { indices, palette, transparent: hasAlpha };
  }

  class Encoder {
    constructor(width, height) {
      this.w = width;
      this.h = height;
      this.out = new Bytes(1 << 20);
      // LZW dictionary: key = (prefix code << 8) | next index. A "generation" stamp
      // makes clearing the dictionary free instead of wiping 1M entries each time.
      this.codes = new Int32Array(1 << 20);
      this.stamp = new Int32Array(1 << 20);
      this.gen = 0;

      const o = this.out;
      o.str("GIF89a");
      o.u16(width); o.u16(height);
      o.byte(0); o.byte(0); o.byte(0);              // no global palette, every frame has its own
      // NETSCAPE2.0 extension: loop forever
      o.byte(0x21); o.byte(0xFF); o.byte(11); o.str("NETSCAPE2.0");
      o.byte(3); o.byte(1); o.u16(0); o.byte(0);
    }

    // rgba: width*height*4 bytes (e.g. from getImageData), delay in seconds
    addFrame(rgba, delay) {
      const { indices, palette, transparent } = quantize(rgba, this.w * this.h);
      let bits = 1;
      while (1 << bits < palette.length / 3) bits++;
      const o = this.out;

      // graphic control: delay, transparency; disposal 2 clears transparent frames between steps
      o.byte(0x21); o.byte(0xF9); o.byte(4);
      o.byte(transparent ? (2 << 2) | 1 : 1 << 2);
      o.u16(Math.max(2, Math.round(delay * 100)));
      o.byte(0);                                    // transparent color index
      o.byte(0);

      // image descriptor + local palette
      o.byte(0x2C);
      o.u16(0); o.u16(0); o.u16(this.w); o.u16(this.h);
      o.byte(0x80 | (bits - 1));
      const table = new Uint8Array((1 << bits) * 3);
      table.set(palette);
      o.bytes(table);

      this.lzw(indices, Math.max(2, bits));
    }

    lzw(indices, minCodeSize) {
      const o = this.out;
      o.byte(minCodeSize);
      const clear = 1 << minCodeSize, eoi = clear + 1;
      let codeSize = minCodeSize + 1, next = eoi + 1;
      let cur = 0, shift = 0;

      const block = new Uint8Array(255);
      let bl = 0;
      const flush = () => { if (bl) { o.byte(bl); o.bytes(block.subarray(0, bl)); bl = 0; } };
      const emit = (code) => {
        cur |= code << shift;
        shift += codeSize;
        while (shift >= 8) {
          block[bl++] = cur & 255;
          cur >>>= 8;
          shift -= 8;
          if (bl === 255) flush();
        }
      };

      const codes = this.codes, stamp = this.stamp;
      let gen = ++this.gen;
      emit(clear);
      let prefix = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        if (stamp[key] === gen) { prefix = codes[key]; continue; }
        emit(prefix);
        if (next === 4096) {                         // dictionary full → start over
          emit(clear);
          next = eoi + 1;
          codeSize = minCodeSize + 1;
          gen = ++this.gen;
        } else {
          if (next >= 1 << codeSize) codeSize++;
          stamp[key] = gen;
          codes[key] = next++;
        }
        prefix = k;
      }
      emit(prefix);
      emit(eoi);
      if (shift > 0) { block[bl++] = cur & 255; if (bl === 255) flush(); }
      flush();
      o.byte(0);                                     // end of image data
    }

    finish() {
      this.out.byte(0x3B);
      return new Blob([this.out.result()], { type: "image/gif" });
    }
  }

  return { decode, parse, Encoder };
})();

if (typeof module !== "undefined") module.exports = GIF;   // lets tests run it in Node
