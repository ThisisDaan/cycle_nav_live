import * as store from './store.js';
import { iconOrEmoji } from './icons.js';
import { t } from './i18n.js';
import { bearing, dist } from './geo.js';
import { map, mapRotation, resetNorth, rotateMap, setRotFrame, setUserRot, userRot, zoomBoost } from './mapview.js';
import { nav, onNavFix } from './navigation.js';
import { picking } from './offlineui.js';
import { to } from './planner.js';
import { options, pendingPlan, planRoute, setPendingPlan } from './routing-ui.js';
import { $, esc, S, toast } from './ui.js';
import { wxUpdate } from './wxui.js';

export let meMarker;

let accuracyCircle;
export let me = null;               // last fix: { latlng, accuracy, heading, speed, time }
let lastMovedFrom = null;    // for computing heading when the GPS doesn't give one
let compass = null;          // smoothed compass heading (degrees), when the phone has one
let shownRotation = 0;       // marker rotation, kept continuous so it never spins the long way round

// Follow mode outside navigation: 0 off, 1 follow north-up, 2 follow with heading up.
const LOCATE_ICONS = {
  0: '<path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>',
  1: '<path fill="currentColor" d="M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm8.94 5A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>',
  2: '<path fill="currentColor" d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7z"/>',
};
export const fol = { mode: 0, paused: false, resume: 1, heading: 2, course: null, fastSince: 0, touched: 0, userZoom: null, wantZoom: null, toasted: false };

// ---------------------------------------------------------------- GPS & position marker

// var, not let: startGps runs from init() before the module reaches this line
var gpsWatch = null, lastFixAt = 0, watchStartedAt = 0, fixErrorShown = false;
export function startGps() {
  if (!('geolocation' in navigator)) { toast('This device has no location support'); return; }
  watchGps();
  // Phones (iPhone Safari especially) silently stop a location watch after a timeout or when the
  // screen was off. If fixes stop coming, or we come back to the app after a while, start it again.
  // A cold GPS can take a while for its first fix, so give a fresh watch 45 s before restarting it.
  const stale = () => Date.now() - Math.max(lastFixAt, watchStartedAt) > (lastFixAt ? 20000 : 45000);
  setInterval(() => { if (!document.hidden && stale()) watchGps(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && lastFixAt && Date.now() - lastFixAt > 10000) watchGps(); });
}

function watchGps() {
  watchStartedAt = Date.now();
  if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = navigator.geolocation.watchPosition(pos => {
    lastFixAt = Date.now();
    if (nav?.sim) return; // the simulator is driving
    try { handleFix({
      latlng: [pos.coords.latitude, pos.coords.longitude],
      accuracy: pos.coords.accuracy,
      heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
      time: pos.timestamp,
    }); } catch (e) {
      // never let one bad fix freeze the position: log it and keep taking fixes
      console.error(e);
      if (!fixErrorShown) { fixErrorShown = true; toast(t('Something went wrong, still following your location')); }
    }
  }, err => {
    if (err.code === err.PERMISSION_DENIED) toast('Location is off — type a start point, or allow location access');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

// accelerometer: when did the phone last move? (a phone on a desk or in a still hand barely registers)
let motionAt = 0, shakeAt = 0, lastG = null;
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const now = Date.now();
  if (lastG && Math.hypot(g.x - lastG.x, g.y - lastG.y, g.z - lastG.z) > 0.6) shakeAt = now;
  lastG = { x: g.x, y: g.y, z: g.z };
  motionAt = now;
}
function phoneStill() {
  const now = Date.now();
  return now - motionAt < 2000 && now - shakeAt > 4000;
}

export function handleFix(fix) {
  const first = !me;
  // Standing still, GPS wanders (indoors by tens of metres, with made-up speeds too): keep the arrow
  // put until we're clearly moving or the fix lands well outside the error circle. When the motion
  // sensor says the phone isn't moving at all, hold on much harder. A clearly sharper fix still wins.
  if (!first) {
    const d = dist(me.latlng, fix.latlng), acc = fix.accuracy || 20, still = phoneStill();
    const moving = !still && fix.speed != null && fix.speed >= 1.5 && acc <= 25;
    const r = still ? Math.max(30, Math.min(80, acc * 1.5)) : Math.max(8, Math.min(50, acc));
    const sharper = acc < (me.accuracy || 99) * 0.5;
    if (!moving && !sharper && d < r) fix = { ...fix, latlng: me.latlng, heading: me.heading, accuracy: me.accuracy };
  }
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
  if (pendingPlan) { setPendingPlan(false); planRoute(); }
  if (nav) onNavFix(fix);
  else followStep(fix);
}

// ---- follow mode (no navigation): the map keeps you centred, like Google Maps

export function updateLocateBtn() {
  const m = fol.paused ? 0 : fol.mode, b = $('#locateBtn');
  b.querySelector('svg').innerHTML = LOCATE_ICONS[m];
  b.classList.toggle('active', m > 0);
  const label = t(['Centre on me', 'Following you', 'Following you, heading up'][m]);
  b.title = label; b.setAttribute('aria-label', label);
}

export function setFollow(mode) {
  if (nav) return;
  const was = fol.paused ? 0 : fol.mode;
  fol.mode = mode; fol.paused = false;
  if (mode) { fol.resume = fol.heading = mode; }
  if (mode === 2) {
    fol.course = currentHeading() ?? fol.course;
    setRotFrame(true);
  } else if (was === 2 || userRot) resetNorth();
  updateLocateBtn();
  if (mode) { $('#recenterBtn').hidden = true; fol.userZoom = null; if (me) followStep(me, true); }
  else planRecenter();
}

export function pauseFollow() {
  fol.paused = true;
  if (fol.mode === 2) setUserRot(mapRotation);
  updateLocateBtn();
  $('#recenterBtn').hidden = false;
}

export function stopFollow(instant) {
  if (!fol.mode && !fol.paused) return;
  const was = fol.mode;
  fol.mode = 0; fol.paused = false;
  if (was === 2 && !instant) resetNorth();
  updateLocateBtn();
  planRecenter();
}

export function folHeading() {
  const moving = me?.speed != null && me.speed > 1.5;
  return moving && fol.course != null ? fol.course : (compass ?? fol.course);
}

function followStep(fix, force) {
  const now = Date.now(), kmh = (fix.speed ?? 0) * 3.6;
  if (fix.heading != null && (fix.speed == null || fix.speed > 1.5)) {
    fol.course = fol.course == null ? fix.heading : (fol.course + angleDelta(fol.course, fix.heading) * 0.6 + 360) % 360;
  }
  // riding along at a decent pace without having touched the map: start following by itself
  fol.fastSince = kmh > 8 ? (fol.fastSince || now) : 0;
  if ((!fol.mode || fol.paused) && fol.fastSince && now - fol.fastSince > 10000 && now - fol.touched > 30000
      && !options.length && !to && !picking && $('#sheet').hidden) {
    setFollow(fol.heading || 2);
    if (!fol.toasted) { fol.toasted = true; toast('Following you'); }
    return;
  }
  if (!fol.mode || fol.paused) return;
  if (fol.mode === 2) rotateMap();
  let z = map.getZoom();
  if (fix.speed != null && fix.speed > 1.5) {
    z = (kmh < 12 ? 17.25 : kmh < 22 ? 16.75 : 16.25) + zoomBoost();
    if (Math.abs(z - map.getZoom()) < 0.3) z = map.getZoom();
  } else if (force) z = Math.max(z, 16 + zoomBoost());
  fol.wantZoom = z;
  let c = fix.latlng;
  if (fol.mode === 2) { // rider at about 60% of the height: more road ahead
    const a = mapRotation * Math.PI / 180, d = innerHeight * 0.1;
    c = map.unproject(map.project(c, z).subtract(L.point(-d * Math.sin(a), d * Math.cos(a))), z);
  }
  map.setView(c, z, { animate: true, pan: { duration: meGlide.ms / 1000, easeLinearity: 1 } });
}

// Compass: the marker turns with the phone. While riding faster than walking
// pace we trust the GPS direction of travel instead (no magnetic noise from the bike).
export function startCompass() {
  const onOrientation = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h == null) return;
    h = (h + (screen.orientation?.angle || 0) + 360) % 360;
    compass = compass == null ? h : (compass + angleDelta(compass, h) * 0.3 + 360) % 360;
    scheduleHeading();
  };
  addEventListener('devicemotion', onMotion);
  if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', onOrientation);
  else addEventListener('deviceorientation', onOrientation);
  // iPhone Safari only gives the compass after asking, from a tap
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    addEventListener('click', () => DeviceOrientationEvent.requestPermission().catch(() => {}), { once: true });
  }
}

export function angleDelta(from, to) { return ((to - from + 540) % 360) - 180; }

export function currentHeading() {
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
  else if (!nav && fol.mode === 2 && !fol.paused && !(me?.speed > 1.5)) rotateMap();
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
    return cone + `<div class="bike-badge me-bike" style="--bike:${esc(b.color)}">${iconOrEmoji(b.icon, 24)}</div>`;
  }
  return '<svg class="me-arrow me-rot" viewBox="0 0 40 40"><path d="M20 5 L32 33 L20 26.5 L8 33 Z" fill="var(--accent)" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/></svg>';
}

export function drawMe(rebuild = false) {
  if (!me) return;
  if (rebuild && meMarker) { meMarker.remove(); meMarker = null; }
  if (!meMarker) {
    const size = S().theme.marker === 'dot' ? 40 : S().theme.marker === 'bike' ? 38 : 52;
    meMarker = L.marker(me.latlng, {
      icon: L.divIcon({ className: 'me-marker', html: meIconHtml(), iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
    accuracyCircle = accuracyCircle || L.circle(me.latlng, { radius: me.accuracy, stroke: false, fillColor: S().theme.accent, fillOpacity: .12, interactive: false }).addTo(map);
  }
  moveMe(me.latlng);
  accuracyCircle.setRadius(Math.min(me.accuracy || 0, 200));
  accuracyCircle.setStyle({ fillColor: S().theme.accent });
  applyHeading();
}

export function planRecenter() {
  if (nav) return;
  const off = !!me && $('#sheet').hidden && (fol.paused || (!fol.mode && !map.getBounds().pad(-0.1).contains(me.latlng)));
  $('#recenterBtn').hidden = !off;
}

// GPS fixes arrive about once a second: glide the marker to each new spot over roughly that
// interval instead of jumping, like a car navigation arrow.
export var meGlide = { from: null, to: null, t0: 0, ms: 1000, last: 0, raf: 0 };
export function moveMe(ll) {
  const now = performance.now(), g = meGlide;
  const cur = g.to ? glidePos(now) : null;
  if (g.to && g.to[0] === ll[0] && g.to[1] === ll[1]) return;
  // re-targeting within the same fix (snapped onto the route) keeps the same start and clock
  if (now - g.last > 50 || !cur) {
    g.ms = Math.min(1200, Math.max(250, now - (g.last || now - 1000)));
    g.from = cur || ll; g.t0 = now; g.last = now;
  }
  g.to = ll;
  const far = g.from && dist(g.from, ll) > 300; // a big jump (new fix after a gap): no slow slide across town
  if (far || matchMedia('(prefers-reduced-motion: reduce)').matches) g.from = ll;
  if (!g.raf) g.raf = requestAnimationFrame(glideTick);
}
function glidePos(now) {
  const g = meGlide, k = Math.min(1, (now - g.t0) / g.ms);
  return [g.from[0] + (g.to[0] - g.from[0]) * k, g.from[1] + (g.to[1] - g.from[1]) * k];
}
function glideTick() {
  const g = meGlide, now = performance.now(), p = glidePos(now);
  meMarker?.setLatLng(p);
  accuracyCircle?.setLatLng(p);
  g.raf = now - g.t0 < g.ms ? requestAnimationFrame(glideTick) : 0;
}
