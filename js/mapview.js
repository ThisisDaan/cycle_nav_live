import * as store from './store.js';
import { MAP_STYLES, tileStyle } from './theme.js';
import { applyBuildings, calmStyle } from './mapstyle.js';
import { icon, ICON_PATHS } from './icons.js';
import { t } from './i18n.js';
import { nav, setNavOpen } from './navigation.js';
import { hideNearbyMenu, setMore } from './nearby.js';
import { defaultPickRect, layoutPick, picking, schedulePick, setPickRect } from './offlineui.js';
import { renderPins, setPinLayer } from './pins.js';
import { dropPin, setLastCtx, tapMap } from './placesheet.js';
import { hideSuggestions } from './planner.js';
import { angleDelta, currentHeading, fol, folHeading, me, meGlide, pauseFollow, planRecenter, setFollow, simulating, stopFollow } from './position.js';
import { options, setRouteLayer, setSheetCollapsed, setViaLayer } from './routing-ui.js';
import { $, locked, S } from './ui.js';

export let map;

export let tiles;

let tilesToken = 0;
export let mapRotation = 0;         // degrees the map is turned while navigating, kept continuous
export let recenterTimer = 0;

export let userRot = 0;             // planner rotation chosen by two-finger twist
export function setUserRot(v) { userRot = v; }
let rotFrameTimer = 0;

const TILT = 50;             // degrees the map is tipped back in the 3D view
export const landscapeMQ = matchMedia('(orientation: landscape) and (max-height: 500px)');
export const isLand = () => landscapeMQ.matches;

// Width of the left column (panels) in landscape, safe area included; 0 in portrait.
const panelProbe = Object.assign(document.createElement('div'), {});
export function installPanelProbe() {
  panelProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:0;width:var(--panel-w)';
  document.body.appendChild(panelProbe);
}
export const panelW = () => (isLand() ? panelProbe.offsetWidth : 0);
// The part of the screen the map is seen through, and where the rider sits in it.
function navGeom() {
  const w = innerWidth, h = innerHeight, pl = panelW();
  return { w, h, pl, cx: Math.round((pl + w) / 2), py: Math.round(h * (isLand() ? 0.70 : 0.66)) };
}
const FRAME_3D = 850;        // half-size of the tilted map square (px)
export const is3d = () => document.body.classList.contains('nav-frame') && S().view3d !== false;

const buildings3d = () => S().view3d !== false;
export const framed = () => document.body.classList.contains('nav-frame') || document.body.classList.contains('rot-frame');

// While the map is turned (CSS rotation), Leaflet's drag offsets are in screen
// space; turn them into map space so the map moves under your finger.
const dragMove = L.Draggable.prototype._onMove;
export function installLeafletPatches() {
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
  L.Map.prototype.mouseEventToContainerPoint = function (e) {
    const c = this._container;
    if (!framed() || is3d() || c.id !== 'map') return mouseToPoint.call(this, e);
    const r = c.getBoundingClientRect(), a = mapRotation * Math.PI / 180;
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    return L.point(c.offsetWidth / 2 + x * Math.cos(a) - y * Math.sin(a), c.offsetHeight / 2 + x * Math.sin(a) + y * Math.cos(a));
  };
  L.Map.prototype.fitBounds = function (...args) {
    if (!nav) stopFollow(true);
    if (!nav && document.body.classList.contains('rot-frame')) resetNorth(true);
    return fitBounds.apply(this, args);
  };
}

// Taps, long-presses, clicks and pinches: screen position -> map container position,
// undoing the CSS rotation around the centre of the (big, turned) map square.
const mouseToPoint = L.Map.prototype.mouseEventToContainerPoint;

// A programmatic fit in the planner assumes a north-up screen-sized map.
const fitBounds = L.Map.prototype.fitBounds;

// ---------------------------------------------------------------- map

export function setupMap() {
  const view = S().view;
  map = L.map('map', { zoomControl: false, tap: true, zoomSnap: 0.25 })
    .setView(view?.center || [52.3676, 4.9041], view?.zoom || 13);
  setTiles();
  setRouteLayer(L.layerGroup().addTo(map));
  const zoomClass = () => map.getContainer().classList.toggle('zoom-low', map.getZoom() < 14);
  map.on('zoomend', zoomClass); zoomClass();
  setViaLayer(L.layerGroup().addTo(map));
  setPinLayer(L.layerGroup().addTo(map));
  renderPins();

  let saveTimer;
  map.on('moveend', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.update(s => {
      const c = map.getCenter();
      s.view = { center: [c.lat, c.lng], zoom: map.getZoom() };
    }), 500);
  });
  // Looking around without navigating: offer the same Re-centre button once you're off screen.
  map.on('moveend', planRecenter);
  map.on('dragstart', () => {
    if (nav) { nav.follow = false; clearTimeout(recenterTimer); $('#recenterBtn').hidden = false; }
    else if (fol.mode && !fol.paused) pauseFollow();
    else if (options.length) setSheetCollapsed(true);
  });
  // After looking around, snap back to your position by itself.
  map.on('dragend', () => { if (nav) autoRecenter(8000); });
  // keep the building height in step with the zoom while pinching, not only once it ends
  map.on('zoom', () => { if (!rotRaf) rotRaf = requestAnimationFrame(rotTick); });
  map.on('zoomend', () => {
    syncGL();
    // A pinch while following sets your own zoom level for the rest of the ride.
    // A pinch while following becomes your preferred zoom (remembered, and still speed-aware).
    if (nav?.follow && nav.wantZoom != null && Math.abs(map.getZoom() - nav.wantZoom) > 0.05) addZoomBoost(map.getZoom() - nav.wantZoom);
    if (!nav && fol.mode && !fol.paused && fol.wantZoom != null && Math.abs(map.getZoom() - fol.wantZoom) > 0.05) addZoomBoost(map.getZoom() - fol.wantZoom);
  });
  addEventListener('touchstart', e => { if (e.target.closest?.('#map')) fol.touched = Date.now(); }, { capture: true, passive: true });
  addEventListener('mousedown', e => { if (e.target.closest?.('#map')) fol.touched = Date.now(); }, true);
  setupTwist();
  map.on('click', e => { hideSuggestions(); $('#bikeMenu').hidden = true; hideNearbyMenu(); setMore(false); tapMap(e); });
  map.on('contextmenu', e => { setLastCtx(Date.now()); if (!picking && !simulating) dropPin([e.latlng.lat, e.latlng.lng]); });
}

export async function setTiles() {
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
  if (gl) { gl.on('load', syncGL); gl.on('styleimagemissing', e => bikeBadge(gl, e.id)); syncGL(); }
}

// The GL map lives inside the CSS-rotated #map. To keep street names upright, its container is turned
// back by the same angle (CSS `rotate`) and the GL bearing is set to match, so the picture is
// geographically identical but MapLibre draws the labels screen-aligned.
const GL_PAD = 0.12;
const glPos = L.DomUtil.setPosition;
export function installGlPatches() {
  L.DomUtil.setPosition = function (el, p) {
    // position the GL container with `translate` (applied after `rotate`) so turning it keeps its own centre
    if (el.classList?.contains('leaflet-gl-layer')) { el._leaflet_pos = p; el.style.translate = `${p.x}px ${p.y}px`; return; }
    return glPos.call(this, el, p);
  };
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
}

const glTransform = L.DomUtil.setTransform;

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
export function syncGL() {
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
  syncBikeLayers(gl);
}

// bike essentials follow the settings toggle; unpaved roads are dashed only for a mountain bike
function syncBikeLayers(gl) {
  const on = S().bikePois !== false, mtb = store.activeBike()?.type === 'mtb', key = `${on}${mtb}`;
  if (gl._bk === key || !gl.getLayer('bike-essentials')) return;
  gl._bk = key;
  gl.setLayoutProperty('bike-essentials', 'visibility', on ? 'visible' : 'none');
  gl.setLayoutProperty('unpaved-mtb', 'visibility', mtb ? 'visible' : 'none');
}

const BADGES = { bicycle_parking: ['P', '#1a73e8'], bicycle: ['build', '#e8710a'], drinking_water: ['water', '#0b8ec9'], toilets: ['wc', '#6b5bd2'], train: ['train', '#1f4e8c'] };
function bikeBadge(gl, id) {
  const b = BADGES[id.replace(/^bk-/, '')];
  if (!b || gl.hasImage(id)) return;
  const c = document.createElement('canvas'), r = 2;
  c.width = c.height = 32 * r;
  const g = c.getContext('2d');
  g.scale(r, r);
  g.beginPath(); g.arc(16, 16, 14, 0, 7); g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 2.5; g.strokeStyle = b[1]; g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (b[0] === 'P') { g.fillStyle = b[1]; g.font = 'bold 19px sans-serif'; g.fillText('P', 16, 17); }
  else { g.save(); g.translate(16 - 9, 16 - 9); g.scale(18 / 24, 18 / 24); g.fillStyle = b[1]; g.fill(new Path2D(ICON_PATHS[b[0]])); g.restore(); }
  gl.addImage(id, g.getImageData(0, 0, c.width, c.height), { pixelRatio: r });
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

// ---- navigation camera: follow you, turn the map, zoom with speed

export const ORIENTATIONS = {
  course:  { label: 'Riding direction', desc: 'The way you ride points up' },
  north:   { label: 'North up',         desc: 'The map never turns' },
  compass: { label: 'Phone direction',  desc: 'Turns with the phone, like a compass' },
};

// While navigating, the map is a big square around a point low on the screen
// (more road ahead), so it can be turned without showing empty corners.
export function setNavFrame(on) {
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
    if (picking) { setPickRect(defaultPickRect()); layoutPick(); schedulePick(); }
  }, 120);
}
export function wireViewport() {
  addEventListener('resize', onViewportChange);
  addEventListener('orientationchange', onViewportChange);
}

export function rotateMap() {
  let target = nav ? 0 : userRot;
  if (!nav && fol.mode === 2 && !fol.paused) target = folHeading() ?? userRot;
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
    + `<small>${nav?.manual != null ? icon('pan_tool', 10) : { course: '', north: 'N', compass: icon('explore', 10) }[S().orientation]}</small>`;
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
export function setRotFrame(on) {
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
export function resetNorth(instant) {
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
    g = { last: ang(e.touches), twist: 0, on: false, base: nav ? (nav.manual ?? mapRotation) : (fol.mode === 2 && !fol.paused ? mapRotation : userRot) };
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
      if (!nav) { setRotFrame(true); if (fol.mode && !fol.paused) { userRot = mapRotation; pauseFollow(); } }
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

export function followCamera(fix, st) {
  rotateMap();
  if (!nav.follow) return;
  // Further out when riding fast, close in just before a turn; plus your own preference.
  const kmh = (fix.speed ?? 0) * 3.6;
  let z = (kmh < 12 ? 17.25 : kmh < 22 ? 16.75 : 16.25) + zoomBoost();
  if (st?.next && st.distToNext < 150) z = Math.max(z, 17.5 + zoomBoost());
  if (Math.abs(z - map.getZoom()) < 0.3) z = map.getZoom();
  nav.wantZoom = z;
  // pan at the same steady pace as the marker glides, so it stays put on screen
  map.setView(fix.latlng, z, { animate: true, pan: { duration: meGlide.ms / 1000, easeLinearity: 1 } });
}

export const zoomBoost = () => S().zoomBoost || 0;
function addZoomBoost(d) {
  store.update(s => { s.zoomBoost = Math.max(-2, Math.min(3, Math.round(((s.zoomBoost || 0) + d) * 4) / 4)); });
}

export function recenter() {
  if (!nav) {
    if (fol.paused) return setFollow(fol.resume);
    // just looking around: fly back to where you are
    if (me) map.flyTo(me.latlng, Math.max(map.getZoom(), 15), { duration: 0.8 });
    return;
  }
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

export function showOverview() {
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
