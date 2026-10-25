import * as store from './store.js';
import { t } from './i18n.js';
import { simplify } from './geo.js';
import { applyBike } from './bikes.js';
import { nav, startRecording } from './navigation.js';
import { from, ME, setFrom, setTo, syncInputs, to } from './planner.js';
import { me } from './position.js';
import { drawStart, gpxRoute, planRoute, selected, setGpxRoute, setRestoreSel, setResumeNav, setVias, vias } from './routing-ui.js';
import { askConfirm } from './ui.js';

// ---------------------------------------------------------------- session (survives reloads / app kills)

export const PLAN_KEY = 'cyclenav-session', NAV_KEY = 'cyclenav-nav-session';
const SESSION_MAX_AGE = 6 * 3600 * 1000;

let sessionTimer;
const packPlace = p => p && (p.isMe ? { isMe: true } : { name: p.name, detail: p.detail, latlng: p.latlng });
const packVias = list => list.map(v => ({ ll: [v[0], v[1]], gpx: v.gpx, name: v.name, city: v.city }));
const unpackVias = list => (list || []).map(v => Object.assign([v.ll[0], v.ll[1]], { gpx: v.gpx, name: v.name, city: v.city }));
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
export const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

export function saveNavSession() {
  if (!nav) return;
  const r = nav.recorder;
  lsSet(NAV_KEY, {
    savedAt: Date.now(),
    dest: packPlace(nav.dest),
    vias: packVias(nav.vias || []),
    startedAt: r.startedAt,
    recordOnly: !!nav.recordOnly,
    bikeId: store.activeBike().id,
    rec: { distance: r.distance, movingTime: r.movingTime, points: simplify(r.points, 4) },
  });
}

export function savePlanSession(keepIfEmpty) {
  if (nav) return;
  if (!to) { if (!keepIfEmpty) lsSet(PLAN_KEY, null); return; }
  lsSet(PLAN_KEY, {
    from: packPlace(from), to: packPlace(to), vias: packVias(vias),
    gpx: gpxRoute ? { name: gpxRoute.name, vias: packVias(gpxRoute.vias) } : null,
    selected, bikeId: store.activeBike().id,
  });
}

export function scheduleSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(savePlanSession, 300);
}

export function restoreSession() {
  const ns = lsGet(NAV_KEY);
  if (ns && Date.now() - ns.savedAt < SESSION_MAX_AGE && ns.rec) {
    const name = ns.dest?.name;
    const text = ns.recordOnly || !ns.dest ? t('Resume recording?') : t('Resume your ride to {0}?', ns.dest.isMe ? t('My location') : name);
    askConfirm(text, { ok: 'Resume', cancel: 'Discard' }).then(yes => {
      if (!yes) { lsSet(NAV_KEY, null); return; }
      applyBike(ns.bikeId);
      if (ns.recordOnly || !ns.dest) { startRecording(ns); return; }
      const lastPt = ns.rec.points[ns.rec.points.length - 1];
      setFrom(me || !lastPt ? ME : { name: t('Start'), detail: '', latlng: [lastPt[0], lastPt[1]] }); setTo(ns.dest); setVias(unpackVias(ns.vias)); setGpxRoute(null);
      setResumeNav(ns);
      syncInputs();
      planRoute({ fit: false });
    });
    return;
  }
  lsSet(NAV_KEY, null);
  const ps = lsGet(PLAN_KEY);
  if (!ps?.to) return;
  applyBike(ps.bikeId);
  setFrom(ps.from || ME); setTo(ps.to);
  setVias(unpackVias(ps.vias));
  setGpxRoute(ps.gpx ? { name: ps.gpx.name, vias: unpackVias(ps.gpx.vias) } : null);
  setRestoreSel(ps.selected);
  syncInputs();
  if (!from.isMe) drawStart(from.latlng);
  planRoute({ fit: false });
}
