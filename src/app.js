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
  fit: 1, fitFailed: false, plan: null, est: null, loadId: 0,
  run: 0, encodeId: 0, encodePlan: null, gifPlan: null, gifUrl: null, gifBytes: 0, baseName: 'animation',
};

/* ---------- Utils ---------- */
function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 2 : 1) + ' MB';
}
const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const baseNameOf = (name) => name.replace(/\.[^.]+$/, '').replace(/[\s_\-.]*\d+$/, '') || 'animation';
const clampInt = (v, lo, hi, dflt) => { v = Math.round(+v); return Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, v)) : dflt; };

/* ---------- Plan: which frames to show and for how long ---------- */
function buildPlan(fit = st.fit) {
  const n = st.n;
  const frames = [];
  for (let i = 0; i < n; i++) {
    // merge only frames that are pixel-for-pixel identical to the previous one
    const dup = st.dedupe && i > 0 && st.diffs[i] === 0;
    if (dup) frames[frames.length - 1].units++;
    else frames.push({ src: i, startU: i, units: 1 });
  }
  // GIF delays are in 1/100 s: round the running time so the total length stays exact
  let minDelay = Infinity;
  for (const f of frames) {
    const a = Math.round(f.startU * 100 / st.fps), b = Math.round((f.startU + f.units) * 100 / st.fps);
    f.delay = Math.max(1, b - a);
    minDelay = Math.min(minDelay, f.delay);
  }
  return {
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
  clearGif();
  Object.assign(st, {
    files: pngs, n: pngs.length, thumbs: new Array(pngs.length), diffs: null, plan: null, est: null,
    baseName: baseNameOf(pngs[0].name), run: st.run + 1, encodeId: 0, gifPlan: null,
  });
  $('#empty').hidden = true;
  $('#editor').hidden = false;
  $('#loading').hidden = false;
  $('#loadText').textContent = `Analyzing frames 0 / ${st.n}`;
  $('#loadBar').style.width = '0%';
  buildStrip();
  st.loadId = nextId();
  wA.postMessage({ type: 'load', id: st.loadId, files: pngs });
}

/* ---------- Worker messages ---------- */
let pendingEst = null;
function requestEstimate(plan, samples = 6) {
  if (pendingEst) pendingEst.resolve(null);
  const id = nextId();
  return new Promise((resolve) => {
    pendingEst = { id, resolve };
    wA.postMessage({ type: 'estimate', id, plan: planMsg(plan), samples });
  });
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
  if (m.id !== st.encodeId) return;
  if (m.type === 'encodeProgress') {
    setBusy(`Building GIF ${Math.round(m.done / m.total * 100)}%`, m.done / m.total);
  } else if (m.type === 'encoded') {
    st.encodeId = 0;
    const blob = new Blob([m.buffer], { type: 'image/gif' });
    // if paused, stay on the same source frame in the new GIF
    const keep = player.playing ? null : frameIndexForSrc(st.gifPlan, player.idx, st.encodePlan);
    clearGif(false);
    st.gifUrl = URL.createObjectURL(blob);
    st.gifBytes = blob.size;
    st.gifPlan = st.encodePlan;
    player.load(m.buffer, keep);
    setBusy(null);
    renderSize();
  } else if (m.type === 'error') {
    st.encodeId = 0;
    setBusy(null);
    toast('Could not build GIF: ' + m.message);
  }
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

/* ---------- Settings change → rebuild the GIF automatically ---------- */
let timer = 0;
function schedule(delay = 350) {
  if (!st.diffs) return;
  // drop any encode in progress; its settings are out of date
  if (st.encodeId) { wE.postMessage({ type: 'cancel', kind: 'encode' }); st.encodeId = 0; }
  st.plan = buildPlan(st.targetOn ? st.fit : 1);
  renderInfo();
  setBusy(st.targetOn ? 'Fitting to target size' : 'Building GIF', 0);
  clearTimeout(timer);
  timer = setTimeout(rebuild, delay);
}

async function rebuild() {
  const run = ++st.run;
  st.est = null;
  renderSize(true);

  let fit = 1;
  if (st.targetOn) {
    const r = await fitToTarget(run);
    if (r == null || run !== st.run) return;
    fit = r.fit; st.est = r.bytes; st.fitFailed = r.failed;
  } else st.fitFailed = false;
  st.fit = fit;
  st.plan = buildPlan(fit);
  renderInfo();

  // start encoding; show a quick estimate until the real file is ready
  st.encodeId = nextId();
  st.encodePlan = st.plan;
  setBusy('Building GIF 0%', 0);
  wE.postMessage({ type: 'encode', id: st.encodeId, plan: planMsg(st.plan), repeat: 0 });
  if (!st.targetOn) {
    requestEstimate(st.plan).then((b) => {
      if (b != null && run === st.run && st.encodeId) { st.est = b; renderSize(); }
    });
  } else renderSize();
}

/* Find the scale factor that keeps the GIF under the target. Leaves 5% headroom for estimate error. */
async function fitToTarget(run) {
  const safe = st.targetMB * 1024 * 1024 * 0.95;
  const minFit = Math.min(1, 16 / Math.min(st.w, st.h));
  let f = 1, lo = null, hi = null, loBytes = null, lastBytes = null;
  for (let it = 0; it < 7; it++) {
    const bytes = await requestEstimate(buildPlan(f), 5);
    if (bytes == null || run !== st.run) return null;
    lastBytes = bytes;
    if (bytes <= safe) {
      if (lo == null || f > lo) { lo = f; loBytes = bytes; }
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
  if (lo != null) return { fit: lo, bytes: loBytes, failed: false };
  return { fit: minFit, bytes: lastBytes, failed: true };
}

/* ---------- Rendering ---------- */
function renderControls() {
  $('#fpsInput').value = st.fps;
  $('#wInput').value = st.w;
  $('#hInput').value = st.h;
  $('#pctInput').value = Math.abs(st.w / st.baseW - st.h / st.baseH) < 0.01 ? Math.round(st.w / st.baseW * 100) : '';
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
  const p = st.plan;
  $('#outFrames').textContent = p.frames.length;
  $('#outSecs').textContent = (p.totalCs / 100).toFixed(2) + 's';
  $('#delayWarn').hidden = p.minDelay >= 2;
  const fitted = st.targetOn && (p.outW !== st.w || p.outH !== st.h);
  $('#fitNote').hidden = !st.targetOn || !(fitted || st.fitFailed);
  $('#fitNote').textContent = st.fitFailed ? 'Still over the target at the smallest size.' : `Resized to ${p.outW} × ${p.outH}`;
  $('#fitNote').classList.toggle('bad', st.fitFailed);
  updateStripState();
}

function renderSize(loading = false) {
  const actual = st.gifUrl && !st.encodeId;
  const shown = actual ? st.gifBytes : st.est;
  $('#sizeLabel').textContent = actual ? 'File size' : 'Estimated size';
  $('#sizeVal').textContent = loading || shown == null ? 'Calculating…' : (actual ? '' : '~ ') + fmtBytes(shown);
  const over = st.targetOn && shown != null && !loading && shown > st.targetMB * 1024 * 1024;
  $('#sizeCard').classList.toggle('over', over);
  $('#dlBtn').disabled = !actual;
}

function setBusy(text, progress = 0) {
  const busy = text != null;
  $('#busy').hidden = !busy;
  $('#player').classList.toggle('dim', busy);
  if (busy) {
    $('#busyText').textContent = text;
    $('#busyBar').style.width = Math.round(progress * 100) + '%';
  }
  $('#gifEmpty').hidden = !!st.gifUrl || busy;
  $('#player').hidden = !st.gifUrl;
  renderPlayState();
}

function clearGif(clearPlayer = true) {
  if (st.gifUrl) URL.revokeObjectURL(st.gifUrl);
  st.gifUrl = null; st.gifBytes = 0;
  if (clearPlayer) { player.clear(); player.playing = true; }
}

function download() {
  if (!st.gifUrl) return;
  const a = document.createElement('a');
  a.href = st.gifUrl; a.download = st.baseName + '.gif';
  a.click();
}

/* ---------- Player ---------- */
const player = new GifPlayer($('#player'), (i) => {
  const src = st.gifPlan?.frames[i]?.src;
  if (nowCell) nowCell.classList.remove('now');
  nowCell = src != null ? stripCells[src] : null;
  if (nowCell) {
    nowCell.classList.add('now');
    if (!player.playing) nowCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
});
let nowCell = null;

// map an output frame of one plan to the matching output frame of another plan
function frameIndexForSrc(fromPlan, idx, toPlan) {
  if (!fromPlan || !toPlan) return 0;
  const src = fromPlan.frames[idx]?.src ?? 0;
  return outputFrameFor(toPlan, src);
}
function outputFrameFor(plan, src) {
  const fs = plan.frames;
  for (let k = 0; k < fs.length; k++) if (src >= fs[k].startU && src < fs[k].startU + fs[k].units) return k;
  return 0;
}
function renderPlayState() {
  $('#playIcon').hidden = !st.gifUrl || player.playing || !$('#busy').hidden;
}
$('#viewer').onclick = () => {
  if (!st.gifUrl) return;
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
    cell.onclick = () => seekToSource(i);
    strip.appendChild(cell);
    return cell;
  });
}
function seekToSource(i) {
  if (!st.gifUrl || !st.gifPlan) return;
  player.seek(outputFrameFor(st.gifPlan, i));
  renderPlayState();
}
function drawStripThumb(i) {
  const th = st.thumbs[i], cv = stripCells[i]?.querySelector('canvas');
  if (!th || !cv) return;
  cv.width = th.width; cv.height = th.height;
  cv.getContext('2d').drawImage(th, 0, 0);
}
function updateStripState() {
  const used = new Map(st.plan.frames.map((f) => [f.src, f.units]));
  stripCells.forEach((c, i) => {
    const u = used.get(i);
    c.classList.toggle('off', !u);
    c.querySelector('.dur').textContent = u > 1 ? '×' + u : '';
  });
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
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
$('#pctInput').onchange = (e) => {
  const p = clampInt(e.target.value, 1, 400, 100) / 100;
  st.w = Math.max(1, Math.round(st.baseW * p)); st.h = Math.max(1, Math.round(st.baseH * p));
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
$('#targetOn').onchange = (e) => { st.targetOn = e.target.checked; st.fit = 1; changed(); if (st.targetOn) $('#targetInput').focus(); };
$('#targetInput').onchange = (e) => { st.targetMB = Math.max(0.1, +e.target.value || 5); e.target.value = st.targetMB; changed(); };
$('#dlBtn').onclick = download;
// Enter in a number field applies it right away
$$('input[type=number]').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); }));

startWorkers();
