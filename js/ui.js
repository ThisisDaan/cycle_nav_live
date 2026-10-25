import * as store from './store.js';
import { isNative } from './native.js';
import { t } from './i18n.js';
import { closeSettings } from './settings.js';

export const $ = sel => document.querySelector(sel);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const S = () => store.get();

export let locked = false;          // lock mode: an overlay swallows every touch

export function pickFiles(accept, multiple, cb) {
  const input = $('#fileInput');
  input.accept = accept;
  input.multiple = multiple;
  input.value = '';
  input.onchange = () => input.files.length && cb([...input.files]);
  input.click();
}

// ---------------------------------------------------------------- dialog & toast

// In-app replacements for confirm() / prompt(): promise-based, back button or tap outside = cancel.
export let askState = null;
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
export function askClose(ok) {
  const st = askState;
  if (!st) return;
  askState = null;
  $('#ask').hidden = true;
  st.resolve(ok ? (st.input ? $('#askInput').value.trim() : true) : (st.input ? null : false));
}
export const askConfirm = (text, o = {}) => askOpen({ text, ...o });
export const askText = (text, o = {}) => askOpen({ text, input: { value: o.value, placeholder: o.placeholder, maxLength: o.maxLength }, ...o });
export function wireDialogs() {
  $('#askOk').onclick = () => askClose(true);
  $('#askCancel').onclick = () => askClose(false);
  $('#ask').addEventListener('click', e => { if (e.target.id === 'ask') askClose(false); });
  $('#ask').addEventListener('keydown', e => {
    if (e.key === 'Escape') askClose(false);
    else if (e.key === 'Enter' && e.target.id === 'askInput') askClose(true);
  });
  $('#dialog').addEventListener('click', e => { if (e.target.id === 'dialog') closeDialog(); });
  $('#settings').addEventListener('click', e => { if (e.target.id === 'settings') closeSettings(); });
}

export function openDialog(html) {
  $('#dialog').classList.remove('end-sheet');
  $('#dialogBody').innerHTML = html;
  $('#dialog').hidden = false;
}
export function closeDialog() { $('#dialog').hidden = true; $('#dialog').classList.remove('end-sheet'); }

let toastTimer;
// Web only: full screen (the Android app already is). iPhone Safari can't, so explain the home-screen way.
export function setupFullscreen() {
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

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------------------------------------------------------------- lock mode

export function lockScreen() {
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
export function setupLock() {
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
