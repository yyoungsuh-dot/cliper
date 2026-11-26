'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- Workers ---------- */
const workerURL = URL.createObjectURL(new Blob([document.getElementById('worker-src').textContent], { type: 'text/javascript' }));
const MB_URL = new URL('vendor/mediabunny.min.js', location.href).href;
let wA, wE; // wA: analysis + size estimates, wE: encoding
let seq = 0;
const nextId = () => ++seq;

function startWorkers() {
  wA?.terminate(); wE?.terminate();
  wA = new Worker(workerURL);
  wE = new Worker(workerURL);
  wA.onmessage = onA;
  wE.onmessage = onE;
}

/* ---------- State ---------- */
const st = {
  kind: 'png', name: '', n: 0, files: [], video: null, srcFps: null,
  baseW: 0, baseH: 0, sizes: [], hasAlpha: false, diffs: null, thumbs: [],
  format: 'gif', fps: 30, w: 0, h: 0, lock: true, dedupe: false,
  alphaMode: 'keep', matte: '#FFFFFF', targetOn: false, targetMB: 5,
  clips: [],          // [{s, e}] 0-based, inclusive; always at least one once loaded
  sel: 0,
  results: new Map(), // key → result
  est: null, loadId: 0, run: 0, building: null, baseName: 'animation',
};
const FMT = {
  gif: { ext: 'gif', one: 'GIF', many: 'GIFs' },
  mp4: { ext: 'mp4', one: 'MP4', many: 'MP4s' },
  png: { ext: 'zip', one: 'PNGs (ZIP)', many: 'PNGs (ZIP)' },
};

/* ---------- Utils ---------- */
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
  return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
}
const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const baseNameOf = (name) => name.replace(/\.[^.]+$/, '').replace(/[\s_\-.]*\d+$/, '') || 'animation';
const clampNum = (v, lo, hi, dflt) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; };
const clampInt = (v, lo, hi, dflt) => Math.round(clampNum(v, lo, hi, dflt));
const padNum = (k) => String(k).padStart(Math.max(3, String(st.n).length), '0');
const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name);
const isPngFile = (f) => f.type === 'image/png' || /\.png$/i.test(f.name);
const isFullClip = () => st.clips.length === 1 && st.clips[0].s === 0 && st.clips[0].e === st.n - 1;

/* ---------- Clips ---------- */
const segments = () => st.clips;
const sig = () => {
  const f = st.format;
  return JSON.stringify([f, f !== 'png' && st.fps, st.w, st.h, f === 'gif' && st.dedupe,
    st.hasAlpha && (f === 'mp4' ? 'matte' : st.alphaMode), st.hasAlpha && st.matte, f !== 'png' && st.targetOn && st.targetMB]);
};
const keyOf = (g, s = sig()) => `${s}|${g.s}-${g.e}`;
const resultFor = (i) => { const g = st.clips[i]; return g ? st.results.get(keyOf(g)) : null; };
const segOfFrame = (f) => st.clips.findIndex((g) => f >= g.s && f <= g.e);

/* ---------- Plan: which frames to show and for how long ---------- */
function buildPlan(g, fit = 1) {
  const merge = st.format === 'gif' && st.dedupe;
  const frames = [];
  for (let i = g.s; i <= g.e; i++) {
    if (merge && i > g.s && st.diffs[i] === 0) frames[frames.length - 1].units++;
    else frames.push({ src: i, startU: i, units: 1 });
  }
  // delays are in 1/100 s: round the running time so the total length stays exact
  let minDelay = Infinity;
  for (const f of frames) {
    const a = Math.round((f.startU - g.s) * 100 / st.fps), b = Math.round((f.startU - g.s + f.units) * 100 / st.fps);
    f.delay = Math.max(1, b - a);
    minDelay = Math.min(minDelay, f.delay);
  }
  let outW = Math.max(1, Math.round(st.w * fit)), outH = Math.max(1, Math.round(st.h * fit));
  if (st.format === 'mp4') { outW = Math.max(2, Math.round(outW / 2) * 2); outH = Math.max(2, Math.round(outH / 2) * 2); }
  const fill = st.hasAlpha && (st.format === 'mp4' || st.alphaMode === 'matte');
  return {
    s: g.s, e: g.e, outW, outH, frames,
    keepAlpha: st.hasAlpha && !fill,
    matte: fill ? st.matte : null,
    minDelay,
    totalCs: frames.reduce((s, f) => s + f.delay, 0),
  };
}
const planMsg = (p) => ({
  outW: p.outW, outH: p.outH, keepAlpha: p.keepAlpha, matte: p.matte,
  frames: p.frames.map((f) => ({ src: f.src, delay: f.delay })),
});
const outputFrameFor = (plan, src) => {
  const fs = plan.frames;
  for (let k = 0; k < fs.length; k++) if (src >= fs[k].startU && src < fs[k].startU + fs[k].units) return k;
  return 0;
};

/* ---------- Loading files ---------- */
async function filesFromDataTransfer(dt) {
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(e) {
    if (e.isFile) out.push(await new Promise((res, rej) => e.file(res, rej)));
    else if (e.isDirectory) {
      const r = e.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => r.readEntries(res, rej));
        for (const x of batch) await walk(x);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

function loadFiles(list) {
  const videos = list.filter(isVideoFile);
  const pngs = list.filter(isPngFile).sort(naturalSort);
  let kind;
  if (videos.length) {
    kind = 'video';
    if (videos.length > 1 || pngs.length) toast(`Opened ${videos[0].name}. One video at a time.`);
  } else if (pngs.length) kind = 'png';
  else { toast('Drop a video (MP4, MOV, WebM) or PNG files.'); return; }

  startWorkers();
  st.thumbs.forEach((t) => t?.close?.());
  clearResults();
  Object.values(players).forEach((p) => p.clear());
  Object.assign(st, {
    kind, files: kind === 'png' ? pngs : [], video: kind === 'video' ? videos[0] : null,
    name: kind === 'video' ? videos[0].name : `${pngs.length} PNG files`,
    n: 0, thumbs: [], diffs: null, est: null, clips: [], sel: 0, srcFps: null,
    baseName: baseNameOf(kind === 'video' ? videos[0].name : pngs[0].name), run: st.run + 1, building: null,
  });
  $('#empty').hidden = true;
  $('#editor').hidden = false;
  $('#loading').hidden = false;
  $('#loadText').textContent = kind === 'video' ? 'Reading video…' : `Reading frames 0 / ${pngs.length}`;
  $('#loadBar').style.width = '0%';
  $('#strip').innerHTML = ''; $('#clipFrames').innerHTML = ''; stripCells = [];
  st.loadId = nextId();
  wA.postMessage({ type: 'load', id: st.loadId, kind, files: st.files, file: st.video, mbUrl: MB_URL });
}

/* ---------- Worker messages ---------- */
let pendingEst = null, pendingEnc = null;
function requestEstimate(plan, samples = 6) {
  if (pendingEst) pendingEst.resolve(null);
  const id = nextId();
  return new Promise((resolve) => {
    pendingEst = { id, resolve };
    wA.postMessage({ type: 'estimate', id, fmt: st.format, plan: planMsg(plan), samples });
  });
}
function requestEncode(plan, extra, onProgress) {
  cancelEncode();
  const id = nextId();
  return new Promise((resolve) => {
    pendingEnc = { id, resolve, onProgress };
    wE.postMessage({ type: 'encode', id, fmt: st.format, plan: planMsg(plan), mbUrl: MB_URL, fps: st.fps, ...extra });
  });
}
function cancelEncode() {
  if (!pendingEnc) return;
  wE.postMessage({ type: 'cancel', kind: 'encode' });
  const p = pendingEnc; pendingEnc = null; p.resolve(null);
}

function onA(e) {
  const m = e.data;
  if (m.type === 'loadProgress' && m.id === st.loadId) {
    if (!stripCells.length) buildStrip(m.total);
    st.thumbs[m.index] = m.thumb;
    drawStripThumb(m.index);
    $('#loadText').textContent = `Reading frames ${m.index + 1} / ${m.total}`;
    $('#loadBar').style.width = ((m.index + 1) / m.total * 100) + '%';
  } else if (m.type === 'loaded' && m.id === st.loadId) {
    Object.assign(st, { n: m.n, baseW: m.baseW, baseH: m.baseH, sizes: m.sizes, hasAlpha: m.hasAlpha, diffs: m.diffs, w: m.baseW, h: m.baseH });
    if (st.kind === 'video') { st.srcFps = Math.round(m.fps * 100) / 100; st.fps = st.srcFps; }
    st.clips = [{ s: 0, e: st.n - 1 }];
    wE.postMessage({ type: 'init', kind: st.kind, files: st.files, file: st.video, mbUrl: MB_URL });
    $('#loading').hidden = true;
    onLoaded();
  } else if (m.type === 'estimated' && pendingEst && m.id === pendingEst.id) {
    const p = pendingEst; pendingEst = null; p.resolve(m.bytes);
  } else if (m.type === 'error') {
    if (m.kind === 'estimate' && pendingEst?.id === m.id) { const p = pendingEst; pendingEst = null; p.resolve(null); }
    if (m.kind === 'load') {
      $('#loading').hidden = true;
      const fileMode = location.protocol === 'file:' && st.kind === 'video';
      toast(fileMode ? 'Video needs the online version of this app.' : 'Could not open this file: ' + m.message);
      if (!st.diffs) { $('#editor').hidden = true; $('#empty').hidden = false; }
    } else toast('Error: ' + m.message);
  }
}

function onE(e) {
  const m = e.data;
  if (m.type === 'error' && m.kind === 'load') { toast('Could not open this file: ' + m.message); return; }
  if (!pendingEnc || m.id !== pendingEnc.id) return;
  if (m.type === 'encodeProgress') pendingEnc.onProgress?.(m.done / m.total);
  else if (m.type === 'encoded') { const p = pendingEnc; pendingEnc = null; p.resolve(m); }
  else if (m.type === 'error') { const p = pendingEnc; pendingEnc = null; p.resolve(null); toast('Could not export: ' + m.message); }
}

/* ---------- After loading ---------- */
function onLoaded() {
  const mismatched = st.sizes.filter((s) => s && (s[0] !== st.baseW || s[1] !== st.baseH)).length;
  $('#srcName').textContent = st.name;
  $('#srcName').title = st.name;
  $('#srcDims').textContent = `${st.baseW} × ${st.baseH}`;
  $('#srcAlpha').hidden = !st.hasAlpha;
  $('#srcFpsRow').hidden = st.kind !== 'video';
  $('#srcFps').textContent = st.srcFps ? `${st.srcFps} fps` : '';
  $('#sizeWarn').hidden = !mismatched || st.kind !== 'png';
  $('#sizeWarn').textContent = mismatched
    ? `${mismatched} image(s) differ in size from the first frame (${st.baseW} × ${st.baseH}) and were centered.` : '';
  renderControls();
  schedule(0);
}

/* ---------- Settings change → rebuild automatically ---------- */
let timer = 0;
function schedule(delay = 350) {
  if (!st.diffs) return;
  st.run++;             // stops any rebuild in progress
  cancelEncode();
  if (pendingEst) { const p = pendingEst; pendingEst = null; p.resolve(null); }
  st.est = null;
  st.sel = Math.max(0, Math.min(st.sel, st.clips.length - 1));
  renderInfo();
  renderClips();
  showSelected();
  renderSize();
  clearTimeout(timer);
  timer = setTimeout(rebuild, delay);
}

async function rebuild() {
  const run = ++st.run;
  const segs = segments();
  const s = sig();
  const keep = new Set(segs.map((g) => keyOf(g, s)));
  for (const [k, r] of st.results) if (!keep.has(k)) { dropResult(r); st.results.delete(k); }

  const order = [st.sel, ...segs.map((_, i) => i).filter((i) => i !== st.sel)];
  for (const i of order) {
    const g = segs[i], key = keyOf(g, s);
    if (st.results.has(key)) continue;
    const fmt = st.format;
    st.building = { i, progress: 0, phase: fmt === 'gif' && st.targetOn ? 'fit' : 'encode' };
    renderBusy(); renderSize();

    let fit = 1, failed = false, extra = {};
    if (fmt === 'gif' && st.targetOn) {
      const r = await fitToTarget(run, g);
      if (r == null || run !== st.run) return;
      fit = r.fit; failed = r.failed;
    }
    const plan = buildPlan(g, fit);
    if (fmt === 'mp4' && st.targetOn) {
      // bitrate that fills the target, with headroom for the container
      const secs = plan.totalCs / 100;
      extra.bitrate = Math.max(50_000, Math.floor((st.targetMB * 1024 * 1024 * 8 * 0.92) / secs));
    }
    if (i === st.sel && segs.length === 1 && fmt !== 'mp4' && !(fmt === 'gif' && st.targetOn)) {
      requestEstimate(plan).then((b) => { if (b != null && run === st.run && !st.results.has(key)) { st.est = b; renderSize(); } });
    }
    st.building = { i, progress: 0, phase: 'encode' };
    renderBusy();
    const res = await requestEncode(plan, extra, (p) => {
      if (run !== st.run) return;
      st.building.progress = p;
      renderBusy();
    });
    if (!res || run !== st.run) return;
    st.results.set(key, makeResult(res, plan, failed));
    st.building = null;
    if (i === st.sel) showSelected();
    renderClips(); renderInfo(); renderSize(); renderBusy();
  }
  st.building = null;
  renderBusy(); renderSize();
}

function makeResult(res, plan, failed) {
  if (res.fmt === 'png') {
    const bytes = res.frames.reduce((s, f) => s + f.size, 0);
    return { fmt: 'png', frames: res.frames, bytes, plan, failed };
  }
  const blob = new Blob([res.buffer], { type: res.fmt === 'gif' ? 'image/gif' : 'video/mp4' });
  return { fmt: res.fmt, blob, url: URL.createObjectURL(blob), bytes: blob.size, buffer: res.fmt === 'gif' ? res.buffer : null, plan, failed };
}
function dropResult(r) { if (r.url) URL.revokeObjectURL(r.url); }

/* Find the scale factor that keeps one GIF under the target. Leaves 5% headroom for estimate error. */
async function fitToTarget(run, g) {
  const safe = st.targetMB * 1024 * 1024 * 0.95;
  const minFit = Math.min(1, 16 / Math.min(st.w, st.h));
  let f = 1, lo = null, hi = null;
  for (let it = 0; it < 7; it++) {
    const bytes = await requestEstimate(buildPlan(g, f), 5);
    if (bytes == null || run !== st.run) return null;
    if (bytes <= safe) {
      if (lo == null || f > lo) lo = f;
      if (f >= 1 || bytes > safe * 0.9) break;
    } else hi = hi == null ? f : Math.min(hi, f);
    let next = f * Math.sqrt((safe * 0.97) / bytes);
    if (lo != null) next = Math.max(next, lo + 0.005);
    if (hi != null) next = Math.min(next, hi - 0.005);
    next = Math.max(minFit, Math.min(1, Math.round(next * 1000) / 1000));
    if (Math.abs(next - f) < 0.004) break;
    if (hi != null && lo != null && hi - lo < 0.01) break;
    f = next;
  }
  return lo != null ? { fit: lo, failed: false } : { fit: minFit, failed: true };
}

/* ---------- Rendering ---------- */
function renderControls() {
  const f = st.format;
  $$('#fmtSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === f));
  $('#fpsCard').hidden = f === 'png';
  $('#fpsInput').value = st.fps;
  $('#wInput').value = st.w;
  $('#hInput').value = st.h;
  $('#lockBtn').classList.toggle('on', st.lock);
  $('#lockBtn').setAttribute('aria-pressed', st.lock);
  $('#lockBtn').title = st.lock ? 'Aspect ratio locked' : 'Aspect ratio unlocked';
  $('#dedupeCard').hidden = f !== 'gif';
  $('#dedupe').checked = st.dedupe;
  // transparency: MP4 has no alpha, so the background is always filled
  $('#alphaGroup').hidden = !st.hasAlpha;
  $('#alphaTitle').textContent = f === 'mp4' ? 'Background' : 'Transparency';
  $('#alphaSeg').hidden = f === 'mp4';
  $$('#alphaSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.alphaMode));
  $('#matteRow').hidden = !(f === 'mp4' || st.alphaMode === 'matte');
  if ($('#matteRow').hidden || $('#alphaGroup').hidden) openPicker(false); else placePicker();
  $('#matteSw').style.background = st.matte;
  $('#matteHex').textContent = st.matte;
  $('#targetCard').hidden = f === 'png';
  $('#targetOn').checked = st.targetOn;
  $('#targetInput').disabled = !st.targetOn;
  $('#targetRow').classList.toggle('disabled', !st.targetOn);
}

function renderInfo() {
  const g = st.clips[st.sel];
  if (!g) return;
  const p = buildPlan(g);
  $('#clipCountRow').hidden = st.clips.length < 2;
  $('#clipCount').textContent = st.clips.length;
  $('#outFrames').textContent = p.frames.length;
  $('#outSecs').textContent = (p.totalCs / 100).toFixed(2) + 's';
  $('#delayWarn').hidden = st.format !== 'gif' || p.minDelay >= 2;

  const r = resultFor(st.sel);
  const fitted = st.format === 'gif' && st.targetOn && r && (r.plan.outW !== st.w || r.plan.outH !== st.h);
  $('#fitNote').hidden = !st.targetOn || !r || !(fitted || r.failed);
  if (r) {
    $('#fitNote').textContent = r.failed ? 'Still over the target at the smallest size.' : `Resized to ${r.plan.outW} × ${r.plan.outH}`;
    $('#fitNote').classList.toggle('bad', !!r.failed);
  }

  // strip: dim merged frames and frames outside every clip
  const used = new Map();
  for (const sg of st.clips) for (const fr of buildPlan(sg).frames) used.set(fr.src, fr.units);
  stripCells.forEach((c, i) => {
    const u = used.get(i);
    const inside = segOfFrame(i) >= 0;
    c.classList.toggle('out', !inside);
    c.classList.toggle('off', inside && !u);
    c.querySelector('.dur').textContent = u > 1 ? '×' + u : '';
  });
}

function renderSize() {
  const segs = segments();
  if (!segs.length) return;
  const results = segs.map((_, i) => resultFor(i));
  const done = results.filter(Boolean).length;
  const all = done === segs.length;
  const total = results.reduce((s, r) => s + (r ? r.bytes : 0), 0);
  const multi = segs.length > 1;
  const F = FMT[st.format];
  let label, value;
  if (all) { label = multi ? `Total size · ${segs.length} clips` : 'File size'; value = fmtBytes(total); }
  else if (multi) { label = `Exporting ${Math.min(done + 1, segs.length)} of ${segs.length}`; value = done ? fmtBytes(total) + ' +' : 'Calculating…'; }
  else { label = 'Estimated size'; value = st.est != null ? '~ ' + fmtBytes(st.est) : 'Calculating…'; }
  $('#sizeLabel').textContent = label;
  $('#sizeVal').textContent = value;
  const over = st.format !== 'png' && st.targetOn && results.some((r) => r && r.bytes > st.targetMB * 1024 * 1024);
  $('#sizeCard').classList.toggle('over', over);
  $('#dlBtn').disabled = !all;
  $('#dlBtn').textContent = st.format === 'png' ? (pngFrameCount() === 1 ? 'Download PNG' : 'Download PNGs (ZIP)')
    : multi ? `Download ${segs.length} ${F.many}` : `Download ${F.one}`;
}

function renderBusy() {
  const ready = !!resultFor(st.sel);
  const b = st.building;
  $('#busy').hidden = ready;
  if (!ready) {
    const verb = { gif: 'Building GIF', mp4: 'Encoding MP4', png: 'Rendering PNGs' }[st.format];
    if (b && b.i === st.sel) {
      $('#busyText').textContent = b.phase === 'fit' ? 'Fitting to target size' : `${verb} ${Math.round(b.progress * 100)}%`;
      $('#busyBar').style.width = Math.round(b.progress * 100) + '%';
    } else { $('#busyText').textContent = verb; $('#busyBar').style.width = '0%'; }
  }
  const el = activeEl();
  el.classList.toggle('dim', !ready);
  $('#gifEmpty').hidden = !!shownKey || !ready;
  renderPlayState();
}

/* ---------- Preview players ---------- */
const onPlayerFrame = (i) => {
  const src = shownPlan?.frames[i]?.src;
  if (nowCell) nowCell.classList.remove('now');
  nowCell = src != null ? stripCells[src] : null;
  if (nowCell) {
    nowCell.classList.add('now');
    if (!player().playing) nowCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
};
const players = {
  gif: new GifPlayer($('#player'), onPlayerFrame),
  png: new PngSeqPlayer($('#player'), onPlayerFrame),
  mp4: new VideoPlayer($('#vplayer'), onPlayerFrame),
};
const player = () => players[shownFmt || st.format];
const activeEl = () => (st.format === 'mp4' ? $('#vplayer') : $('#player'));
let nowCell = null, shownKey = null, shownPlan = null, shownFmt = null, pendingSeekSrc = null, wantPlaying = true;

function showSelected() {
  const g = st.clips[st.sel];
  if (!g) return;
  $('#clipBadge').hidden = st.clips.length < 2;
  $('#clipBadge').textContent = `Clip ${st.sel + 1} · ${g.s + 1}–${g.e + 1}`;
  const r = resultFor(st.sel);
  if (r) {
    const key = keyOf(g);
    if (key !== shownKey) {
      const prev = shownFmt ? players[shownFmt] : null;
      let keep = null;
      if (pendingSeekSrc != null) { wantPlaying = false; keep = outputFrameFor(r.plan, pendingSeekSrc); pendingSeekSrc = null; }
      else if (prev && !prev.playing && shownPlan) {
        const src = shownPlan.frames[prev.idx]?.src;
        if (src != null && src >= g.s && src <= g.e) { wantPlaying = false; keep = outputFrameFor(r.plan, src); }
        else wantPlaying = true;
      }
      if (prev && shownFmt !== r.fmt) prev.clear();
      shownPlan = r.plan; shownKey = key; shownFmt = r.fmt;
      $('#player').hidden = r.fmt === 'mp4';
      $('#vplayer').hidden = r.fmt !== 'mp4';
      const p = players[r.fmt];
      p.playing = wantPlaying;
      if (r.fmt === 'gif') p.load(r.buffer, keep);
      else if (r.fmt === 'png') p.load({ frames: r.frames.map((f) => f.blob), delays: r.plan.frames.map((f) => f.delay), w: r.plan.outW, h: r.plan.outH }, keep);
      else {
        let t = 0;
        const starts = r.plan.frames.map((f) => { const s0 = t; t += f.delay / 100; return s0; });
        p.load({ url: r.url, starts }, keep);
      }
      fitPreview();
    } else if (pendingSeekSrc != null) {
      player().seek(outputFrameFor(r.plan, pendingSeekSrc)); pendingSeekSrc = null;
    }
  }
  renderBusy();
}

function clearResults() {
  for (const r of st.results.values()) dropResult(r);
  st.results.clear();
  shownKey = null; shownPlan = null; shownFmt = null; wantPlaying = true;
  $('#player').hidden = true; $('#vplayer').hidden = true;
}

// Fit the preview inside its box without cropping (never upscale)
function fitPreview() {
  const stage = $('#stage');
  const el = shownFmt === 'mp4' ? $('#vplayer') : $('#player');
  const w = shownFmt === 'mp4' ? shownPlan?.outW : el.width, h = shownFmt === 'mp4' ? shownPlan?.outH : el.height;
  if (!w || !h || w < 2) return;
  $('#viewer').style.setProperty('--ar', `${w} / ${h}`);
  const bw = stage.clientWidth, bh = stage.clientHeight;
  if (!bw || !bh) return;
  const k = Math.min(bw / w, bh / h, 1);
  el.style.width = Math.floor(w * k) + 'px';
  el.style.height = Math.floor(h * k) + 'px';
}
new ResizeObserver(fitPreview).observe($('#stage'));

function renderPlayState() {
  const p = shownFmt ? players[shownFmt] : null;
  $('#playIcon').hidden = !p || p.playing || !$('#busy').hidden;
}
$('#viewer').onclick = () => {
  if (!shownFmt || !$('#busy').hidden) return;
  wantPlaying = player().toggle();
  renderPlayState();
};

/* ---------- Download ---------- */
async function download() {
  const segs = segments();
  const results = segs.map((_, i) => resultFor(i));
  if (results.some((r) => !r)) return;
  const range = (g) => `${padNum(g.s + 1)}-${padNum(g.e + 1)}`;
  const named = !isFullClip();
  if (st.format === 'png') {
    const pad4 = (k) => String(k).padStart(Math.max(4, String(st.n).length), '0');
    // a single frame in total: save it as a plain PNG, no ZIP
    if (pngFrameCount() === 1) {
      const f = results[0].frames[0];
      save(URL.createObjectURL(f.blob), st.n === 1 ? `${st.baseName}.png` : `${st.baseName}_${pad4(f.src + 1)}.png`, true);
      return;
    }
    const entries = [];
    segs.forEach((g, i) => {
      const dir = segs.length > 1 ? `${st.baseName}_${range(g)}/` : '';
      for (const f of results[i].frames) entries.push({ name: `${dir}${st.baseName}_${pad4(f.src + 1)}.png`, blob: f.blob, crc: f.crc, size: f.size });
    });
    const zip = makeZip(entries);
    const name = segs.length === 1 && named ? `${st.baseName}_${range(segs[0])}.zip` : `${st.baseName}.zip`;
    save(URL.createObjectURL(zip), name, true);
    return;
  }
  for (let i = 0; i < segs.length; i++) {
    save(results[i].url, named ? `${st.baseName}_${range(segs[i])}.${FMT[st.format].ext}` : `${st.baseName}.${FMT[st.format].ext}`);
    if (i < segs.length - 1) await new Promise((res) => setTimeout(res, 300));
  }
}
const pngFrameCount = () => st.clips.reduce((s, g) => s + (g.e - g.s + 1), 0);
function save(url, name, revoke) {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* Minimal ZIP writer (stored, no compression: PNGs are already compressed) */
function makeZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nb = enc.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, e.crc, true);
    lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true); lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    parts.push(lh, nb, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true); ch.setUint16(28, nb.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch, nb);
    offset += 30 + nb.length + e.size;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/* ---------- Frame strip with iPhone-style trim frames ---------- */
let stripCells = [];
function buildStrip(n) {
  const strip = $('#strip');
  strip.innerHTML = '';
  nowCell = null;
  const names = st.kind === 'png' ? st.files.map((f) => f.name) : null;
  stripCells = Array.from({ length: n }, (_, i) => {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.title = names ? names[i] : `Frame ${i + 1}`;
    cell.innerHTML = `<canvas width="1" height="1"></canvas><span class="num">${i + 1}</span><span class="dur"></span>`;
    cell.onclick = () => seekToFrame(i);
    strip.appendChild(cell);
    return cell;
  });
}
function drawStripThumb(i) {
  const th = st.thumbs[i], cv = stripCells[i]?.querySelector('canvas');
  if (!th || !cv) return;
  cv.width = th.width; cv.height = th.height;
  cv.getContext('2d').drawImage(th, 0, 0);
}
function seekToFrame(i) {
  const k = segOfFrame(i);
  if (k < 0) return;
  if (k !== st.sel) { selectClip(k, i); return; }
  const r = resultFor(k);
  if (!r || shownKey !== keyOf(st.clips[k])) { pendingSeekSrc = i; showSelected(); return; }
  wantPlaying = false;
  player().seek(outputFrameFor(r.plan, i));
  renderPlayState();
}

function selectClip(k, seekSrc = null) {
  st.sel = k;
  if (seekSrc != null) pendingSeekSrc = seekSrc;
  renderClips(); renderInfo(); showSelected();
  if (!resultFor(k)) schedule(0);
}
function setClips(clips, sel = st.sel) {
  st.clips = clips.length ? clips : [{ s: 0, e: st.n - 1 }];
  st.sel = Math.max(0, Math.min(sel, st.clips.length - 1));
  schedule();
}

// Split the selected clip at the frame shown in the preview (or in the middle)
function currentSrc() {
  const p = shownFmt ? players[shownFmt] : null;
  return p && shownPlan ? shownPlan.frames[p.idx]?.src : null;
}
function splitClip() {
  const cs = st.clips.map((c) => ({ ...c }));
  const k = st.sel, c = cs[k];
  if (c.e - c.s < 1) { toast('This clip is a single frame.'); return; }
  let at = currentSrc();
  if (at == null || at <= c.s || at > c.e) at = Math.floor((c.s + c.e + 1) / 2);
  cs.splice(k, 1, { s: c.s, e: at - 1 }, { s: at, e: c.e });
  pendingSeekSrc = at;
  setClips(cs, k + 1);
}
function removeClip(k) {
  setClips(st.clips.filter((_, i) => i !== k), Math.min(st.sel, st.clips.length - 2));
}
// Clamp one clip's edges between its neighbours
function updateClip(k, s, e) {
  const cs = st.clips;
  const lo = k > 0 ? cs[k - 1].e + 1 : 0;
  const hi = k < cs.length - 1 ? cs[k + 1].s - 1 : st.n - 1;
  s = Math.max(lo, Math.min(s, hi));
  e = Math.max(s, Math.min(e, hi));
  cs[k] = { s, e };
}

function renderClips() {
  $('#resetClips').hidden = isFullClip();
  const list = $('#clipList');
  const active = document.activeElement;
  if (!(active && list.contains(active) && active.tagName === 'INPUT')) {
    list.innerHTML = '';
    st.clips.forEach((c, k) => {
      const r = resultFor(k);
      const row = document.createElement('div');
      row.className = 'clip' + (k === st.sel ? ' sel' : '');
      row.innerHTML = `
        <div class="name">Clip ${k + 1}<small>${r ? fmtBytes(r.bytes) : '…'}</small></div>
        <div class="range">
          <input type="number" min="1" max="${st.n}" value="${c.s + 1}" aria-label="Clip ${k + 1} first frame">
          <span>–</span>
          <input type="number" min="1" max="${st.n}" value="${c.e + 1}" aria-label="Clip ${k + 1} last frame">
        </div>
        <button class="del" aria-label="Remove clip ${k + 1}"${st.clips.length < 2 ? ' hidden' : ''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
      const [si, ei] = row.querySelectorAll('input');
      const apply = () => {
        updateClip(k, clampInt(si.value, 1, st.n, c.s + 1) - 1, clampInt(ei.value, 1, st.n, c.e + 1) - 1);
        si.value = st.clips[k].s + 1; ei.value = st.clips[k].e + 1;
        st.sel = k;
        schedule();
      };
      si.onchange = apply; ei.onchange = apply;
      [si, ei].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); }));
      row.querySelector('.del').onclick = (e) => { e.stopPropagation(); removeClip(k); };
      row.onclick = (e) => { if (e.target.tagName !== 'INPUT' && k !== st.sel) selectClip(k); };
      list.appendChild(row);
    });
  }
  renderFrames();
}

const cellEdges = () => stripCells.map((c) => [c.offsetLeft, c.offsetLeft + c.offsetWidth]);
const CHEV_L = '<svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 2 8l5 5"/></svg>';
const CHEV_R = '<svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 5 5-5 5"/></svg>';
function placeFrame(fr, c, edges) {
  const left = edges[c.s][0], width = edges[c.e][1] - left;
  fr.style.left = left + 'px';
  fr.style.width = width + 'px';
  fr.querySelector('.tag').textContent = `${c.s + 1}–${c.e + 1}`;
  pinTag(fr);
}
// keep each clip's label inside the visible part of its frame while the strip scrolls
function pinTag(fr) {
  const tag = fr.querySelector('.tag');
  const sc = $('#stripScroll');
  const left = fr.offsetLeft, width = fr.offsetWidth, tw = tag.offsetWidth;
  const x = Math.max(0, Math.min(sc.scrollLeft - left + 6, width - tw));
  tag.style.transform = `translateX(${x}px)`;
}
$('#stripScroll').addEventListener('scroll', () => $$('#clipFrames .clipframe').forEach(pinTag), { passive: true });
function renderFrames() {
  const box = $('#clipFrames');
  box.innerHTML = '';
  if (!stripCells.length || !st.clips.length) return;
  const edges = cellEdges();
  st.clips.forEach((c, k) => {
    const fr = document.createElement('div');
    fr.className = 'clipframe' + (k === st.sel ? ' sel' : '');
    fr.innerHTML = `<span class="tag"></span><span class="handle l">${CHEV_L}</span><span class="handle r">${CHEV_R}</span>`;
    box.appendChild(fr);
    placeFrame(fr, c, edges);
    fr.querySelector('.tag').onclick = () => k !== st.sel && selectClip(k);
    fr.querySelectorAll('.handle').forEach((hd) => hd.addEventListener('pointerdown', (e) => startDrag(e, k, hd.classList.contains('l') ? 'l' : 'r')));
  });
}

let drag = null;
function startDrag(e, k, side) {
  e.preventDefault(); e.stopPropagation();
  const el = e.currentTarget;
  drag = { k, side, el, edges: cellEdges(), orig: { ...st.clips[k] }, x: e.clientX };
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onDrag);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  if (st.sel !== k) {
    st.sel = k;
    $$('#clipFrames .clipframe').forEach((f, i) => f.classList.toggle('sel', i === k));
    renderInfo(); showSelected();
  }
  dragScroll();
}
function onDrag(e) { if (drag) { drag.x = e.clientX; applyDrag(); } }
function applyDrag() {
  const inner = $('#stripInner').getBoundingClientRect();
  const x = drag.x - inner.left;
  const c = st.clips[drag.k];
  let best = 0, bestD = Infinity;
  drag.edges.forEach(([l, r], i) => {
    const d = Math.abs((drag.side === 'l' ? l : r) - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (drag.side === 'l') updateClip(drag.k, best, c.e); else updateClip(drag.k, c.s, Math.max(best, c.s));
  const nc = st.clips[drag.k];
  placeFrame($('#clipFrames').children[drag.k], nc, drag.edges);
  const inputs = $('#clipList').children[drag.k]?.querySelectorAll('input');
  if (inputs) { inputs[0].value = nc.s + 1; inputs[1].value = nc.e + 1; }
}
function dragScroll() {
  if (!drag) return;
  const sc = $('#stripScroll'), r = sc.getBoundingClientRect();
  const edge = 48;
  let dx = 0;
  if (drag.x > r.right - edge) dx = Math.min(24, (drag.x - (r.right - edge)) / 2);
  else if (drag.x < r.left + edge) dx = -Math.min(24, ((r.left + edge) - drag.x) / 2);
  if (dx) { sc.scrollLeft += dx; applyDrag(); }
  requestAnimationFrame(dragScroll);
}
function endDrag() {
  if (!drag) return;
  const { el } = drag;
  el.removeEventListener('pointermove', onDrag);
  el.removeEventListener('pointerup', endDrag);
  el.removeEventListener('pointercancel', endDrag);
  const changed = drag.orig.s !== st.clips[drag.k].s || drag.orig.e !== st.clips[drag.k].e;
  drag = null;
  if (changed) schedule(); else renderClips();
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

/* ---------- Color picker ---------- */
const picker = new ColorPicker($('#cp'), {
  value: st.matte,
  onChange: (hex) => { st.matte = hex; $('#matteSw').style.background = hex; $('#matteHex').textContent = hex; schedule(); },
});
// Figma-style: the picker floats to the left of the settings column, next to the swatch
function placePicker() {
  const panel = $('#cpPanel');
  if (panel.hidden || innerWidth <= 820) return;
  const btn = $('#matteBtn').getBoundingClientRect(), side = $('aside').getBoundingClientRect();
  const h = panel.offsetHeight;
  panel.style.left = Math.max(12, side.left - 12 - panel.offsetWidth) + 'px';
  panel.style.top = Math.max(12, Math.min(btn.top - 8, innerHeight - h - 12)) + 'px';
}
function openPicker(open) {
  $('#cpPanel').hidden = !open;
  $('#matteBtn').setAttribute('aria-expanded', open);
  if (open) placePicker();
}
$('#matteBtn').onclick = (e) => { e.stopPropagation(); openPicker($('#cpPanel').hidden); };
$('#cpClose').onclick = () => openPicker(false);
addEventListener('pointerdown', (e) => {
  if (!$('#cpPanel').hidden && !$('#cpPanel').contains(e.target) && !$('#matteBtn').contains(e.target)) openPicker(false);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cpPanel').hidden) openPicker(false); });
addEventListener('resize', placePicker);
$('aside').addEventListener('scroll', placePicker, { passive: true });
addEventListener('scroll', placePicker, { passive: true });

/* ---------- Events ---------- */
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  loadFiles(await filesFromDataTransfer(e.dataTransfer));
});
addEventListener('resize', () => { if (!drag) renderFrames(); });
$('#pickFiles').onchange = (e) => { loadFiles([...e.target.files]); e.target.value = ''; };
$('#pickFolder').onchange = (e) => { loadFiles([...e.target.files]); e.target.value = ''; };
$$('[data-pick]').forEach((b) => (b.onclick = () => $('#' + b.dataset.pick).click()));

const MAXD = 8192;
const changed = () => { renderControls(); schedule(); };
$$('#fmtSeg button').forEach((b) => (b.onclick = () => { if (st.format !== b.dataset.v) { st.format = b.dataset.v; changed(); } }));
$('#fpsInput').onchange = (e) => { st.fps = Math.round(clampNum(e.target.value, 1, 120, 30) * 100) / 100; changed(); };
$('#wInput').onchange = (e) => {
  st.w = clampInt(e.target.value, 1, MAXD, st.w);
  if (st.lock) st.h = Math.max(1, Math.round(st.w * st.baseH / st.baseW));
  changed();
};
$('#hInput').onchange = (e) => {
  st.h = clampInt(e.target.value, 1, MAXD, st.h);
  if (st.lock) st.w = Math.max(1, Math.round(st.h * st.baseW / st.baseH));
  changed();
};
$('#lockBtn').onclick = () => {
  st.lock = !st.lock;
  if (st.lock) {
    const nh = Math.max(1, Math.round(st.w * st.baseH / st.baseW));
    if (nh !== st.h) { st.h = nh; changed(); return; }
  }
  renderControls();
};
$('#dedupe').onchange = (e) => { st.dedupe = e.target.checked; changed(); };
$$('#alphaSeg button').forEach((b) => (b.onclick = () => { st.alphaMode = b.dataset.v; changed(); }));
$('#targetOn').onchange = (e) => { st.targetOn = e.target.checked; changed(); if (st.targetOn) $('#targetInput').focus(); };
$('#targetInput').onchange = (e) => { st.targetMB = Math.max(0.1, +e.target.value || 5); e.target.value = st.targetMB; changed(); };
$('#splitClip').onclick = () => st.diffs && splitClip();
$('#resetClips').onclick = () => setClips([], 0);
$('#dlBtn').onclick = download;
$$('input[type=number]').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); }));

startWorkers();
