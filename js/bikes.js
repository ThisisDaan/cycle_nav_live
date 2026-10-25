import * as store from './store.js';
import { BIKE_TYPES, BIKE_ICONS, newBike } from './store.js';
import { ROUTE_STYLES } from './router.js';
import { bikeSpeed } from './memory.js';
import { ACCENTS } from './theme.js';
import { icon, iconOrEmoji, iconName } from './icons.js';
import { t } from './i18n.js';
import { syncGL } from './mapview.js';
import { nav } from './navigation.js';
import { to } from './planner.js';
import { drawMe } from './position.js';
import { rideList } from './rides.js';
import { planRoute } from './routing-ui.js';
import { openSettings } from './settings.js';
import { $, askConfirm, closeDialog, esc, openDialog, S } from './ui.js';

export function applyBike(id) {
  if (id && id !== store.activeBike().id && S().bikes.some(b => b.id === id)) store.update(s => { s.activeBikeId = id; });
  renderBikeChip();
}

// ---------------------------------------------------------------- bikes

export function renderBikeChip() {
  syncGL();
  const b = store.activeBike();
  const sp = bikeSpeed(b, rideList);
  $('#bikeChip').innerHTML = `<span class="bike-badge" style="--bike:${esc(b.color)}">${iconOrEmoji(b.icon, 20)}</span>
    <span class="chip-text"><span class="chip-name">${esc(b.name)}</span><small>${sp.kmh.toFixed(1)} km/h · ${t(ROUTE_STYLES[b.style]?.label || 'Calm')}</small></span>
    <span class="sheet-bike-change">${t('Change')}${icon('expand_more', 18)}</span>`;
  if (S().theme.marker === 'bike') drawMe(true);
}

export function toggleBikeMenu() {
  const menu = $('#bikeMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  // the chip sits in the route sheet, so the menu opens upwards from it
  const chip = $('#bikeChip').getBoundingClientRect();
  menu.style.top = 'auto';
  menu.style.bottom = `${innerHeight - chip.top + 8}px`;
  menu.style.left = `${chip.left}px`;
  menu.style.right = 'auto';
  menu.classList.add('bike-menu');
  menu.innerHTML = S().bikes.map(b => `
    <button data-id="${b.id}" class="${b.id === S().activeBikeId ? 'current' : ''}">
      <span class="bike-badge" style="--bike:${esc(b.color)}">${iconOrEmoji(b.icon, 20)}</span>
      <span><b>${esc(b.name)}</b><small>${bikeSpeed(b, rideList).kmh.toFixed(1)} km/h · ${esc(t(BIKE_TYPES[b.type]?.label || ''))}</small></span>
    </button>`).join('') + '<button data-manage="1"><span class="bike-badge" style="--bike:var(--muted)">＋</span><span><b>Manage bikes</b></span></button>';
  menu.hidden = false;
  menu.querySelectorAll('button').forEach(btn => btn.onclick = () => {
    menu.hidden = true;
    if (btn.dataset.manage) return openSettings('bikes');
    setActiveBike(btn.dataset.id);
  });
}

export function setActiveBike(id) {
  const changed = id !== S().activeBikeId;
  store.update(s => { s.activeBikeId = id; });
  renderBikeChip();
  if (changed && to && !nav) planRoute();
}

// the theme accents plus 8 more, so bikes are easy to tell apart; the accent picker uses the same set
const BIKE_COLORS = [...ACCENTS, '#d93a3a', '#7cb518', '#1e6b45', '#23408e', '#b03aa8', '#8a5a33', '#8a949c', '#1b1f23'];
export const colorChoices = (current, key) => `<div class="choices">${BIKE_COLORS.map(c =>
  `<button class="swatch ${c === current ? 'selected' : ''}" style="background:${c}" data-${key}="${c}" aria-label="${c}"></button>`).join('')}</div>`;
export function editBike(bikeId) {
  const isNew = !bikeId;
  const bike = isNew ? newBike({ name: '', color: ACCENTS[S().bikes.length % ACCENTS.length] }) : { ...S().bikes.find(b => b.id === bikeId) };
  const sp = bikeSpeed(bike, rideList);
  const render = () => {
    openDialog(`
      <h2>${isNew ? 'Add a bike' : 'Edit bike'}</h2>
      <label class="field"><span>Name</span><input type="text" id="bName" value="${esc(bike.name)}" placeholder="e.g. Gazelle, Road bike, Bakfiets"></label>
      <div class="field"><span>Icon</span><div class="choices">${BIKE_ICONS.map(i => `<button class="choice icon-choice ${i === (iconName(bike.icon) || bike.icon) ? 'selected' : ''}" data-icon="${i}" aria-label="${i}">${icon(i, 24)}</button>`).join('')}</div></div>
      <div class="field"><span>Colour</span>${colorChoices(bike.color, 'color')}</div>
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
