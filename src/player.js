/* Minimal GIF player: parses the GIF we just made and draws frames to a canvas,
 * so the preview can be paused and jumped to a specific frame.
 * Our encoder always writes full-canvas frames, so each frame is drawn on its own. */
'use strict';

function parseGif(buf) {
  const u = new Uint8Array(buf);
  let p = 6;
  const width = u[p] | (u[p + 1] << 8), height = u[p + 2] | (u[p + 3] << 8);
  const lsd = u[p + 4];
  p += 7;
  let gct = null;
  if (lsd & 0x80) { const n = 3 * (1 << ((lsd & 7) + 1)); gct = u.subarray(p, p + n); p += n; }
  const frames = [];
  let gce = { delay: 0, transparent: false, ti: 0 };
  while (p < u.length) {
    const b = u[p++];
    if (b === 0x21) {
      const label = u[p++];
      if (label === 0xf9) {
        const packed = u[p + 1];
        gce = { delay: u[p + 2] | (u[p + 3] << 8), transparent: !!(packed & 1), ti: u[p + 4] };
      }
      while (u[p]) p += u[p] + 1;
      p++;
    } else if (b === 0x2c) {
      const x = u[p] | (u[p + 1] << 8), y = u[p + 2] | (u[p + 3] << 8);
      const w = u[p + 4] | (u[p + 5] << 8), h = u[p + 6] | (u[p + 7] << 8);
      const packed = u[p + 8];
      p += 9;
      let pal = gct;
      if (packed & 0x80) { const n = 3 * (1 << ((packed & 7) + 1)); pal = u.subarray(p, p + n); p += n; }
      const minCode = u[p++];
      const start = p;
      let len = 0;
      while (u[p]) { len += u[p]; p += u[p] + 1; }
      p++;
      frames.push({ x, y, w, h, pal, minCode, start, len, ...gce });
      gce = { delay: 0, transparent: false, ti: 0 };
    } else break; // 0x3b trailer
  }
  return { u, width, height, frames };
}

function lzwDecode(u, f) {
  // gather sub-blocks into one contiguous array
  const data = new Uint8Array(f.len);
  for (let p = f.start, o = 0; u[p]; p += u[p] + 1) { data.set(u.subarray(p + 1, p + 1 + u[p]), o); o += u[p]; }
  const count = f.w * f.h;
  const out = new Uint8Array(count);
  const MAX = 4096;
  const prefix = new Int16Array(MAX), suffix = new Uint8Array(MAX), stack = new Uint8Array(MAX + 1);
  const clear = 1 << f.minCode, eoi = clear + 1;
  let size = f.minCode + 1, mask = (1 << size) - 1, avail = clear + 2, old = -1;
  for (let c = 0; c < clear; c++) suffix[c] = c;
  let datum = 0, bits = 0, first = 0, top = 0, pi = 0, bi = 0;
  while (pi < count) {
    if (top === 0) {
      if (bits < size) { if (bi >= data.length) break; datum |= data[bi++] << bits; bits += 8; continue; }
      let code = datum & mask; datum >>>= size; bits -= size;
      if (code === eoi || code > avail) break;
      if (code === clear) { size = f.minCode + 1; mask = (1 << size) - 1; avail = clear + 2; old = -1; continue; }
      if (old === -1) { stack[top++] = suffix[code]; old = code; first = code; continue; }
      const inCode = code;
      if (code === avail) { stack[top++] = first; code = old; }
      while (code > clear) { stack[top++] = suffix[code]; code = prefix[code]; }
      first = suffix[code];
      stack[top++] = first;
      if (avail < MAX) {
        prefix[avail] = old; suffix[avail] = first; avail++;
        if ((avail & mask) === 0 && avail < MAX) { size++; mask += avail; }
      }
      old = inCode;
    }
    out[pi++] = stack[--top];
  }
  return out;
}

class GifPlayer {
  constructor(canvas, onFrame) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.onFrame = onFrame;
    this.gif = null; this.cache = []; this.useCache = false;
    this.idx = 0; this.playing = true; this.timer = 0;
  }
  load(buf, keepIndex) {
    clearTimeout(this.timer);
    this.cache.forEach((b) => b?.close?.());
    this.cache = [];
    this.gif = parseGif(buf);
    const g = this.gif;
    this.cv.width = g.width; this.cv.height = g.height;
    // keep decoded frames in memory only if they fit in ~400 MB
    this.useCache = g.width * g.height * 4 * g.frames.length < 400 * 1024 * 1024;
    this.idx = keepIndex != null ? Math.min(keepIndex, g.frames.length - 1) : 0;
    this.show(this.idx);
    if (this.playing) this.schedule();
  }
  clear() {
    clearTimeout(this.timer);
    this.cache.forEach((b) => b?.close?.());
    this.cache = []; this.gif = null;
    this.ctx.clearRect(0, 0, this.cv.width, this.cv.height);
  }
  get count() { return this.gif ? this.gif.frames.length : 0; }
  frameImage(i) {
    const g = this.gif, f = g.frames[i];
    const idx = lzwDecode(g.u, f);
    const lut = new Uint32Array(256);
    for (let c = 0; c < f.pal.length / 3; c++) lut[c] = 0xff000000 | (f.pal[c * 3 + 2] << 16) | (f.pal[c * 3 + 1] << 8) | f.pal[c * 3];
    if (f.transparent) lut[f.ti] = 0;
    const img = new ImageData(f.w, f.h);
    const px = new Uint32Array(img.data.buffer);
    for (let k = 0; k < idx.length; k++) px[k] = lut[idx[k]];
    return img;
  }
  show(i) {
    if (!this.gif) return;
    const f = this.gif.frames[i];
    this.idx = i;
    const cached = this.cache[i];
    this.ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    if (cached) this.ctx.drawImage(cached, f.x, f.y);
    else {
      const img = this.frameImage(i);
      this.ctx.putImageData(img, f.x, f.y);
      if (this.useCache) createImageBitmap(img).then((b) => { if (this.gif && !this.cache[i]) this.cache[i] = b; else b.close(); });
    }
    this.onFrame?.(i);
  }
  schedule() {
    clearTimeout(this.timer);
    const d = this.gif.frames[this.idx].delay;
    // browsers treat delays under 0.02s as 0.1s; mimic that
    const ms = (d < 2 ? 10 : d) * 10;
    this.timer = setTimeout(() => {
      if (!this.playing || !this.gif) return;
      this.show((this.idx + 1) % this.count);
      this.schedule();
    }, ms);
  }
  play() { if (!this.gif) return; this.playing = true; this.schedule(); }
  pause() { this.playing = false; clearTimeout(this.timer); }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing; }
  seek(i) { this.pause(); this.show(i); }
}

/* Plays the PNG frames we built (one Blob per frame) on a canvas. Same interface as GifPlayer. */
class PngSeqPlayer {
  constructor(canvas, onFrame) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.onFrame = onFrame;
    this.frames = null; this.delays = null; this.cache = []; this.useCache = false;
    this.idx = 0; this.playing = true; this.timer = 0; this.token = 0;
  }
  get count() { return this.frames ? this.frames.length : 0; }
  load(data, keepIndex) {
    this.clear();
    this.frames = data.frames; this.delays = data.delays;
    this.cv.width = data.w; this.cv.height = data.h;
    this.useCache = data.w * data.h * 4 * this.frames.length < 400 * 1024 * 1024;
    this.idx = keepIndex != null ? Math.min(keepIndex, this.count - 1) : 0;
    this.show(this.idx).then(() => { if (this.playing) this.schedule(); });
  }
  clear() {
    clearTimeout(this.timer); this.token++;
    this.cache.forEach((b) => b?.close?.()); this.cache = []; this.frames = null;
    this.ctx.clearRect(0, 0, this.cv.width, this.cv.height);
  }
  async show(i) {
    if (!this.frames) return;
    const tok = ++this.token;
    this.idx = i;
    let bmp = this.cache[i];
    if (!bmp) {
      bmp = await createImageBitmap(this.frames[i]);
      if (tok !== this.token) { bmp.close(); return; }
      if (this.useCache) this.cache[i] = bmp;
    }
    this.ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    this.ctx.drawImage(bmp, 0, 0);
    if (!this.useCache) bmp.close();
    this.onFrame?.(i);
  }
  schedule() {
    clearTimeout(this.timer);
    const t0 = performance.now();
    const ms = Math.max(10, this.delays[this.idx] * 10);
    this.timer = setTimeout(async () => {
      if (!this.playing || !this.frames) return;
      await this.show((this.idx + 1) % this.count);
      if (this.playing) this.schedule();
    }, Math.max(0, ms - (performance.now() - t0)));
  }
  play() { if (!this.frames) return; this.playing = true; this.schedule(); }
  pause() { this.playing = false; clearTimeout(this.timer); }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing; }
  seek(i) { this.pause(); this.show(i); }
}

/* Wraps a <video> element for the MP4 preview. Same interface as GifPlayer. */
class VideoPlayer {
  constructor(video, onFrame) {
    this.v = video; this.onFrame = onFrame; this.fps = 30; this.n = 0; this.starts = [];
    this.idx = 0; this.playing = true; this.loaded = false;
    const tick = (now, meta) => {
      if (this.loaded) {
        const i = this.frameAt(meta.mediaTime);
        if (i !== this.idx) { this.idx = i; this.onFrame?.(i); }
      }
      this.v.requestVideoFrameCallback(tick);
    };
    if (this.v.requestVideoFrameCallback) this.v.requestVideoFrameCallback(tick);
  }
  get count() { return this.n; }
  frameAt(t) {
    // starts[] holds each frame's start time in seconds
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= t + 1e-4) lo = mid; else hi = mid - 1; }
    return lo;
  }
  load(data, keepIndex) {
    this.n = data.starts.length; this.starts = data.starts; this.loaded = true;
    this.v.src = data.url; this.v.loop = true; this.v.muted = true; this.v.playsInline = true;
    this.idx = keepIndex != null ? Math.min(keepIndex, this.n - 1) : 0;
    const go = () => {
      this.v.currentTime = this.starts[this.idx] + 0.001;
      if (this.playing) this.v.play().catch(() => {}); else this.onFrame?.(this.idx);
    };
    if (this.v.readyState >= 1) go(); else this.v.addEventListener('loadedmetadata', go, { once: true });
  }
  clear() { this.loaded = false; this.v.pause(); this.v.removeAttribute('src'); this.v.load(); }
  play() { this.playing = true; this.v.play().catch(() => {}); }
  pause() { this.playing = false; this.v.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing; }
  seek(i) { this.pause(); this.idx = i; this.v.currentTime = this.starts[i] + 0.001; this.onFrame?.(i); }
}
