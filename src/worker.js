/* PNG → GIF worker
 * - 'load'     : 모든 PNG를 한 번 훑어서 프레임 간 차이, 투명 여부, 썸네일을 만든다.
 *                (원본 픽셀은 한 장씩만 메모리에 두고 바로 버린다)
 * - 'estimate' : 출력 프레임 중 일부만 실제로 인코딩해서 전체 용량을 추정한다.
 * - 'encode'   : 전체 GIF를 한 프레임씩 디코드 → 리사이즈 → 양자화 → 인코딩한다.
 * 새 작업이 오면 이전 작업은 다음 await 지점에서 중단된다.
 */
const { GIFEncoder, quantize, applyPalette } = self.gifenc;

let files = [];
let baseW = 0, baseH = 0;
const latest = { load: 0, estimate: 0, encode: 0 };
const THUMB_MAX = 240;
const ALPHA_CUT = 128;

const stale = (kind, id) => latest[kind] !== id;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cancel') { latest[m.kind] = -1; return; }
  if (m.type === 'init') { files = m.files; baseW = m.baseW; baseH = m.baseH; return; }
  latest[m.type] = m.id;
  const run = { load, estimate, encode }[m.type];
  run(m).catch((err) => self.postMessage({ type: 'error', kind: m.type, id: m.id, message: String(err && err.message || err) }));
};

async function load(m) {
  files = m.files;
  const n = files.length;
  const diffs = new Float32Array(n);
  const sizes = [];
  let hasAlpha = false;

  // 기준 크기는 첫 프레임
  const first = await createImageBitmap(files[0]);
  baseW = first.width; baseH = first.height;
  first.close();

  const cv = new OffscreenCanvas(baseW, baseH);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const ts = Math.min(1, THUMB_MAX / Math.max(baseW, baseH));
  const tw = Math.max(1, Math.round(baseW * ts)), th = Math.max(1, Math.round(baseH * ts));
  const tcv = new OffscreenCanvas(tw, th);
  const tctx = tcv.getContext('2d');
  tctx.imageSmoothingQuality = 'high';

  let prev = null;
  for (let i = 0; i < n; i++) {
    if (stale('load', m.id)) return;
    const bmp = await createImageBitmap(files[i]);
    sizes.push([bmp.width, bmp.height]);
    ctx.clearRect(0, 0, baseW, baseH);
    ctx.drawImage(bmp, Math.round((baseW - bmp.width) / 2), Math.round((baseH - bmp.height) / 2));
    bmp.close();
    const data = ctx.getImageData(0, 0, baseW, baseH).data;
    const px = new Uint32Array(data.buffer);

    if (!hasAlpha) {
      for (let p = 3; p < data.length; p += 4) if (data[p] < 255) { hasAlpha = true; break; }
    }
    if (prev) {
      let changed = 0;
      for (let p = 0; p < px.length; p++) if (px[p] !== prev[p]) changed++;
      diffs[i] = changed / px.length;
    } else diffs[i] = 1;
    prev = px;

    tctx.clearRect(0, 0, tw, th);
    tctx.drawImage(cv, 0, 0, tw, th);
    const thumb = tcv.transferToImageBitmap();
    self.postMessage({ type: 'loadProgress', id: m.id, index: i, total: n, thumb }, [thumb]);
  }
  self.postMessage({ type: 'loaded', id: m.id, baseW, baseH, sizes, hasAlpha, diffs }, [diffs.buffer]);
}

/* ---------- 프레임 렌더링 & 양자화 ---------- */

let rcv = null, rctx = null;
async function renderFrame(src, outW, outH, matte) {
  if (!rcv || rcv.width !== outW || rcv.height !== outH) {
    rcv = new OffscreenCanvas(outW, outH);
    rctx = rcv.getContext('2d', { willReadFrequently: true });
  }
  const bmp = await createImageBitmap(files[src]);
  const sx = outW / baseW, sy = outH / baseH;
  rctx.setTransform(1, 0, 0, 1, 0, 0);
  rctx.clearRect(0, 0, outW, outH);
  if (matte) { rctx.fillStyle = matte; rctx.fillRect(0, 0, outW, outH); }
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = 'high';
  const dx = Math.round((baseW - bmp.width) / 2), dy = Math.round((baseH - bmp.height) / 2);
  rctx.drawImage(bmp, dx * sx, dy * sy, bmp.width * sx, bmp.height * sy);
  bmp.close();
  return rctx.getImageData(0, 0, outW, outH).data;
}

function quantizeFrame(data, keepAlpha) {
  if (keepAlpha) {
    let clear = 0;
    for (let p = 3; p < data.length; p += 4) if (data[p] < ALPHA_CUT) clear++;
    if (clear > 0) {
      const total = data.length / 4;
      const opaqueN = total - clear;
      let palette;
      if (opaqueN > 0) {
        const opaque = new Uint8Array(opaqueN * 4);
        for (let p = 0, o = 0; p < data.length; p += 4) {
          if (data[p + 3] >= ALPHA_CUT) {
            opaque[o] = data[p]; opaque[o + 1] = data[p + 1]; opaque[o + 2] = data[p + 2]; opaque[o + 3] = 255; o += 4;
          }
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

function writeFrame(gif, q, w, h, delayCs, plan, repeat) {
  gif.writeFrame(q.index, w, h, {
    palette: q.palette,
    delay: delayCs * 10,
    transparent: q.transparent,
    transparentIndex: q.transparentIndex,
    dispose: plan.keepAlpha ? 2 : 1,
    repeat,
  });
}

/* ---------- 용량 추정 ---------- */

async function estimate(m) {
  const { plan } = m;
  const frames = plan.frames;
  const k = Math.min(frames.length, m.samples || 6);
  const picks = [];
  for (let j = 0; j < k; j++) picks.push(Math.floor((j + 0.5) * frames.length / k));

  const gif = GIFEncoder();
  let headerBytes = 0;
  for (let j = 0; j < picks.length; j++) {
    if (stale('estimate', m.id)) return;
    const f = frames[picks[j]];
    const data = await renderFrame(f.src, plan.outW, plan.outH, plan.matte);
    if (stale('estimate', m.id)) return;
    const q = quantizeFrame(data, plan.keepAlpha);
    if (j === 0) headerBytes = 6 + 7 + 19; // 시그니처 + 화면 디스크립터 + 반복 블록(대략)
    writeFrame(gif, q, plan.outW, plan.outH, f.delay, plan, 0);
  }
  gif.finish();
  const sampleBytes = gif.bytesView().length - headerBytes - 1;
  const perFrame = sampleBytes / picks.length;
  const bytes = Math.round(headerBytes + 1 + perFrame * frames.length);
  self.postMessage({ type: 'estimated', id: m.id, bytes });
}

/* ---------- 전체 인코딩 ---------- */

async function encode(m) {
  const { plan } = m;
  const gif = GIFEncoder();
  const n = plan.frames.length;
  for (let i = 0; i < n; i++) {
    if (stale('encode', m.id)) return;
    const f = plan.frames[i];
    const data = await renderFrame(f.src, plan.outW, plan.outH, plan.matte);
    if (stale('encode', m.id)) return;
    const q = quantizeFrame(data, plan.keepAlpha);
    writeFrame(gif, q, plan.outW, plan.outH, f.delay, plan, m.repeat);
    self.postMessage({ type: 'encodeProgress', id: m.id, done: i + 1, total: n });
  }
  gif.finish();
  const out = gif.bytes();
  self.postMessage({ type: 'encoded', id: m.id, buffer: out.buffer }, [out.buffer]);
}
