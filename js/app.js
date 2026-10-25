import { initNative, isNative, keepAwake, onBackButton } from './native.js';
import { applyTheme } from './theme.js';
import { startTranslating } from './i18n.js';
import { renderBikeChip } from './bikes.js';
import { closeDrawer, drawerOpen } from './drawer.js';
import { installGlPatches, installLeafletPatches, installPanelProbe, setTiles, setupMap, wireViewport } from './mapview.js';
import { nav, openEndSheet, setupButtons } from './navigation.js';
import { hideNearbyMenu, moreOpen, setMore } from './nearby.js';
import { closePicker, picking, wireOffline, wirePicker } from './offlineui.js';
import { closePlaceSheet } from './placesheet.js';
import { hideSuggestions, setupPlanner, to } from './planner.js';
import { startCompass, startGps } from './position.js';
import { reloadRides } from './rides.js';
import { setupSheet } from './routing-ui.js';
import { restoreSession, saveNavSession, savePlanSession } from './session.js';
import { closeSettings } from './settings.js';
import { $, askClose, askState, closeDialog, locked, S, wireDialogs } from './ui.js';
import { setupWeather } from './wxui.js';

// ---------------------------------------------------------------- startup

installLeafletPatches();
installPanelProbe();
init();
// what used to run at import time, after init()'s synchronous part, in the same order
installGlPatches();
wireViewport();
wirePicker();
wireOffline();
wireDialogs();

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
  restoreSession();
  setInterval(saveNavSession, 10000);
  addEventListener('pagehide', () => { saveNavSession(); savePlanSession(true); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(S().theme);
    if (S().theme.mapStyle === 'auto') setTiles();
  });
  // No service worker in the Android app or during local development (it would serve stale files).
  if ('serviceWorker' in navigator && !isNative && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (nav && document.visibilityState === 'visible') keepAwake(true);
    if (document.visibilityState === 'hidden') { saveNavSession(); savePlanSession(true); }
  });
}

// Android back button: close whatever is on top; never quit in the middle of a ride.
function handleBack() {
  if (locked) return true;
  if (picking) { closePicker(); return true; }
  if (askState) { askClose(null); return true; }
  if (drawerOpen) { closeDrawer(); return true; }
  if (closePlaceSheet()) return true;
  if (!$('#dialog').hidden) { closeDialog(); return true; }
  if (!$('#settings').hidden) { closeSettings(); return true; }
  if (!$('#bikeMenu').hidden) { $('#bikeMenu').hidden = true; return true; }
  if (hideNearbyMenu()) return true;
  if (moreOpen) { setMore(false); return true; }
  if (!$('#suggestions').hidden) { hideSuggestions(); document.activeElement?.blur(); return true; }
  if (nav) { openEndSheet(); return true; }
  if (to) { $('#clearBtn').click(); return true; }
  return false;
}
