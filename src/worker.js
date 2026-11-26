/* Media worker
 * Sources: a PNG sequence (File[]) or one video file (decoded with Mediabunny).
 * - 'load'     : read every frame once → diffs between frames, transparency, thumbnails
 * - 'init'     : open the same source without analysis (for the second worker)
 * - 'estimate' : encode a few sample frames to predict the GIF / PNG size
 * - 'encode'   : build a GIF, MP4 or PNG frames for one clip
 * A newer job of the same kind makes the older one stop at its next await.
 */
const { GIFEncoder, quantize, applyPalette } = self.gifenc;

let MB = null;
function mediabunny(url) {
  if (!MB) { importScripts(url); MB = self.Mediabunny; }
  return MB;
}

let source = null;   // { kind, n, w, h, fps, frames(indices) }
let ready = Promise.resolve();
const latest = { load: 0, estimate: 0, encode: 0 };
const stale = (kind, id) => latest[kind] !== id;
const ALPHA_CUT = 128;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cancel') { latest[m.kind] = -1; return; }
  if (m.type === 'init') { ready = openSource(m).catch((err) => fail('load', 0, err)); return; }
  latest[m.type] = m.id;
  const run = { load, estimate, encode }[m.type];
  ready.then(() => run(m)).catch((err) => fail(m.type, m.id, err));
};
function fail(kind, id, err) {
  self.postMessage({ type: 'error', kind, id, message: String((err && err.message) || err) });
}

/* ---------- Sources ---------- */
async function openSource(m) {
  if (m.kind === 'png') {
    const files = m.files;
    const first = await createImageBitmap(files[0]);
    const w = first.width, h = first.height;
    first.close();
    source = {
      kind: 'png', n: files.length, w, h, fps: null,
      async *frames(indices) {
        for (const i of indices) {
          const bmp = await createImageBitmap(files[i]);
          try { yield { i, img: bmp, w: bmp.width, h: bmp.height }; } finally { bmp.close(); }
        }
      },
    };
    return;
  }
  const M = mediabunny(m.mbUrl);
  const input = new M.Input({ source: new M.BlobSource(m.file), formats: M.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('This file has no video track.');
  if (track.canDecode && !(await track.canDecode())) throw new Error('This browser cannot decode this video codec.');
  const w = await track.getDisplayWidth(), h = await track.getDisplayHeight();
  // every frame's timestamp, in presentation order
  const ps = new M.EncodedPacketSink(track);
  const ts = [];
  for (let p = await ps.getFirstPacket({ metadataOnly: true }); p; p = await ps.getNextPacket(p, { metadataOnly: true })) ts.push(p.timestamp);
  ts.sort((a, b) => a - b);
  const n = ts.length;
  const fps = n > 1 ? (n - 1) / (ts[n - 1] - ts[0]) : 30;
  const sink = new M.CanvasSink(track, { alpha: true });
  source = {
    kind: 'video', n, w, h, fps,
    async *frames(indices) {
      let k = 0;
      for await (const wc of sink.canvasesAtTimestamps(indices.map((i) => ts[i]))) {
        const i = indices[k++];
        if (!wc) continue;
        yield { i, img: wc.canvas, w: wc.canvas.width, h: wc.canvas.height };
      }
    },
  };
}

/* ---------- Analysis ---------- */
async function load(m) {
  await openSource(m);
  const { n, w, h } = source;
  const diffs = new Float32Array(n);
  const sizes = [];
  let hasAlpha = false;
  // full resolution for PNGs (exact duplicates); at most 960px wide for video (speed)
  const as = source.kind === 'png' ? 1 : Math.min(1, 960 / w);
  const aw = Math.max(1, Math.round(w * as)), ah = Math.max(1, Math.round(h * as));
  const cv = new OffscreenCanvas(aw, ah);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const thumbH = n <= 600 ? 112 : n <= 2000 ? 64 : 40;
  const th = Math.min(h, thumbH), tw = Math.max(1, Math.round(w * th / h));
  const tcv = new OffscreenCanvas(tw, th);
  const tctx = tcv.getContext('2d');
  tctx.imageSmoothingQuality = 'high';

  let prev = null;
  const all = Array.from({ length: n }, (_, i) => i);
  for await (const f of source.frames(all)) {
    if (stale('load', m.id)) return;
    sizes[f.i] = [f.w, f.h];
    ctx.clearRect(0, 0, aw, ah);
    ctx.drawImage(f.img, Math.round((w - f.w) / 2 * as), Math.round((h - f.h) / 2 * as), f.w * as, f.h * as);
    const data = ctx.getImageData(0, 0, aw, ah).data;
    const px = new Uint32Array(data.buffer);
    if (!hasAlpha) for (let p = 3; p < data.length; p += 4) if (data[p] < 255) { hasAlpha = true; break; }
    if (prev) {
      let changed = 0;
      for (let p = 0; p < px.length; p++) if (px[p] !== prev[p]) changed++;
      diffs[f.i] = changed / px.length;
    } else diffs[f.i] = 1;
    prev = px;
    tctx.clearRect(0, 0, tw, th);
    tctx.drawImage(cv, 0, 0, tw, th);
    const thumb = tcv.transferToImageBitmap();
    self.postMessage({ type: 'loadProgress', id: m.id, index: f.i, total: n, thumb }, [thumb]);
  }
  self.postMessage({ type: 'loaded', id: m.id, baseW: w, baseH: h, sizes, hasAlpha, diffs, fps: source.fps, n }, [diffs.buffer]);
}

/* ---------- Rendering ---------- */
let rcv = null, rctx = null;
function draw(f, outW, outH, matte, base) {
  if (!rcv || rcv.width !== outW || rcv.height !== outH) {
    rcv = new OffscreenCanvas(outW, outH);
    rctx = rcv.getContext('2d', { willReadFrequently: true });
  }
  const sx = outW / source.w, sy = outH / source.h;
  rctx.setTransform(1, 0, 0, 1, 0, 0);
  rctx.clearRect(0, 0, outW, outH);
  if (base) { rctx.fillStyle = base; rctx.fillRect(0, 0, outW, outH); }
  if (matte) { rctx.fillStyle = matte; rctx.fillRect(0, 0, outW, outH); }
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = 'high';
  const dx = Math.round((source.w - f.w) / 2), dy = Math.round((source.h - f.h) / 2);
  rctx.drawImage(f.img, dx * sx, dy * sy, f.w * sx, f.h * sy);
  return rctx;
}
const pixels = (ctx) => ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;

function quantizeFrame(data, keepAlpha) {
  if (keepAlpha) {
    let clear = 0;
    for (let p = 3; p < data.length; p += 4) if (data[p] < ALPHA_CUT) clear++;
    if (clear > 0) {
      const opaqueN = data.length / 4 - clear;
      let palette;
      if (opaqueN > 0) {
        const opaque = new Uint8Array(opaqueN * 4);
        for (let p = 0, o = 0; p < data.length; p += 4) {
          if (data[p + 3] >= ALPHA_CUT) { opaque[o] = data[p]; opaque[o + 1] = data[p + 1]; opaque[o + 2] = data[p + 2]; opaque[o + 3] = 255; o += 4; }
        }
        palette = quantize(opaque, 255);
      } else palette = [[0, 0, 0]];
      const index = applyPalette(data, palette);
      const ti = palette.length;
      palette.push([0, 0, 0]);
      for (let p = 3, i = 0; p < data.length; p += 4, i++) if (data[p] < ALPHA_CUT) index[i] = ti;
      return { palette, index, transparent: true, transparentIndex: ti };
    }
  }
  const palette = quantize(data, 256);
  return { palette, index: applyPalette(data, palette), transparent: false, transparentIndex: 0 };
}
function writeGifFrame(gif, q, plan, delayCs) {
  gif.writeFrame(q.index, plan.outW, plan.outH, {
    palette: q.palette, delay: delayCs * 10, transparent: q.transparent, transparentIndex: q.transparentIndex,
    dispose: plan.keepAlpha ? 2 : 1, repeat: 0,
  });
}

/* ---------- Size estimate (GIF / PNG) ---------- */
async function estimate(m) {
  const { plan, fmt } = m;
  const frames = plan.frames;
  const k = Math.min(frames.length, m.samples || 6);
  const picks = [];
  for (let j = 0; j < k; j++) picks.push(frames[Math.floor((j + 0.5) * frames.length / k)]);
  const bySrc = new Map(picks.map((f) => [f.src, f]));
  let bytes = 0, count = 0;
  const gif = fmt === 'gif' ? GIFEncoder() : null;
  for await (const f of source.frames([...bySrc.keys()].sort((a, b) => a - b))) {
    if (stale('estimate', m.id)) return;
    const ctx = draw(f, plan.outW, plan.outH, plan.matte);
    if (gif) writeGifFrame(gif, quantizeFrame(pixels(ctx), plan.keepAlpha), plan, bySrc.get(f.i).delay);
    else bytes += (await ctx.canvas.convertToBlob({ type: 'image/png' })).size;
    count++;
    if (stale('estimate', m.id)) return;
  }
  if (gif) { gif.finish(); bytes = gif.bytesView().length - 32; }
  const total = Math.round(32 + (bytes / Math.max(1, count)) * frames.length);
  self.postMessage({ type: 'estimated', id: m.id, bytes: total });
}

/* ---------- Encoding ---------- */
async function encode(m) {
  const { plan, fmt } = m;
  const n = plan.frames.length;
  const want = plan.frames.map((f) => f.src);
  const delayOf = new Map(plan.frames.map((f) => [f.src, f.delay]));
  const progress = (done) => self.postMessage({ type: 'encodeProgress', id: m.id, done, total: n });
  let done = 0;

  if (fmt === 'gif') {
    const gif = GIFEncoder();
    for await (const f of source.frames(want)) {
      if (stale('encode', m.id)) return;
      const ctx = draw(f, plan.outW, plan.outH, plan.matte);
      writeGifFrame(gif, quantizeFrame(pixels(ctx), plan.keepAlpha), plan, delayOf.get(f.i));
      progress(++done);
    }
    gif.finish();
    const out = gif.bytes();
    self.postMessage({ type: 'encoded', id: m.id, fmt, buffer: out.buffer }, [out.buffer]);
    return;
  }

  if (fmt === 'png') {
    const frames = [];
    for await (const f of source.frames(want)) {
      if (stale('encode', m.id)) return;
      const ctx = draw(f, plan.outW, plan.outH, plan.matte);
      const blob = await ctx.canvas.convertToBlob({ type: 'image/png' });
      const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
      frames.push({ src: f.i, blob, crc, size: blob.size });
      progress(++done);
    }
    if (stale('encode', m.id)) return;
    self.postMessage({ type: 'encoded', id: m.id, fmt, frames });
    return;
  }

  // MP4 (H.264; VP9 if the browser can't encode H.264 at this size)
  const M = mediabunny(m.mbUrl);
  const cv = new OffscreenCanvas(plan.outW, plan.outH);
  const cctx = cv.getContext('2d');
  let codec = 'avc';
  const bitrate = m.bitrate || M.QUALITY_HIGH;
  if (M.canEncodeVideo && !(await M.canEncodeVideo('avc', { width: plan.outW, height: plan.outH, bitrate }))) codec = 'vp9';
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
  const vsrc = new M.CanvasSource(cv, { codec, bitrate, keyFrameInterval: 2 });
  output.addVideoTrack(vsrc, { frameRate: m.fps });
  await output.start();
  let t = 0;
  for await (const f of source.frames(want)) {
    if (stale('encode', m.id)) { await output.cancel?.(); return; }
    const ctx = draw(f, plan.outW, plan.outH, plan.matte, '#000000');
    cctx.drawImage(ctx.canvas, 0, 0);
    const dur = delayOf.get(f.i) / 100;
    await vsrc.add(t, dur);
    t += dur;
    progress(++done);
  }
  vsrc.close();
  await output.finalize();
  if (stale('encode', m.id)) return;
  const buf = output.target.buffer;
  self.postMessage({ type: 'encoded', id: m.id, fmt, buffer: buf }, [buf]);
}

/* ---------- CRC32 (for the ZIP of PNG frames) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
