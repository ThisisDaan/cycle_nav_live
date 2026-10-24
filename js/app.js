import * as store from './store.js';
import { BIKE_TYPES, BIKE_ICONS, newBike, newRideId } from './store.js';
import { fetchAlternatives, fetchRoute, hintText, isRoundabout, isUturn, ROUTE_STYLES } from './router.js';
import { search, reverse } from './geocode.js';
import { bikeSpeed, buildIndex, familiarity, findFamiliar, viaPointsFor } from './memory.js';
import { Navigator, Recorder, Simulator } from './nav.js';
import { initNative, isNative, keepAwake, onBackButton, saveFile, speak, stopSpeaking } from './native.js';
import { ACCENTS, APP_ICONS, MAP_STYLES, MARKERS, applyTheme, iconSvg, tileStyle } from './theme.js';
import { applyBuildings, calmStyle } from './mapstyle.js';
import * as offline from './offline.js';
import { CLASS_COLORS, CLASS_ORDER } from './roadclass.js';
import * as bnative from './brouter-native.js';
import { bottomSheet } from './sheet.js';
import { refreshOfflineSegments, routingMode } from './router.js';
import { adviseHere, adviseRide } from './weather.js';
import { LANGUAGES, language, startTranslating, t } from './i18n.js';
import { bearing, dist, fmtClock, fmtDist, fmtDuration, projectOnSegment, resample, simplify } from './geo.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = () => store.get();

const ME = { isMe: true, name: 'My location' };

let map, tiles, meMarker, accuracyCircle, routeLayer, rideLayer, endMarker, startMarker;
let me = null;               // last fix: { latlng, accuracy, heading, speed, time }
let lastMovedFrom = null;    // for computing heading when the GPS doesn't give one
let compass = null;          // smoothed compass heading (degrees), when the phone has one
let shownRotation = 0;       // marker rotation, kept continuous so it never spins the long way round
let from = ME, to = null;
let options = [], selected = 0, planToken = 0, pendingPlan = false;
let vias = [];               // points the user added to shape the route
let gpxRoute = null;         // { name, vias } when following a GPX file
let viaLayer, pinLayer;
let rideList = [], cells = new Set();
let nav = null;              // active navigation / recording session
let tilesToken = 0;
let mapRotation = 0;         // degrees the map is turned while navigating, kept continuous
let recenterTimer = 0;
let wxAdvice = null, wxToken = 0, wxAt = 0, wxTimer = 0;   // ride weather advice
const wxOn = () => S().wx !== false;
let userRot = 0;             // planner rotation chosen by two-finger twist
let rotFrameTimer = 0;
let locked = false;          // lock mode: an overlay swallows every touch
const TILT = 50;             // degrees the map is tipped back in the 3D view
const landscapeMQ = matchMedia('(orientation: landscape) and (max-height: 500px)');
const isLand = () => landscapeMQ.matches;
let sheetCtl = null, navCtl = null;
// Width of the left column (panels) in landscape, safe area included; 0 in portrait.
const panelProbe = Object.assign(document.createElement('div'), {});
panelProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:0;width:var(--panel-w)';
document.body.appendChild(panelProbe);
const panelW = () => (isLand() ? panelProbe.offsetWidth : 0);
// The part of the screen the map is seen through, and where the rider sits in it.
function navGeom() {
  const w = innerWidth, h = innerHeight, pl = panelW();
  return { w, h, pl, cx: Math.round((pl + w) / 2), py: Math.round(h * (isLand() ? 0.70 : 0.66)) };
}
const FRAME_3D = 850;        // half-size of the tilted map square (px)
const is3d = () => document.body.classList.contains('nav-frame') && S().view3d !== false;

const buildings3d = () => S().view3d !== false;
const framed = () => document.body.classList.contains('nav-frame') || document.body.classList.contains('rot-frame');

// While the map is turned (CSS rotation), Leaflet's drag offsets are in screen
// space; turn them into map space so the map moves under your finger.
const dragMove = L.Draggable.prototype._onMove;
L.Draggable.prototype._onMove = function (e) {
  if (!framed() || !this._startPoint || e.touches?.length > 1) return dragMove.call(this, e);
  const t = e.touches?.length === 1 ? e.touches[0] : e;
  // in the tilted 3D view the vertical axis is squashed, so stretch it back (approximately)
  const a = mapRotation * Math.PI / 180, dx = t.clientX - this._startPoint.x, dy = (t.clientY - this._startPoint.y) / (is3d() ? Math.cos(TILT * Math.PI / 180) * 0.8 : 1);
  this._parentScale = { x: 1, y: 1 };
  dragMove.call(this, {
    clientX: this._startPoint.x + dx * Math.cos(a) - dy * Math.sin(a),
    clientY: this._startPoint.y + dx * Math.sin(a) + dy * Math.cos(a),
    target: e.target, type: e.type, preventDefault: () => e.preventDefault(),
  });
};

// Taps, long-presses, clicks and pinches: screen position -> map container position,
// undoing the CSS rotation around the centre of the (big, turned) map square.
const mouseToPoint = L.Map.prototype.mouseEventToContainerPoint;
L.Map.prototype.mouseEventToContainerPoint = function (e) {
  const c = this._container;
  if (!framed() || is3d() || c.id !== 'map') return mouseToPoint.call(this, e);
  const r = c.getBoundingClientRect(), a = mapRotation * Math.PI / 180;
  const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
  return L.point(c.offsetWidth / 2 + x * Math.cos(a) - y * Math.sin(a), c.offsetHeight / 2 + x * Math.sin(a) + y * Math.cos(a));
};

// A programmatic fit in the planner assumes a north-up screen-sized map.
const fitBounds = L.Map.prototype.fitBounds;
L.Map.prototype.fitBounds = function (...args) {
  if (!nav && document.body.classList.contains('rot-frame')) resetNorth(true);
  return fitBounds.apply(this, args);
};

// ---------------------------------------------------------------- startup

init();

async function init() {
  initNative().then(() => onBackButton(handleBack)).catch(() => {});
  applyTheme(S().theme);
  startTranslating();
  setupMap();
  setupPlanner();
  setupButtons();
  setupSheet();
  setupWeather();
  renderBikeChip();
  startGps();
  startCompass();
  await reloadRides();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(S().theme);
    if (S().theme.mapStyle === 'auto') setTiles();
  });
  // No service worker in the Android app or during local development (it would serve stale files).
  if ('serviceWorker' in navigator && !isNative && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (nav && document.visibilityState === 'visible') keepAwake(true);
  });
}

async function reloadRides() {
  try { rideList = await store.rides.all(); } catch { rideList = []; }
  cells = buildIndex(rideList);
  renderBikeChip();
  if (rideLayer) showRiddenRoads(true);
}

// ---------------------------------------------------------------- map

function setupMap() {
  const view = S().view;
  map = L.map('map', { zoomControl: false, tap: true, zoomSnap: 0.25 })
    .setView(view?.center || [52.3676, 4.9041], view?.zoom || 13);
  setTiles();
  routeLayer = L.layerGroup().addTo(map);
  const zoomClass = () => map.getContainer().classList.toggle('zoom-low', map.getZoom() < 14);
  map.on('zoomend', zoomClass); zoomClass();
  viaLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  renderPins();

  let saveTimer;
  map.on('moveend', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.update(s => {
      const c = map.getCenter();
      s.view = { center: [c.lat, c.lng], zoom: map.getZoom() };
    }), 500);
  });
  map.on('dragstart', () => {
    if (nav) { nav.follow = false; clearTimeout(recenterTimer); $('#recenterBtn').hidden = false; }
    else if (options.length) setSheetCollapsed(true);
  });
  // After looking around, snap back to your position by itself.
  map.on('dragend', () => { if (nav) autoRecenter(8000); });
  // keep the building height in step with the zoom while pinching, not only once it ends
  map.on('zoom', () => { if (!rotRaf) rotRaf = requestAnimationFrame(rotTick); });
  map.on('zoomend', () => {
    syncGL();
    // A pinch while following sets your own zoom level for the rest of the ride.
    if (nav?.follow && nav.wantZoom != null && Math.abs(map.getZoom() - nav.wantZoom) > 0.05) nav.userZoom = map.getZoom();
  });
  setupTwist();
  map.on('click', () => { hideSuggestions(); $('#bikeMenu').hidden = true; });
  map.on('contextmenu', e => !picking && dropPin([e.latlng.lat, e.latlng.lng]));
}

async function setTiles() {
  const style = tileStyle(S().theme);
  const token = ++tilesToken;
  let layer;
  if (style.vector) {
    try {
      layer = L.maplibreGL({
        style: await calmStyle(style.dark),
        attribution: '&copy; OpenStreetMap contributors · <a href="https://openfreemap.org">OpenFreeMap</a> · Routing <a href="https://brouter.de">BRouter</a>',
        interactive: false,
        padding: GL_PAD,
      });
    } catch {
      layer = null; // vector tiles unavailable: fall back to the standard map below
    }
  }
  if (!layer) {
    const raster = style.url ? style : MAP_STYLES.standard;
    layer = L.tileLayer(raster.url, {
      maxZoom: 19,
      maxNativeZoom: raster.maxZoom || 19,
      className: raster.className || '',
      attribution: raster.attr + ' · Routing <a href="https://brouter.de">BRouter</a>',
      subdomains: raster.noSub ? '' : 'abc',
    });
  }
  if (token !== tilesToken) return;
  if (tiles) map.removeLayer(tiles);
  tiles = layer.addTo(map);
  const gl = tiles.getMaplibreMap?.();
  if (gl) { gl.on('load', syncGL); syncGL(); }
}

// The GL map lives inside the CSS-rotated #map. To keep street names upright, its container is turned
// back by the same angle (CSS `rotate`) and the GL bearing is set to match, so the picture is
// geographically identical but MapLibre draws the labels screen-aligned.
const GL_PAD = 0.12;
const glPos = L.DomUtil.setPosition;
L.DomUtil.setPosition = function (el, p) {
  // position the GL container with `translate` (applied after `rotate`) so turning it keeps its own centre
  if (el.classList?.contains('leaflet-gl-layer')) { el._leaflet_pos = p; el.style.translate = `${p.x}px ${p.y}px`; return; }
  return glPos.call(this, el, p);
};
const glTransform = L.DomUtil.setTransform;
L.DomUtil.setTransform = function (el, offset, scale) {
  const box = el.parentNode;
  const rot = box?._glRot;
  if (rot && box.classList?.contains('leaflet-gl-layer')) {
    // Leaflet's zoom animation offsets assume an unturned layer; fold the container's turn into them
    const a = -rot * Math.PI / 180, co = Math.cos(a), si = Math.sin(a), s = scale || 1;
    const o = offset || L.point(0, 0), cx = box.offsetWidth / 2, cy = box.offsetHeight / 2;
    offset = L.point(co * o.x - si * o.y + (s - 1) * (co * cx - si * cy - cx), si * o.x + co * o.y + (s - 1) * (si * cx + co * cy - cy));
  }
  return glTransform.call(this, el, offset, scale);
};

function turnGL(gl, rot) {
  const box = tiles?.getContainer?.();
  if (!box || !gl) return;
  const r = Math.round(rot * 20) / 20;
  if (box._glRot === r) return;
  box._glRot = r;
  box.style.rotate = r ? `${r}deg` : '';
  gl.jumpTo({ bearing: r });
}

// 3D view extras on the GL map: fake building height and a lower pixel ratio for the big tilted square.
function syncGL() {
  const gl = tiles?.getMaplibreMap?.();
  if (!gl) return;
  const tilted = is3d();
  const size = 2 * FRAME_3D * (1 + 2 * GL_PAD), dpr = window.devicePixelRatio || 1;
  const pr = tilted ? Math.min(dpr, 3200 / (size * 1.1)) : dpr;
  if (gl.getPixelRatio() !== pr) gl.setPixelRatio(pr);
  const box = tiles.getContainer();
  const want = map.getSize().multiplyBy(1 + 2 * GL_PAD);
  if (box && Math.abs(box.offsetWidth - want.x) > 1) tiles._resizeContainer?.();
  // the container grows with the oversized map frame; make sure the canvas follows
  if (box && (Math.abs(box.offsetWidth - parseFloat(gl.getCanvas().style.width)) > 1 || Math.abs(box.offsetHeight - parseFloat(gl.getCanvas().style.height)) > 1)) gl.resize();
  turnGL(gl, renderedRot());
  // lift is smaller when the map is not tipped back (planner)
  applyBuildings(gl, buildings3d(), map.getZoom(), tilted ? 1.9 : 1.1);
}

// The CSS rotation animates over ROT_MS; read the angle it is *actually* showing (computed style),
// so labels and building offsets follow it frame by frame whatever the easing.
const ROT_MS = 500;
let rotAnim = null, rotRaf = 0;
function renderedRot() {
  if (!framed()) { rotAnim = null; return 0; }
  const tr = getComputedStyle($('#map')).transform;
  if (!tr || tr === 'none') return 0;
  const m = new DOMMatrix(tr);
  // first column of rotateX(tilt) * rotate(-rot) is (cos, sin*cos(tilt), sin*sin(tilt))
  const th = Math.atan2(Math.sign(m.m12 || 1) * Math.hypot(m.m12, m.m13), m.m11);
  let rot = -th * 180 / Math.PI;
  rot += Math.round((mapRotation - rot) / 360) * 360;
  return rot;
}
function startRotAnim(from, to) {
  if (from === to && !rotAnim) return;
  rotAnim = { t0: performance.now(), ms: document.body.classList.contains('nav-frame') ? ROT_MS : 350 };
  if (!rotRaf) rotRaf = requestAnimationFrame(rotTick);
}
function rotTick() {
  rotRaf = 0;
  syncGL();
  const busy = document.body.classList.contains('twisting') || (rotAnim && performance.now() - rotAnim.t0 < rotAnim.ms + 60);
  if (busy) rotRaf = requestAnimationFrame(rotTick);
  else { rotAnim = null; syncGL(); }
}

async function dropPin(latlng) {
  if (nav) return;
  // start · via · end, in the order you'd plan a ride
  const html = name => `<div class="map-popup"><b class="selectable">${esc(name)}</b><button data-a="from">Directions from here</button>${
    options.length ? '<button data-a="via">Go via here</button>' : ''}<button class="go" data-a="to">Directions to here</button><button data-a="pin">${BOOKMARK_SVG} Save as pin</button></div>`;
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

// ---------------------------------------------------------------- GPS & position marker

function startGps() {
  if (!('geolocation' in navigator)) { toast('This device has no location support'); return; }
  navigator.geolocation.watchPosition(pos => {
    if (nav?.sim) return; // the simulator is driving
    handleFix({
      latlng: [pos.coords.latitude, pos.coords.longitude],
      accuracy: pos.coords.accuracy,
      heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
      time: pos.timestamp,
    });
  }, err => {
    if (err.code === err.PERMISSION_DENIED) toast('Location is off — type a start point, or allow location access');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

function handleFix(fix) {
  const first = !me;
  if (first) setTimeout(() => { if (me) wxUpdate(); }, 0);
  if (fix.heading == null) {
    if (lastMovedFrom && dist(lastMovedFrom, fix.latlng) > 6) {
      fix.heading = bearing(lastMovedFrom, fix.latlng);
      lastMovedFrom = fix.latlng;
    } else {
      fix.heading = me?.heading ?? null;
      lastMovedFrom ||= fix.latlng;
    }
  } else {
    lastMovedFrom = fix.latlng;
  }
  me = fix;
  drawMe();
  if (first && !S().view && !nav) map.setView(fix.latlng, 15);
  if (pendingPlan) { pendingPlan = false; planRoute(); }
  if (nav) onNavFix(fix);
}

// Compass: the marker turns with the phone. While riding faster than walking
// pace we trust the GPS direction of travel instead (no magnetic noise from the bike).
function startCompass() {
  const onOrientation = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    h = (h + (screen.orientation?.angle || 0) + 360) % 360;
    compass = compass == null ? h : (compass + angleDelta(compass, h) * 0.3 + 360) % 360;
    scheduleHeading();
  };
  if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', onOrientation);
  else addEventListener('deviceorientation', onOrientation);
  // iPhone Safari only gives the compass after asking, from a tap
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    addEventListener('click', () => DeviceOrientationEvent.requestPermission().catch(() => {}), { once: true });
  }
}

function angleDelta(from, to) { return ((to - from + 540) % 360) - 180; }

function currentHeading() {
  const moving = me?.speed != null ? me.speed > 2.5 : false;
  if (moving && me.heading != null) return me.heading;
  return compass ?? me?.heading ?? null;
}

let headingFrame = 0;
function scheduleHeading() {
  if (!headingFrame) headingFrame = requestAnimationFrame(() => { headingFrame = 0; applyHeading(); });
}

function applyHeading() {
  const el = meMarker?.getElement()?.querySelector('.me-rot');
  if (!el) return;
  const h = currentHeading();
  el.classList.toggle('no-heading', h == null);
  if (h == null) return;
  shownRotation += angleDelta(shownRotation, h);
  el.style.transform = `rotate(${shownRotation}deg)`;
  if (nav && S().orientation === 'compass') rotateMap();
}

function meIconHtml() {
  return `<div class="me-tilt">${meIconInner()}</div>`;
}

function meIconInner() {
  const kind = S().theme.marker;
  const cone = '<div class="me-rot me-beam"><div class="me-cone"></div></div>';
  if (kind === 'dot') return cone + '<div class="me-dot"></div>';
  if (kind === 'bike') {
    const b = store.activeBike();
    return cone + `<div class="bike-badge me-bike" style="--bike:${esc(b.color)}">${esc(b.icon)}</div>`;
  }
  return '<svg class="me-arrow me-rot" viewBox="0 0 40 40"><path d="M20 4 L33 34 L20 27 L7 34 Z" fill="var(--accent)" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>';
}

function drawMe(rebuild = false) {
  if (!me) return;
  if (rebuild && meMarker) { meMarker.remove(); meMarker = null; }
  if (!meMarker) {
    const size = S().theme.marker === 'dot' ? 40 : S().theme.marker === 'bike' ? 38 : 40;
    meMarker = L.marker(me.latlng, {
      icon: L.divIcon({ className: 'me-marker', html: meIconHtml(), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
    accuracyCircle = accuracyCircle || L.circle(me.latlng, { radius: me.accuracy, stroke: false, fillColor: S().theme.accent, fillOpacity: .12, interactive: false }).addTo(map);
  }
  meMarker.setLatLng(me.latlng);
  accuracyCircle.setLatLng(me.latlng).setRadius(Math.min(me.accuracy || 0, 200));
  accuracyCircle.setStyle({ fillColor: S().theme.accent });
  applyHeading();
}

// ---------------------------------------------------------------- planner

function setupPlanner() {
  // Keep the map buttons just below the search box as it grows with added points.
  new ResizeObserver(() => {
    const r = $('#planner').getBoundingClientRect();
    document.documentElement.style.setProperty('--planner-bottom', `${Math.round(r.bottom + 12)}px`);
  }).observe($('#planner'));
  for (const which of ['from', 'to']) {
    const input = $(`#${which}Input`);
    let timer, abort;
    input.addEventListener('focus', () => { input.select(); showSuggestions(which, input.value.trim()); });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { showSuggestions(which, ''); return; }
      timer = setTimeout(async () => {
        abort?.abort();
        abort = new AbortController();
        renderSuggestions(which, null, `<li class="s-head"><span class="spinner"></span>Searching…</li>`);
        try {
          const results = await search(q, me?.latlng || mapCenter(), abort.signal);
          renderSuggestions(which, results.length ? results : null, results.length ? '' : '<li class="s-head">Nothing found</li>');
        } catch (e) {
          if (e.name !== 'AbortError') renderSuggestions(which, null, '<li class="s-head">Search is unavailable right now</li>');
        }
      }, 300);
    });
    input.addEventListener('keydown', e => {
      const items = [...document.querySelectorAll('#suggestions li[data-i]')];
      const cur = items.findIndex(li => li.classList.contains('active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[cur]?.classList.remove('active');
        const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.classList.add('active');
      } else if (e.key === 'Enter') {
        (items[cur] || items[0])?.click();
      } else if (e.key === 'Escape') {
        hideSuggestions();
        input.blur();
      }
    });
  }
  $('#swapBtn').onclick = () => {
    pushUndo('Swapped');
    [from, to] = [to || ME, from];
    vias.reverse();
    if (to?.isMe && from?.isMe) to = null;
    syncInputs();
    planRoute();
  };
  $('#clearBtn').onclick = () => {
    if (to) pushUndo('Route cleared');
    from = ME; to = null;
    syncInputs();
    clearRoutes();
  };
}

function mapCenter() { const c = map.getCenter(); return [c.lat, c.lng]; }

let suggestionItems = [];
function showSuggestions(which, q) {
  if (q.length >= 3) return; // a search is (or will be) running
  const items = [];
  if (which === 'from' || !from.isMe) items.push({ ...ME, icon: '◎', detail: me ? 'Use GPS' : 'Waiting for GPS…' });
  if (which === 'to') items.push({ name: 'Follow a GPX route…', detail: 'Open a .gpx file and navigate along it', icon: '📂', action: 'gpx' });
  const recent = S().recent.map(r => ({ ...r, icon: '🕘', recent: true }));
  renderSuggestions(which, [...items, ...recent], '', recent.length ? 'Recent' : '');
}

function renderSuggestions(which, items, extraHtml = '', head = '') {
  suggestionItems = items || [];
  const ul = $('#suggestions');
  ul.dataset.which = which;
  let html = extraHtml;
  suggestionItems.forEach((it, i) => {
    if (head && i === suggestionItems.findIndex(x => x.recent)) html += `<li class="s-head">${esc(head)}</li>`;
    html += `<li data-i="${i}"><span class="s-icon">${it.icon || '📍'}</span><span class="s-text"><div class="s-name">${esc(it.name)}</div>${it.detail ? `<div class="s-detail">${esc(it.detail)}</div>` : ''}</span>${(it.latlng || it.isMe) && !it.recent ? `<button class="s-pin" data-pin aria-label="Save as pin" title="Save as pin">${BOOKMARK_SVG}</button>` : ''}</li>`;
  });
  ul.innerHTML = html;
  ul.hidden = !html;
  ul.querySelectorAll('li[data-i]').forEach(li => {
    li.onmousedown = e => e.preventDefault(); // keep focus so blur doesn't eat the click
    const pb = li.querySelector('[data-pin]');
    if (pb) pb.onclick = e => {
      e.stopPropagation();
      const it = suggestionItems[+li.dataset.i];
      const latlng = it.isMe ? me?.latlng : it.latlng;
      if (!latlng) { toast('Waiting for your location…'); return; }
      hideSuggestions(); document.activeElement?.blur();
      editPin(null, { name: it.isMe ? '' : it.name, note: it.isMe ? '' : it.detail || '', latlng });
    };
    li.onclick = () => {
      const { icon, recent, action, ...place } = suggestionItems[+li.dataset.i];
      if (action === 'gpx') { hideSuggestions(); document.activeElement?.blur(); pickGpxRoute(); return; }
      choosePlace(ul.dataset.which, place);
    };
  });
}

function hideSuggestions() { $('#suggestions').hidden = true; }

function choosePlace(which, place) {
  hideSuggestions();
  document.activeElement?.blur();
  if (which === 'from') from = place; else to = place;
  vias = [];
  gpxRoute = null;
  if (!place.isMe) store.addRecent({ name: place.name, detail: place.detail, latlng: place.latlng });
  syncInputs();
  if (to) planRoute(); else if (which === 'from') drawStart(resolve(from));
  // Show the place right away; once both ends are known the route fit takes over.
  const ll = resolve(place);
  if (ll && !(to && resolve(from) && resolve(to))) map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: 0.8 });
}

function syncInputs() {
  $('#fromInput').value = from?.isMe ? '' : from?.name || '';
  $('#toInput').value = to ? (to.isMe ? t('My location') : to.name) : '';
}

function resolve(place) { return place?.isMe ? me?.latlng : place?.latlng; }

// ---------------------------------------------------------------- routing

async function planRoute({ fit = true } = {}) {
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
  if (vias.length) {
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
    const [alts, familiar] = await Promise.all([
      fetchAlternatives(a, b, bike).catch(e => e),
      familiarRoute(a, b, bike),
    ]);
    if (token !== planToken) return;
    if (familiar) list.push({ route: familiar, kind: 'familiar' });
    if (Array.isArray(alts)) {
      alts.forEach(route => {
        if (familiar && Math.abs(route.length - familiar.length) < 40 && Math.abs(route.stats.turns - familiar.stats.turns) <= 1) return;
        list.push({ route, kind: 'alt' });
      });
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
  selectRoute(pick, fit);
}

async function familiarRoute(a, b, bike) {
  const f = findFamiliar(rideList, a, b);
  if (!f) return null;
  try {
    const route = await fetchRoute([a, ...viaPointsFor(f.points), b], bike);
    route.ridden = f.count;
    route.saved = f.saved;
    return route;
  } catch { return null; }
}

function selectRoute(i, fit = false) {
  selected = i;
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
  const bike = store.activeBike();
  const pace = `${t("{0}'s pace", esc(bike.name))}: <b>${bikeSpeed(bike, rideList).kmh.toFixed(1)} km/h</b>`;
  $('#routeStatus').innerHTML = vias.length
    ? `${pace} · <button class="link-btn" id="resetVias">Undo my changes</button>`
    : `${pace} · <span class="route-hint">Drag the green line to change the route</span>`;
  $('#resetVias') && ($('#resetVias').onclick = () => { pushUndo('Route reset'); vias = gpxRoute ? gpxRoute.vias.slice() : []; planRoute(); });
  $('#rememberBtn').hidden = options[selected]?.kind !== 'custom';
  $('#routeCards').innerHTML = options.map((o, i) => {
    const r = o.route;
    const title = {
      familiar: t('Your usual way'),
      custom: gpxRoute ? `GPX: ${esc(gpxRoute.name)}` : t('Your route'),
      calm: t(ROUTE_STYLES[store.activeBike().style]?.offroad ? 'Most off-road' : 'Calmest'),
    }[o.kind] || t(o.shortest ? 'Shorter' : 'Alternative');
    const tags = [];
    if (o.kind === 'familiar') tags.push(`<span class="tag">${r.saved && r.ridden === 1 ? t('saved by you') : t('ridden {0}×', r.ridden)}</span>`);
    else if (o.familiar > 0.5) tags.push(`<span class="tag">${t('{0}% familiar', Math.round(o.familiar * 100))}</span>`);
    const added = vias.filter(v => !v.gpx).length;
    if (o.kind === 'custom' && gpxRoute) tags.push('<span class="tag">follows your GPX</span>');
    if (o.kind === 'custom' && added) tags.push(`<span class="tag">${added > 1 ? t('{0} points added', added) : t('1 point added')}</span>`);
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
    ? `<div class="rc-warn" role="button">⚠ ${t('{0} busy road without bike lane', fmtDist(m.busy))}</div>` : '';
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

function drawEvents(r) {
  for (const e of r.events || []) {
    L.marker(e.latlng, {
      interactive: false, keyboard: false, zIndexOffset: -100,
      icon: L.divIcon({ className: `ev-icon ev-${e.type}`, html: e.type === 'signal' ? SIGNAL_SVG : RISKY_SVG, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).addTo(routeLayer);
  }
}

function drawRoutes(onlySelected = false) {
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
  if (!nav) {
    // A wide invisible line that is easy to hit with a finger: press and drag it
    // to pull the route somewhere else (or just tap it to drop a point).
    const hit = L.polyline(r.coords, { color: '#000', weight: 30, opacity: 0, className: 'route-hit' }).addTo(routeLayer);
    enableLineDrag(hit.getElement(), r);
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
function alongRoute(route, p) {
  let best = { d: Infinity, along: 0 };
  for (let i = 0; i < route.coords.length - 1; i++) {
    const r = projectOnSegment(p, route.coords[i], route.coords[i + 1]);
    if (r.d < best.d) best = { d: r.d, along: route.cum[i] + r.t * (route.cum[i + 1] - route.cum[i]) };
  }
  return best.along;
}

function addVia(p) {
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

// ---- undo for route edits

const undoStack = [];
let undoTimer = 0;
const snapPlan = () => ({ from, to, gpx: gpxRoute, vias: vias.map(v => Object.assign([v[0], v[1]], { gpx: v.gpx, name: v.name, city: v.city })) });

function pushUndo(label) {
  undoStack.push(snapPlan());
  if (undoStack.length > 40) undoStack.shift();
  updateUndoUi();
  const bar = $('#undoBar');
  $('#undoMsg').textContent = t(label);
  bar.hidden = false;
  const sh = $('#sheet');
  if (!landscapeMQ.matches) {
    const place = () => { bar.style.bottom = `${sh.hidden ? 24 : Math.max(16, innerHeight - sh.getBoundingClientRect().top + 12)}px`; };
    place(); setTimeout(place, 360);
  } else bar.style.bottom = '';
  bar.classList.remove('show'); bar.offsetWidth; bar.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { bar.classList.remove('show'); setTimeout(() => { bar.hidden = true; }, 250); }, 5000);
}

function updateUndoUi() { $('#undoBtn').hidden = !undoStack.length || !!nav; }

function undo() {
  const s = undoStack.pop();
  if (!s) return;
  clearTimeout(undoTimer);
  $('#undoBar').classList.remove('show'); $('#undoBar').hidden = true;
  from = s.from; to = s.to; gpxRoute = s.gpx;
  vias = s.vias.map(v => Object.assign([v[0], v[1]], { gpx: v.gpx, name: v.name, city: v.city }));
  syncInputs();
  updateUndoUi();
  if (to) planRoute({ fit: false }); else clearRoutes();
}

const BOOKMARK_SVG = '<svg class="bm-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>';
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
      <button class="icon-btn" data-unvia="${n}" title="Remove this point" aria-label="Remove point ${viaLetter(n)}">✕</button>
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


function setSheetCollapsed(collapsed) {
  if (sheetCtl && $('#sheet').classList.contains('collapsed') !== collapsed) sheetCtl.go(collapsed);
  else $('#sheet').classList.toggle('collapsed', collapsed);
}

// Save the hand-shaped route as if it had been ridden, so it becomes "Your usual way".
async function rememberRoute() {
  const o = options[selected];
  if (!o) return;
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
  });
  await reloadRides();
  vias = [];
  gpxRoute = null;
  toast('Saved. Next time this shows up as “Your usual way”');
  planRoute({ fit: false });
}

function setupSheet() {
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
    if (which === 'from') from = p; else to = p;
    syncInputs();
    planRoute({ fit: false });
  });
}

function drawStart(a) {
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

function clearRoutes() {
  planToken++;
  options = [];
  vias = [];
  gpxRoute = null;
  routeLayer.clearLayers();
  viaLayer.clearLayers();
  $('#viaRows').innerHTML = '';
  startMarker?.remove(); endMarker?.remove();
  $('#sheet').hidden = true;
  wxUpdate();
}

// ---------------------------------------------------------------- ride weather advice

async function wxUpdate() {
  const my = ++wxToken;
  const o = !$('#sheet').hidden && options[selected];
  if (!wxOn() || nav || (!o && !me)) { wxAdvice = null; return wxRender(); }
  const adv = o ? await adviseRide(o.route, Date.now(), o.time) : await adviseHere(me.latlng);
  if (my !== wxToken) return;
  wxAdvice = adv && { ...adv, _for: o ? o.route : null };
  wxAt = Date.now();
  wxRender();
}

function wxLine(a) {
  return `<span class="wx-ic">${a.icon}</span><span class="wx-tx">${esc(a.text)}${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</span>`;
}

function wxRender() {
  const a = wxAdvice;
  const o = !$('#sheet').hidden && options[selected];
  const chip = $('#wxChip');
  chip.hidden = !(a && !o && !nav);
  if (!chip.hidden) { chip.innerHTML = wxLine(a); chip.className = `wx-chip wx-${a.kind}`; }
  const line = document.querySelector('.route-card.selected .rc-advice');
  if (line) {
    const ok = a && o && a._for === o.route;
    line.hidden = !ok;
    if (ok) { line.innerHTML = wxLine(a); line.className = `rc-advice wx-${a.kind}`; }
  }
  if (!a) closeWxPop();
}

function wxBarH(mm) { return mm < 0.1 ? 0 : Math.min(1, (Math.log10(mm) + 1.2) / 3.2); }

function showWxPop() {
  const a = wxAdvice;
  if (!a) return;
  const pop = $('#wxPop');
  const max = Math.max(...a.bars.map(b => b.mm));
  const di = a.depart == null ? -1 : Math.round((a.depart - a.now) / 300000);
  const cols = a.bars.map((b, i) => {
    const h = wxBarH(b.mm);
    const mark = i === 0 ? t('now') : i === di ? t('go') : '';
    return `<div class="wx-col${i === 0 || i === di ? ' mark' : ''}"><span class="wx-flag">${mark}</span>
      <div class="wx-slot"><i ${h ? `style="height:${Math.max(5, h * 100)}%"` : 'class="dry"'}></i></div><b>${i % 6 === 0 ? fmtClock(new Date(b.t)) : ''}</b></div>`;
  }).join('');
  const facts = [];
  if (a.cur?.temp != null) facts.push(`🌡 ${Math.round(a.cur.temp)}°`);
  if (a.cur?.speed != null) facts.push(`<span class="wx-arrow" style="transform:rotate(${Math.round(a.cur.dir + 180)}deg)">↑</span> ${t('Wind {0} Bft', a.wind?.bft ?? '–')} · ${Math.round(a.cur.speed * 3.6)} km/h`);
  pop.innerHTML = `<div class="wx-card" role="dialog">
    <div class="wx-head ${`wx-${a.kind}`}">${wxLine(a)}</div>
    <h4>${t('Rain forecast, next 90 min')} · ${max < 0.1 ? t('dry') : max < 1 ? t('light') : max < 5 ? t('moderate') : t('heavy')}</h4>
    <div class="wx-graph">${cols}</div>
    <div class="wx-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
    <button class="secondary-btn wx-close">${t('Close')}</button></div>`;
  pop.hidden = false;
  pop.onclick = e => { if (e.target === pop || e.target.closest('.wx-close')) closeWxPop(); };
}
function closeWxPop() { $('#wxPop').hidden = true; }

function setupWeather() {
  $('#wxChip').onclick = showWxPop;
  wxTimer = setInterval(() => { if (!document.hidden) wxUpdate(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - wxAt > 5 * 60 * 1000) wxUpdate(); });
  offline.onOfflineChange(() => wxUpdate());
}

// ---------------------------------------------------------------- navigation

function setupButtons() {
  $('#startBtn').onclick = () => startNavigation(options[selected]);
  $('#stopBtn').onclick = openEndSheet;
  $('#recordBtn').onclick = () => startRecording();
  $('#locateBtn').onclick = () => {
    if (me) map.setView(me.latlng, Math.max(map.getZoom(), 16));
    else toast('Waiting for your location…');
  };
  $('#recenterBtn').onclick = recenter;
  $('#voiceBtn').onclick = () => {
    store.update(s => { s.voice = !s.voice; });
    renderVoiceBtn();
    if (!S().voice) stopSpeaking();
    toast(S().voice ? 'Voice on' : 'Voice off');
  };
  $('#compassBtn').onclick = () => resetNorth();
  $('#orientBtn').onclick = () => {
    if (nav?.manual != null) { nav.manual = null; $('#recenterBtn').hidden = nav.follow; toast(t('Map: {0}', t(ORIENTATIONS[S().orientation].label).toLowerCase())); return rotateMap(); }
    const modes = Object.keys(ORIENTATIONS);
    const next = modes[(modes.indexOf(S().orientation) + 1) % modes.length];
    store.update(s => { s.orientation = next; });
    toast(t('Map: {0}', t(ORIENTATIONS[next].label).toLowerCase()));
    rotateMap();
  };
  $('#view3dBtn').onclick = () => {
    store.update(s => { s.view3d = s.view3d === false; });
    setNavFrame(!!nav);
    if (nav?.follow && me) followCamera(me, nav.last);
  };
  document.querySelectorAll('.lockBtn').forEach(b => b.onclick = lockScreen);
  setupFullscreen();
  setupLock();
  navCtl = bottomSheet({
    el: $('#navBar'), grips: [$('#navBar .sheet-handle'), $('#navToggle')], scroller: $('#navBar'),
    isCollapsed: () => $('#navDetails').hidden,
    apply: c => setNavOpen(!c),
    disabled: () => landscapeMQ.matches,
  });
  $('#navToggle').onclick = () => navCtl.toggle();
  $('#overviewBtn').onclick = showOverview;
  setupStopSearch();
  $('#settingsBtn').onclick = () => openSettings('bikes');
  setupDrawer();
  $('#closeSettings').onclick = closeSettings;
  $('#bikeChip').onclick = e => { e.stopPropagation(); toggleBikeMenu(); };
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => openSettings(b.dataset.tab));
}

function renderVoiceBtn() {
  const on = S().voice;
  $('#voiceBtn').innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/>${on
    ? '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'
    : '<path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9l6 6M22 9l-6 6"/>'}</svg>`;
  $('#voiceBtn').classList.toggle('muted', !on);
}

function startNavigation(option) {
  if (!option) return;
  const bike = store.activeBike();
  nav = {
    route: option.route,
    navigator: new Navigator(option.route),
    recorder: new Recorder(),
    dest: to,
    vias: vias.slice(),
    along: 0,
    follow: true,
    speedKmh: bikeSpeed(bike, rideList).kmh,
  };
  options = [option]; selected = 0;
  drawRoutes(true);
  viaLayer.clearLayers();
  enterNavUi(false);
  if (S().demo) {
    toast('Demo mode: simulating your ride');
    nav.sim = new Simulator(option.route, nav.speedKmh, handleFix);
  } else if (me) {
    nav.wantZoom = 17;
    map.setView(me.latlng, 17, { animate: false });
    onNavFix(me);
  } else {
    $('#navDist').textContent = 'Locating…';
  }
  const spoken = fmtDist(option.route.length).replace('km', t('kilometres')).replace(' m', ` ${t('metres')}`);
  if (S().voice) speak(t("Let's go. {0} to go", spoken));
}

function startRecording() {
  nav = { recorder: new Recorder(), follow: true, recordOnly: true, vias: [] };
  enterNavUi(true);
  if (me) { nav.wantZoom = 17; map.setView(me.latlng, 17, { animate: false }); }
  toast('Recording — ride your favourite way and Cycle Nav will remember it');
}

function enterNavUi(recordOnly) {
  document.body.classList.add('navigating');
  updateUndoUi();
  $('#navBanner').hidden = recordOnly;
  $('#navBar').hidden = false;
  $('#navRemainLabel').textContent = recordOnly ? 'ridden' : 'to go';
  $('#navEtaLabel').textContent = recordOnly ? 'moving' : 'arrival';
  renderVoiceBtn();
  $('#voiceBtn').hidden = recordOnly;
  $('#navButtons').hidden = false;
  map.closePopup();
  setNavFrame(true);
  keepAwake(true);
}

function onNavFix(fix) {
  const { recorder } = nav;
  recorder.add(fix.latlng, fix.accuracy, fix.time || Date.now());
  const kmh = fix.speed != null ? fix.speed * 3.6 : recorder.speedKmh;
  $('#navSpeed').textContent = kmh ? kmh.toFixed(0) : '–';

  // Riding direction for the map: GPS course while moving, smoothed a little.
  if (fix.heading != null && (fix.speed == null || fix.speed > 1.5)) {
    nav.course = nav.course == null ? fix.heading : (nav.course + angleDelta(nav.course, fix.heading) * 0.6 + 360) % 360;
  }

  if (nav.recordOnly) {
    followCamera(fix, null);
    $('#navEta').textContent = fmtDuration(recorder.movingTime);
    $('#navRemain').textContent = fmtDist(recorder.distance);
    renderNavDetails();
    return;
  }

  const st = nav.navigator.update(fix.latlng, fix.accuracy);
  nav.last = st;
  // GPS wanders a few metres: pull the marker onto the line when it's close (fully within 20 m,
  // easing off to nothing at 35 m), so you clearly see yourself on the route.
  const k = st.offRoute ? 0 : st.offBy <= 20 ? 1 : Math.max(0, (35 - st.offBy) / 15);
  if (k > 0 && meMarker) {
    const ll = [fix.latlng[0] + (st.snap[0] - fix.latlng[0]) * k, fix.latlng[1] + (st.snap[1] - fix.latlng[1]) * k];
    meMarker.setLatLng(ll);
    accuracyCircle?.setLatLng(ll);
    fix = { ...fix, latlng: ll };
  }
  followCamera(fix, st);
  if (!st.offRoute) nav.along = st.along;
  checkStops(fix);
  renderNavDetails();
  $('#navRemain').textContent = fmtDist(st.remaining);
  $('#navEta').textContent = fmtClock(new Date(Date.now() + st.remaining / (nav.speedKmh / 3.6) * 1000));

  const banner = $('#navBanner');
  banner.classList.toggle('off-route', st.offRoute);
  if (st.offRoute) {
    $('#navArrow').innerHTML = arrowSvg(null, true);
    $('#navDist').textContent = 'Off route';
    $('#navInstr').textContent = nav.rerouting ? 'Finding a new route…' : 'Rerouting…';
    $('#navThen').hidden = true;
    if (!nav.rerouting) reroute();
    return;
  }
  $('#navArrow').innerHTML = arrowSvg(st.next);
  $('#navDist').textContent = fmtDist(st.distToNext);
  $('#navInstr').textContent = st.next ? hintText(st.next) : 'Arrive at destination';
  // Always show what comes after the next turn, so you can get in lane early.
  $('#navThen').hidden = !st.after;
  if (st.after) $('#navThen').innerHTML = `${t('Then')} ${arrowSvg(st.after)} <span>${esc(hintText(st.after).toLowerCase())} ${st.thenSoon ? `<b>${t('right after')}</b>` : t('after {0}', fmtDist(st.afterGap))}</span>`;
  if (st.say && S().voice) speak(st.say);
  else if (S().voice && S().lightHint) {
    const cum = nav.route.cum;
    if (!nav.lightsSaid) nav.lightsSaid = new Set();
    const light = (nav.route.events || []).find(e => e.type === 'signal' && !nav.lightsSaid.has(e.idx)
      && cum[e.idx] - st.along > 0 && cum[e.idx] - st.along < 80);
    if (light) { nav.lightsSaid.add(light.idx); speak(t('Traffic light ahead')); }
  }
  if (st.arrived && !nav.arriving) {
    nav.arriving = true;
    $('#navDist').textContent = 'Arrived';
    $('#navInstr').textContent = to?.name || 'You have arrived';
    setTimeout(() => nav && stopNavigation(true), 1500);
  }
}

async function reroute(points) {
  nav.rerouting = true;
  const session = nav;
  try {
    // Keep the points you added that are still ahead of you.
    const ahead = points || session.vias.filter(v => alongRoute(session.route, v) > session.along + 30);
    const route = await fetchRoute([me.latlng, ...ahead, resolve(session.dest)], store.activeBike());
    session.vias = ahead;
    if (nav !== session) return;
    session.route = route;
    session.navigator = new Navigator(route);
    options = [{ route }]; selected = 0;
    drawRoutes(true);
    session.sim?.setRoute(route);
    drawNavStops();
    renderNavDetails();
    if (S().voice) speak(t('Route updated'));
  } catch {
    toast('Could not reroute — keep going, retrying shortly');
  } finally {
    setTimeout(() => { session.rerouting = false; }, 4000);
  }
}

function stopNavigation(arrived, discard = false) {
  if (!nav) return;
  const session = nav;
  nav = null;
  session.sim?.stop();
  keepAwake(false);
  stopSpeaking();
  document.body.classList.remove('navigating');
  updateUndoUi();
  clearTimeout(recenterTimer);
  setNavOpen(false);
  viaLayer.clearLayers();
  setNavFrame(false);
  $('#navBanner').hidden = $('#navBar').hidden = $('#recenterBtn').hidden = $('#navButtons').hidden = true;
  $('#navBanner').classList.remove('off-route');

  if (arrived || session.recordOnly) {
    from = ME; to = null; syncInputs(); clearRoutes();
  } else if (to) {
    planRoute();
  }
  if (discard) return;
  if (session.recorder.distance > 150) offerSaveRide(session, arrived);
  else if (session.recordOnly) toast('Ride too short to save');
}

// ---- navigation camera: follow you, turn the map, zoom with speed

const ORIENTATIONS = {
  course:  { label: 'Riding direction', desc: 'The way you ride points up' },
  north:   { label: 'North up',         desc: 'The map never turns' },
  compass: { label: 'Phone direction',  desc: 'Turns with the phone, like a compass' },
};

// While navigating, the map is a big square around a point low on the screen
// (more road ahead), so it can be turned without showing empty corners.
function setNavFrame(on) {
  const el = $('#map');
  document.body.classList.remove('rot-frame');
  userRot = 0;
  const is3d3 = on && S().view3d !== false;
  document.body.classList.toggle('nav-3d', is3d3);
  if (on) {
    const { w, h, cx, py } = navGeom();
    const r = is3d3 ? FRAME_3D : Math.ceil(Math.hypot(Math.max(cx, w - cx), Math.max(py, h - py)));
    $('#mapWrap').style.perspectiveOrigin = `${cx}px ${py}px`;
    el.style.cssText = `inset:auto;left:${cx - r}px;top:${py - r}px;width:${2 * r}px;height:${2 * r}px`;
  } else {
    el.style.cssText = '';
    mapRotation = 0;
  }
  document.body.classList.toggle('nav-frame', on);
  for (const h of ['touchZoom', 'doubleClickZoom', 'scrollWheelZoom']) map.options[h] = on ? 'center' : true;
  map.invalidateSize({ pan: false });
  rotateMap();
  syncGL();
}

// Turned the phone / resized the window: re-fit the map frame, camera and panels.
let resizeTimer;
function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const r = $('#planner').getBoundingClientRect();
    document.documentElement.style.setProperty('--planner-bottom', `${Math.round(r.bottom + 12)}px`);
    if (nav) {
      setNavFrame(true);
      if (nav.follow && me) followCamera(me, nav.last);
    } else {
      if (document.body.classList.contains('rot-frame')) {
        const el = $('#map'), w = innerWidth, h = innerHeight, rr = Math.ceil(Math.hypot(w, h) / 2);
        el.style.cssText = `inset:auto;left:${Math.round(w / 2 - rr)}px;top:${Math.round(h / 2 - rr)}px;width:${2 * rr}px;height:${2 * rr}px`;
      }
      map.invalidateSize();
      rotateMap();
      syncGL();
    }
    if (picking) { pickRect = defaultPickRect(); layoutPick(); schedulePick(); }
  }, 120);
}
addEventListener('resize', onViewportChange);
addEventListener('orientationchange', onViewportChange);

function rotateMap() {
  let target = nav ? 0 : userRot;
  if (nav?.manual != null) target = nav.manual;
  else if (nav && !nav.overview) {
    const mode = S().orientation;
    if (mode === 'course') target = nav.course ?? currentHeading() ?? 0;
    else if (mode === 'compass') target = currentHeading() ?? nav.course ?? 0;
  }
  if (framed()) {
    const prevRot = renderedRot();
    mapRotation += angleDelta(mapRotation, target);
    $('#map').style.transform = `rotateX(${is3d() ? TILT : 0}deg) rotate(${-mapRotation}deg)`;
    $('#map').style.setProperty('--rot', `${-mapRotation}deg`);
    $('#map').style.setProperty('--irot', `${mapRotation}deg`);
    counterRotate();
    startRotAnim(prevRot, mapRotation);
  }
  const b3 = $('#view3dBtn');
  b3.textContent = S().view3d !== false ? t('3D view: on') : t('3D view: off');
  const cb = $('#compassBtn');
  cb.hidden = !!nav || (!document.body.classList.contains('rot-frame') && !mapRotation);
  cb.innerHTML = compassSvg(-mapRotation);
  const btn = $('#orientBtn');
  btn.title = `Map: ${ORIENTATIONS[S().orientation].label}`;
  btn.innerHTML = compassSvg(-mapRotation, nav?.manual != null)
    + `<small>${nav?.manual != null ? '✋' : { course: '', north: 'N', compass: '🧭' }[S().orientation]}</small>`;
}

const compassSvg = (deg, manual) => `<svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${deg}deg)"><path d="M12 2l4 10h-8z" fill="var(--danger)"/><path d="M12 22l-4-10h8z" fill="currentColor" opacity=".45"/></svg>`;

// Icons and popups sit inside the turned map; turn them back so they stay upright.
function counterRotate() {
  if (!framed()) return;
  for (const el of map._container.querySelectorAll('.leaflet-marker-icon:not(.me-marker):not([data-o])')) {
    el.dataset.o = 1;
    if (el.firstElementChild) el.firstElementChild.style.transformOrigin = `${-parseFloat(el.style.marginLeft || 0)}px ${-parseFloat(el.style.marginTop || 0)}px`;
  }
}

// Outside navigation the map is only turned (and made oversized) while the user has twisted it.
function setRotFrame(on) {
  if (nav || on === document.body.classList.contains('rot-frame')) return;
  clearTimeout(rotFrameTimer);
  const el = $('#map'), c = map.getCenter(), z = map.getZoom();
  if (on) {
    const w = innerWidth, h = innerHeight, r = Math.ceil(Math.hypot(w, h) / 2);
    el.style.cssText = `inset:auto;left:${Math.round(w / 2 - r)}px;top:${Math.round(h / 2 - r)}px;width:${2 * r}px;height:${2 * r}px`;
  } else {
    el.style.cssText = '';
    mapRotation = userRot = 0;
  }
  document.body.classList.toggle('rot-frame', on);
  map.invalidateSize({ pan: false });
  map.setView(c, z, { animate: false });
  rotateMap();
  syncGL();
}

// Back to north-up (animated unless `instant`), then drop the oversized frame.
function resetNorth(instant) {
  if (nav) { nav.manual = null; rotateMap(); return; }
  userRot = 0;
  if (instant) return setRotFrame(false);
  rotateMap();
  clearTimeout(rotFrameTimer);
  rotFrameTimer = setTimeout(() => setRotFrame(false), 450);
}

// Two-finger twist: starts only after 12 degrees so a plain pinch never turns the map.
// Leaflet's own pinch-zoom keeps running; it reads positions through the patched
// mouseEventToContainerPoint, so it stays correct while the map turns.
function setupTwist() {
  let g = null;
  const ang = ts => Math.atan2(ts[1].clientY - ts[0].clientY, ts[1].clientX - ts[0].clientX) * 180 / Math.PI;
  addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || locked || ![...e.touches].every(t => t.target.closest?.('#map'))) return;
    g = { last: ang(e.touches), twist: 0, on: false, base: nav ? (nav.manual ?? mapRotation) : userRot };
  }, true);
  addEventListener('touchmove', e => {
    if (!g || e.touches.length !== 2) return;
    const a = ang(e.touches);
    g.twist += angleDelta(g.last, a);
    g.last = a;
    if (!g.on) {
      if (Math.abs(g.twist) < 12) return;
      g.on = true;
      // Only switch to the rotatable frame once it's really a twist: swapping it in on every
      // two-finger touch resized the map mid-pinch and made it jump sideways.
      clearTimeout(rotFrameTimer);
      if (!nav) setRotFrame(true);
      document.body.classList.add('twisting');
    }
    const deg = g.base - g.twist;
    if (nav) {
      nav.manual = deg;
      $('#recenterBtn').hidden = false;
      autoRecenter(8000);
    } else userRot = deg;
    rotateMap();
  }, true);
  const end = e => {
    if (!g || e.touches.length >= 2) return;
    const was = g;
    g = null;
    document.body.classList.remove('twisting');
    if (nav || (!was.on && !userRot)) return; // a plain pinch: nothing to undo
    if (Math.abs(angleDelta(0, userRot)) < (was.on ? 6 : 1)) resetNorth(); // snap to north when close
    else rotateMap();
  };
  addEventListener('touchend', end, true);
  addEventListener('touchcancel', end, true);
  map.on('layeradd', counterRotate);
}

function followCamera(fix, st) {
  rotateMap();
  if (!nav.follow) return;
  let z = nav.userZoom ?? map.getZoom();
  if (nav.userZoom == null) {
    // Further out when riding fast, close in just before a turn.
    const kmh = (fix.speed ?? 0) * 3.6;
    z = kmh < 12 ? 17.25 : kmh < 22 ? 16.75 : 16.25;
    if (st?.next && st.distToNext < 150) z = 17.5;
    if (Math.abs(z - map.getZoom()) < 0.3) z = map.getZoom();
  }
  nav.wantZoom = z;
  map.setView(fix.latlng, z, { animate: true });
}

function recenter() {
  if (!nav) return;
  clearTimeout(recenterTimer);
  Object.assign(nav, { follow: true, overview: false, userZoom: null, manual: null });
  $('#recenterBtn').hidden = true;
  if (me) followCamera(me, nav.last);
  else rotateMap();
}

function autoRecenter(ms) {
  clearTimeout(recenterTimer);
  recenterTimer = setTimeout(() => nav && (!nav.follow || nav.manual != null) && recenter(), ms);
}

function showOverview() {
  if (!nav?.route) return;
  setNavOpen(false);
  Object.assign(nav, { follow: false, overview: true, manual: null });
  rotateMap();
  $('#recenterBtn').hidden = false;
  // Fit the route into the part of the (oversized) map you can actually see.
  const el = $('#map'), left = -el.offsetLeft, top = -el.offsetTop;
  const banner = $('#navBanner').getBoundingClientRect(), bar = $('#navBar').getBoundingClientRect();
  const pts = [me?.latlng, ...nav.route.coords].filter(Boolean);
  map.fitBounds(L.latLngBounds(pts), {
    paddingTopLeft: isLand() ? [left + panelW() + 20, top + 20] : [left + 30, top + (banner.bottom || 0) + 20],
    paddingBottomRight: isLand() ? [el.offsetWidth - left - innerWidth + 66, el.offsetHeight - top - innerHeight + 20]
      : [el.offsetWidth - left - innerWidth + 30, el.offsetHeight - top - (bar.top || innerHeight) + 20],
  });
  autoRecenter(20000);
}

// ---- ride details panel (tap the bottom bar)

function toggleNavDetails(open = $('#navDetails').hidden) {
  if (navCtl && $('#navBar').offsetHeight && $('#navDetails').hidden === open) return navCtl.go(!open);
  setNavOpen(open);
}

function setNavOpen(open) {
  $('#navDetails').hidden = !open;
  $('#navToggle').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('nav-details-open', open);
  if (open) renderNavDetails();
  else { $('#stopInput').value = ''; $('#stopInput').blur(); $('#stopResults').hidden = true; }
}

function renderNavDetails() {
  if (!nav || $('#navDetails').hidden) return;
  const rec = nav.recorder;
  $('#ndMoving').textContent = fmtDuration(rec.movingTime);
  $('#ndRidden').textContent = fmtDist(rec.distance);
  $('#ndAvg').textContent = rec.speedKmh ? rec.speedKmh.toFixed(1) : '–';
  for (const id of ['#ndStopBox', '#ndTurns', '#ndTurnsHead', '#ndStops', '#overviewBtn']) $(id).hidden = !!nav.recordOnly;
  if (nav.recordOnly) return;

  const stops = nav.vias.filter(v => v.stop);
  $('#ndStops').innerHTML = stops.map((v, i) => `<div class="list-item"><span class="nd-stop-pin">${i + 1}</span>
    <div class="li-main"><div class="li-title selectable">${esc(v.stop.name)}</div><div class="li-sub">${t('{0} away', fmtDist(Math.max(0, alongRoute(nav.route, v) - nav.along)))}</div></div>
    <button class="icon-btn" data-unstop="${i}" aria-label="Remove stop">✕</button></div>`).join('');
  $('#ndStops').querySelectorAll('[data-unstop]').forEach(b => b.onclick = () => removeStop(stops[+b.dataset.unstop]));

  const { cum, hints } = nav.route;
  const upcoming = hints.filter(h => cum[h.idx] > nav.along + 3 && h.cmd !== 1 && h.cmd !== 13).slice(0, 12);
  $('#ndTurns').innerHTML = upcoming.map(h => `<li>${arrowSvg(h)}<span>${esc(hintText(h))}</span><b>${fmtDist(cum[h.idx] - nav.along)}</b></li>`).join('')
    + `<li>${arrowSvg(null)}<span class="selectable">${esc(nav.dest?.name || t('Destination'))}</span><b>${fmtDist(Math.max(0, nav.route.length - nav.along))}</b></li>`;
}

// ---- add a stop while riding

function setupStopSearch() {
  const input = $('#stopInput'), ul = $('#stopResults');
  let timer, abort, results = [];
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { ul.hidden = true; return; }
    timer = setTimeout(async () => {
      abort?.abort();
      abort = new AbortController();
      try { results = await search(q, me?.latlng, abort.signal); } catch { return; }
      ul.innerHTML = results.map((p, i) => `<li data-i="${i}"><span class="s-icon">📍</span><span class="s-text"><div class="s-name">${esc(p.name)}</div>${p.detail ? `<div class="s-detail">${esc(p.detail)}</div>` : ''}</span></li>`).join('')
        || '<li class="s-head">Nothing found</li>';
      ul.hidden = false;
      ul.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => addStop(results[+li.dataset.i]));
    }, 300);
  });
}

function addStop(place) {
  if (!nav || nav.recordOnly) return;
  setNavOpen(false);
  const p = Object.assign(place.latlng.slice(), { stop: place });
  // Put it in order among the points still ahead, judged by where it meets the route.
  const ahead = nav.vias.filter(v => alongRoute(nav.route, v) > nav.along + 30);
  const at = alongRoute(nav.route, p);
  ahead.splice(ahead.filter(v => alongRoute(nav.route, v) < at).length, 0, p);
  nav.vias = ahead;
  drawNavStops();
  toast(t('Adding a stop at {0}…', place.name));
  reroute(ahead);
}

function removeStop(v) {
  nav.vias = nav.vias.filter(x => x !== v && alongRoute(nav.route, x) > nav.along + 30);
  drawNavStops();
  reroute(nav.vias);
}

function drawNavStops() {
  viaLayer.clearLayers();
  nav?.vias.filter(v => v.stop).forEach((v, i) => L.marker(v, {
    icon: L.divIcon({ className: '', html: `<div class="stop-marker">${i + 1}</div>`, iconSize: [26, 26] }),
    interactive: false,
  }).addTo(viaLayer));
}

function checkStops(fix) {
  for (const v of nav.vias) {
    if (!v.stop || v.reached || dist(fix.latlng, v) > 35) continue;
    v.reached = true;
    toast(t("You've reached {0}", v.stop.name));
    if (S().voice) speak(t('You have reached {0}', v.stop.name));
  }
}

function arrowSvg(h, warn = false) {
  const sw = 'stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  if (warn) return `<svg viewBox="0 0 64 64"><path d="M32 8 L58 54 H6 Z" ${sw}/><path d="M32 26v13M32 46v1" ${sw}/></svg>`;
  if (!h) return `<svg viewBox="0 0 64 64"><path d="M18 58V8" ${sw}/><path d="M20 10h30l-7 9 7 9H20z" fill="currentColor"/></svg>`;
  if (isRoundabout(h)) {
    return `<svg viewBox="0 0 64 64"><circle cx="32" cy="27" r="14" ${sw}/><path d="M32 60V41" ${sw}/>
      <text x="32" y="33" text-anchor="middle" font-size="17" font-weight="800" fill="currentColor" font-family="system-ui">${h.exit || ''}</text></svg>`;
  }
  if (isUturn(h)) return `<svg viewBox="0 0 64 64"><path d="M42 58V26a10 10 0 0 0-20 0v12" ${sw}/><path d="M11 36 L22 50 L33 36 Z" fill="currentColor"/></svg>`;
  let a = h.cmd === 1 || h.cmd === 16 ? 0 : Math.max(-150, Math.min(150, h.angle || 0));
  if (h.cmd === 8 || h.cmd === 17) a = Math.min(a, -25);
  if (h.cmd === 9 || h.cmd === 18) a = Math.max(a, 25);
  const r = a * Math.PI / 180, sx = 32, sy = 34, L1 = 16;
  const ex = sx + Math.sin(r) * L1, ey = sy - Math.cos(r) * L1;
  const tx = ex + Math.sin(r) * 11, ty = ey - Math.cos(r) * 11;
  const px = Math.cos(r) * 10, py = Math.sin(r) * 10;
  return `<svg viewBox="0 0 64 64"><path d="M32 60V${sy} L${ex.toFixed(1)} ${ey.toFixed(1)}" ${sw}/>
    <path d="M${tx.toFixed(1)} ${ty.toFixed(1)} L${(ex + px).toFixed(1)} ${(ey + py).toFixed(1)} L${(ex - px).toFixed(1)} ${(ey - py).toFixed(1)} Z" fill="currentColor"/></svg>`;
}

// ---------------------------------------------------------------- pins

const PIN_EMOJIS = ['📍', '🏠', '🏢', '☕', '🍽️', '🍺', '🛒', '🏪', '🚉', '🅿️', '🚲', '🔧', '⛽', '🚰', '🚻', '🌳', '🏞️', '🏖️', '⛰️', '📸', '🏥', '🏫', '❤️', '⭐'];

function renderPins() {
  if (!pinLayer) return;
  pinLayer.clearLayers();
  for (const p of S().pins.filter(x => x.show)) {
    const m = L.marker(p.latlng, { icon: L.divIcon({ className: '', html: `<div class="pin-marker">${esc(p.emoji)}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }), zIndexOffset: 200 });
    m.on('click', () => openPinPopup(p.id));
    m.addTo(pinLayer);
  }
}

function openPinPopup(id) {
  const p = S().pins.find(x => x.id === id);
  if (!p) return;
  const acts = [
    !nav && ['to', 'Directions to here', 'go'],
    nav && !nav.recordOnly && ['stop', 'Add as stop', 'go'],
    ['edit', 'Edit'], ['del', 'Delete'],
  ].filter(Boolean);
  L.popup({ closeButton: false, offset: [0, -14] }).setLatLng(p.latlng)
    .setContent(`<div class="map-popup"><b class="selectable">${esc(p.emoji)} ${esc(p.name)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}${
      acts.map(([a, label, cls]) => `<button ${cls ? `class="${cls}"` : ''} data-a="${a}">${label}</button>`).join('')}</div>`)
    .openOn(map);
  map.getContainer().querySelectorAll('.leaflet-popup .map-popup button').forEach(b => b.onclick = () => {
    map.closePopup();
    const a = b.dataset.a;
    if (a === 'to') choosePlace('to', { name: p.name, detail: p.note || '', latlng: p.latlng });
    else if (a === 'stop') addStop({ name: p.name, detail: p.note || '', latlng: p.latlng });
    else if (a === 'edit') editPin(p);
    else if (a === 'del') deletePin(p.id);
  });
}

async function deletePin(id) {
  if (!await askConfirm(t('Delete this pin?'), { ok: 'Delete', danger: true })) return;
  store.update(s => { s.pins = s.pins.filter(p => p.id !== id); });
  renderPins();
  if (drawerOpen) renderDrawer();
}

function editPin(pin, fresh) {
  const d = pin || { id: null, name: '', emoji: '📍', note: '', show: true, ...fresh };
  let emoji = d.emoji;
  openDialog(`
    <h2>${pin ? 'Edit pin' : 'Save pin'}</h2>
    <label class="field"><span>Name</span><input type="text" id="pinName" value="${esc(d.name)}" placeholder="${esc(t('Pin'))}" maxlength="60"></label>
    <div class="field"><span>Emoji</span>
      <div class="emoji-grid">${PIN_EMOJIS.map(e => `<button type="button" class="emoji-opt ${e === emoji ? 'selected' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
      <input type="text" id="pinEmoji" value="${esc(emoji)}" placeholder="Any emoji" maxlength="8" class="emoji-input">
    </div>
    <label class="field"><span>Note (optional)</span><input type="text" id="pinNote" value="${esc(d.note)}" maxlength="120"></label>
    <label class="toggle"><span>Show on map</span><input type="checkbox" id="pinShow" ${d.show ? 'checked' : ''}></label>
    <div class="dialog-actions">
      ${pin ? '<button class="secondary-btn" id="pinDel">Delete</button>' : ''}
      <button class="secondary-btn" id="pinCancel">Cancel</button>
      <button class="primary-btn" id="pinSave">Save</button>
    </div>`);
  const box = $('#dialogBody');
  box.querySelectorAll('.emoji-opt').forEach(b => b.onclick = () => {
    $('#pinEmoji').value = emoji = b.dataset.e;
    box.querySelectorAll('.emoji-opt').forEach(x => x.classList.toggle('selected', x === b));
  });
  $('#pinEmoji').oninput = e => { emoji = e.target.value; box.querySelectorAll('.emoji-opt').forEach(x => x.classList.toggle('selected', x.dataset.e === emoji)); };
  $('#pinCancel').onclick = closeDialog;
  if (pin) $('#pinDel').onclick = () => { closeDialog(); deletePin(pin.id); };
  $('#pinSave').onclick = () => {
    const rec = {
      id: d.id || newRideId(),
      name: $('#pinName').value.trim() || t('Pin'),
      emoji: ($('#pinEmoji').value.trim() || '📍'),
      note: $('#pinNote').value.trim(),
      latlng: d.latlng,
      show: $('#pinShow').checked,
    };
    store.update(s => {
      const i = s.pins.findIndex(p => p.id === rec.id);
      if (i >= 0) s.pins[i] = rec; else s.pins.unshift(rec);
    });
    closeDialog();
    renderPins();
    if (drawerOpen) renderDrawer();
    else toast(t('Pin saved'));
  };
}

// ---------------------------------------------------------------- end-of-ride sheet

function openEndSheet() {
  if (!nav || !$('#dialog').hidden) return;
  const rec = nav.recorder;
  const canSave = rec.distance > 150;
  openDialog(`
    <h2>End this ride?</h2>
    <div class="stat-row">
      <div><b>${fmtDist(rec.distance)}</b><span>ridden</span></div>
      <div><b>${fmtDuration(rec.movingTime)}</b><span>moving</span></div>
      <div><b>${rec.speedKmh ? rec.speedKmh.toFixed(1) : '–'}</b><span>km/h avg</span></div>
    </div>
    <div class="end-actions">
      <button class="primary-btn" id="endSave">${canSave ? 'End and save ride' : 'End ride'}</button>
      ${canSave ? '<button class="secondary-btn danger" id="endDiscard">End without saving</button>' : ''}
      <button class="secondary-btn" id="endContinue">Continue riding</button>
    </div>`);
  $('#dialog').classList.add('end-sheet');
  $('#endSave').onclick = () => { closeDialog(); stopNavigation(false); };
  if (canSave) $('#endDiscard').onclick = () => { closeDialog(); stopNavigation(false, true); };
  $('#endContinue').onclick = closeDialog;
}

// ---------------------------------------------------------------- rides

function offerSaveRide(session, arrived) {
  const rec = session.recorder;
  const bike = store.activeBike();
  openDialog(`
    <h2>${arrived ? 'You made it! 🎉' : 'Save this ride?'}</h2>
    <p>${session.sim ? 'This was a simulated demo ride — you probably want to discard it.' : 'Saved rides teach Cycle Nav your favourite ways and your real speed.'}</p>
    <div class="stat-row">
      <div><b>${fmtDist(rec.distance)}</b><span>distance</span></div>
      <div><b>${fmtDuration(rec.movingTime)}</b><span>moving</span></div>
      <div><b>${rec.speedKmh ? rec.speedKmh.toFixed(1) : '–'}</b><span>km/h avg</span></div>
    </div>
    <label class="field"><span>Ridden on</span>
      <select id="saveBike">${S().bikes.map(b => `<option value="${b.id}" ${b.id === bike.id ? 'selected' : ''}>${esc(b.icon)} ${esc(b.name)}</option>`).join('')}</select>
    </label>
    <label class="field"><span>Name (optional)</span>
      <input type="text" id="saveName" placeholder="${esc(session.dest?.name ? t('To {0}', session.dest.name) : t('Ride'))}">
    </label>
    <div class="dialog-actions">
      <button class="secondary-btn" id="discardRide">Discard</button>
      <button class="primary-btn" id="saveRide">Save ride</button>
    </div>`);
  $('#discardRide').onclick = closeDialog;
  $('#saveRide').onclick = async () => {
    const name = $('#saveName').value.trim() || (session.dest?.name ? t('To {0}', session.dest.name) : t('Ride'));
    const ride = rec.toRide(newRideId(), $('#saveBike').value, name);
    if (session.sim) ride.movingTime = 0; // don't learn speed from a simulation
    await store.rides.put(ride);
    closeDialog();
    await reloadRides();
    toast('Ride saved — I’ll remember this way');
  };
}

// ---- follow a GPX route: guide the router along the track with many via points

function pickGpxRoute() {
  pickFiles('.gpx,application/gpx+xml,application/octet-stream', false, files => openGpxRoute(files[0]));
}

async function openGpxRoute(file) {
  let parsed;
  try { parsed = parseGpx(await file.text()); } catch { parsed = { pts: [] }; }
  const track = parsed.pts.map(p => p.latlng);
  if (track.length < 2) { toast('No route or track found in that GPX file'); return; }
  await followTrack(track, parsed.name || file.name.replace(/\.gpx$/i, ''));
}

// Plan a route that sticks to a recorded or imported track.
async function followTrack(track, name) {
  // A guide point every ~400 m keeps the route on the GPX's roads.
  const len = track.reduce((d, p, i) => i ? d + dist(track[i - 1], p) : 0, 0);
  const n = Math.max(1, Math.min(50, Math.round(len / 400)));
  const guide = resample(track, len / (n + 1)).slice(1, n + 1).map(p => Object.assign([p[0], p[1]], { gpx: true }));

  const start = Object.assign(track[0].slice(), { gpx: true });
  // From where you are now, first ride to the start of the track (unless you're already there).
  const fromMe = me && dist(me.latlng, track[0]) > 150;
  from = me ? ME : { name: t('Start of {0}', name), detail: 'GPX', latlng: track[0] };
  to = { name, detail: t('End of GPX route'), latlng: track[track.length - 1] };
  vias = fromMe ? [start, ...guide] : guide;
  gpxRoute = { name, vias: vias.slice() };
  syncInputs();
  toast(t('Following {0} ({1})', name, fmtDist(len)));
  await planRoute();
}

// A ride as a GPX track (with timestamps when it was really ridden).
function toGpx(ride) {
  const x = s => esc(s);
  const pts = ride.points.map(p => {
    const time = p[2] != null && ride.source !== 'planned' ? `<time>${new Date(ride.startedAt + p[2] * 1000).toISOString()}</time>` : '';
    return `<trkpt lat="${p[0]}" lon="${p[1]}">${time}</trkpt>`;
  }).join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cycle Nav" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(ride.name || 'Ride')}</name><time>${new Date(ride.startedAt).toISOString()}</time></metadata>
  <trk>
    <name>${x(ride.name || 'Ride')}</name>
    <type>cycling</type>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const pts = [...doc.querySelectorAll('trkpt, rtept')].map(el => ({
    latlng: [+el.getAttribute('lat'), +el.getAttribute('lon')],
    time: Date.parse(el.querySelector('time')?.textContent || '') || null,
  })).filter(p => Number.isFinite(p.latlng[0]) && Number.isFinite(p.latlng[1]));
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim();
  return { pts, name };
}

async function importGpx(files) {
  const bike = store.activeBike();
  let ok = 0;
  for (const file of files) {
    try {
      const { pts, name } = parseGpx(await file.text());
      if (pts.length < 2) continue;
      const rec = new Recorder();
      const timed = pts.every(p => p.time);
      let t = timed ? pts[0].time : Date.now();
      rec.startedAt = t;
      for (let i = 0; i < pts.length; i++) {
        if (timed) t = pts[i].time;
        else if (i) t += dist(pts[i - 1].latlng, pts[i].latlng) / (bike.speed / 3.6) * 1000;
        rec.add(pts[i].latlng, 5, t);
      }
      const ride = rec.toRide(newRideId(), bike.id, name || file.name.replace(/\.gpx$/i, ''));
      ride.endedAt = t;
      ride.source = 'gpx';
      if (!timed) ride.movingTime = 0; // no real timing info, don't learn speed from it
      await store.rides.put(ride);
      ok++;
    } catch { /* skip broken file */ }
  }
  await reloadRides();
  toast(ok ? t('Imported {0} rides for {1}', ok, bike.name) : t('No usable GPX tracks found'));
}

function showRiddenRoads(on) {
  rideLayer?.remove();
  rideLayer = null;
  if (!on) return;
  rideLayer = L.layerGroup(rideList.map(r => L.polyline(r.points, {
    color: S().bikes.find(b => b.id === r.bikeId)?.color || S().theme.accent,
    weight: 4, opacity: .45, interactive: false,
  }))).addTo(map);
}

// ---------------------------------------------------------------- bikes

function renderBikeChip() {
  const b = store.activeBike();
  const sp = bikeSpeed(b, rideList);
  $('#bikeChip').innerHTML = `<span class="bike-badge" style="--bike:${esc(b.color)}">${esc(b.icon)}</span>
    <span class="chip-text"><span class="chip-name">${esc(b.name)}</span><small>${sp.kmh.toFixed(1)} km/h · ${t(ROUTE_STYLES[b.style]?.label || 'Calm')}</small></span>`;
  if (S().theme.marker === 'bike') drawMe(true);
}

function toggleBikeMenu() {
  const menu = $('#bikeMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  const chip = $('#bikeChip').getBoundingClientRect();
  menu.style.top = `${chip.bottom + 8}px`;
  menu.innerHTML = S().bikes.map(b => `
    <button data-id="${b.id}" class="${b.id === S().activeBikeId ? 'current' : ''}">
      <span class="bike-badge" style="--bike:${esc(b.color)}">${esc(b.icon)}</span>
      <span><b>${esc(b.name)}</b><small>${bikeSpeed(b, rideList).kmh.toFixed(1)} km/h · ${esc(t(BIKE_TYPES[b.type]?.label || ''))}</small></span>
    </button>`).join('') + '<button data-manage="1"><span class="bike-badge" style="--bike:var(--muted)">＋</span><span><b>Manage bikes</b></span></button>';
  menu.hidden = false;
  menu.querySelectorAll('button').forEach(btn => btn.onclick = () => {
    menu.hidden = true;
    if (btn.dataset.manage) return openSettings('bikes');
    setActiveBike(btn.dataset.id);
  });
}

function setActiveBike(id) {
  const changed = id !== S().activeBikeId;
  store.update(s => { s.activeBikeId = id; });
  renderBikeChip();
  if (changed && to && !nav) planRoute();
}

function editBike(bikeId) {
  const isNew = !bikeId;
  const bike = isNew ? newBike({ name: '', color: ACCENTS[S().bikes.length % ACCENTS.length] }) : { ...S().bikes.find(b => b.id === bikeId) };
  const sp = bikeSpeed(bike, rideList);
  const render = () => {
    openDialog(`
      <h2>${isNew ? 'Add a bike' : 'Edit bike'}</h2>
      <label class="field"><span>Name</span><input type="text" id="bName" value="${esc(bike.name)}" placeholder="e.g. Gazelle, Road bike, Bakfiets"></label>
      <div class="field"><span>Icon</span><div class="choices">${BIKE_ICONS.map(i => `<button class="choice emoji-choice ${i === bike.icon ? 'selected' : ''}" data-icon="${i}">${i}</button>`).join('')}</div></div>
      <div class="field"><span>Colour</span><div class="choices">${ACCENTS.map(c => `<button class="swatch ${c === bike.color ? 'selected' : ''}" style="background:${c}" data-color="${c}" aria-label="${c}"></button>`).join('')}
        <label class="swatch swatch-custom ${ACCENTS.includes(bike.color) ? '' : 'selected'}" title="Custom colour"><input type="color" id="bColor" value="${esc(bike.color)}"></label></div></div>
      <label class="field"><span>Type</span><select id="bType">${Object.entries(BIKE_TYPES).map(([k, t]) => `<option value="${k}" ${k === bike.type ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
      <div class="field"><span>Route style</span><div class="choices">${Object.entries(ROUTE_STYLES).map(([k, s]) => `<button class="choice ${k === bike.style ? 'selected' : ''}" data-style="${k}">${s.label}<small>${s.desc}</small></button>`).join('')}</div></div>
      <label class="field"><span>Average speed (km/h)</span><input type="number" id="bSpeed" min="5" max="45" step="0.5" value="${bike.speed}"></label>
      <p class="hint" style="margin-top:-8px">${sp.learned ? t('Learned from your last {0} rides: {1} km/h. Arrival times use {2} km/h.', sp.rides, `<b>${sp.learned.toFixed(1)}</b>`, sp.kmh.toFixed(1)) : 'Used for arrival times until Cycle Nav has learned your real pace from a few saved rides.'}</p>
      <label class="toggle"><span>Avoid unnecessary climbing</span><input type="checkbox" id="bHills" ${bike.avoidHills ? 'checked' : ''}></label>
      ${bike.style === 'offroad' ? '' : `<label class="toggle"><span>Paved roads only (no gravel or dirt)</span><input type="checkbox" id="bPaved" ${bike.avoidUnpaved ? 'checked' : ''}></label>`}
      <div class="dialog-actions">
        ${!isNew && S().bikes.length > 1 ? '<button class="secondary-btn text-danger" id="bDelete" style="margin-right:auto">Remove</button>' : ''}
        <button class="secondary-btn" id="bCancel">Cancel</button>
        <button class="primary-btn" id="bSave">Save</button>
      </div>`);
    const body = $('#dialogBody');
    const keep = () => { bike.name = $('#bName').value; bike.speed = +$('#bSpeed').value || bike.speed; bike.avoidHills = $('#bHills').checked; if ($('#bPaved')) bike.avoidUnpaved = $('#bPaved').checked; };
    body.querySelectorAll('[data-icon]').forEach(b => b.onclick = () => { keep(); bike.icon = b.dataset.icon; render(); });
    body.querySelectorAll('[data-color]').forEach(b => b.onclick = () => { keep(); bike.color = b.dataset.color; render(); });
    body.querySelectorAll('[data-style]').forEach(b => b.onclick = () => { keep(); bike.style = b.dataset.style; render(); });
    $('#bColor').onchange = e => { keep(); bike.color = e.target.value; render(); };
    $('#bType').onchange = e => {
      keep();
      const prev = BIKE_TYPES[bike.type];
      bike.type = e.target.value;
      if (bike.speed === prev.speed) bike.speed = BIKE_TYPES[bike.type].speed;
      bike.avoidHills = bike.type !== 'ebike';
      bike.avoidUnpaved = bike.type === 'road';
      if (bike.type === 'mtb') bike.style = 'offroad';
      else if (bike.style === 'offroad') bike.style = 'calm';
      render();
    };
    $('#bCancel').onclick = closeDialog;
    $('#bDelete') && ($('#bDelete').onclick = async () => {
      if (!await askConfirm(t('Remove {0}? Its rides stay saved.', bike.name), { ok: 'Remove', danger: true })) return;
      store.update(s => {
        s.bikes = s.bikes.filter(b => b.id !== bike.id);
        if (s.activeBikeId === bike.id) s.activeBikeId = s.bikes[0].id;
      });
      closeDialog(); renderBikeChip(); openSettings('bikes');
    });
    $('#bSave').onclick = () => {
      keep();
      bike.name = bike.name.trim() || t('My bike');
      store.update(s => {
        if (isNew) { s.bikes.push(bike); s.activeBikeId = bike.id; }
        else s.bikes = s.bikes.map(b => b.id === bike.id ? bike : b);
      });
      closeDialog(); renderBikeChip(); openSettings('bikes');
      if (to && !nav) planRoute();
    };
  };
  render();
}

// ---------------------------------------------------------------- settings

let currentTab = 'bikes';
function openSettings(tab = currentTab) {
  currentTab = tab;
  $('#settings').hidden = false;
  $('#bikeMenu').hidden = true;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('#settingsBody');
  body.innerHTML = ({ bikes: bikesTab, look: lookTab, more: moreTab })[tab]();
  wireSettings(tab, body);
}

function closeSettings() { $('#settings').hidden = true; }

function bikesTab() {
  return `<div class="section"><h3>Your bikes</h3>
    ${S().bikes.map(b => {
      const sp = bikeSpeed(b, rideList);
      return `<div class="list-item">
        <span class="bike-badge" style="--bike:${esc(b.color)}">${esc(b.icon)}</span>
        <div class="li-main"><div class="li-title">${esc(b.name)} ${b.id === S().activeBikeId ? '<span class="tag">riding</span>' : ''}</div>
          <div class="li-sub">${esc(t(BIKE_TYPES[b.type]?.label))} · ${t('{0} routes', t(ROUTE_STYLES[b.style]?.label))} · ${sp.kmh.toFixed(1)} km/h${sp.learned ? ` ${t('(learned from {0} rides)', sp.rides)}` : ''}</div></div>
        ${b.id !== S().activeBikeId ? `<button class="secondary-btn" data-use="${b.id}">Use</button>` : ''}
        <button class="secondary-btn" data-edit="${b.id}">Edit</button>
      </div>`;
    }).join('')}
    <div class="btn-row"><button class="primary-btn" id="addBike">Add a bike</button></div>
    <p class="hint">Each bike has its own route style and speed. Ride with it and save the ride, and its speed adjusts to how fast you really go.</p>
  </div>`;
}

function lookTab() {
  const t = S().theme;
  return `<div class="section"><h3>Appearance</h3>
      <div class="choices">${['auto', 'light', 'dark'].map(m => `<button class="choice ${t.mode === m ? 'selected' : ''}" data-mode="${m}">${{ auto: 'Automatic', light: 'Light', dark: 'Dark' }[m]}</button>`).join('')}</div>
    </div>
    <div class="section"><h3>Accent colour</h3>
      <div class="choices">${ACCENTS.map(c => `<button class="swatch ${c === t.accent ? 'selected' : ''}" style="background:${c}" data-accent="${c}" aria-label="${c}"></button>`).join('')}
        <label class="swatch swatch-custom ${ACCENTS.includes(t.accent) ? '' : 'selected'}" title="Custom colour"><input type="color" id="accentPicker" value="${t.accent}"></label></div>
    </div>
    <div class="section"><h3>Map</h3>
      <label class="field"><select id="mapStyle">${Object.entries(MAP_STYLES).map(([k, s]) => `<option value="${k}" ${k === t.mapStyle ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    </div>
    <div class="section"><h3>Your position on the map</h3>
      <div class="choices">${Object.entries(MARKERS).map(([k, l]) => `<button class="choice ${t.marker === k ? 'selected' : ''}" data-marker="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="section"><h3>App icon</h3>
      <div class="choices">${Object.entries(APP_ICONS).map(([k, l]) => `<button class="choice icon-choice ${t.appIcon === k ? 'selected' : ''}" data-icon-kind="${k}" title="${l}">${iconSvg(k, t.accent, 52)}</button>`).join('')}</div>
      <p class="hint">Used for the browser tab and when you add Cycle Nav to your home screen (re-add it to pick up a new icon).</p>
    </div>`;
}

function moreTab() {
  const km = rideList.reduce((s, r) => s + r.distance, 0) / 1000;
  return `<div class="section"><h3>Language</h3>
      <div class="choices">${Object.entries(LANGUAGES).map(([k, l]) => `<button class="choice ${language() === k ? 'selected' : ''}" data-lang="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="section"><h3>Offline maps</h3><div id="offlineBox"></div></div>
    <div class="section"><h3>Navigation</h3>
      <label class="toggle"><span>Spoken directions</span><input type="checkbox" id="optVoice" ${S().voice ? 'checked' : ''}></label>
      <label class="toggle"><span>${t('Announce traffic lights ahead')}</span><input type="checkbox" id="optLightHint" ${S().lightHint ? 'checked' : ''}></label>
      <div class="field"><span>Map while navigating</span><div class="choices">${Object.entries(ORIENTATIONS).map(([k, o]) => `<button class="choice ${S().orientation === k ? 'selected' : ''}" data-orient="${k}">${o.label}<small>${o.desc}</small></button>`).join('')}</div></div>
      <label class="toggle"><span>${t('Ride weather advice')}</span><input type="checkbox" id="optWx" ${wxOn() ? 'checked' : ''}></label>
      <label class="toggle"><span>${t('3D buildings and view')}</span><input type="checkbox" id="optView3d" ${S().view3d !== false ? 'checked' : ''}></label>
      <label class="toggle"><span>Demo mode (simulate riding the route)</span><input type="checkbox" id="optDemo" ${S().demo ? 'checked' : ''}></label>
      <p class="hint">Demo mode lets you try navigation at your desk. Simulated rides can still be saved, so discard them.</p>
    </div>
    <div class="section"><h3>Memory</h3>
      <div class="stat-row"><div><b>${rideList.length}</b><span>rides</span></div><div><b>${km.toFixed(km < 100 ? 1 : 0)}</b><span>km remembered</span></div></div>
      <label class="toggle"><span>Show my ridden roads on the map</span><input type="checkbox" id="showRidden" ${rideLayer ? 'checked' : ''}></label>
      <p class="hint">When you plan a trip you’ve ridden before, Cycle Nav offers “Your usual way”, and it prefers routes over roads you know.</p>
      <div class="btn-row"><button class="secondary-btn" id="importGpx">Import GPX rides</button><button class="secondary-btn" id="followGpx">Navigate a GPX route</button></div>
      <p class="hint">Got rides in Strava, Garmin or Komoot? Export them as GPX and import them here to teach Cycle Nav your routes right away. Your saved pins, routes and rides live in the Saved drawer (bookmark button).</p>
    </div>
    <div class="section"><h3>Your data</h3>
      <p class="hint" style="margin-top:0">Bikes, settings and rides are stored only on this device.</p>
      <div class="btn-row"><button class="secondary-btn" id="exportData">Export backup</button><button class="secondary-btn" id="importData">Restore backup</button></div>
    </div>
    <div class="section"><h3>About</h3>
      <p class="hint" style="margin-top:0">Map data © OpenStreetMap contributors. Routing by BRouter with a custom “calm” profile that prefers bike paths and straightforward roads and penalises turns and residential shortcuts. Search by Photon.</p>
    </div>`;
}

function wireSettings(tab, body) {
  const on = (sel, ev, fn) => body.querySelectorAll(sel).forEach(el => el[ev] = fn);
  const setTheme = patch => {
    store.update(s => Object.assign(s.theme, patch));
    applyTheme(S().theme);
    if ('mapStyle' in patch || 'mode' in patch) setTiles();
    if ('marker' in patch || 'accent' in patch) drawMe(true);
    if ('accent' in patch && options.length) drawRoutes(!!nav);
    openSettings('look');
  };
  if (tab === 'bikes') {
    on('[data-edit]', 'onclick', e => editBike(e.currentTarget.dataset.edit));
    on('[data-use]', 'onclick', e => { setActiveBike(e.currentTarget.dataset.use); openSettings('bikes'); });
    on('#addBike', 'onclick', () => editBike(null));
  }
  if (tab === 'look') {
    on('[data-mode]', 'onclick', e => setTheme({ mode: e.currentTarget.dataset.mode }));
    on('[data-accent]', 'onclick', e => setTheme({ accent: e.currentTarget.dataset.accent }));
    on('#accentPicker', 'onchange', e => setTheme({ accent: e.target.value }));
    on('#mapStyle', 'onchange', e => setTheme({ mapStyle: e.target.value }));
    on('[data-marker]', 'onclick', e => setTheme({ marker: e.currentTarget.dataset.marker }));
    on('[data-icon-kind]', 'onclick', e => setTheme({ appIcon: e.currentTarget.dataset.iconKind }));
  }
  if (tab === 'more') {
    on('#showRidden', 'onchange', e => showRiddenRoads(e.target.checked));
    on('#followGpx', 'onclick', () => { closeSettings(); pickGpxRoute(); });
    on('#importGpx', 'onclick', () => importGpxFiles());
    on('#optVoice', 'onchange', e => store.update(s => { s.voice = e.target.checked; }));
    on('#optLightHint', 'onchange', e => store.update(s => { s.lightHint = e.target.checked; }));
    on('#optWx', 'onchange', e => { store.update(s => { s.wx = e.target.checked; }); wxUpdate(); });
    on('#optView3d', 'onchange', e => { store.update(s => { s.view3d = e.target.checked; }); if (nav) setNavFrame(true); else syncGL(); });
    on('#optDemo', 'onchange', e => store.update(s => { s.demo = e.target.checked; }));
    on('[data-lang]', 'onclick', e => {
      const lang = e.currentTarget.dataset.lang;
      if (lang === language()) return;
      store.update(s => { s.lang = lang; });
      location.reload(); // simplest way to redraw every bit of text
    });
    on('[data-orient]', 'onclick', e => { store.update(s => { s.orientation = e.currentTarget.dataset.orient; }); openSettings('more'); });
    renderOffline();
    on('#exportData', 'onclick', exportData);
    on('#importData', 'onclick', () => pickFiles('.json,application/json', false, files => importData(files[0])));
  }
}

// ---------------------------------------------------------------- saved drawer (pins, routes, rides)

let drawerTab = 'pins', drawerQuery = '', drawerOpen = false, drawerHideTimer = 0, drawerPos = 0;
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

function renderDrawer() {
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
    html = items.map(p => row(p.id, `<span class="srow-ic">${esc(p.emoji)}</span>`, p.name,
      [me ? esc(t('{0} from you', fmtDist(dist(me.latlng, p.latlng)))) : '', esc(p.note || '')].filter(Boolean).join(' · ') || esc(t('Pin')),
      (navStop ? act('stop', '＋ ' + t('Add as stop'), 'go') : nav ? '' : act('to', '➜ ' + t('Directions to here'), 'go')) +
      act('show', p.show ? '👁' : '🚫', 'ic ' + (p.show ? 'on' : ''), p.show ? t('Shown on map') : t('Hidden on map')) +
      act('edit', '✎', 'ic', t('Edit')) + act('del', '🗑', 'ic danger', t('Delete')))).join('');
  } else {
    html = items.map(r => {
      const b = S().bikes.find(x => x.id === r.bikeId);
      const badge = `<span class="srow-ic" style="--bike:${esc(b?.color || '#888')}">${esc(b?.icon || '🚲')}</span>`;
      const speed = tab === 'rides' && r.movingTime ? ` · ${(r.distance / r.movingTime * 3.6).toFixed(1)} km/h` : '';
      return row(r.id, badge, r.name || t('Ride'), `${esc(fmtDist(r.distance))} · ${esc(dFmtDate(r.startedAt))}${speed}`,
        (nav ? '' : act('ride', '▶ ' + t('Ride it'), 'go')) + act('rename', '✎', 'ic', t('Rename')) + act('gpx', 'GPX', '', t('Export GPX')) + act('del', '🗑', 'ic danger', t('Delete')));
    }).join('');
  }
  if (!items.length) {
    const hint = total ? t('Nothing found') : ({
      pins: t('No pins yet. Long-press the map, or tap the pin icon in a search result, to save a place.'),
      routes: t('No saved routes yet. Plan a route and tap the bookmark button to keep it here.'),
      rides: t('No rides yet. Navigate somewhere, or tap the red record button and ride your favourite way.'),
    })[tab];
    html = `<div class="drawer-empty"><div class="de-ic">${total ? '🔍' : { pins: '📍', routes: '🗺️', rides: '🚲' }[tab]}</div><p>${esc(hint)}</p></div>`;
  }
  $('#drawerList').innerHTML = html;
  $('#drawerSearch').placeholder = t('Search saved');
  $('#drawerSearchBox').hidden = !total;
  $('#drawerFoot').innerHTML = tab === 'pins'
    ? `<button class="secondary-btn" data-f="here">📌 ${esc(t('Save my location'))}</button>`
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
function closeDrawer() {
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
function importGpxFiles() {
  pickFiles('.gpx,application/gpx+xml', true, async files => { await importGpx(files); renderDrawer(); if (!$('#settings').hidden && currentTab === 'more') openSettings('more'); });
}

async function drawerAction(id, a) {
  const pin = S().pins.find(p => p.id === id), ride = rideList.find(r => r.id === id);
  if (pin) {
    const place = { name: pin.name, detail: pin.note || '', latlng: pin.latlng };
    if (a === 'open') {
      if (nav) {
        if (nav.recordOnly) return;
        if (await askConfirm(t('Add {0} as a stop?', `${pin.emoji} ${pin.name}`), { ok: 'Add as stop' })) { closeDrawer(); addStop(place); }
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
    else if (a === 'ride') { closeDrawer(); await followTrack(ride.points.map(p => [p[0], p[1]]), ride.name || t('Ride')); }
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

function setupDrawer() {
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

// ---------------------------------------------------------------- offline maps

let offJob = null;   // { cancel, label, pct } while a download runs
const MB = b => b > 0 ? Math.max(1, Math.round(b / 1e6)) : 0;
const SEG_BYTES = 180e6;

async function renderOffline() {
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
let picking = false, pickRect = null, pickLayer = null, pickSegs = new Set(), pickTimer = 0, pickGeoTimer = 0, pickTok = 0;
const PICK_MIN = 80, PICK_MAX_BYTES = 1.5e9, PICK_MAX_TILES = 150000;
let pickState = null;   // { bounds, name, ok }

async function openPicker() {
  if (offJob) { toast('A download is already running'); return; }
  closeSettings();
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

function closePicker() {
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
function defaultPickRect() {
  const a = pickArea(), aw = a.x1 - a.x0, ah = isLand() ? a.y1 : a.y1 - 0;
  const sheetH = $('#pickSheet').offsetHeight || 170;
  const availH = isLand() ? ah : innerHeight - sheetH, mw = aw * 0.1, mh = availH * 0.1;
  return { l: a.x0 + mw, t: Math.max(mh, 24), r: a.x1 - mw - (isLand() ? 56 : 0), b: availH - mh - (isLand() ? 8 : 24) };
}

function layoutPick() {
  const f = $('#pickFrame').style, r = pickRect;
  f.left = r.l + 'px'; f.top = r.t + 'px'; f.width = (r.r - r.l) + 'px'; f.height = (r.b - r.t) + 'px';
}

function pickBounds() {
  const mr = $('#map').getBoundingClientRect(), r = pickRect;
  const nw = map.containerPointToLatLng([r.l - mr.left, r.t - mr.top]), se = map.containerPointToLatLng([r.r - mr.left, r.b - mr.top]);
  return L.latLngBounds([se.lat, nw.lng], [nw.lat, se.lng]);
}

function schedulePick() {
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

(function wirePicker() {
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
})();

function updateOfflineChip() {
  const el = $('#offlineChip');
  if (!el) return;
  const off = offline.isOffline();
  el.hidden = !off;
  if (off) el.textContent = routingMode() === 'none' ? t('Offline – no routing data here') : t('Offline – using downloaded map');
}
offline.onOfflineChange(updateOfflineChip);
window.addEventListener('offline', updateOfflineChip);
window.addEventListener('online', updateOfflineChip);
updateOfflineChip();

function pickFiles(accept, multiple, cb) {
  const input = $('#fileInput');
  input.accept = accept;
  input.multiple = multiple;
  input.value = '';
  input.onchange = () => input.files.length && cb([...input.files]);
  input.click();
}

async function exportData() {
  const { view, ...settings } = S();
  const json = JSON.stringify({ app: 'cycle-nav', version: 1, settings, rides: rideList });
  try {
    await saveFile(`cycle-nav-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json');
  } catch {
    toast('Could not export the backup');
  }
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'cycle-nav') throw new Error();
    if (!await askConfirm(t('Restore {0} bikes and {1} rides? This replaces what’s on this device.', data.settings.bikes.length, data.rides.length), { ok: 'Restore', danger: true })) return;
    store.replaceAll(data.settings);
    await store.rides.clear();
    for (const r of data.rides) await store.rides.put(r);
    await reloadRides();
    applyTheme(S().theme); setTiles(); drawMe(true); renderBikeChip();
    openSettings('more');
    toast('Backup restored');
  } catch {
    toast('That file is not a Cycle Nav backup');
  }
}

// ---------------------------------------------------------------- dialog & toast

// Android back button: close whatever is on top; never quit in the middle of a ride.
function handleBack() {
  if (locked) return true;
  if (picking) { closePicker(); return true; }
  if (askState) { askClose(null); return true; }
  if (drawerOpen) { closeDrawer(); return true; }
  if (!$('#dialog').hidden) { closeDialog(); return true; }
  if (!$('#settings').hidden) { closeSettings(); return true; }
  if (!$('#bikeMenu').hidden) { $('#bikeMenu').hidden = true; return true; }
  if (!$('#suggestions').hidden) { hideSuggestions(); document.activeElement?.blur(); return true; }
  if (nav) { openEndSheet(); return true; }
  if (to) { $('#clearBtn').click(); return true; }
  return false;
}

// In-app replacements for confirm() / prompt(): promise-based, back button or tap outside = cancel.
let askState = null;
function askOpen({ title, text, input, ok = 'OK', cancel = 'Cancel', danger = false }) {
  if (askState) askClose(null);
  const box = $('#ask');
  $('#askTitle').textContent = title || '';
  $('#askTitle').hidden = !title;
  $('#askText').textContent = text || '';
  $('#askText').hidden = !text;
  const inp = $('#askInput');
  inp.hidden = !input;
  if (input) { inp.value = input.value || ''; inp.placeholder = input.placeholder || ''; inp.maxLength = input.maxLength || 80; }
  $('#askOk').textContent = ok;
  $('#askOk').className = danger ? 'danger-btn' : 'primary-btn';
  $('#askCancel').textContent = cancel;
  $('#askCancel').hidden = !cancel;
  box.hidden = false;
  return new Promise(resolve => {
    askState = { resolve, input: !!input };
    setTimeout(() => (input ? inp : $('#askOk')).focus({ preventScroll: true }), 30);
  });
}
function askClose(ok) {
  const st = askState;
  if (!st) return;
  askState = null;
  $('#ask').hidden = true;
  st.resolve(ok ? (st.input ? $('#askInput').value.trim() : true) : (st.input ? null : false));
}
const askConfirm = (text, o = {}) => askOpen({ text, ...o });
const askText = (text, o = {}) => askOpen({ text, input: { value: o.value, placeholder: o.placeholder, maxLength: o.maxLength }, ...o });
$('#askOk').onclick = () => askClose(true);
$('#askCancel').onclick = () => askClose(false);
$('#ask').addEventListener('click', e => { if (e.target.id === 'ask') askClose(false); });
$('#ask').addEventListener('keydown', e => {
  if (e.key === 'Escape') askClose(false);
  else if (e.key === 'Enter' && e.target.id === 'askInput') askClose(true);
});

function openDialog(html) {
  $('#dialog').classList.remove('end-sheet');
  $('#dialogBody').innerHTML = html;
  $('#dialog').hidden = false;
}
function closeDialog() { $('#dialog').hidden = true; $('#dialog').classList.remove('end-sheet'); }
$('#dialog').addEventListener('click', e => { if (e.target.id === 'dialog') closeDialog(); });
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings') closeSettings(); });

let toastTimer;
// Web only: full screen (the Android app already is). iPhone Safari can't, so explain the home-screen way.
function setupFullscreen() {
  if (isNative || matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  const can = document.fullscreenEnabled || document.webkitFullscreenEnabled;
  document.querySelectorAll('.fsBtn').forEach(b => {
    b.hidden = false;
    b.onclick = () => {
      if (!can) return toast(t('For full screen: tap Share, then “Add to Home Screen”'));
      const el = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch?.(() => {});
    };
  });
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------------------------------------------------------------- lock mode

function lockScreen() {
  locked = true;
  document.body.classList.add('locked');
  $('#lock').hidden = false;
  $('#lock').focus({ preventScroll: true });
  setKnob(0);
  document.activeElement?.blur?.();
  toast('Screen locked');
}

function unlockScreen() {
  locked = false;
  document.body.classList.remove('locked');
  $('#lock').hidden = true;
}

function setKnob(x) { $('.lock-knob').style.transform = `translateX(${x}px)`; }

// The overlay swallows everything; only dragging the knob to the end unlocks.
function setupLock() {
  const lock = $('#lock'), knob = $('.lock-knob'), track = $('.lock-track');
  let drag = null;
  const range = () => track.clientWidth - knob.offsetWidth - 8;
  for (const type of ['click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'wheel', 'pointerdown']) {
    lock.addEventListener(type, e => { if (e.cancelable) e.preventDefault(); e.stopPropagation(); }, { passive: false });
  }
  knob.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, id: e.pointerId };
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('dragging');
  });
  knob.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    setKnob(Math.max(0, Math.min(range(), e.clientX - drag.x)));
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const x = Math.max(0, Math.min(range(), e.clientX - drag.x));
    drag = null;
    knob.classList.remove('dragging');
    if (e.type === 'pointerup' && x / range() >= 0.9) unlockScreen();
    else setKnob(0);
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  addEventListener('keydown', e => { if (locked) { e.preventDefault(); e.stopPropagation(); } }, true);
}
