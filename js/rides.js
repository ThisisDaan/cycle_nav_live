import * as store from './store.js';
import { newRideId } from './store.js';
import { buildIndex } from './memory.js';
import { Recorder } from './nav.js';
import { t } from './i18n.js';
import { dist, fmtDist, fmtDuration, resample } from './geo.js';
import { renderBikeChip } from './bikes.js';
import { map } from './mapview.js';
import { ME, setFrom, setTo, syncInputs } from './planner.js';
import { me } from './position.js';
import { planRoute, setGpxRoute, setVias, vias } from './routing-ui.js';
import { $, closeDialog, esc, openDialog, pickFiles, S, toast } from './ui.js';

export let rideLayer;

export let rideList = [], cells = new Set();

export async function reloadRides() {
  try { rideList = await store.rides.all(); } catch { rideList = []; }
  cells = buildIndex(rideList);
  renderBikeChip();
  if (rideLayer) showRiddenRoads(true);
}

// ---------------------------------------------------------------- rides

export function offerSaveRide(session, arrived) {
  const rec = session.recorder;
  const bike = store.activeBike();
  openDialog(`
    <h2>${arrived ? 'You made it!' : 'Save this ride?'}</h2>
    <p>${session.sim ? 'This was a simulated demo ride — you probably want to discard it.' : 'Saved rides teach Cycle Nav your favourite ways and your real speed.'}</p>
    <div class="stat-row">
      <div><b>${fmtDist(rec.distance)}</b><span>distance</span></div>
      <div><b>${fmtDuration(rec.movingTime)}</b><span>moving</span></div>
      <div><b>${rec.speedKmh ? rec.speedKmh.toFixed(1) : '–'}</b><span>km/h avg</span></div>
    </div>
    <label class="field"><span>Ridden on</span>
      <select id="saveBike">${S().bikes.map(b => `<option value="${b.id}" ${b.id === bike.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    </label>
    <label class="field"><span>Name (optional)</span>
      <input type="text" id="saveName" placeholder="${esc(session.dest?.name ? t('To {0}', session.dest.name) : t('Ride'))}">
    </label>
    <div class="dialog-actions">
      <button class="secondary-btn" id="discardRide">Discard</button>
      <button class="primary-btn" id="saveRide">Save ride</button>
    </div>`);
  $('#discardRide').onclick = closeDialog;
  $('#saveRide').onclick = async () => {
    const name = $('#saveName').value.trim() || (session.dest?.name ? t('To {0}', session.dest.name) : t('Ride'));
    const ride = rec.toRide(newRideId(), $('#saveBike').value, name);
    if (session.sim) ride.movingTime = 0; // don't learn speed from a simulation
    await store.rides.put(ride);
    closeDialog();
    await reloadRides();
    toast('Ride saved — I’ll remember this way');
  };
}

// ---- follow a GPX route: guide the router along the track with many via points

export function pickGpxRoute() {
  pickFiles('.gpx,application/gpx+xml,application/octet-stream', false, files => openGpxRoute(files[0]));
}

async function openGpxRoute(file) {
  let parsed;
  try { parsed = parseGpx(await file.text()); } catch { parsed = { pts: [] }; }
  const track = parsed.pts.map(p => p.latlng);
  if (track.length < 2) { toast('No route or track found in that GPX file'); return; }
  await followTrack(track, parsed.name || file.name.replace(/\.gpx$/i, ''));
}

// Plan a route that sticks to a recorded or imported track.
export async function followTrack(track, name) {
  // A guide point every ~400 m keeps the route on the GPX's roads.
  const len = track.reduce((d, p, i) => i ? d + dist(track[i - 1], p) : 0, 0);
  const n = Math.max(1, Math.min(50, Math.round(len / 400)));
  const guide = resample(track, len / (n + 1)).slice(1, n + 1).map(p => Object.assign([p[0], p[1]], { gpx: true }));

  const start = Object.assign(track[0].slice(), { gpx: true });
  // From where you are now, first ride to the start of the track (unless you're already there).
  const fromMe = me && dist(me.latlng, track[0]) > 150;
  setFrom(me ? ME : { name: t('Start of {0}', name), detail: 'GPX', latlng: track[0] });
  setTo({ name, detail: t('End of GPX route'), latlng: track[track.length - 1] });
  setVias(fromMe ? [start, ...guide] : guide);
  setGpxRoute({ name, vias: vias.slice() });
  syncInputs();
  toast(t('Following {0} ({1})', name, fmtDist(len)));
  await planRoute();
}

// A ride as a GPX track (with timestamps when it was really ridden).
export function toGpx(ride) {
  const x = s => esc(s);
  const pts = ride.points.map(p => {
    const time = p[2] != null && ride.source !== 'planned' ? `<time>${new Date(ride.startedAt + p[2] * 1000).toISOString()}</time>` : '';
    return `<trkpt lat="${p[0]}" lon="${p[1]}">${time}</trkpt>`;
  }).join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cycle Nav" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${x(ride.name || 'Ride')}</name><time>${new Date(ride.startedAt).toISOString()}</time></metadata>
  <trk>
    <name>${x(ride.name || 'Ride')}</name>
    <type>cycling</type>
    <trkseg>
      ${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const pts = [...doc.querySelectorAll('trkpt, rtept')].map(el => ({
    latlng: [+el.getAttribute('lat'), +el.getAttribute('lon')],
    time: Date.parse(el.querySelector('time')?.textContent || '') || null,
  })).filter(p => Number.isFinite(p.latlng[0]) && Number.isFinite(p.latlng[1]));
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim();
  return { pts, name };
}

export async function importGpx(files) {
  const bike = store.activeBike();
  let ok = 0;
  for (const file of files) {
    try {
      const { pts, name } = parseGpx(await file.text());
      if (pts.length < 2) continue;
      const rec = new Recorder();
      const timed = pts.every(p => p.time);
      let t = timed ? pts[0].time : Date.now();
      rec.startedAt = t;
      for (let i = 0; i < pts.length; i++) {
        if (timed) t = pts[i].time;
        else if (i) t += dist(pts[i - 1].latlng, pts[i].latlng) / (bike.speed / 3.6) * 1000;
        rec.add(pts[i].latlng, 5, t);
      }
      const ride = rec.toRide(newRideId(), bike.id, name || file.name.replace(/\.gpx$/i, ''));
      ride.endedAt = t;
      ride.source = 'gpx';
      if (!timed) ride.movingTime = 0; // no real timing info, don't learn speed from it
      await store.rides.put(ride);
      ok++;
    } catch { /* skip broken file */ }
  }
  await reloadRides();
  toast(ok ? t('Imported {0} rides for {1}', ok, bike.name) : t('No usable GPX tracks found'));
}

export function showRiddenRoads(on) {
  rideLayer?.remove();
  rideLayer = null;
  if (!on) return;
  rideLayer = L.layerGroup(rideList.map(r => L.polyline(r.points, {
    color: S().bikes.find(b => b.id === r.bikeId)?.color || S().theme.accent,
    weight: 4, opacity: .45, interactive: false,
  }))).addTo(map);
}
