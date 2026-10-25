import { reverse } from './geocode.js';
import { BIKE_POI } from './mapstyle.js';
import { cachedPlace, detailsHtml, isStation, lookupPlace, placeLinks, trainPlanner } from './placeinfo.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { dist } from './geo.js';
import { map, tiles } from './mapview.js';
import { addStop, nav } from './navigation.js';
import { picking } from './offlineui.js';
import { BOOKMARK_LINE_SVG, BOOKMARK_SVG, editPin } from './pins.js';
import { choosePlace } from './planner.js';
import { fol, pauseFollow } from './position.js';
import { addVia, options } from './routing-ui.js';
import { $, esc, S } from './ui.js';

// ---- tapping a business / place on the map (OpenMapTiles `poi` layer)
const POI_TYPES = {
  bicycle_parking: 'Bicycle parking', bicycle: 'Bike shop', drinking_water: 'Drinking water', toilets: 'Toilets', cafe: 'Café',
  restaurant: 'Restaurant', fast_food: 'Fast food', bar: 'Bar', pub: 'Pub', supermarket: 'Supermarket', grocery: 'Grocery', bakery: 'Bakery',
  pharmacy: 'Pharmacy', hospital: 'Hospital', doctors: 'Doctor', dentist: 'Dentist', school: 'School', library: 'Library', post: 'Post office',
  bank: 'Bank', atm: 'ATM', fuel: 'Fuel station', parking: 'Parking', park: 'Park', playground: 'Playground', museum: 'Museum', hotel: 'Hotel',
  bus: 'Bus stop', rail: 'Train station', station: 'Station', halt: 'Station', airport: 'Airport', clothing_store: 'Clothes shop', florist: 'Florist', butcher: 'Butcher',
};
const poiType = p => { const k = POI_TYPES[p.subclass] || POI_TYPES[p.class] || (p.subclass || p.class || '').replace(/_/g, ' '); return t(k.charAt(0).toUpperCase() + k.slice(1)); };
export var lastCtx = 0;
export function setLastCtx(v) { lastCtx = v; }

function poiAt(e) {
  const gl = tiles?.getMaplibreMap?.();
  if (!gl) return null;
  const layers = ['train-stations', 'bike-essentials', 'poi_r1', 'poi_r7', 'poi_transit'].filter(id => gl.getLayer(id));
  if (!layers.length) return null;
  const pt = gl.project([e.latlng.lng, e.latlng.lat]);
  let best = null;
  for (const f of gl.queryRenderedFeatures([[pt.x - 18, pt.y - 18], [pt.x + 18, pt.y + 18]], { layers })) {
    const p = f.properties || {};
    if (f.geometry?.type !== 'Point' || !(p.name || BIKE_POI.includes(p.class))) continue;
    const q = gl.project(f.geometry.coordinates), d = Math.hypot(q.x - pt.x, q.y - pt.y);
    if (!best || d < best.d) best = { d, p, ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]] };
  }
  return best;
}

function placePopupHtml(name, sub, only, extra = '') {
  return `<div class="map-popup"><b class="selectable">${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}${extra}${only === 'via' ? '' : '<button data-a="from">Directions from here</button>'}${
    options.length ? '<button data-a="via">Go via here</button>' : ''}${only === 'via' ? '' : `<button class="go" data-a="to">Directions to here</button><button data-a="pin">${BOOKMARK_SVG} Save as pin</button>`}</div>`;
}
function openPlacePopup(latlng, name, sub, only, lookup) {
  if (nav) return;
  if (fol.mode && !fol.paused) pauseFollow();
  const place = { name, detail: sub || '', latlng };
  const cached = lookup ? cachedPlace(name, latlng) : null;
  const popup = L.popup({ closeButton: false, offset: [0, -4], maxWidth: 260 }).setLatLng(latlng)
    .setContent(placePopupHtml(name, sub, only, cached ? detailsHtml(cached.tags) : lookup ? `<small class="pp-loading">${esc(t('Loading details…'))}</small>` : '')).openOn(map);
  const wire = () => popup.getElement()?.querySelectorAll('button').forEach(b => b.onclick = () => {
    map.closePopup();
    if (b.dataset.a === 'via') addVia(latlng);
    else if (b.dataset.a === 'pin') editPin(null, { name, latlng });
    else choosePlace(b.dataset.a, place);
  });
  wire();
  if (lookup && !cached) lookupPlace(name, latlng).then(tags => {
    if (!popup.isOpen()) return;
    popup.setContent(placePopupHtml(name, sub, only, detailsHtml(tags)));
    wire();
    popup.update();
  }).catch(() => {
    if (!popup.isOpen()) return;
    popup.setContent(placePopupHtml(name, sub, only));
    wire();
    popup.update();
  });
}
export function tapMap(e) {
  if (nav || picking || Date.now() - lastCtx < 700) return;
  if (e.originalEvent?.target?.closest?.('.leaflet-marker-icon, .leaflet-interactive, .leaflet-popup')) return;
  const hit = poiAt(e);
  // named places are looked up by name; unnamed bike parking by type (to tell guarded garages from racks)
  if (hit) openPlaceSheet(hit.ll, hit.p.name || poiType(hit.p), hit.p.name ? poiType(hit.p) : '', hit.p.class === 'railway' ? 'station' : hit.p.name ? true : hit.p.class === 'bicycle_parking' && 'bicycle_parking', hit.p.class === 'railway');
  else closePlaceSheet();
}

// Tapped place as a bottom card, like Google Maps: details fill in once looked up, with
// Save / Call / Website / Directions buttons (Via too while a route is planned).
var placeSel = null;
export function openPlaceSheet(latlng, name, sub, lookup, station = false) {
  if (!nav && fol.mode && !fol.paused) pauseFollow();
  map.closePopup();
  const place = { name, detail: sub || '', latlng }, token = {};
  placeSel?.marker.remove();
  placeSel = { token, marker: L.circleMarker(latlng, { radius: 9, color: '#fff', weight: 3, fillColor: S().theme.accent, fillOpacity: 1, interactive: false }).addTo(map) };
  $('#placeName').textContent = name;
  $('#placeType').textContent = sub || '';
  const go = act => { closePlaceSheet(); if (act === 'stop') addStop(place); else if (act === 'via') addVia(latlng); else if (act === 'pin') editPin(null, { name, latlng }); else choosePlace(act, place); };
  const render = tags => {
    const l = placeLinks(tags);
    const saved = (S().pins || []).some(p => dist(p.latlng, latlng) < 30);
    // the same layout on every card: a row of labelled buttons (scrolls sideways if long), Directions below
    const ext = ' target="_blank" rel="noopener noreferrer"';
    const links = [l.tel && [l.tel, icon('phone'), t('Call'), ''], l.site && [l.site, icon('language'), t('Website'), ext],
      (station || isStation(tags)) && [trainPlanner(name, latlng, tags?.['addr:country']), icon('train'), t('Train times'), ext]].filter(Boolean);
    $('#placeActions').innerHTML = `<div class="place-pills"><button class="place-pill${saved ? ' saved' : ''}" data-a="pin">${saved ? BOOKMARK_SVG : BOOKMARK_LINE_SVG} ${esc(t(saved ? 'Saved' : 'Save'))}</button>`
      + (options.length && !nav ? `<button class="place-pill" data-a="via">${icon('add')} ${esc(t('Go via here'))}</button>` : '')
      + links.map(([href, ic, label, extra]) => `<a class="place-pill" href="${esc(href)}"${extra}>${ic} ${esc(label)}</a>`).join('')
      // mid-ride the main action is a stop on the way, not a new trip
      + `</div>${nav ? (nav.recordOnly ? '' : `<button class="primary-btn" data-a="stop">${esc(t('Add as stop'))}</button>`) : `<button class="primary-btn" data-a="to">${esc(t('Directions'))}</button>`}`;
    $('#placeActions').querySelectorAll('[data-a]').forEach(b => b.onclick = () => go(b.dataset.a));
  };
  const cat = lookup === true ? null : lookup || null, cached = lookup ? cachedPlace(name, latlng, cat) : null;
  $('#placeBody').innerHTML = cached ? detailsHtml(cached.tags) : lookup ? `<small class="pp-loading">${esc(t('Loading details…'))}</small>` : '';
  render(cached?.tags);
  $('#placeSheet').classList.remove('leaving');
  $('#placeSheet').hidden = false;
  if (lookup && !cached) lookupPlace(name, latlng, cat).then(tags => {
    if (placeSel?.token !== token) return;
    $('#placeBody').innerHTML = detailsHtml(tags); render(tags);
    $('#placeBody').animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
  }).catch(() => { if (placeSel?.token === token) $('#placeBody').innerHTML = ''; });
}
export function closePlaceSheet() {
  if (!placeSel) return false;
  placeSel.marker.remove(); placeSel = null;
  // slide out, then hide (unless another place opened it again meanwhile)
  const el = $('#placeSheet');
  el.classList.add('leaving');
  setTimeout(() => { el.classList.remove('leaving'); if (!placeSel) el.hidden = true; }, 220);
  return true;
}

export async function dropPin(latlng) {
  if (nav) return;
  if (fol.mode && !fol.paused) pauseFollow();
  // start · via · end, in the order you'd plan a ride
  const html = name => placePopupHtml(name);
  const popup = L.popup({ closeButton: false, offset: [0, -4] })
    .setLatLng(latlng)
    .setContent(html('Dropped pin'))
    .openOn(map);
  let place = { name: 'Dropped pin', detail: '', latlng };
  const wire = () => {
    popup.getElement()?.querySelectorAll('button').forEach(b => b.onclick = () => {
      map.closePopup();
      if (b.dataset.a === 'via') addVia(latlng);
      else if (b.dataset.a === 'pin') editPin(null, { name: place.name === 'Dropped pin' ? '' : place.name, latlng });
      else choosePlace(b.dataset.a, place);
    });
  };
  wire();
  place = await reverse(latlng);
  if (popup.isOpen()) {
    popup.setContent(html(place.name));
    wire();
  }
}
