'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- Workers ---------- */
const workerURL = URL.createObjectURL(new Blob([document.getElementById('worker-src').textContent], { type: 'text/javascript' }));
let wA, wE; // wA: analysis + size estimates, wE: GIF encoding
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
  n: 0, files: [], baseW: 0, baseH: 0, sizes: [], hasAlpha: false, diffs: null, thumbs: [],
  fps: 30, w: 0, h: 0, lock: true, dedupe: false,
  alphaMode: 'keep', matte: '#ffffff', targetOn: false, targetMB: 5,
  clips: [],          // [{s, e}] 0-based, inclusive. Empty = the whole sequence is one GIF.
  sel: 0,             // selected segment index
  results: new Map(), // key → { blob, url, bytes, buffer, plan, failed }
  est: null, loadId: 0, run: 0, building: null, baseName: 'animation',
};

/* ---------- Utils ---------- */
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
  return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
}
const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const baseNameOf = (name) => name.replace(/\.[^.]+$/, '').replace(/[\s_\-.]*\d+$/, '') || 'animation';
const clampInt = (v, lo, hi, dflt) => { v = Math.round(+v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt; };
const padNum = (k) => String(k).padStart(Math.max(3, String(st.n).length), '0');

/* ---------- Segments (clips) ---------- */
const segments = () => (st.clips.length ? st.clips : [{ s: 0, e: st.n - 1 }]);
const sig = () => JSON.stringify([st.fps, st.w, st.h, st.dedupe, st.hasAlpha && st.alphaMode, st.hasAlpha && st.alphaMode === 'matte' && st.matte, st.targetOn && st.targetMB]);
const keyOf = (g, s = sig()) => `${s}|${g.s}-${g.e}`;
const resultFor = (i) => { const g = segments()[i]; return g ? st.results.get(keyOf(g)) : null; };
const segOfFrame = (f) => segments().findIndex((g) => f >= g.s && f <= g.e);

/* ---------- Plan: which frames to show and for how long ---------- */
function buildPlan(g, fit = 1) {
  const frames = [];
  for (let i = g.s; i <= g.e; i++) {
    // merge only frames that are pixel-for-pixel identical to the previous one
    const dup = st.dedupe && i > g.s && st.diffs[i] === 0;
    if (dup) frames[frames.length - 1].units++;
    else frames.push({ src: i, startU: i, units: 1 });
  }
  // GIF delays are in 1/100 s: round the running time so the total length stays exact
  let minDelay = Infinity;
  for (const f of frames) {
    const a = Math.round((f.startU - g.s) * 100 / st.fps), b = Math.round((f.startU - g.s + f.units) * 100 / st.fps);
    f.delay = Math.max(1, b - a);
    minDelay = Math.min(minDelay, f.delay);
  }
  return {
    s: g.s, e: g.e,
    outW: Math.max(1, Math.round(st.w * fit)),
    outH: Math.max(1, Math.round(st.h * fit)),
    frames,
    keepAlpha: st.hasAlpha && st.alphaMode === 'keep',
    matte: st.hasAlpha && st.alphaMode === 'matte' ? st.matte : null,
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
  const pngs = list.filter((f) => /\.png$/i.test(f.name) || f.type === 'image/png').sort(naturalSort);
  if (!pngs.length) { toast('No PNG files found. Drop a PNG sequence or a folder of PNGs.'); return; }

  startWorkers();
  st.thumbs.forEach((t) => t?.close?.());
  clearResults();
  player.clear(); player.playing = true;
  Object.assign(st, {
    files: pngs, n: pngs.length, thumbs: new Array(pngs.length), diffs: null, est: null,
    clips: [], sel: 0, baseName: baseNameOf(pngs[0].name), run: st.run + 1, building: null,
  });
  $('#empty').hidden = true;
  $('#editor').hidden = false;
  $('#loading').hidden = false;
  $('#loadText').textContent = `Analyzing frames 0 / ${st.n}`;
  $('#loadBar').style.width = '0%';
  $('#player').hidden = true;
  buildStrip();
  renderClips();
  st.loadId = nextId();
  wA.postMessage({ type: 'load', id: st.loadId, files: pngs });
}

/* ---------- Worker messages ---------- */
let pendingEst = null, pendingEnc = null;
function requestEstimate(plan, samples = 6) {
  if (pendingEst) pendingEst.resolve(null);
  const id = nextId();
  return new Promise((resolve) => {
    pendingEst = { id, resolve };
    wA.postMessage({ type: 'estimate', id, plan: planMsg(plan), samples });
  });
}
function requestEncode(plan, onProgress) {
  cancelEncode();
  const id = nextId();
  return new Promise((resolve) => {
    pendingEnc = { id, resolve, onProgress };
    wE.postMessage({ type: 'encode', id, plan: planMsg(plan), repeat: 0 });
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
    st.thumbs[m.index] = m.thumb;
    drawStripThumb(m.index);
    $('#loadText').textContent = `Analyzing frames ${m.index + 1} / ${m.total}`;
    $('#loadBar').style.width = ((m.index + 1) / m.total * 100) + '%';
  } else if (m.type === 'loaded' && m.id === st.loadId) {
    Object.assign(st, { baseW: m.baseW, baseH: m.baseH, sizes: m.sizes, hasAlpha: m.hasAlpha, diffs: m.diffs, w: m.baseW, h: m.baseH });
    wE.postMessage({ type: 'init', files: st.files, baseW: st.baseW, baseH: st.baseH });
    $('#loading').hidden = true;
    onLoaded();
  } else if (m.type === 'estimated' && pendingEst && m.id === pendingEst.id) {
    const p = pendingEst; pendingEst = null; p.resolve(m.bytes);
  } else if (m.type === 'error') {
    if (m.kind === 'estimate' && pendingEst?.id === m.id) { const p = pendingEst; pendingEst = null; p.resolve(null); }
    toast('Error: ' + m.message);
    if (m.kind === 'load') $('#loading').hidden = true;
  }
}

function onE(e) {
  const m = e.data;
  if (!pendingEnc || m.id !== pendingEnc.id) return;
  if (m.type === 'encodeProgress') pendingEnc.onProgress?.(m.done / m.total);
  else if (m.type === 'encoded') { const p = pendingEnc; pendingEnc = null; p.resolve(m.buffer); }
  else if (m.type === 'error') { const p = pendingEnc; pendingEnc = null; p.resolve(null); toast('Could not build GIF: ' + m.message); }
}

/* ---------- After loading ---------- */
function onLoaded() {
  const mismatched = st.sizes.filter(([w, h]) => w !== st.baseW || h !== st.baseH).length;
  $('#srcCount').textContent = `${st.n}`;
  $('#srcDims').textContent = `${st.baseW} × ${st.baseH}`;
  $('#srcAlpha').hidden = !st.hasAlpha;
  $('#sizeWarn').hidden = !mismatched;
  $('#sizeWarn').textContent = mismatched
    ? `${mismatched} image(s) differ in size from the first frame (${st.baseW} × ${st.baseH}) and were centered.` : '';
  $('#alphaGroup').hidden = !st.hasAlpha;
  renderControls();
  schedule(0);
}

/* ---------- Settings change → rebuild GIFs automatically ---------- */
let timer = 0;
function schedule(delay = 350) {
  if (!st.diffs) return;
  st.run++;             // stops any rebuild in progress
  cancelEncode();
  if (pendingEst) { const p = pendingEst; pendingEst = null; p.resolve(null); }
  st.est = null;
  st.sel = Math.min(st.sel, segments().length - 1);
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
  // drop results that no longer match any clip/settings
  const keep = new Set(segs.map((g) => keyOf(g, s)));
  for (const [k, r] of st.results) if (!keep.has(k)) { URL.revokeObjectURL(r.url); st.results.delete(k); }

  const order = [st.sel, ...segs.map((_, i) => i).filter((i) => i !== st.sel)];
  for (const i of order) {
    const g = segs[i], key = keyOf(g, s);
    if (st.results.has(key)) continue;
    st.building = { i, progress: 0, phase: st.targetOn ? 'fit' : 'encode' };
    renderBusy(); renderSize();

    let fit = 1, failed = false;
    if (st.targetOn) {
      const r = await fitToTarget(run, g);
      if (r == null || run !== st.run) return;
      fit = r.fit; failed = r.failed;
    }
    const plan = buildPlan(g, fit);
    if (i === st.sel && segs.length === 1 && !st.targetOn) {
      requestEstimate(plan).then((b) => { if (b != null && run === st.run && !st.results.has(key)) { st.est = b; renderSize(); } });
    }
    st.building = { i, progress: 0, phase: 'encode' };
    renderBusy();
    const buf = await requestEncode(plan, (p) => {
      if (run !== st.run) return;
      st.building.progress = p;
      renderBusy();
    });
    if (!buf || run !== st.run) return;
    const blob = new Blob([buf], { type: 'image/gif' });
    st.results.set(key, { blob, url: URL.createObjectURL(blob), bytes: blob.size, buffer: buf, plan, failed });
    st.building = null;
    if (i === st.sel) showSelected();
    renderClips(); renderInfo(); renderSize(); renderBusy();
  }
  st.building = null;
  renderBusy(); renderSize();
}

/* Find the scale factor that keeps one GIF under the target. Leaves 5% headroom for estimate error. */
async function fitToTarget(run, g) {
  const safe = st.targetMB * 1024 * 1024 * 0.95;
  const minFit = Math.min(1, 16 / Math.min(st.w, st.h));
  let f = 1, lo = null, hi = null, lastBytes = null;
  for (let it = 0; it < 7; it++) {
    const bytes = await requestEstimate(buildPlan(g, f), 5);
    if (bytes == null || run !== st.run) return null;
    lastBytes = bytes;
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
  if (lo != null) return { fit: lo, failed: false };
  return { fit: minFit, failed: true, bytes: lastBytes };
}

/* ---------- Rendering ---------- */
function renderControls() {
  $('#fpsInput').value = st.fps;
  $('#wInput').value = st.w;
  $('#hInput').value = st.h;
  $('#lockBtn').classList.toggle('on', st.lock);
  $('#lockBtn').setAttribute('aria-pressed', st.lock);
  $('#lockBtn').title = st.lock ? 'Aspect ratio locked' : 'Aspect ratio unlocked';
  $('#dedupe').checked = st.dedupe;
  $$('#alphaSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.alphaMode));
  $('#matteRow').hidden = st.alphaMode !== 'matte';
  $('#targetOn').checked = st.targetOn;
  $('#targetInput').disabled = !st.targetOn;
  $('#targetRow').classList.toggle('disabled', !st.targetOn);
}

function renderInfo() {
  const segs = segments();
  const g = segs[st.sel];
  const p = buildPlan(g);
  $('#clipCountRow').hidden = !st.clips.length;
  $('#clipCount').textContent = segs.length;
  $('#outFrames').textContent = p.frames.length;
  $('#outSecs').textContent = (p.totalCs / 100).toFixed(2) + 's';
  $('#delayWarn').hidden = p.minDelay >= 2;

  // target fit note (selected GIF)
  const r = resultFor(st.sel);
  const fitted = st.targetOn && r && (r.plan.outW !== st.w || r.plan.outH !== st.h);
  $('#fitNote').hidden = !st.targetOn || !r || !(fitted || r.failed);
  if (r) {
    $('#fitNote').textContent = r.failed ? 'Still over the target at the smallest size.' : `Resized to ${r.plan.outW} × ${r.plan.outH}`;
    $('#fitNote').classList.toggle('bad', r.failed);
  }

  // strip: dim merged frames and frames outside every clip
  const used = new Map();
  for (const sg of segs) for (const f of buildPlan(sg).frames) used.set(f.src, f.units);
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
  const results = segs.map((_, i) => resultFor(i));
  const done = results.filter(Boolean).length;
  const all = done === segs.length;
  const total = results.reduce((s, r) => s + (r ? r.bytes : 0), 0);
  const multi = segs.length > 1;
  const target = st.targetMB * 1024 * 1024;
  let label, value;
  if (all) {
    label = multi ? `Total size · ${segs.length} GIFs` : 'File size';
    value = fmtBytes(total);
  } else if (multi) {
    label = `Building ${Math.min(done + 1, segs.length)} of ${segs.length} GIFs`;
    value = done ? fmtBytes(total) + ' +' : 'Calculating…';
  } else {
    label = 'Estimated size';
    value = st.est != null ? '~ ' + fmtBytes(st.est) : 'Calculating…';
  }
  $('#sizeLabel').textContent = label;
  $('#sizeVal').textContent = value;
  const over = st.targetOn && results.some((r) => r && r.bytes > target);
  $('#sizeCard').classList.toggle('over', over);
  $('#dlBtn').disabled = !all;
  $('#dlBtn').textContent = multi ? `Download ${segs.length} GIFs` : 'Download GIF';
}

function renderBusy() {
  const ready = !!resultFor(st.sel);
  const b = st.building;
  const busy = !ready;
  $('#busy').hidden = !busy;
  if (busy) {
    if (b && b.i === st.sel) {
      $('#busyText').textContent = b.phase === 'fit' ? 'Fitting to target size' : `Building GIF ${Math.round(b.progress * 100)}%`;
      $('#busyBar').style.width = Math.round(b.progress * 100) + '%';
    } else {
      $('#busyText').textContent = 'Building GIF';
      $('#busyBar').style.width = '0%';
    }
  }
  $('#player').classList.toggle('dim', busy);
  $('#gifEmpty').hidden = !$('#player').hidden || busy;
  renderPlayState();
}

/* Show the selected GIF in the player (or keep the old one dimmed until it's ready) */
let shownKey = null, pendingSeekSrc = null;
function showSelected() {
  const segs = segments();
  const g = segs[st.sel];
  const r = resultFor(st.sel);
  // clip badge
  $('#clipBadge').hidden = segs.length < 2;
  $('#clipBadge').textContent = `Clip ${st.sel + 1} · ${g.s + 1}–${g.e + 1}`;
  if (r) {
    const key = keyOf(g);
    if (key !== shownKey) {
      let keep = null;
      if (pendingSeekSrc != null) { player.pause(); keep = outputFrameFor(r.plan, pendingSeekSrc); pendingSeekSrc = null; }
      else if (!player.playing && player.gif && shownPlan) {
        const src = shownPlan.frames[player.idx]?.src;
        if (src != null && src >= g.s && src <= g.e) keep = outputFrameFor(r.plan, src);
        else player.play(); // paused frame is outside this clip: start playing it
      }
      shownPlan = r.plan;
      shownKey = key;
      $('#player').hidden = false;
      player.load(r.buffer, keep);
      fitCanvas();
    } else if (pendingSeekSrc != null) {
      player.seek(outputFrameFor(r.plan, pendingSeekSrc)); pendingSeekSrc = null;
    }
  }
  renderBusy();
}
let shownPlan = null;

function clearResults() {
  for (const r of st.results.values()) URL.revokeObjectURL(r.url);
  st.results.clear();
  shownKey = null; shownPlan = null;
}

async function download() {
  const segs = segments();
  const multi = st.clips.length > 0;
  for (let i = 0; i < segs.length; i++) {
    const r = resultFor(i);
    if (!r) return;
    const g = segs[i];
    const a = document.createElement('a');
    a.href = r.url;
    a.download = multi ? `${st.baseName}_${padNum(g.s + 1)}-${padNum(g.e + 1)}.gif` : `${st.baseName}.gif`;
    a.click();
    if (i < segs.length - 1) await new Promise((res) => setTimeout(res, 300));
  }
}

/* ---------- Player ---------- */
const player = new GifPlayer($('#player'), (i) => {
  const src = shownPlan?.frames[i]?.src;
  if (nowCell) nowCell.classList.remove('now');
  nowCell = src != null ? stripCells[src] : null;
  if (nowCell) {
    nowCell.classList.add('now');
    if (!player.playing) nowCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
});
let nowCell = null;

// Fit the canvas inside the preview box without cropping (never upscale)
function fitCanvas() {
  const cv = $('#player'), stage = $('#stage');
  const w = cv.width, h = cv.height;
  $('#viewer').style.setProperty('--ar', `${w} / ${h}`);
  const bw = stage.clientWidth, bh = stage.clientHeight;
  if (!bw || !bh || w < 2) return;
  const k = Math.min(bw / w, bh / h, 1);
  cv.style.width = Math.floor(w * k) + 'px';
  cv.style.height = Math.floor(h * k) + 'px';
}
new ResizeObserver(fitCanvas).observe($('#stage'));

function renderPlayState() {
  $('#playIcon').hidden = $('#player').hidden || player.playing || !$('#busy').hidden;
}
$('#viewer').onclick = () => {
  if ($('#player').hidden || !$('#busy').hidden) return;
  player.toggle();
  renderPlayState();
};

/* ---------- Frame strip ---------- */
let stripCells = [];
function buildStrip() {
  const strip = $('#strip');
  strip.innerHTML = '';
  nowCell = null;
  stripCells = st.files.map((f, i) => {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.title = f.name;
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
  if (!r) { pendingSeekSrc = i; return; }
  if (shownKey !== keyOf(segments()[k])) { pendingSeekSrc = i; showSelected(); return; }
  player.seek(outputFrameFor(r.plan, i));
  renderPlayState();
}

/* ---------- Clips ---------- */
function selectClip(k, seekSrc = null) {
  st.sel = k;
  if (seekSrc != null) pendingSeekSrc = seekSrc;
  renderClips(); renderInfo(); showSelected();
  // if this clip isn't built yet, rebuild starting with it
  if (!resultFor(k)) schedule(0);
}

function setClips(clips, sel = st.sel) {
  st.clips = clips;
  st.sel = Math.max(0, Math.min(sel, segments().length - 1));
  schedule();
}

// Split where the animation stops: a run of identical frames ends a clip
function autoSplit() {
  const minPause = Math.max(3, Math.round(st.fps * 0.2));
  const cuts = [];
  let a = 0;
  for (let i = 1; i <= st.n; i++) {
    const same = i < st.n && st.diffs[i] === 0;
    if (same) continue;
    // frames a..i-1 are identical
    const len = i - a;
    if (len >= minPause && a > 0 && i < st.n) cuts.push(i - 1);
    a = i;
  }
  if (!cuts.length) { toast('No pauses found in this sequence.'); return; }
  const clips = [];
  let s = 0;
  for (const c of cuts) { clips.push({ s, e: c }); s = c + 1; }
  clips.push({ s, e: st.n - 1 });
  setClips(clips, 0);
  toast(`Split into ${clips.length} clips.`);
}

function addClip() {
  if (!st.clips.length) { setClips([{ s: 0, e: st.n - 1 }], 0); return; }
  const cs = [...st.clips];
  // fill the first gap, if any
  let prevEnd = -1;
  for (let i = 0; i <= cs.length; i++) {
    const start = i < cs.length ? cs[i].s : st.n;
    if (start - prevEnd > 1) { cs.splice(i, 0, { s: prevEnd + 1, e: start - 1 }); setClips(cs, i); return; }
    if (i < cs.length) prevEnd = cs[i].e;
  }
  // otherwise split the selected clip (or the longest) in half
  let k = st.sel;
  if (cs[k].e - cs[k].s < 1) k = cs.reduce((m, c, i) => (c.e - c.s > cs[m].e - cs[m].s ? i : m), 0);
  const c = cs[k];
  if (c.e - c.s < 1) { toast('Every clip is a single frame.'); return; }
  const mid = Math.floor((c.s + c.e) / 2);
  cs.splice(k, 1, { s: c.s, e: mid }, { s: mid + 1, e: c.e });
  setClips(cs, k + 1);
}

function removeClip(k) {
  const cs = st.clips.filter((_, i) => i !== k);
  setClips(cs, Math.min(st.sel, cs.length - 1));
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
  const has = st.clips.length > 0;
  $('#clearClips').hidden = !has;
  const list = $('#clipList');
  // keep focus on an input that is being edited
  const active = document.activeElement;
  if (active && list.contains(active) && active.tagName === 'INPUT') { renderTrack(); return; }
  list.innerHTML = '';
  st.clips.forEach((c, k) => {
    const r = resultFor(k);
    const row = document.createElement('div');
    row.className = 'clip' + (k === st.sel ? ' sel' : '');
    row.innerHTML = `
      <div class="name">Clip ${k + 1}<small>${r ? fmtBytes(r.bytes) : '…'}</small></div>
      <div class="range">
        <input type="number" min="1" max="${st.n}" value="${c.s + 1}" aria-label="Clip ${k + 1} start frame">
        <span>–</span>
        <input type="number" min="1" max="${st.n}" value="${c.e + 1}" aria-label="Clip ${k + 1} end frame">
      </div>
      <button class="del" aria-label="Remove clip ${k + 1}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
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
  renderTrack();
}

/* Clip bands under the frame strip, with drag handles on both ends */
function cellEdges() {
  return stripCells.map((c) => [c.offsetLeft, c.offsetLeft + c.offsetWidth]);
}
function renderTrack() {
  const track = $('#track');
  track.innerHTML = '';
  if (!st.clips.length || !stripCells.length) return;
  const edges = cellEdges();
  st.clips.forEach((c, k) => {
    const band = document.createElement('div');
    band.className = 'band' + (k === st.sel ? ' sel' : '');
    band.style.left = edges[c.s][0] + 'px';
    band.style.width = (edges[c.e][1] - edges[c.s][0]) + 'px';
    band.innerHTML = `<span class="handle l"></span><span class="lbl">${c.s + 1}–${c.e + 1}</span><span class="lbl end">${c.s + 1}–${c.e + 1}</span><span class="handle r"></span>`;
    band.classList.toggle('wide', edges[c.e][1] - edges[c.s][0] > 260);
    band.onclick = () => { if (k !== st.sel) selectClip(k); };
    band.querySelectorAll('.handle').forEach((hd) => hd.addEventListener('pointerdown', (e) => startDrag(e, k, hd.classList.contains('l') ? 'l' : 'r')));
    track.appendChild(band);
  });
}

let drag = null;
function startDrag(e, k, side) {
  e.preventDefault(); e.stopPropagation();
  drag = { k, side, edges: cellEdges(), orig: { ...st.clips[k] }, pointer: e.pointerId, x: e.clientX };
  e.target.setPointerCapture(e.pointerId);
  e.target.addEventListener('pointermove', onDrag);
  e.target.addEventListener('pointerup', endDrag);
  e.target.addEventListener('pointercancel', endDrag);
  if (st.sel !== k) { st.sel = k; renderInfo(); showSelected(); }
  dragScroll();
}
function onDrag(e) {
  if (!drag) return;
  drag.x = e.clientX;
  applyDrag();
}
function applyDrag() {
  const inner = $('#stripInner').getBoundingClientRect();
  const x = drag.x - inner.left;
  const c = st.clips[drag.k];
  let best = 0, bestD = Infinity;
  drag.edges.forEach(([l, r], i) => {
    const d = Math.abs((drag.side === 'l' ? l : r) - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (drag.side === 'l') updateClip(drag.k, best, c.e);
  else updateClip(drag.k, c.s, Math.max(best, c.s));
  // live update of the band and the list numbers
  const nc = st.clips[drag.k];
  const band = $('#track').children[drag.k];
  band.style.left = drag.edges[nc.s][0] + 'px';
  band.style.width = (drag.edges[nc.e][1] - drag.edges[nc.s][0]) + 'px';
  band.querySelectorAll('.lbl').forEach((l) => (l.textContent = `${nc.s + 1}–${nc.e + 1}`));
  band.classList.toggle('wide', drag.edges[nc.e][1] - drag.edges[nc.s][0] > 260);
  const inputs = $('#clipList').children[drag.k]?.querySelectorAll('input');
  if (inputs) { inputs[0].value = nc.s + 1; inputs[1].value = nc.e + 1; }
}
// auto-scroll the strip while dragging near its edges
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
function endDrag(e) {
  if (!drag) return;
  e.target.removeEventListener('pointermove', onDrag);
  e.target.removeEventListener('pointerup', endDrag);
  e.target.removeEventListener('pointercancel', endDrag);
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

/* ---------- Events ---------- */
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  loadFiles(await filesFromDataTransfer(e.dataTransfer));
});
addEventListener('resize', () => { if (!drag) renderTrack(); });
$('#pickFiles').onchange = (e) => { loadFiles([...e.target.files]); e.target.value = ''; };
$('#pickFolder').onchange = (e) => { loadFiles([...e.target.files]); e.target.value = ''; };
$$('[data-pick]').forEach((b) => (b.onclick = () => $('#' + b.dataset.pick).click()));

const MAXD = 8192;
const changed = () => { renderControls(); schedule(); };
$('#fpsInput').onchange = (e) => { st.fps = clampInt(e.target.value, 1, 100, 30); changed(); };
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
  if (st.lock) { // snap back to the original aspect ratio when locking
    const nh = Math.max(1, Math.round(st.w * st.baseH / st.baseW));
    if (nh !== st.h) { st.h = nh; changed(); return; }
  }
  renderControls();
};
$('#dedupe').onchange = (e) => { st.dedupe = e.target.checked; changed(); };
$$('#alphaSeg button').forEach((b) => (b.onclick = () => { st.alphaMode = b.dataset.v; changed(); }));
$('#matteColor').oninput = (e) => { st.matte = e.target.value; schedule(); };
$('#targetOn').onchange = (e) => { st.targetOn = e.target.checked; changed(); if (st.targetOn) $('#targetInput').focus(); };
$('#targetInput').onchange = (e) => { st.targetMB = Math.max(0.1, +e.target.value || 5); e.target.value = st.targetMB; changed(); };
$('#autoSplit').onclick = () => st.diffs && autoSplit();
$('#addClip').onclick = () => st.diffs && addClip();
$('#clearClips').onclick = () => setClips([], 0);
$('#dlBtn').onclick = download;
// Enter in a number field applies it right away
$$('input[type=number]').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); }));

startWorkers();
