import { icon, ICON_PATHS } from './icons.js';
import { t } from './i18n.js';
import { dist, fmtDist, projectOnSegment } from './geo.js';
import { map } from './mapview.js';
import { nav } from './navigation.js';
import { openPlaceSheet } from './placesheet.js';
import { me } from './position.js';
import { options, selected } from './routing-ui.js';
import { $, esc, toast } from './ui.js';

// ---- find nearby (Nominatim): cafés, toilets, drinking water, bike shops, bike parking
// With a route planned it searches along the selected route (within 150 m), otherwise around you (1.5 km).
const NEARBY = {
  cafe: { ic: 'cafe', label: 'Café', many: 'cafés', q: 'cafe', type: 'amenity/cafe' },
  toilets: { ic: 'wc', label: 'Toilet', many: 'toilets', q: 'toilets', type: 'amenity/toilets' },
  water: { ic: 'water', label: 'Drinking water', many: 'drinking water points', q: 'drinking water', type: 'amenity/drinking_water' },
  bike: { ic: 'build', label: 'Bike shop', many: 'bike shops', q: 'bicycle shop', type: 'shop/bicycle' },
  parking: { ic: 'parking', label: 'Bike parking', many: 'bike parking spots', q: 'bicycle parking', type: 'amenity/bicycle_parking' },
};
var nearby = null, nearbyToken = 0;
const NEARBY_AROUND = 1500, NEARBY_ROUTE = 150;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// the map column and the navigation column each have a Find nearby button; both open the same menu
const nearbyBtn = () => $(nav ? '#navNearbyBtn' : '#nearbyBtn');
function setNearbyBtn() { ['#nearbyBtn', '#navNearbyBtn'].forEach(b => $(b).classList.toggle('active', !!nearby)); }
// the route to search along: the one being ridden, else the planned one
const aheadText = m => m < 25 ? t('Right here') : t('{0} ahead', fmtDist(m));
const nearbyRoute = () => nav ? (nav.recordOnly ? null : nav.route) : options[selected]?.route;

export function clearNearby(onlyRoute = false) {
  if (onlyRoute && nearby?.mode !== 'route') return;
  nearbyToken++;
  const had = nearby;
  nearby = null;
  had?.layer.remove();
  setNearbyBtn();
}

export function hideNearbyMenu() {
  const menu = $('#nearbyMenu');
  if (menu.hidden || menu.classList.contains('leaving')) return false;
  ['#nearbyBtn', '#navNearbyBtn'].forEach(b => $(b).setAttribute('aria-expanded', 'false'));
  if (reduceMotion()) { menu.hidden = true; return true; }
  menu.classList.add('leaving');
  setTimeout(() => { if (menu.classList.contains('leaving')) { menu.hidden = true; menu.classList.remove('leaving'); } }, 160);
  return true;
}

export function toggleNearbyMenu() {
  const menu = $('#nearbyMenu');
  if (hideNearbyMenu()) return;
  $('#bikeMenu').hidden = true;
  menu.innerHTML = Object.entries(NEARBY).map(([k, n]) => `<button role="menuitem" data-k="${k}" class="${nearby?.key === k ? 'current' : ''}">${icon(n.ic, 22)}<span><b>${esc(t(n.label))}</b></span></button>`).join('')
    + (nearby ? `<button role="menuitem" data-k="" class="nearby-clear">${icon('close', 22)}<span><b>${esc(t('Clear'))}</b></span></button>` : '');
  menu.classList.remove('leaving');
  menu.hidden = false;
  const r = nearbyBtn().getBoundingClientRect();
  menu.style.top = `${Math.max(8, Math.min(r.top, innerHeight - menu.offsetHeight - 12))}px`;
  nearbyBtn().setAttribute('aria-expanded', 'true');
  menu.querySelectorAll('button').forEach(b => b.onclick = () => { hideNearbyMenu(); b.dataset.k ? searchNearby(b.dataset.k) : clearNearby(); });
}

// Bounding boxes ([w, s, e, n]) to ask Nominatim about: one for the area, or a few along a long route.
function routeBoxes(route) {
  const chunks = Math.min(4, Math.max(1, Math.ceil(route.length / 6000)));
  const padLat = NEARBY_ROUTE * 1.4 / 111320, boxes = [];
  for (let c = 0; c < chunks; c++) {
    const a = route.length * c / chunks, b = route.length * (c + 1) / chunks;
    let w = 181, s = 91, e = -181, n = -91;
    route.coords.forEach((p, i) => {
      if (route.cum[i] < a - 1 || route.cum[i] > b + 1) return;
      w = Math.min(w, p[1]); e = Math.max(e, p[1]); s = Math.min(s, p[0]); n = Math.max(n, p[0]);
    });
    if (w > e) continue;
    const padLon = padLat / Math.cos((s + n) / 2 * Math.PI / 180);
    boxes.push([w - padLon, s - padLat, e + padLon, n + padLat]);
  }
  return boxes;
}

async function nominatimBox(n, [w, s, e, nn]) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(n.q)}&viewbox=${w.toFixed(5)},${nn.toFixed(5)},${e.toFixed(5)},${s.toFixed(5)}&bounded=1&limit=40`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  return (await r.json()).filter(x => `${x.category}/${x.type}` === n.type);
}

async function searchNearby(key) {
  if (nearby?.key === key) return clearNearby();
  const n = NEARBY[key], route = nearbyRoute();
  const from = nav && route ? nav.along - 20 : 0; // while riding, only what's still ahead
  if (!navigator.onLine) return toast(t('Finding places nearby needs a connection'));
  clearNearby();
  const token = nearbyToken, mode = route ? 'route' : 'around';
  const origin = me?.latlng || [map.getCenter().lat, map.getCenter().lng];
  nearby = { key, mode, layer: L.layerGroup().addTo(map) };
  setNearbyBtn();
  toast(t('Searching…'));
  let boxes;
  if (route) boxes = routeBoxes(route);
  else {
    const dLat = NEARBY_AROUND / 111320, dLon = dLat / Math.cos(origin[0] * Math.PI / 180);
    boxes = [[origin[1] - dLon, origin[0] - dLat, origin[1] + dLon, origin[0] + dLat]];
  }
  const seen = new Map();
  try {
    for (let i = 0; i < boxes.length; i++) {
      if (i) await sleep(1100);
      const res = await nominatimBox(n, boxes[i]);
      if (token !== nearbyToken) return;
      res.forEach(x => seen.set(x.osm_type + x.osm_id, x));
    }
  } catch {
    if (token === nearbyToken) { clearNearby(); toast(t('Finding places nearby needs a connection')); }
    return;
  }
  const found = [];
  for (const x of seen.values()) {
    const ll = [+x.lat, +x.lon];
    if (route) {
      let best = { d: Infinity, m: 0 };
      for (let i = 0; i < route.coords.length - 1; i++) {
        const r = projectOnSegment(ll, route.coords[i], route.coords[i + 1]);
        if (r.d < best.d) best = { d: r.d, m: route.cum[i] + r.t * (route.cum[i + 1] - route.cum[i]) };
      }
      if (best.d <= NEARBY_ROUTE && best.m >= from) found.push({ ll, m: best.m, name: x.name });
    } else {
      const d = dist(ll, origin);
      if (d <= NEARBY_AROUND) found.push({ ll, m: d, name: x.name });
    }
  }
  found.sort((p, q) => p.m - q.m);
  if (!found.length) { clearNearby(); toast(t(nav && route ? 'Nothing found ahead' : 'Nothing found nearby')); return; }
  const shown = found.slice(0, 40);
  shown.forEach((f, i) => {
    // worked out on tap, so "ahead" is still right after riding on
    const where = () => nav && route ? aheadText(f.m - nav.along) : route ? t('{0} along the route', fmtDist(f.m)) : t('{0} from here', fmtDist(f.m));
    L.marker(f.ll, { icon: L.divIcon({ className: 'nearby-icon', html: `<span style="animation-delay:${Math.min(i, 12) * 30}ms">${icon(n.ic, 18)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 200 })
      .on('click', () => { const sub = where(); openPlaceSheet(f.ll, f.name || t(n.label), f.name ? `${t(n.label)} · ${sub}` : sub, f.name ? true : key === 'parking' ? 'bicycle_parking' : false); })
      .addTo(nearby.layer);
  });
  if (nav) {
    // don't pull the camera away mid-ride; just say how far the nearest one is
    const near = route ? aheadText(shown[0].m - nav.along) : t('{0} from here', fmtDist(shown[0].m));
    toast(shown.length === 1 ? t('One {0}: {1}', t(n.label).toLowerCase(), near.toLowerCase()) : t('{0} {1}, nearest: {2}', shown.length, t(n.many), near.toLowerCase()));
    return;
  }
  toast(shown.length === 1 ? t('One {0} nearby', t(n.label).toLowerCase()) : t('{0} {1} nearby', shown.length, t(n.many)));
  const pts = shown.map(f => f.ll);
  if (!route) pts.push(origin);
  const bounds = L.latLngBounds(pts);
  if (!map.getBounds().contains(bounds)) map.fitBounds(bounds, { paddingTopLeft: [30, 120], paddingBottomRight: [70, route ? 300 : 120], maxZoom: 17 });
}

// ---- "More": the less-used map buttons fold away behind one button
export var moreOpen = false;
export function syncMoreDot() { $('#moreBtn .more-dot').hidden = moreOpen || !$('#radarBtn').classList.contains('active'); }
export function setMore(on) {
  if (on === moreOpen) return;
  moreOpen = on;
  $('#moreBtns').classList.toggle('open', on);
  $('#moreBtns').inert = !on;
  $('#moreBtn').setAttribute('aria-expanded', on);
  $('#moreBtn .ic-more').setAttribute('d', on ? ICON_PATHS.close : ICON_PATHS.more_horiz);
  syncMoreDot();
}
