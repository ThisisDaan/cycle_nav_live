import * as store from './store.js';
import { newRideId } from './store.js';
import { fetchAlternatives, fetchRoute, ROUTE_STYLES } from './router.js';
import { reverse } from './geocode.js';
import { bikeSpeed, familiarity, findFamiliar, viaPointsFor } from './memory.js';
import { CLASS_COLORS, CLASS_ORDER } from './roadclass.js';
import { bottomSheet } from './sheet.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { dist, fmtDist, fmtDuration, projectOnSegment, simplify } from './geo.js';
import { isLand, landscapeMQ, map, panelW } from './mapview.js';
import { nav, startNavigation } from './navigation.js';
import { clearNearby } from './nearby.js';
import { from, pushUndo, resolve, setFrom, setTo, syncInputs, to, undo } from './planner.js';
import { stopFollow } from './position.js';
import { cells, reloadRides, rideList } from './rides.js';
import { packVias, scheduleSession, unpackVias } from './session.js';
import { $, esc, S, toast } from './ui.js';
import { showWxPop, wxAdvice, wxLine, wxUpdate } from './wxui.js';

export let routeLayer;
export function setRouteLayer(v) { routeLayer = v; }

let endMarker;

export let startMarker;
export function setStartMarker(v) { startMarker = v; }

export let options = [], selected = 0, planToken = 0, pendingPlan = false;
export function setOptions(v) { options = v; }
export function setSelected(v) { selected = v; }
export function setPendingPlan(v) { pendingPlan = v; }
export let vias = [];               // points the user added to shape the route
export function setVias(v) { vias = v; }
export let gpxRoute = null;         // { name, vias } when following a GPX file
export function setGpxRoute(v) { gpxRoute = v; }
export let viaLayer;
export function setViaLayer(v) { viaLayer = v; }

let sheetCtl = null;

export let restoreSel = null;       // route index to reselect after a restored plan
export function setRestoreSel(v) { restoreSel = v; }
// A saved route shown exactly as it was saved (no new trip to the router), as long as the start,
// the end and the points you shaped it with are unchanged; any edit plans afresh.
let pinned = null;                  // { key, route }
const planKey = (a, b) => [a, ...vias, b].map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
export let resumeNav = null;        // saved ride waiting for its route before navigation restarts
export function setResumeNav(v) { resumeNav = v; }

// ---------------------------------------------------------------- routing

export async function planRoute({ fit = true } = {}) {
  stopFollow(true);
  scheduleSession();
  if (!to) return;
  const a = resolve(from), b = resolve(to);
  const sheet = $('#sheet');
  sheet.hidden = false;
  if (fit) setSheetCollapsed(false);
  $('#startBtn').disabled = true;
  if (fit) $('#routeCards').innerHTML = '';
  if (!a || !b) {
    pendingPlan = true;
    $('#routeStatus').innerHTML = '<span class="spinner"></span>Waiting for your location…';
    return;
  }
  if (dist(a, b) < 30) {
    $('#routeStatus').textContent = 'Start and destination are the same place.';
    return;
  }
  const token = ++planToken;
  $('#routeStatus').innerHTML = `<span class="spinner"></span>${vias.length ? 'Updating your route…' : 'Finding calm routes…'}`;
  drawEndpoints(a, b);
  drawVias();

  const bike = store.activeBike();
  const list = [];
  if (pinned && pinned.key === planKey(a, b)) {
    list.push({ route: pinned.route, kind: 'custom' });
  } else if (vias.length) {
    // The user shaped the route by hand: one route through their points.
    let route;
    try {
      route = await fetchRoute([a, ...vias, b], bike);
    } catch (e) {
      if (token === planToken) $('#routeStatus').textContent = t("Couldn't route through that point: {0}", e.message);
      return;
    }
    if (token !== planToken) return;
    // The router snaps each point to the nearest road; move the dots there too.
    vias = vias.map(v => Object.assign(route.coords.reduce((best, c) => dist(c, v) < dist(best, v) ? c : best).slice(), { gpx: v.gpx, name: v.name, city: v.city }));
    list.push({ route, kind: 'custom' });
  } else {
    const [alts, familiar, nostops] = await Promise.all([
      fetchAlternatives(a, b, bike).catch(e => e),
      familiarRoute(a, b, bike),
      fetchRoute([a, b], bike, 0, 'nostops').catch(() => null),
    ]);
    if (token !== planToken) return;
    if (familiar) list.push({ route: familiar, kind: 'familiar' });
    if (Array.isArray(alts)) {
      alts.forEach(route => {
        if (familiar && Math.abs(route.length - familiar.length) < 40 && Math.abs(route.stats.turns - familiar.stats.turns) <= 1) return;
        list.push({ route, kind: 'alt' });
      });
    }
    if (nostops && list.length) {
      const dup = list.find(o => Math.abs(o.route.length - nostops.length) < 15 && o.route.stats.turns === nostops.stats.turns);
      if (!dup) list.push({ route: nostops, kind: 'nostops' });
      else if (dup.route.stats.signals <= Math.min(...list.map(o => o.route.stats.signals))) dup.fewestStops = true;
    }
    if (!list.length) {
      $('#routeStatus').textContent = t("Couldn't find a route: {0}", alts?.message || '?');
      return;
    }
  }

  const speed = bikeSpeed(bike, rideList).kmh;
  for (const o of list) {
    o.familiar = familiarity(cells, o.route.coords);
    o.time = o.route.length / (speed / 3.6);
  }
  const shortest = Math.min(...list.map(o => o.route.length));
  const fewestTurns = Math.min(...list.map(o => o.route.stats.turns));
  for (const o of list) {
    o.shortest = list.length > 1 && o.route.length === shortest;
    o.fewestTurns = list.length > 1 && list.filter(x => x.route.stats.turns === fewestTurns).length === 1 && o.route.stats.turns === fewestTurns;
  }

  // Rank the router's alternatives ourselves: every turn costs as much as a
  // detour of a few hundred metres, busy road counts against, bike paths for.
  // Off-road: trails count for, instead of bike paths.
  const { turn_penalty: turnCost, offroad } = ROUTE_STYLES[bike.style] || ROUTE_STYLES.calm;
  const bonus = r => offroad ? 0.3 * r.stats.unpavedShare : 0.2 * r.stats.bikeShare;
  const calmScore = o => o.route.length * (1 + 1.5 * o.route.stats.busyShare - bonus(o.route)) + o.route.stats.turns * turnCost;
  const alts2 = list.filter(o => o.kind === 'alt');
  if (alts2.length) alts2.reduce((a, b) => calmScore(b) < calmScore(a) ? b : a).kind = 'calm';
  list.sort((a, b) => (a.kind === 'familiar' ? -1 : 0) - (b.kind === 'familiar' ? -1 : 0) || calmScore(a) - calmScore(b));

  // Default choice: the way you usually go, else the calmest, unless an
  // alternative follows roads you know much better without a big detour.
  let pick = list.findIndex(o => o.kind === 'familiar' || o.kind === 'custom');
  if (pick < 0) {
    pick = Math.max(0, list.findIndex(o => o.kind === 'calm'));
    const base = list[pick];
    list.forEach((o, i) => {
      if (o.familiar >= base.familiar + 0.3 && o.route.length <= base.route.length * 1.15) pick = i;
    });
  }
  options = list;
  if (vias.length) drawVias();
  if (restoreSel != null) { if (restoreSel < list.length) pick = restoreSel; restoreSel = null; }
  selectRoute(pick, fit);
  if (resumeNav) { const r = resumeNav; resumeNav = null; startNavigation(options[selected], r); }
}

async function familiarRoute(a, b, bike) {
  const f = findFamiliar(rideList, a, b);
  if (!f) return null;
  const exact = savedExact(f, a, b);
  if (exact) return exact;
  try {
    const route = await fetchRoute([a, ...viaPointsFor(f.points), b], bike);
    route.ridden = f.count;
    route.saved = f.saved;
    return route;
  } catch { return null; }
}
// a saved route that starts and ends here is used exactly as saved
function savedExact(f, a, b) {
  const plan = f.ride?.plan;
  if (!plan?.route || dist(plan.a, a) > 60 || dist(plan.b, b) > 60) return null;
  return { ...plan.route, ridden: f.count, saved: true };
}

function selectRoute(i, fit = false) {
  selected = i;
  clearNearby(true);
  scheduleSession();
  renderRouteCards();
  drawRoutes();
  $('#startBtn').disabled = false;
  if (fit) {
    const bounds = L.latLngBounds(options.flatMap(o => [o.route.coords[0], ...o.route.coords.filter((_, k) => k % 10 === 0)]));
    const sheetH = $('#sheet').offsetHeight;
    const wide = innerWidth >= 720;
    map.fitBounds(bounds, isLand() ? { paddingTopLeft: [panelW() + 20, 30], paddingBottomRight: [66, 30] } : {
      paddingTopLeft: [wide ? 500 : 30, wide ? 40 : 150],
      paddingBottomRight: [30, wide ? 40 : sheetH + 20],
    });
  }
}

function renderRouteCards() {
  $('#routeStatus').innerHTML = vias.length
    ? '<button class="link-btn" id="resetVias">Undo my changes</button>'
    : '<span class="route-hint">Drag the green line to change the route</span>';
  $('#resetVias') && ($('#resetVias').onclick = () => { pushUndo('Route reset'); vias = gpxRoute ? gpxRoute.vias.slice() : []; planRoute(); });
  $('#rememberBtn').hidden = options[selected]?.kind !== 'custom';
  $('#routeCards').innerHTML = options.map((o, i) => {
    const r = o.route;
    const title = {
      familiar: t('Your usual way'),
      custom: gpxRoute ? `GPX: ${esc(gpxRoute.name)}` : t('Your route'),
      calm: t(ROUTE_STYLES[store.activeBike().style]?.offroad ? 'Most off-road' : 'Calmest'),
      nostops: t('Fewest stops'),
    }[o.kind] || t(o.shortest ? 'Shorter' : 'Alternative');
    const tags = [];
    if (o.kind === 'familiar') tags.push(`<span class="tag">${r.saved && r.ridden === 1 ? t('saved by you') : t('ridden {0}×', r.ridden)}</span>`);
    else if (o.familiar > 0.5) tags.push(`<span class="tag">${t('{0}% familiar', Math.round(o.familiar * 100))}</span>`);
    const added = vias.filter(v => !v.gpx).length;
    if (o.kind === 'custom' && gpxRoute) tags.push('<span class="tag">follows your GPX</span>');
    if (o.kind === 'custom' && added) tags.push(`<span class="tag">${added > 1 ? t('{0} points added', added) : t('1 point added')}</span>`);
    if (o.kind === 'nostops' || o.fewestStops) tags.push(`<span class="tag">${o.kind === 'nostops' ? '' : `${t('Fewest stops')} · `}${r.stats.signals ? (r.stats.signals > 1 ? t('{0} traffic lights', r.stats.signals) : t('1 traffic light')) : t('No traffic lights')}</span>`);
    if (o.fewestTurns) tags.push('<span class="tag">fewest turns</span>');
    if (r.stats.busyShare > 0.08) tags.push(`<span class="tag warn">${t('{0}% busy road', Math.round(r.stats.busyShare * 100))}</span>`);
    const meta = r.stats.meters && Object.keys(r.stats.meters).length ? [t('{0} turns', r.stats.turns)] : [t('{0}% bike paths/lanes', Math.round(r.stats.bikeShare * 100)), t('{0} turns', r.stats.turns)];
    if (r.stats.unpavedShare > 0.03) meta.push(t('{0}% unpaved', Math.round(r.stats.unpavedShare * 100)));
    if (r.ascend > 15) meta.push(`↑ ${r.ascend} m`);
    const wxa = i === selected && wxAdvice?._for === r ? wxAdvice : null;
    return `<button class="route-card ${i === selected ? 'selected' : ''}" data-i="${i}">
      ${i === selected ? `<div class="rc-advice wx-${wxa?.kind || ''}" role="button" ${wxa ? '' : 'hidden'}>${wxa ? wxLine(wxa) : ''}</div>` : ''}
      <div class="rc-title">${title} ${tags.join('')}</div>
      <div class="rc-time">${fmtDuration(o.time)}</div>
      <div class="rc-meta">${meta.join(' · ')}</div>
      <div class="rc-dist">${fmtDist(r.length)}</div>
      ${safetyHtml(r)}
    </button>`;
  }).join('');
  document.querySelectorAll('.route-card').forEach(c => c.onclick = e => {
    if (e.target.closest('.rc-advice')) return showWxPop();
    if (e.target.closest('.rc-legend')) return showLegend();
    if (e.target.closest('.rc-warn')) {
      const r = options[+c.dataset.i]?.route;
      if (+c.dataset.i !== selected) selectRoute(+c.dataset.i, false);
      if (r?.longestBusy) map.fitBounds(L.latLngBounds(r.coords.slice(r.longestBusy.a, r.longestBusy.b + 1)), { maxZoom: 17, padding: [60, 60] });
      return;
    }
    if (+c.dataset.i === selected && $('#sheet').classList.contains('collapsed')) return setSheetCollapsed(false);
    selectRoute(+c.dataset.i);
  });
  wxUpdate();
}

const CLASS_LABEL = { path: 'bike path', calm: 'quiet street', shared: 'shared road', busy: 'busy road', unpaved: 'unpaved', walk: 'walking' };

function safetyHtml(r) {
  const m = r.stats.meters;
  const total = m ? CLASS_ORDER.reduce((a, k) => a + (m[k] || 0), 0) : 0;
  if (!total) return `<div class="bar"><i class="b-bike" style="width:${r.stats.bikeShare * 100}%"></i><i style="flex:1"></i><i class="b-busy" style="width:${r.stats.busyShare * 100}%"></i></div>`;
  const parts = CLASS_ORDER.filter(k => m[k] > 0).map(k => ({ k, pct: m[k] / total * 100 }));
  const bar = parts.map(p => `<i style="width:${p.pct}%;background:${CLASS_COLORS[p.k]}"></i>`).join('');
  const txt = parts.filter(p => Math.round(p.pct) >= 3).sort((a, b) => b.pct - a.pct).slice(0, 3)
    .map(p => `${Math.round(p.pct)}% ${t(CLASS_LABEL[p.k])}`).join(' · ');
  const extra = [];
  if (r.stats.signals) extra.push(r.stats.signals > 1 ? t('{0} traffic lights', r.stats.signals) : t('1 traffic light'));
  if (r.stats.risky) extra.push(r.stats.risky > 1 ? t('{0} risky crossings', r.stats.risky) : t('1 risky crossing'));
  const busy = r.longestBusy && m.busy >= 200
    ? `<div class="rc-warn" role="button">${icon('warning', 16)} ${t('{0} busy road without bike lane', fmtDist(m.busy))}</div>` : '';
  return `<div class="bar">${bar}</div>
      <div class="rc-safety"><span>${txt}${extra.length ? `<br>${extra.join(' · ')}` : ''}</span><span class="rc-legend" role="button" aria-label="${t('Colour legend')}">?</span></div>${busy}`;
}

function showLegend() {
  if (document.querySelector('.legend-pop')) return;
  const rows = CLASS_ORDER.map(k => `<div class="lg-row"><i class="lg-sw lg-${k}" style="--c:${CLASS_COLORS[k]}"></i><span>${t(LEGEND[k])}</span></div>`).join('');
  const el = document.createElement('div');
  el.className = 'legend-pop';
  el.innerHTML = `<div class="legend-card"><h3>${t('Route colours')}</h3>${rows}
    <div class="lg-row"><span class="ev-icon lg-ev">${SIGNAL_SVG}</span><span>${t('Traffic light')}</span></div>
    <div class="lg-row"><span class="ev-icon lg-ev">${RISKY_SVG}</span><span>${t('Risky crossing (busy road, no lights)')}</span></div></div>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}
const LEGEND = {
  path: 'Bike path (separate from cars)', calm: 'Quiet street or bike lane', shared: 'Shared road, 31-50 km/h',
  busy: 'Busy road, no bike lane', unpaved: 'Unpaved surface', walk: 'Walk your bike',
};
const SIGNAL_SVG = '<svg viewBox="0 0 24 24" width="19" height="19"><rect x="7" y="2" width="10" height="20" rx="4" fill="#2b2f33"/><circle cx="12" cy="7" r="2.2" fill="#e5484d"/><circle cx="12" cy="12" r="2.2" fill="#f5c542"/><circle cx="12" cy="17" r="2.2" fill="#3fb36b"/></svg>';
const RISKY_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 2.5 22.5 21h-21z" fill="#f5c542" stroke="#b3261e" stroke-width="2" stroke-linejoin="round"/><rect x="11" y="9" width="2" height="6" rx="1" fill="#b3261e"/><circle cx="12" cy="17.6" r="1.2" fill="#b3261e"/></svg>';

const BRIDGE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="11" fill="#fff" stroke="#5f6b73" stroke-width="1.5"/><path d="M3.5 15h17M5 15c1.5-5 4-6.500 7-6.500s5.500 1.500 7 6.500M8 15v-4M12 15V8.500M16 15v-4" fill="none" stroke="#2b2f33" stroke-width="1.500" stroke-linecap="round"/></svg>';
const TUNNEL_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="11" fill="#fff" stroke="#5f6b73" stroke-width="1.5"/><path d="M5 18v-6a7 7 0 0 1 14 0v6z" fill="#5f6b73"/><path d="M9 18v-5a3 3 0 0 1 6 0v5z" fill="#fff"/></svg>';
const EVENT_SVG = { signal: SIGNAL_SVG, risky: RISKY_SVG, bridge: BRIDGE_SVG, tunnel: TUNNEL_SVG };

function drawEvents(r) {
  for (const e of r.events || []) {
    L.marker(e.latlng, {
      interactive: false, keyboard: false, zIndexOffset: -100,
      icon: L.divIcon({ className: `ev-icon ev-${e.type}`, html: EVENT_SVG[e.type] || RISKY_SVG, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(routeLayer);
  }
}

export function drawRoutes(onlySelected = false) {
  routeLayer.clearLayers();
  const accent = S().theme.accent;
  options.forEach((o, i) => {
    if (i === selected || onlySelected) return;
    L.polyline(o.route.coords, { color: '#7d8a90', weight: 6, opacity: .55 })
      .on('click', () => selectRoute(i))
      .addTo(routeLayer);
  });
  const r = options[selected]?.route;
  if (!r) return;
  L.polyline(r.coords, { color: '#fff', weight: 11, opacity: .95, interactive: false }).addTo(routeLayer);
  if (r.segments?.length) {
    for (const sg of r.segments) {
      const o = { color: CLASS_COLORS[sg.cls], weight: 7, opacity: 1, interactive: false, lineCap: 'butt', lineJoin: 'round' };
      if (sg.cls === 'unpaved') o.dashArray = '9 6';
      if (sg.cls === 'walk') { o.dashArray = '1 9'; o.lineCap = 'round'; }
      L.polyline(r.coords.slice(sg.a, sg.b + 1), o).addTo(routeLayer);
    }
    drawEvents(r);
  } else {
    L.polyline(r.coords, { color: accent, weight: 7, opacity: 1, interactive: false }).addTo(routeLayer);
  }
  // dashes that slide along the line towards the destination (still while navigating, to save battery)
  L.polyline(r.coords, { className: nav ? 'route-flow' : 'route-flow moving', color: '#1d2a33', weight: 4, opacity: .3, dashArray: '4 14', lineCap: 'round', interactive: false }).addTo(routeLayer);
  drawFlow();
  if (!nav) {
    // A wide invisible line that is easy to hit with a finger: press and drag it
    // to pull the route somewhere else (or just tap it to drop a point).
    const hit = L.polyline(r.coords, { color: '#000', weight: 30, opacity: 0, className: 'route-hit' }).addTo(routeLayer);
    enableLineDrag(hit.getElement(), r);
  }
}

// Small chevrons along the chosen route showing which way to ride (handy for GPX loops that cross themselves).
// Spaced in screen pixels and limited to the visible area, so they are redrawn after every zoom or pan.
var flowLayer = null;
const FLOW_GAP = 130;
const FLOW_SVG = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M11 3 19 15 11 11.5 3 15z" fill="#1d2a33" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
function drawFlow() {
  if (!flowLayer) {
    flowLayer = L.layerGroup().addTo(map);
    map.on('zoomend moveend', drawFlow);
  }
  flowLayer.clearLayers();
  const r = options[selected]?.route;
  if (!r || !gpxRoute || map.getZoom() < 13 || !map.hasLayer(routeLayer) || !routeLayer.getLayers().length) return; // GPX routes only
  const view = map.getBounds().pad(0.3);
  let carry = FLOW_GAP / 2, prev = map.latLngToLayerPoint(r.coords[0]);
  for (let i = 1; i < r.coords.length; i++) {
    const cur = map.latLngToLayerPoint(r.coords[i]), seg = prev.distanceTo(cur);
    while (carry <= seg) {
      const f = carry / seg, pt = L.point(prev.x + (cur.x - prev.x) * f, prev.y + (cur.y - prev.y) * f), ll = map.layerPointToLatLng(pt);
      if (view.contains(ll)) {
        const deg = Math.round(Math.atan2(cur.x - prev.x, prev.y - cur.y) * 180 / Math.PI);
        L.marker(ll, { interactive: false, keyboard: false, zIndexOffset: -200,
          icon: L.divIcon({ className: 'flow-icon', html: `<i style="transform:rotate(calc(${deg}deg - var(--irot, 0deg)))">${FLOW_SVG}</i>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        }).addTo(flowLayer);
      }
      carry += FLOW_GAP;
    }
    carry -= seg; prev = cur;
  }
}

// Google Maps-style: press on the route, drag it to another road, let go.
function enableLineDrag(el, route) {
  if (!el) return;
  // Keep Leaflet from starting a map pan when the press lands on the line.
  L.DomEvent.on(el, 'touchstart mousedown click', L.DomEvent.stopPropagation);
  L.DomEvent.on(el, 'mousedown', L.DomEvent.preventDefault); // no text selection while dragging
  el.addEventListener('pointerdown', down => {
    if (down.button > 0) return;
    down.preventDefault();
    down.stopPropagation(); // Leaflet listens for pointerdown on the map to start panning
    el.setPointerCapture(down.pointerId);
    map.dragging.disable();

    const startPt = [down.clientX, down.clientY];
    const startLL = map.mouseEventToLatLng(down);
    const at = alongRoute(route, [startLL.lat, startLL.lng]);
    const index = vias.filter(v => alongRoute(route, v) < at).length;
    const prev = index === 0 ? route.coords[0] : vias[index - 1];
    const next = index === vias.length ? route.coords[route.coords.length - 1] : vias[index];
    let ghost = null, band = null, moved = false;

    const move = e => {
      if (!moved && Math.hypot(e.clientX - startPt[0], e.clientY - startPt[1]) < 8) return;
      moved = true;
      const ll = map.mouseEventToLatLng(e);
      if (!ghost) {
        band = L.polyline([prev, ll, next], { color: S().theme.accent, weight: 4, dashArray: '6 8', interactive: false }).addTo(map);
        ghost = L.marker(ll, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="via-marker"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
      }
      ghost.setLatLng(ll);
      band.setLatLngs([prev, ll, next]);
    };
    const up = e => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      map.dragging.enable();
      ghost?.remove();
      band?.remove();
      if (e.type === 'pointercancel') return;
      const ll = moved ? map.mouseEventToLatLng(e) : startLL;
      pushUndo('Point added');
      vias.splice(index, 0, [ll.lat, ll.lng]);
      setSheetCollapsed(true);
      if (!moved && vias.length === 1) toast('Drag the line or the white dot to change the route');
      planRoute({ fit: false });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// ---- shaping the route by hand (via points)

// Distance along a route to the point closest to p.
export function alongRoute(route, p) {
  let best = { d: Infinity, along: 0 };
  for (let i = 0; i < route.coords.length - 1; i++) {
    const r = projectOnSegment(p, route.coords[i], route.coords[i + 1]);
    if (r.d < best.d) best = { d: r.d, along: route.cum[i] + r.t * (route.cum[i + 1] - route.cum[i]) };
  }
  return best.along;
}

export function addVia(p) {
  pushUndo('Point added');
  const route = options[selected]?.route;
  if (route) {
    const at = alongRoute(route, p);
    const index = vias.filter(v => alongRoute(route, v) < at).length;
    vias.splice(index, 0, p);
  } else {
    vias.push(p);
  }
  setSheetCollapsed(true);
  if (vias.length === 1) toast('Drag the white dot to where you want to ride');
  planRoute({ fit: false });
}

const viaLetter = i => String.fromCharCode(65 + i % 26);
let viaRowsOpen = false;     // more than two points fold into one "n points in between" row

// The points you added, as rows between start and destination: My location → A → B → Griend 14.
function renderViaRows() {
  const shown = vias.filter(v => !v.gpx);
  const box = $('#viaRows');
  if (shown.length <= 2) viaRowsOpen = false;
  if (shown.length > 2 && !viaRowsOpen) {
    const letters = `${viaLetter(0)}–${viaLetter(shown.length - 1)}`;
    box.innerHTML = `<button class="planner-row via-row via-fold" aria-expanded="false">
        <span class="pin-via">${shown.length}</span>
        <span class="via-name">${t('{0} points in between', shown.length)} <small>${letters}</small></span>
        <span class="via-chevron">▾</span>
      </button>`;
    box.querySelector('.via-fold').onclick = () => { viaRowsOpen = true; renderViaRows(); };
  } else box.innerHTML = (shown.length > 2 ? `<button class="planner-row via-row via-fold" aria-expanded="true">
        <span class="pin-via">${shown.length}</span><span class="via-name">Hide points</span><span class="via-chevron">▴</span></button>` : '')
    + shown.map((v, n) => `<div class="planner-row via-row">
      <span class="pin-via">${viaLetter(n)}</span>
      <span class="via-name selectable">${v.name ? `${esc(v.name)} <small>${esc(v.city || '')}</small>` : `${t('Point {0}', viaLetter(n))} <small>${t('finding name…')}</small>`}</span>
      <button class="icon-btn" data-unvia="${n}" title="Remove this point" aria-label="Remove point ${viaLetter(n)}">${icon('close', 20)}</button>
    </div>`).join('');
  const fold = box.querySelector('.via-fold[aria-expanded="true"]');
  if (fold) fold.onclick = () => { viaRowsOpen = false; renderViaRows(); };
  box.querySelectorAll('[data-unvia]').forEach(b => b.onclick = () => {
    const v = shown[+b.dataset.unvia];
    pushUndo('Point removed');
    vias = vias.filter(x => x !== v);
    planRoute({ fit: false });
  });
  // Name each point after the street it's on.
  for (const v of shown) {
    if (v.name || v.naming) continue;
    v.naming = true;
    reverse(v, 'street').then(place => {
      v.name = place.name;
      v.city = place.detail.split(', ').find(s => !/^\d{4}/.test(s)) || '';
      // The point may have been snapped/replaced meanwhile: copy the name to its successor at the same spot.
      vias.forEach(x => { if (!x.name && dist(x, v) < 30) Object.assign(x, { name: v.name, city: v.city }); });
      renderViaRows();
    });
  }
}

function drawVias() {
  viaLayer.clearLayers();
  renderViaRows();
  vias.filter(v => !v.gpx).forEach((v, n) => {
    const i = vias.indexOf(v);
    const marker = L.marker(v, {
      draggable: true,
      autoPan: true,
      icon: L.divIcon({ className: '', html: `<div class="via-marker">${viaLetter(n)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 500,
    }).addTo(viaLayer);
    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      pushUndo('Point moved');
      vias[i] = [ll.lat, ll.lng];
      planRoute({ fit: false });
    });
    marker.on('click', () => {
      L.popup({ closeButton: false, offset: [0, -8] })
        .setLatLng(v)
        .setContent(`<div class="map-popup"><b class="selectable">${esc(v.name || t('Point {0}', viaLetter(n)))}</b><button data-a="remove">Remove this point</button></div>`)
        .openOn(map);
      document.querySelector('.map-popup [data-a="remove"]').onclick = () => {
        map.closePopup();
        pushUndo('Point removed');
        vias.splice(i, 1);
        planRoute({ fit: false });
      };
    });
  });
}

// ---- route sheet: tap or swipe the handle to tuck it away and see the map

export function setSheetCollapsed(collapsed) {
  if (sheetCtl && $('#sheet').classList.contains('collapsed') !== collapsed) sheetCtl.go(collapsed);
  else $('#sheet').classList.toggle('collapsed', collapsed);
}

// Save the hand-shaped route as if it had been ridden, so it becomes "Your usual way".
async function rememberRoute() {
  const o = options[selected];
  if (!o) return;
  const a = resolve(from), b = resolve(to);
  const name = `${from.isMe ? 'My location' : from.name} → ${to.name}`;
  await store.rides.put({
    id: newRideId(),
    bikeId: store.activeBike().id,
    name,
    startedAt: Date.now(),
    endedAt: Date.now(),
    distance: Math.round(o.route.length),
    movingTime: 0, // not a real ride: don't learn speed from it
    points: simplify(o.route.coords, 4).map(p => [+p[0].toFixed(6), +p[1].toFixed(6)]),
    source: 'planned',
    // everything needed to bring back exactly this route, and to keep editing it
    plan: { a, b, from: packPlace(from, a), to: packPlace(to, b), vias: packVias(vias), route: o.route },
  });
  await reloadRides();
  // keep showing the route as it is: replanning here used to swap it for a rougher copy
  pinned = { key: planKey(a, b), route: o.route };
  toast('Saved. Next time this shows up as “Your usual way”');
}
const packPlace = (p, ll) => p.isMe ? { name: t('Start'), detail: '', latlng: ll } : { name: p.name, detail: p.detail || '', latlng: ll };

// "Ride it" on a saved route: put back its start, end and shaping points, and show the saved line.
export async function openSavedPlan(ride) {
  const p = ride.plan;
  setFrom(p.from); setTo(p.to);
  vias = unpackVias(p.vias);
  gpxRoute = null;
  pinned = { key: planKey(p.a, p.b), route: p.route };
  syncInputs();
  drawStart(p.a);
  await planRoute();
}

export function setupSheet() {
  const sheet = $('#sheet');
  $('#rememberBtn').onclick = rememberRoute;
  $('#undoBtn').onclick = undo;
  $('#undoAct').onclick = undo;
  sheetCtl = bottomSheet({
    el: sheet, grips: [$('#sheetToggle')], scroller: $('#routeCards'),
    isCollapsed: () => sheet.classList.contains('collapsed'),
    apply: c => sheet.classList.toggle('collapsed', c),
    disabled: () => landscapeMQ.matches,
  });
  $('#sheetToggle').onclick = () => sheetCtl.toggle();
}

function endpointDrag(which, marker) {
  marker.on('dragend', async () => {
    const ll = marker.getLatLng();
    pushUndo(which === 'from' ? 'Start moved' : 'End moved');
    const place = await reverse([ll.lat, ll.lng], 'street');
    const p = { name: place.name, detail: place.detail, latlng: [ll.lat, ll.lng] };
    if (which === 'from') setFrom(p); else setTo(p);
    syncInputs();
    planRoute({ fit: false });
  });
}

export function drawStart(a) {
  startMarker?.remove(); startMarker = null;
  if (from?.isMe || !a) return;
  startMarker = L.marker(a, { draggable: true, autoPan: true, icon: L.divIcon({ className: '', html: '<div class="start-marker"></div>', iconSize: [18, 18] }) }).addTo(map);
  endpointDrag('from', startMarker);
}

function drawEndpoints(a, b) {
  endMarker?.remove();
  drawStart(a);
  endMarker = L.marker(b, { draggable: true, autoPan: true, icon: L.divIcon({ className: '', html: '<div class="end-marker"></div>', iconSize: [28, 28], iconAnchor: [3, 30] }) }).addTo(map);
  endpointDrag('to', endMarker);
}

export function clearRoutes() {
  planToken++;
  clearNearby(true);
  scheduleSession();
  options = [];
  vias = [];
  gpxRoute = null;
  routeLayer.clearLayers(); flowLayer?.clearLayers();
  viaLayer.clearLayers();
  $('#viaRows').innerHTML = '';
  startMarker?.remove(); endMarker?.remove();
  $('#sheet').hidden = true;
  wxUpdate();
}
