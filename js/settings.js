import * as store from './store.js';
import { BIKE_TYPES } from './store.js';
import { ROUTE_STYLES } from './router.js';
import { bikeSpeed } from './memory.js';
import { saveFile } from './native.js';
import { MAP_STYLES, MARKERS, applyTheme } from './theme.js';
import { iconOrEmoji } from './icons.js';
import { LANGUAGES, language, t } from './i18n.js';
import { colorChoices, editBike, renderBikeChip, setActiveBike } from './bikes.js';
import { importGpxFiles } from './drawer.js';
import { ORIENTATIONS, setNavFrame, setTiles, syncGL } from './mapview.js';
import { nav } from './navigation.js';
import { renderOffline } from './offlineui.js';
import { drawMe } from './position.js';
import { pickGpxRoute, reloadRides, rideLayer, rideList, showRiddenRoads } from './rides.js';
import { drawRoutes, options } from './routing-ui.js';
import { $, askConfirm, esc, pickFiles, S, toast } from './ui.js';
import { wxOn, wxUpdate } from './wxui.js';

// ---------------------------------------------------------------- settings

export let currentTab = 'bikes';
export function openSettings(tab = currentTab) {
  currentTab = tab;
  $('#settings').hidden = false;
  $('#bikeMenu').hidden = true;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const body = $('#settingsBody');
  body.innerHTML = ({ bikes: bikesTab, look: lookTab, more: moreTab })[tab]();
  wireSettings(tab, body);
}

export function closeSettings() { $('#settings').hidden = true; }

function bikesTab() {
  return `<div class="section"><h3>Your bikes</h3>
    ${S().bikes.map(b => {
      const sp = bikeSpeed(b, rideList);
      return `<div class="list-item">
        <span class="bike-badge" style="--bike:${esc(b.color)}">${iconOrEmoji(b.icon, 20)}</span>
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
      ${colorChoices(t.accent, 'accent')}
    </div>
    <div class="section"><h3>Map</h3>
      <label class="field"><select id="mapStyle">${Object.entries(MAP_STYLES).map(([k, s]) => `<option value="${k}" ${k === t.mapStyle ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    </div>
    <div class="section"><h3>Your position on the map</h3>
      <div class="choices">${Object.entries(MARKERS).map(([k, l]) => `<button class="choice ${t.marker === k ? 'selected' : ''}" data-marker="${k}">${l}</button>`).join('')}</div>
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
      <label class="toggle"><span>${t('Bike essentials on the map')}</span><input type="checkbox" id="optBikePois" ${S().bikePois !== false ? 'checked' : ''}></label>
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
    on('#optBikePois', 'onchange', e => { store.update(s => { s.bikePois = e.target.checked; }); syncGL(); });
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
