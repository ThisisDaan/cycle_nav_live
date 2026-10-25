import * as store from './store.js';
import { search } from './geocode.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { landscapeMQ, map } from './mapview.js';
import { nav } from './navigation.js';
import { editPin, pinBtn } from './pins.js';
import { me } from './position.js';
import { pickGpxRoute } from './rides.js';
import { clearRoutes, drawStart, gpxRoute, planRoute, setGpxRoute, setVias, vias } from './routing-ui.js';
import { scheduleSession } from './session.js';
import { $, esc, S, toast } from './ui.js';

export const ME = { isMe: true, name: 'My location' };

export let from = ME, to = null;
export function setFrom(v) { from = v; }
export function setTo(v) { to = v; }

// ---------------------------------------------------------------- planner

export function setupPlanner() {
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
  $('#cancelRouteBtn').onclick = () => $('#clearBtn').click();
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
  if (which === 'to') items.push({ name: 'Follow a GPX route…', detail: 'Open a .gpx file and navigate along it', icon: icon('folder_open', 20), action: 'gpx' });
  const recent = S().recent.map(r => ({ ...r, icon: icon('history', 20), recent: true }));
  renderSuggestions(which, [...items, ...recent], '', recent.length ? 'Recent' : '');
}

function renderSuggestions(which, items, extraHtml = '', head = '') {
  suggestionItems = items || [];
  const ul = $('#suggestions');
  ul.dataset.which = which;
  let html = extraHtml;
  suggestionItems.forEach((it, i) => {
    if (head && i === suggestionItems.findIndex(x => x.recent)) html += `<li class="s-head">${esc(head)}</li>`;
    html += `<li data-i="${i}"><span class="s-icon">${it.icon || icon('place', 20)}</span><span class="s-text"><div class="s-name">${esc(it.name)}</div>${it.detail ? `<div class="s-detail">${esc(it.detail)}</div>` : ''}</span>${(it.latlng || it.isMe) && !it.recent ? `${pinBtn(it)}` : ''}</li>`;
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

export function hideSuggestions() { $('#suggestions').hidden = true; }

export function choosePlace(which, place) {
  hideSuggestions();
  document.activeElement?.blur();
  if (which === 'from') from = place; else to = place;
  setVias([]);
  setGpxRoute(null);
  scheduleSession();
  if (!place.isMe) store.addRecent({ name: place.name, detail: place.detail, latlng: place.latlng });
  syncInputs();
  if (to) planRoute(); else if (which === 'from') drawStart(resolve(from));
  // Show the place right away; once both ends are known the route fit takes over.
  const ll = resolve(place);
  if (ll && !(to && resolve(from) && resolve(to))) map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: 0.8 });
}

export function syncInputs() {
  $('#fromInput').value = from?.isMe ? '' : from?.name || '';
  $('#toInput').value = to ? (to.isMe ? t('My location') : to.name) : '';
}

export function resolve(place) { return place?.isMe ? me?.latlng : place?.latlng; }

// ---- undo for route edits

const undoStack = [];
let undoTimer = 0;
const snapPlan = () => ({ from, to, gpx: gpxRoute, vias: vias.map(v => Object.assign([v[0], v[1]], { gpx: v.gpx, name: v.name, city: v.city })) });

export function pushUndo(label) {
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

export function updateUndoUi() { $('#undoBtn').hidden = !undoStack.length || !!nav; }

export function undo() {
  const s = undoStack.pop();
  if (!s) return;
  clearTimeout(undoTimer);
  $('#undoBar').classList.remove('show'); $('#undoBar').hidden = true;
  from = s.from; to = s.to; setGpxRoute(s.gpx);
  setVias(s.vias.map(v => Object.assign([v[0], v[1]], { gpx: v.gpx, name: v.name, city: v.city })));
  syncInputs();
  updateUndoUi();
  if (to) planRoute({ fit: false }); else clearRoutes();
}
