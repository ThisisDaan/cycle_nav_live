import { reverse } from './geocode.js';
import * as offline from './offline.js';
import * as bnative from './brouter-native.js';
import { refreshOfflineSegments, routingMode } from './router.js';
import { t } from './i18n.js';
import { isLand, map, panelW, resetNorth } from './mapview.js';
import { stopFollow } from './position.js';
import { closeSettings, currentTab } from './settings.js';
import { $, askConfirm, esc, toast } from './ui.js';

// ---------------------------------------------------------------- offline maps

let offJob = null;   // { cancel, label, pct } while a download runs
const MB = b => b > 0 ? Math.max(1, Math.round(b / 1e6)) : 0;
const SEG_BYTES = 180e6;

export async function renderOffline() {
  const box = $('#offlineBox');
  if (!box) return;
  const regions = await offline.listRegions().catch(() => []);
  const segs = bnative.available() ? await bnative.listSegments().catch(() => []) : [];
  if (!$('#offlineBox')) return;
  const busy = !!offJob;
  box.innerHTML = `
    ${regions.length ? regions.map(r => `<div class="list-item">
        <div class="li-main"><div class="li-title">${esc(r.name)}</div>
          <div class="li-sub">${MB(r.bytes)} MB · ${new Date(r.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</div></div>
        <button class="secondary-btn" data-off-refresh="${esc(r.id)}" ${busy ? 'disabled' : ''}>Refresh</button>
        <button class="secondary-btn" data-off-del="${esc(r.id)}" ${busy ? 'disabled' : ''}>Delete</button>
      </div>`).join('') : `<p class="hint" style="margin-top:0">${t('No downloaded maps yet.')}</p>`}
    ${bnative.available() ? `<h4 style="margin:14px 0 4px">${t('Routing data')}</h4>
      ${segs.length ? segs.map(g => `<div class="list-item">
        <div class="li-main"><div class="li-title">${esc(g.name)}</div><div class="li-sub">${MB(g.size)} MB</div></div>
        <button class="secondary-btn" data-seg-del="${esc(g.name)}" ${busy ? 'disabled' : ''}>Delete</button>
      </div>`).join('') : `<p class="hint" style="margin-top:0">${t('No routing data downloaded.')}</p>`}`
      : `<p class="hint">${t('Offline routing needs the Android app. Maps and search work here.')}</p>`}
    <div class="btn-row"><button class="primary-btn" id="offPick" ${busy ? 'disabled' : ''}>Download an area</button></div>
    <p class="hint">${t('Downloaded maps let you see the map and search for places without a connection.')}</p>`;
  const on = (sel, fn) => box.querySelectorAll(sel).forEach(el => el.onclick = fn);
  on('[data-off-del]', async e => {
    const r = regions.find(x => x.id === e.currentTarget.dataset.offDel);
    if (!r || !await askConfirm(t('Delete {0}?', r.name), { ok: 'Delete', danger: true })) return;
    await offline.deleteRegion(r.id); renderOffline();
  });
  on('[data-off-refresh]', async e => {
    const r = regions.find(x => x.id === e.currentTarget.dataset.offRefresh);
    if (!r) return;
    await offline.deleteRegion(r.id);
    startOfflineDownload(r.bounds, r.name);
  });
  on('[data-seg-del]', async e => {
    const n = e.currentTarget.dataset.segDel;
    if (!await askConfirm(t('Delete {0}?', n), { ok: 'Delete', danger: true })) return;
    await bnative.deleteSegment(n); await refreshOfflineSegments(); updateOfflineChip(); renderOffline();
  });
  on('#offPick', openPicker);
}

function offProgress(label, pct) {
  if (!offJob) return;
  offJob.label = label; offJob.pct = pct;
  $('#dlLabel').textContent = label;
  $('#dlBar').style.width = pct + '%';
  $('#dlPct').textContent = pct + '%';
}

async function startOfflineDownload(bounds, name) {
  if (offJob) { toast('A download is already running'); return; }
  const b = bounds.getSouth ? { s: bounds.getSouth(), w: bounds.getWest(), n: bounds.getNorth(), e: bounds.getEast() } : bounds;
  const lb = L.latLngBounds([b.s, b.w], [b.n, b.e]);
  if (!name) {
    try { name = (await reverse([(b.s + b.n) / 2, (b.w + b.e) / 2])).name; } catch { /* fall back */ }
    if (!name || /^-?\d+\.\d+, /.test(name)) name = t('Area {0}', new Date().toLocaleDateString());
  }
  let need = [];
  if (bnative.available()) {
    const have = new Set((await bnative.listSegments().catch(() => [])).map(x => x.name));
    need = bnative.segmentsFor(lb).filter(n => !have.has(n));
  }
  const scale = need.length ? 0.5 : 1;
  const job = offline.downloadRegion(name, b, p => {
    const label = { assets: 'Downloading fonts and symbols…', tiles: 'Downloading map…', index: 'Downloading search index…' }[p.phase];
    const frac = p.total ? p.done / p.total : 0;
    const base = { assets: 0, tiles: 3, index: 95 }[p.phase] ?? 0, span = { assets: 3, tiles: 92, index: 5 }[p.phase] ?? 0;
    offProgress(`${t(label)} ${MB(p.bytes)} MB`, Math.round((base + frac * span) * scale));
  });
  offJob = { cancel: () => job.cancel(), label: t('Downloading map…'), pct: 0 };
  $('#dlName').textContent = name;
  $('#dlCard').hidden = false;
  $('#dlCancel').onclick = () => offJob?.cancel();
  offProgress(t('Downloading map…'), 0);
  if (!$('#settings').hidden && currentTab === 'more') renderOffline();
  try {
    await job.promise;
    for (let i = 0; i < need.length; i++) {
      await bnative.downloadSegment(need[i], (loaded, total) =>
        offProgress(`${t('Downloading routing data…')} ${need[i]} ${MB(loaded)}/${MB(total || SEG_BYTES)} MB`, Math.round(50 + (i + loaded / (total || SEG_BYTES)) / need.length * 50)));
    }
    if (need.length) await refreshOfflineSegments();
    toast('Area downloaded');
  } catch (e) {
    toast(e?.name === 'AbortError' ? 'Download cancelled' : 'Download failed');
  } finally {
    offJob = null; updateOfflineChip();
    $('#dlCard').hidden = true;
    if (!$('#settings').hidden && currentTab === 'more') renderOffline();
  }
}

// ---- area picker: a fixed frame over the map; what is inside it gets downloaded
export let picking = false, pickRect = null, pickLayer = null, pickSegs = new Set(), pickTimer = 0, pickGeoTimer = 0, pickTok = 0;
export function setPickRect(v) { pickRect = v; }
const PICK_MIN = 80, PICK_MAX_BYTES = 1.5e9, PICK_MAX_TILES = 150000;
let pickState = null;   // { bounds, name, ok }

async function openPicker() {
  if (offJob) { toast('A download is already running'); return; }
  closeSettings();
  stopFollow(true);
  resetNorth(true);
  picking = true;
  document.body.classList.add('picking');
  $('#pickSheet').hidden = false;
  $('#pickFrame').hidden = false;
  pickRect = defaultPickRect();
  layoutPick();
  pickState = null;
  $('#pickGo').disabled = true;
  $('#pickName').textContent = t('Looking up place…');
  pickLayer = L.layerGroup().addTo(map);
  offline.listRegions().then(rs => {
    if (!picking) return;
    const col = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#2f9e6e';
    for (const r of rs) L.rectangle([[r.bounds.s, r.bounds.w], [r.bounds.n, r.bounds.e]],
      { interactive: false, color: col, weight: 1.5, dashArray: '5 5', fillOpacity: 0.05 }).addTo(pickLayer);
  }).catch(() => {});
  if (bnative.available()) bnative.listSegments().then(x => { pickSegs = new Set(x.map(g => g.name)); schedulePick(); }).catch(() => {});
  map.on('move zoom', schedulePick);
  schedulePick();
}

export function closePicker() {
  if (!picking) return;
  picking = false;
  clearTimeout(pickTimer); clearTimeout(pickGeoTimer);
  map.off('move zoom', schedulePick);
  pickLayer?.remove(); pickLayer = null;
  document.body.classList.remove('picking');
  $('#pickSheet').hidden = true;
  $('#pickFrame').hidden = true;
}

// Free area for the frame: above the sheet in portrait, right of the left column in landscape.
function pickArea() {
  const w = innerWidth, h = innerHeight;
  return isLand() ? { x0: panelW(), x1: w, y1: h } : { x0: 0, x1: w, y1: $('#pickSheet').getBoundingClientRect().top - 8 };
}
export function defaultPickRect() {
  const a = pickArea(), aw = a.x1 - a.x0, ah = isLand() ? a.y1 : a.y1 - 0;
  const sheetH = $('#pickSheet').offsetHeight || 170;
  const availH = isLand() ? ah : innerHeight - sheetH, mw = aw * 0.1, mh = availH * 0.1;
  return { l: a.x0 + mw, t: Math.max(mh, 24), r: a.x1 - mw - (isLand() ? 56 : 0), b: availH - mh - (isLand() ? 8 : 24) };
}

export function layoutPick() {
  const f = $('#pickFrame').style, r = pickRect;
  f.left = r.l + 'px'; f.top = r.t + 'px'; f.width = (r.r - r.l) + 'px'; f.height = (r.b - r.t) + 'px';
}

function pickBounds() {
  const mr = $('#map').getBoundingClientRect(), r = pickRect;
  const nw = map.containerPointToLatLng([r.l - mr.left, r.t - mr.top]), se = map.containerPointToLatLng([r.r - mr.left, r.b - mr.top]);
  return L.latLngBounds([se.lat, nw.lng], [nw.lat, se.lng]);
}

export function schedulePick() {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(updatePick, 120);
}

function updatePick() {
  if (!picking) return;
  const lb = pickBounds(), est = offline.estimateRegion(lb);
  const need = bnative.available() ? bnative.segmentsFor(lb).filter(n => !pickSegs.has(n)) : [];
  const segBytes = need.length * SEG_BYTES, total = est.bytes + segBytes;
  const big = total > PICK_MAX_BYTES || est.tiles > PICK_MAX_TILES;
  const parts = [t('Map ≈ {0} MB', MB(est.bytes))];
  if (bnative.available()) parts.push(need.length ? t('routing data ≈ {0} MB', MB(segBytes)) : t('Routing data for this area is already downloaded.'));
  if (need.length) parts.push(t('total ≈ {0} MB', MB(total)));
  $('#pickInfo').innerHTML = big
    ? `<span class="warn">${esc(t('This area is too large. Zoom in to pick a smaller area.'))}</span><br>${esc(parts.join(' · '))}`
    : `${esc(parts.join(' · '))}<br>${esc(t('Pan and zoom the map, drag the corners to resize.'))}`;
  pickState = { ...(pickState || {}), bounds: lb, ok: !big };
  $('#pickGo').disabled = big;
  clearTimeout(pickGeoTimer);
  const tok = ++pickTok, c = lb.getCenter();
  pickGeoTimer = setTimeout(async () => {
    let name = '';
    try { name = (await reverse([c.lat, c.lng])).name; } catch { /* offline */ }
    if (tok !== pickTok || !picking) return;
    if (!name || /^-?\d+\.\d+, /.test(name)) name = t('Area {0}', new Date().toLocaleDateString());
    pickState.name = name;
    $('#pickName').textContent = name;
  }, 600);
}

export function wirePicker() {
  document.querySelectorAll('#pickFrame .ph').forEach(h => {
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const c = h.dataset.c, move = ev => {
        const r = pickRect, a = pickArea();
        const x = Math.min(Math.max(ev.clientX, a.x0 + 8), a.x1 - 8), y = Math.min(Math.max(ev.clientY, 8), Math.min(innerHeight - 8, a.y1));
        if (c.includes('w')) r.l = Math.min(x, r.r - PICK_MIN); else r.r = Math.max(x, r.l + PICK_MIN);
        if (c.includes('n')) r.t = Math.min(y, r.b - PICK_MIN); else r.b = Math.max(y, r.t + PICK_MIN);
        layoutPick(); schedulePick();
      };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
      h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
    });
  });
  $('#pickCancel').onclick = closePicker;
  $('#pickGo').onclick = () => {
    if (!pickState?.ok) return;
    const { bounds, name } = pickState;
    closePicker();
    startOfflineDownload(bounds, name);
  };
}

function updateOfflineChip() {
  const el = $('#offlineChip');
  if (!el) return;
  const off = offline.isOffline();
  el.hidden = !off;
  if (off) el.textContent = routingMode() === 'none' ? t('Offline – no routing data here') : t('Offline – using downloaded map');
}
export function wireOffline() {
  offline.onOfflineChange(updateOfflineChip);
  window.addEventListener('offline', updateOfflineChip);
  window.addEventListener('online', updateOfflineChip);
  updateOfflineChip();
}
