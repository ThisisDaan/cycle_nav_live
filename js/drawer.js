import * as store from './store.js';
import { saveFile } from './native.js';
import { icon, iconOrEmoji } from './icons.js';
import { t } from './i18n.js';
import { dist, fmtDist } from './geo.js';
import { map } from './mapview.js';
import { addStop, nav } from './navigation.js';
import { picking } from './offlineui.js';
import { deletePin, editPin, openPinPopup, pinIcon, renderPins } from './pins.js';
import { choosePlace } from './planner.js';
import { openSavedPlan } from './routing-ui.js';
import { me } from './position.js';
import { followTrack, importGpx, pickGpxRoute, reloadRides, rideList, toGpx } from './rides.js';
import { currentTab, openSettings } from './settings.js';
import { $, askConfirm, askState, askText, esc, locked, pickFiles, S, toast } from './ui.js';

// ---------------------------------------------------------------- saved drawer (pins, routes, rides)

export let drawerTab = 'pins', drawerQuery = '', drawerOpen = false, drawerHideTimer = 0, drawerPos = 0;
const dFmtDate = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

// what each tab lists, already filtered by the search box
function drawerItems(tab) {
  const q = drawerQuery.trim().toLowerCase();
  const hit = (...f) => !q || f.some(x => String(x || '').toLowerCase().includes(q));
  if (tab === 'pins') {
    const list = S().pins.filter(p => hit(p.name, p.note));
    if (me) list.sort((a, b) => dist(me.latlng, a.latlng) - dist(me.latlng, b.latlng));
    return list;
  }
  return rideList.filter(r => (r.source === 'planned') === (tab === 'routes') && hit(r.name || t('Ride')))
    .sort((a, b) => b.startedAt - a.startedAt);
}
const drawerCount = tab => tab === 'pins' ? S().pins.length : rideList.filter(r => (r.source === 'planned') === (tab === 'routes')).length;

export function renderDrawer() {
  if (!drawerOpen) return;
  const tab = drawerTab, items = drawerItems(tab), total = drawerCount(tab);
  document.querySelectorAll('#drawerTabs .dtab').forEach(b => {
    b.classList.toggle('active', b.dataset.dt === tab);
    b.setAttribute('aria-selected', b.dataset.dt === tab);
  });
  const navStop = nav && !nav.recordOnly;
  const row = (id, badge, name, sub, acts) => `<div class="srow" data-id="${esc(id)}">
    <button class="srow-main" data-a="open">${badge}<span class="srow-text"><b class="srow-name">${esc(name)}</b><span class="srow-sub">${sub}</span></span></button>
    <div class="srow-acts">${acts}</div></div>`;
  const act = (a, label, cls = '', tip = '') => `<button class="sact ${cls}" data-a="${a}"${tip ? ` title="${esc(tip)}" aria-label="${esc(tip)}"` : ''}>${label}</button>`;
  let html;
  if (tab === 'pins') {
    html = items.map(p => row(p.id, `<span class="srow-ic">${pinIcon(p, 24)}</span>`, p.name,
      [me ? esc(t('{0} from you', fmtDist(dist(me.latlng, p.latlng)))) : '', esc(p.note || '')].filter(Boolean).join(' · ') || esc(t('Pin')),
      (navStop ? act('stop', icon('add', 16) + ' ' + t('Add as stop'), 'go') : nav ? '' : act('to', icon('directions', 16) + ' ' + t('Directions to here'), 'go')) +
      act('show', icon(p.show ? 'visibility' : 'visibility_off', 20), 'ic ' + (p.show ? 'on' : ''), p.show ? t('Shown on map') : t('Hidden on map')) +
      act('edit', icon('edit', 20), 'ic', t('Edit')) + act('del', icon('delete', 20), 'ic danger', t('Delete')))).join('');
  } else {
    html = items.map(r => {
      const b = S().bikes.find(x => x.id === r.bikeId);
      const badge = `<span class="srow-ic" style="--bike:${esc(b?.color || '#888')}">${iconOrEmoji(b?.icon, 24)}</span>`;
      const speed = tab === 'rides' && r.movingTime ? ` · ${(r.distance / r.movingTime * 3.6).toFixed(1)} km/h` : '';
      return row(r.id, badge, r.name || t('Ride'), `${esc(fmtDist(r.distance))} · ${esc(dFmtDate(r.startedAt))}${speed}`,
        (nav ? '' : act('ride', icon('play', 16) + ' ' + t('Ride it'), 'go')) + act('rename', icon('edit', 20), 'ic', t('Rename')) + act('gpx', 'GPX', '', t('Export GPX')) + act('del', icon('delete', 20), 'ic danger', t('Delete')));
    }).join('');
  }
  if (!items.length) {
    const hint = total ? t('Nothing found') : ({
      pins: t('No pins yet. Long-press the map, or tap the pin icon in a search result, to save a place.'),
      routes: t('No saved routes yet. Plan a route and tap the bookmark button to keep it here.'),
      rides: t('No rides yet. Navigate somewhere, or tap the red record button and ride your favourite way.'),
    })[tab];
    html = `<div class="drawer-empty"><div class="de-ic">${icon(total ? 'search' : { pins: 'place', routes: 'map', rides: 'bike' }[tab], 52)}</div><p>${esc(hint)}</p></div>`;
  }
  $('#drawerList').innerHTML = html;
  $('#drawerSearch').placeholder = t('Search saved');
  $('#drawerSearchBox').hidden = !total;
  $('#drawerFoot').innerHTML = tab === 'pins'
    ? `<button class="secondary-btn" data-f="here">${icon('push_pin', 18)} ${esc(t('Save my location'))}</button>`
    : `<button class="secondary-btn" data-f="import">${esc(t('Import GPX rides'))}</button><button class="secondary-btn" data-f="follow">${esc(t('Navigate a GPX route'))}</button>`;
}

function setDrawerPos(p) {
  drawerPos = p;
  $('#drawerPanel').style.transform = `translateX(calc(${1 - p} * (var(--drawer-off, var(--panel-w)) - 100%)))`;
  $('#drawerScrim').style.opacity = p;
}
function openDrawer(tab) {
  if (locked || picking) return;
  if (tab) drawerTab = tab;
  clearTimeout(drawerHideTimer);
  if (!drawerOpen) { drawerQuery = ''; $('#drawerSearch').value = ''; }
  $('#bikeMenu').hidden = true;
  map.closePopup();
  drawerOpen = true;
  const wasHidden = !$('#drawer').classList.contains('on');
  $('#drawer').classList.add('on');
  document.body.classList.add('drawer-open');
  renderDrawer();
  if (wasHidden) { $('#drawerPanel').classList.add('dragging'); setDrawerPos(0); $('#drawerPanel').offsetWidth; }
  $('#drawerPanel').classList.remove('dragging');
  setDrawerPos(1);
}
export function closeDrawer() {
  if (!drawerOpen && !$('#drawer').classList.contains('on')) return;
  drawerOpen = false;
  document.activeElement?.blur?.();
  $('#drawerPanel').classList.remove('dragging');
  setDrawerPos(0);
  document.body.classList.remove('drawer-open');
  clearTimeout(drawerHideTimer);
  drawerHideTimer = setTimeout(() => { $('#drawer').classList.remove('on'); }, 260);
}

function previewRide(r) {
  const line = L.polyline(r.points, { color: S().theme.accent, weight: 6, dashArray: '2 10', lineCap: 'round' }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [40, 40] });
  setTimeout(() => line.remove(), 8000);
}
async function exportRideGpx(r) {
  const file = `${(r.name || 'ride').replace(/[^\w\- ]+/g, '').trim() || 'ride'}.gpx`;
  try { await saveFile(file, toGpx(r), 'application/gpx+xml'); } catch { toast('Could not export the GPX'); }
}
export function importGpxFiles() {
  pickFiles('.gpx,application/gpx+xml', true, async files => { await importGpx(files); renderDrawer(); if (!$('#settings').hidden && currentTab === 'more') openSettings('more'); });
}

async function drawerAction(id, a) {
  const pin = S().pins.find(p => p.id === id), ride = rideList.find(r => r.id === id);
  if (pin) {
    const place = { name: pin.name, detail: pin.note || '', latlng: pin.latlng };
    if (a === 'open') {
      if (nav) {
        if (nav.recordOnly) return;
        if (await askConfirm(t('Add {0} as a stop?', pin.name), { ok: 'Add as stop' })) { closeDrawer(); addStop(place); }
        return;
      }
      closeDrawer();
      map.setView(pin.latlng, Math.max(map.getZoom(), 16));
      setTimeout(() => openPinPopup(pin.id), 250);
    }
    else if (a === 'to') { closeDrawer(); choosePlace('to', place); }
    else if (a === 'stop') { closeDrawer(); addStop(place); }
    else if (a === 'show') { store.update(s => { const x = s.pins.find(p => p.id === id); x.show = !x.show; }); renderPins(); renderDrawer(); }
    else if (a === 'edit') editPin(pin);
    else if (a === 'del') deletePin(id);
  } else if (ride) {
    if (a === 'open') { if (nav) return toast('Finish this ride first'); closeDrawer(); previewRide(ride); }
    else if (a === 'ride') { closeDrawer(); if (ride.plan?.route) await openSavedPlan(ride); else await followTrack(ride.points.map(p => [p[0], p[1]]), ride.name || t('Ride')); }
    else if (a === 'rename') {
      const name = await askText(t('Rename'), { value: ride.name || '', placeholder: t('Ride'), ok: 'Save' });
      if (name == null) return;
      await store.rides.put({ ...ride, name: name || ride.name });
      await reloadRides(); renderDrawer();
    }
    else if (a === 'gpx') exportRideGpx(ride);
    else if (a === 'del') {
      if (!await askConfirm(t('Delete this ride? Cycle Nav will forget it.'), { ok: 'Delete', danger: true })) return;
      await store.rides.remove(id); await reloadRides(); renderDrawer();
    }
  }
}

export function setupDrawer() {
  $('#drawerClose').onclick = closeDrawer;
  $('#savedBtn').onclick = () => openDrawer();
  $('#drawerScrim').onclick = closeDrawer;
  document.querySelectorAll('#drawerTabs .dtab').forEach(b => b.onclick = () => {
    const same = drawerOpen && drawerTab === b.dataset.dt;
    openDrawer(b.dataset.dt);
    if (!same) $('#drawerList').scrollTop = 0;
  });
  $('#drawerSearch').oninput = e => { drawerQuery = e.target.value; renderDrawer(); };
  $('#drawerList').onclick = e => {
    const b = e.target.closest('button[data-a]');
    if (b) drawerAction(b.closest('.srow').dataset.id, b.dataset.a);
  };
  $('#drawerFoot').onclick = e => {
    const f = e.target.closest('button')?.dataset.f;
    if (f === 'here') me ? editPin(null, { name: '', latlng: me.latlng }) : toast('Waiting for your location…');
    else if (f === 'import') importGpxFiles();
    else if (f === 'follow') { closeDrawer(); pickGpxRoute(); }
  };

  // Finger-following drag: from the left edge to open, leftwards on panel or scrim to close.
  let g = null;
  const width = () => $('#drawerPanel').offsetWidth || 340;
  const blocked = () => locked || picking || askState || !$('#settings').hidden || !$('#dialog').hidden;
  addEventListener('touchstart', e => {
    g = null;
    if (e.touches.length !== 1) return;
    const t0 = e.touches[0];
    if (!drawerOpen && (t0.clientX <= 22 || e.target.closest('#savedBtn')) && !blocked()) {
      if (t0.clientX <= 22) e.stopPropagation(); // keep Leaflet from panning the map under this swipe
      g = { open: true };
    } else if (drawerOpen && e.target.closest('#drawerPanel, #drawerScrim')) g = { open: false };
    if (g) Object.assign(g, { x0: t0.clientX, y0: t0.clientY, x: t0.clientX, t: performance.now(), v: 0, on: false });
  }, { capture: true, passive: true });
  addEventListener('touchmove', e => {
    if (!g || e.touches.length !== 1) return;
    const t0 = e.touches[0], dx = t0.clientX - g.x0, dy = t0.clientY - g.y0, now = performance.now();
    if (!g.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2 || (g.open ? dx < 0 : dx > 0)) { g = null; return; }
      g.on = true;
      if (g.open) {
        drawerOpen = true; // openDrawer settles the rest on release
        if (g.tab) drawerTab = g.tab;
        $('#drawer').classList.add('on');
        clearTimeout(drawerHideTimer);
        $('#bikeMenu').hidden = true;
        map.closePopup();
        renderDrawer();
        setDrawerPos(0);
      }
      $('#drawerPanel').classList.add('dragging');
    }
    e.preventDefault();
    g.v = (t0.clientX - g.x) / Math.max(1, now - g.t);
    g.x = t0.clientX; g.t = now;
    setDrawerPos(Math.max(0, Math.min(1, (g.open ? 0 : 1) + dx / width())));
  }, { capture: true, passive: false });
  const end = e => {
    if (!g) return;
    const was = g;
    g = null;
    if (!was.on) return;
    if (e.cancelable) e.preventDefault(); // swallow the click that would follow the drag
    const open = was.v > 0.4 ? true : was.v < -0.4 ? false : drawerPos > 0.5;
    if (open) openDrawer(); else closeDrawer();
  };
  addEventListener('touchend', end, { capture: true, passive: false });
  addEventListener('touchcancel', end, { capture: true, passive: false });
}
