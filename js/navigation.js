import * as store from './store.js';
import { fetchRoute, hintText, isRoundabout, isUturn } from './router.js';
import { search } from './geocode.js';
import { bikeSpeed } from './memory.js';
import { Navigator, Recorder, Simulator } from './nav.js';
import { keepAwake, speak, stopSpeaking } from './native.js';
import { bottomSheet } from './sheet.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { bearing, dist, fmtDist, fmtDuration, resample } from './geo.js';
import { toggleBikeMenu } from './bikes.js';
import { setupDrawer } from './drawer.js';
import { followCamera, landscapeMQ, map, ORIENTATIONS, recenter, recenterTimer, resetNorth, rotateMap, setNavFrame, showOverview } from './mapview.js';
import { moreOpen, setMore, toggleNearbyMenu } from './nearby.js';
import { closePlaceSheet } from './placesheet.js';
import { ME, resolve, setFrom, setTo, syncInputs, to, updateUndoUi } from './planner.js';
import { angleDelta, fol, handleFix, me, meMarker, moveMe, setFollow, updateLocateBtn } from './position.js';
import { offerSaveRide, rideList } from './rides.js';
import { alongRoute, clearRoutes, drawRoutes, options, planRoute, selected, setOptions, setSelected, setStartMarker, startMarker, viaLayer, vias } from './routing-ui.js';
import { lsSet, NAV_KEY, PLAN_KEY, saveNavSession } from './session.js';
import { closeSettings, openSettings } from './settings.js';
import { $, closeDialog, esc, lockScreen, openDialog, S, setupFullscreen, setupLock, toast } from './ui.js';
import { toggleRadar } from './wxui.js';

export let nav = null;              // active navigation / recording session

let navCtl = null;

function restoreRecorder(rec, saved) {
  rec.startedAt = saved.startedAt;
  rec.distance = saved.rec.distance;
  rec.movingTime = saved.rec.movingTime;
  rec.points = saved.rec.points;
}

// ---------------------------------------------------------------- navigation

export function setupButtons() {
  $('#startBtn').onclick = () => startNavigation(options[selected]);
  $('#stopBtn').onclick = openEndSheet;
  $('#recordBtn').onclick = () => startRecording();
  $('#locateBtn').onclick = () => {
    if (!me) return toast('Waiting for your location…');
    if (nav) return map.setView(me.latlng, Math.max(map.getZoom(), 16));
    // tap: follow -> follow with heading up -> follow north-up; after a drag it picks the old mode back up
    setFollow(fol.paused ? fol.resume : fol.mode === 1 ? 2 : 1);
  };
  updateLocateBtn();
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
  $('#radarBtn').onclick = () => toggleRadar();
  $('#nearbyBtn').onclick = toggleNearbyMenu;
  $('#navNearbyBtn').onclick = toggleNearbyMenu;
  $('#moreBtn').onclick = () => setMore(!moreOpen);
  $('#placeClose').onclick = closePlaceSheet;
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
  $('#navSettingsBtn').onclick = () => openSettings('more');
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

export function startNavigation(option, resume) {
  if (!option) return;
  fol.mode = 0; fol.paused = false; updateLocateBtn();
  const bike = store.activeBike();
  nav = {
    route: option.route,
    navigator: new Navigator(option.route),
    recorder: new Recorder(),
    dest: to,
    vias: vias.slice(),
    gpx: vias.some(v => v.gpx), // following a GPX track: rerouting goes back to the track
    along: 0,
    follow: true,
    speedKmh: bikeSpeed(bike, rideList).kmh,
  };
  if (resume) { restoreRecorder(nav.recorder, resume); setFrom(ME); startMarker?.remove(); setStartMarker(null); }
  setOptions([option]); setSelected(0);
  lsSet(PLAN_KEY, null);
  saveNavSession();
  drawRoutes(true);
  viaLayer.clearLayers();
  enterNavUi(false);
  if (S().demo && !S().simulate) {
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

export function startRecording(resume) {
  nav = { recorder: new Recorder(), follow: true, recordOnly: true, vias: [] };
  if (resume) restoreRecorder(nav.recorder, resume);
  lsSet(PLAN_KEY, null);
  saveNavSession();
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
  $('#navEtaLabel').textContent = recordOnly ? 'moving' : 'to go';
  renderVoiceBtn();
  $('#voiceBtn').hidden = recordOnly;
  $('#navButtons').hidden = false;
  map.closePopup();
  setNavFrame(true);
  keepAwake(true);
}

export function onNavFix(fix) {
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
    moveMe(ll);
    fix = { ...fix, latlng: ll };
  }
  followCamera(fix, st);
  if (!st.offRoute) nav.along = st.along;
  checkStops(fix);
  renderNavDetails();
  $('#navRemain').textContent = fmtDist(st.remaining);
  // time left is what you act on while riding; seconds once it's under a minute
  const left = st.remaining / (nav.speedKmh / 3.6);
  $('#navEta').textContent = left < 60 ? `${Math.max(5, Math.round(left / 5) * 5)} s` : fmtDuration(left);

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

// After leaving the route, prefer a new route that carries on the way you're riding: people
// often take their own way (a bit of footpath, a street they like). Only turn you around when
// going forward is clearly worse.
async function rerouteAhead(session, ahead) {
  const bike = store.activeBike(), dest = resolve(session.dest), here = me.latlng;
  const direct = await fetchRoute([here, ...ahead, dest], bike);
  const course = session.course;
  if (course == null || (me.speed ?? 3) < 1.5) return direct;
  const turn = Math.abs(angleDelta(course, startBearing(direct.coords)));
  if (turn < 100) return direct; // it already heads roughly your way
  try {
    // nudge the start ~60 m ahead in your direction of travel
    const a = course * Math.PI / 180, m = 60;
    const nudge = [here[0] + m * Math.cos(a) / 111320, here[1] + m * Math.sin(a) / (111320 * Math.cos(here[0] * Math.PI / 180))];
    const fwd = await fetchRoute([here, nudge, ...ahead, dest], bike);
    const okTurn = Math.abs(angleDelta(course, startBearing(fwd.coords))) < 100;
    const extra = fwd.length - direct.length;
    return okTurn && extra < Math.max(400, direct.length * 0.15) ? fwd : direct;
  } catch { return direct; }
}

// Where to get back onto the route you chose. Following a GPX track: the closest point still ahead
// on it, even if that means turning round (keeping to the track is the point). Otherwise the router
// is asked for a few ways back in (that closest point and points further along the route) and the
// one that gets you to the destination soonest wins, with a U-turn counted as a detour, so when the
// route comes back to you further ahead you carry on instead of going back for it.
// Then guide points every ~400 m so the router keeps to the rest of it. Returns [{ p, a }] with
// a = distance along the old route.
async function rejoinPlan(session) {
  const r = session.route, here = me.latlng, course = session.course, end = r.cum[r.cum.length - 1];
  let i0 = 0;
  while (i0 < r.cum.length - 1 && r.cum[i0] < session.along + 40) i0++;
  let near = null;
  for (let i = i0; i < r.coords.length && end - r.cum[i] > 150; i++) {
    const cost = dist(here, r.coords[i]) + (r.cum[i] - session.along) * 0.15;
    if (!near || cost < near.cost) near = { cost, i };
  }
  if (!near) return [];
  let pick = near.i;
  if (!session.gpx) {
    const at = m => { let i = i0; while (i < r.cum.length - 1 && r.cum[i] < session.along + m) i++; return i; };
    const cands = [...new Set([near.i, ...[250, 500, 900, 1500].map(at)])]
      .filter(i => end - r.cum[i] > 150 && dist(here, r.coords[i]) < 2500);
    const bike = store.activeBike();
    const legs = await Promise.all(cands.map(i => fetchRoute([here, r.coords[i]], bike).then(leg => ({ i, leg }), () => null)));
    let best = null;
    for (const c of legs) {
      if (!c) continue;
      const turnBack = course != null && (me.speed ?? 3) >= 1.5 && Math.abs(angleDelta(course, startBearing(c.leg.coords))) > 120;
      const cost = c.leg.length + (end - r.cum[c.i]) + (turnBack ? 300 : 0);
      if (!best || cost < best.cost) best = { cost, i: c.i };
    }
    if (best) pick = best.i;
  }
  const a0 = r.cum[pick], len = end - a0, n = Math.floor(len / 400), step = len / (n + 1);
  const guides = n > 0 ? resample(r.coords.slice(pick), step).slice(1, n + 1) : [];
  return [r.coords[pick], ...guides].map((p, k) => ({ p: [p[0], p[1]], a: a0 + k * step }));
}

// direction of the first ~30 m of a route
function startBearing(coords) {
  let i = 1;
  while (i < coords.length - 1 && dist(coords[0], coords[i]) < 30) i++;
  return bearing(coords[0], coords[Math.min(i, coords.length - 1)]);
}

async function reroute(points) {
  nav.rerouting = true;
  const session = nav;
  try {
    // Keep the points you added that are still ahead of you.
    const vias = points || session.vias.filter(v => alongRoute(session.route, v) > session.along + 30);
    let ahead = vias;
    if (!points) {
      // and steer back onto the route you chose instead of planning a brand new one
      const guide = await rejoinPlan(session);
      if (nav !== session) return;
      if (guide.length) ahead = [...guide, ...vias.map(v => ({ p: v, a: alongRoute(session.route, v) }))].sort((x, y) => x.a - y.a).map(x => x.p);
    }
    const route = await rerouteAhead(session, ahead);
    session.vias = vias;
    if (nav !== session) return;
    session.route = route;
    session.navigator = new Navigator(route);
    setOptions([{ route }]); setSelected(0);
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
  lsSet(NAV_KEY, null);
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
    setFrom(ME); setTo(null); syncInputs(); clearRoutes();
    setFollow(fol.resume);
  } else if (to) {
    planRoute();
  }
  if (discard) return;
  if (session.recorder.distance > 150) offerSaveRide(session, arrived);
  else if (session.recordOnly) toast('Ride too short to save');
}

// ---- ride details panel (tap the bottom bar)

function toggleNavDetails(open = $('#navDetails').hidden) {
  if (navCtl && $('#navBar').offsetHeight && $('#navDetails').hidden === open) return navCtl.go(!open);
  setNavOpen(open);
}

export function setNavOpen(open) {
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
    <button class="icon-btn" data-unstop="${i}" aria-label="Remove stop">${icon('close', 20)}</button></div>`).join('');
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
      ul.innerHTML = results.map((p, i) => `<li data-i="${i}"><span class="s-icon">${icon('place', 20)}</span><span class="s-text"><div class="s-name">${esc(p.name)}</div>${p.detail ? `<div class="s-detail">${esc(p.detail)}</div>` : ''}</span></li>`).join('')
        || '<li class="s-head">Nothing found</li>';
      ul.hidden = false;
      ul.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => addStop(results[+li.dataset.i]));
    }, 300);
  });
}

export function addStop(place) {
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

// ---------------------------------------------------------------- end-of-ride sheet

export function openEndSheet() {
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
