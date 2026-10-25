import { t } from './i18n.js';
import { landscapeMQ, map } from './mapview.js';
import { handleFix, me, setSimulating } from './position.js';
import { $, S } from './ui.js';

// Movement simulator: steer your own position by hand to test navigation and rerouting at a desk.
// Fixes go through handleFix, the same door real GPS uses; position.js ignores real GPS while this is on.

const STEP = 10;                       // metres per tap on Forward
const SPEEDS = { walk: 5, bike: 18 };  // km/h
const TURN = 20;                       // degrees per tap / per repeat while a turn is held

let on = false, pad = null, tick = 0, padTimer = 0;
let pos = null, heading = 0, mode = 'bike';
let fwdHeld = false, cruise = false, turnDir = 0;
let lastTurnAt = 0, lastFixAt = 0, lastTick = 0, lastTapAt = 0, holdTimer = 0, cruiseTimer = 0;

export function initSimulate() { if (S().simulate && !S().demo) setSimulate(true); }

export function setSimulate(v) {
  if (v === on) return;
  on = v;
  setSimulating(on);
  if (on) start(); else stop();
}

function start() {
  pos = me?.latlng ? [...me.latlng] : (c => [c.lat, c.lng])(map.getCenter());
  heading = me?.heading ?? 0;
  fwdHeld = cruise = false; turnDir = 0;
  buildPad();
  map.on('contextmenu', onJump);
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKey, true);
  addEventListener('blur', releaseAll);
  lastTick = Date.now();
  tick = setInterval(step, 100);
  emit(0);
}

function stop() {
  clearInterval(tick); clearInterval(padTimer); clearTimeout(holdTimer); clearTimeout(cruiseTimer);
  map.off('contextmenu', onJump);
  removeEventListener('keydown', onKey, true);
  removeEventListener('keyup', onKey, true);
  removeEventListener('blur', releaseAll);
  const p = pad; pad = null;
  p?.classList.add('leaving');
  setTimeout(() => p?.remove(), 250);
}

function destination([lat, lng], bearingDeg, m) {
  const b = bearingDeg * Math.PI / 180, dLat = m * Math.cos(b) / 111320;
  return [lat + dLat, lng + m * Math.sin(b) / (111320 * Math.cos(lat * Math.PI / 180))];
}

const speedMs = () => SPEEDS[mode] / 3.6;
const moving = () => fwdHeld || cruise;

function emit(speed) {
  lastFixAt = Date.now();
  try { handleFix({ latlng: [...pos], accuracy: 5, heading, speed, time: lastFixAt, sim: true }); } catch (e) { console.error(e); }
}

// runs every 100 ms: glide while moving, turn while a turn is held, send a fix about every second
// (every two seconds when standing still, like a GPS that has nothing new to say)
function step() {
  const now = Date.now(), dt = (now - lastTick) / 1000;
  lastTick = now;
  if (turnDir && now - lastTurnAt >= 250) { turnBy(turnDir); }
  if (moving()) pos = destination(pos, heading, speedMs() * dt);
  if (now - lastFixAt >= (moving() ? 1000 : 2000)) emit(moving() ? speedMs() : 0);
}

function turnBy(dir) {
  heading = (heading + dir * TURN + 360) % 360;
  lastTurnAt = Date.now();
  emit(moving() ? speedMs() : 0);
}

function stepForward() {
  pos = destination(pos, heading, STEP);
  emit(speedMs());
}

function onJump(e) {
  pos = [e.latlng.lat, e.latlng.lng];
  emit(moving() ? speedMs() : 0);
}

// ---- controls (pad buttons and keys share these)

function forwardDown() {
  if (fwdHeld) return;
  const now = Date.now();
  if (cruise) { cruise = false; syncPad(); return; }
  if (now - lastTapAt < 350) { cruise = true; clearTimeout(holdTimer); syncPad(); return; } // double tap: keep going
  lastTapAt = now;
  stepForward();
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { fwdHeld = true; syncPad(); }, 300); // held past a tap: move continuously
}
function forwardUp() { clearTimeout(holdTimer); fwdHeld = false; syncPad(); }

function turnDown(dir) { if (turnDir) return; turnBy(dir); turnDir = dir; lastTurnAt = Date.now() + 250; syncPad(); } // first repeat after 500 ms
function turnUp() { turnDir = 0; syncPad(); }

function halt() {
  clearTimeout(holdTimer);
  fwdHeld = cruise = false; turnDir = 0;
  syncPad();
  emit(0);
}
function releaseAll() { clearTimeout(holdTimer); fwdHeld = false; turnDir = 0; syncPad(); }

const KEYS = {
  ArrowUp: 'fwd', w: 'fwd', W: 'fwd',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowDown: 'stop', s: 'stop', S: 'stop', ' ': 'stop',
};
function onKey(e) {
  const k = KEYS[e.key];
  if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target;
  if (el?.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'keyup') { if (k === 'fwd') forwardUp(); else if (k === 'left' || k === 'right') turnUp(); return; }
  if (e.repeat) return;
  if (k === 'fwd') forwardDown(); else if (k === 'left') turnDown(-1); else if (k === 'right') turnDown(1); else halt();
}

// ---- the pad

function buildPad() {
  pad?.remove();
  pad = document.createElement('div');
  pad.id = 'simPad';
  pad.className = 'card';
  pad.innerHTML = `<span class="sim-badge">${t('Simulating')}</span>
    <div class="sim-row"><button type="button" data-k="left">${t('Turn left')}</button><button type="button" data-k="fwd" class="sim-go">${t('Forward')}</button><button type="button" data-k="right">${t('Turn right')}</button></div>
    <div class="sim-row"><button type="button" data-k="speed"></button><button type="button" data-k="stop">${t('Stop')}</button></div>`;
  document.body.appendChild(pad);
  pad.oncontextmenu = e => e.preventDefault();
  for (const b of pad.querySelectorAll('button')) {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      if (k === 'speed') { mode = mode === 'bike' ? 'walk' : 'bike'; syncPad(); return; }
      b.setPointerCapture?.(e.pointerId);
      if (k === 'fwd') forwardDown(); else if (k === 'left') turnDown(-1); else if (k === 'right') turnDown(1); else halt();
    });
    const up = () => { if (k === 'fwd') forwardUp(); else if (k === 'left' || k === 'right') turnUp(); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }
  syncPad();
  placePad();
  padTimer = setInterval(placePad, 400);
}

function syncPad() {
  if (!pad) return;
  const q = k => pad.querySelector(`[data-k="${k}"]`);
  q('speed').textContent = `${t(mode === 'bike' ? 'Bike' : 'Walk')} ${SPEEDS[mode]} km/h`;
  q('fwd').classList.toggle('held', fwdHeld);
  q('fwd').classList.toggle('cruise', cruise);
  q('left').classList.toggle('held', turnDir < 0);
  q('right').classList.toggle('held', turnDir > 0);
}

// sit just above whichever bottom sheet is showing (side by side in landscape, where the panels
// live in the left column, so the pad moves to the right)
function placePad() {
  if (!pad) return;
  const land = landscapeMQ.matches;
  pad.classList.toggle('land', land);
  let bottom = 16;
  if (!land) for (const id of ['sheet', 'navBar', 'placeSheet']) {
    const el = $(`#${id}`);
    if (el && !el.hidden && el.offsetParent !== null) bottom = Math.max(bottom, innerHeight - el.getBoundingClientRect().top + 12);
  }
  pad.style.bottom = `${Math.round(bottom)}px`;
}
