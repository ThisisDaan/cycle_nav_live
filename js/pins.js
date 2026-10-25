import * as store from './store.js';
import { newRideId } from './store.js';
import { icon, iconOrEmoji, iconName, PIN_ICONS } from './icons.js';
import { t } from './i18n.js';
import { dist } from './geo.js';
import { drawerOpen, renderDrawer } from './drawer.js';
import { map } from './mapview.js';
import { addStop, nav } from './navigation.js';
import { choosePlace } from './planner.js';
import { me } from './position.js';
import { $, askConfirm, closeDialog, esc, openDialog, S, toast } from './ui.js';

export let pinLayer;
export function setPinLayer(v) { pinLayer = v; }

// outline grey until the place is actually saved, then solid in the accent colour
export const BOOKMARK_LINE_SVG = '<svg class="bm-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M17 4H7a1 1 0 0 0-1 1v14.5l6-2.6 6 2.6V5a1 1 0 0 0-1-1z"/></svg>';
export function pinBtn(it) {
  const ll = it.isMe ? me?.latlng : it.latlng;
  const saved = ll && (S().pins || []).some(p => dist(p.latlng, ll) < 30);
  return `<button class="s-pin${saved ? ' saved' : ''}" data-pin aria-label="Save as pin" title="Save as pin">${saved ? BOOKMARK_SVG : BOOKMARK_LINE_SVG}</button>`;
}
export const BOOKMARK_SVG = '<svg class="bm-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>';

// ---------------------------------------------------------------- pins

export const pinIcon = (p, size = 18) => iconOrEmoji(p.icon || p.emoji, size);

export function renderPins() {
  if (!pinLayer) return;
  pinLayer.clearLayers();
  for (const p of S().pins.filter(x => x.show)) {
    const m = L.marker(p.latlng, { icon: L.divIcon({ className: '', html: `<div class="pin-marker">${pinIcon(p, 18)}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }), zIndexOffset: 200 });
    m.on('click', () => openPinPopup(p.id));
    m.addTo(pinLayer);
  }
}

export function openPinPopup(id) {
  const p = S().pins.find(x => x.id === id);
  if (!p) return;
  const acts = [
    !nav && ['to', 'Directions to here', 'go'],
    nav && !nav.recordOnly && ['stop', 'Add as stop', 'go'],
    ['edit', 'Edit'], ['del', 'Delete'],
  ].filter(Boolean);
  L.popup({ closeButton: false, offset: [0, -14] }).setLatLng(p.latlng)
    .setContent(`<div class="map-popup"><b class="selectable">${pinIcon(p, 16)} ${esc(p.name)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}${
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

export async function deletePin(id) {
  if (!await askConfirm(t('Delete this pin?'), { ok: 'Delete', danger: true })) return;
  store.update(s => { s.pins = s.pins.filter(p => p.id !== id); });
  renderPins();
  if (drawerOpen) renderDrawer();
}

export function editPin(pin, fresh) {
  const d = pin || { id: null, name: '', icon: 'place', note: '', show: true, ...fresh };
  let sel = iconName(d.icon || d.emoji) || d.icon || d.emoji;
  openDialog(`
    <h2>${pin ? 'Edit pin' : 'Save pin'}</h2>
    <label class="field"><span>Name</span><input type="text" id="pinName" value="${esc(d.name)}" placeholder="${esc(t('Pin'))}" maxlength="60"></label>
    <div class="field"><span>Icon</span>
      <div class="icon-grid">${PIN_ICONS.map(n => `<button type="button" class="icon-opt ${n === sel ? 'selected' : ''}" data-e="${n}" aria-label="${n}">${icon(n, 22)}</button>`).join('')}</div>
    </div>
    <label class="field"><span>Note (optional)</span><input type="text" id="pinNote" value="${esc(d.note)}" maxlength="120"></label>
    <label class="toggle"><span>Show on map</span><input type="checkbox" id="pinShow" ${d.show ? 'checked' : ''}></label>
    <div class="dialog-actions">
      ${pin ? '<button class="secondary-btn" id="pinDel">Delete</button>' : ''}
      <button class="secondary-btn" id="pinCancel">Cancel</button>
      <button class="primary-btn" id="pinSave">Save</button>
    </div>`);
  const box = $('#dialogBody');
  box.querySelectorAll('.icon-opt').forEach(b => b.onclick = () => {
    sel = b.dataset.e;
    box.querySelectorAll('.icon-opt').forEach(x => x.classList.toggle('selected', x === b));
  });
  $('#pinCancel').onclick = closeDialog;
  if (pin) $('#pinDel').onclick = () => { closeDialog(); deletePin(pin.id); };
  $('#pinSave').onclick = () => {
    const rec = {
      id: d.id || newRideId(),
      name: $('#pinName').value.trim() || t('Pin'),
      icon: sel || 'place',
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
