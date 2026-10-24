// Routing through the public BRouter server (OpenStreetMap data), using our own
// "calm" profile (profiles/calm.brf) with values tuned per bike.

import { cumulative } from './geo.js';
import { t } from './i18n.js';
import * as native from './brouter-native.js';
import { analyse } from './roadclass.js';

const BASE = 'https://brouter.de/brouter';
const PROFILE_CACHE_KEY = 'cyclenav:profiles';

// Route styles: how hard we push towards bike paths / straight roads.
export const ROUTE_STYLES = {
  calm:     { label: 'Calm',     desc: 'Bike paths & straight roads, few turns', turn_penalty: 260, neighbourhood_penalty: 1.7,  mainroad_penalty: 1.4, signal_cost: 45 },
  balanced: { label: 'Balanced', desc: 'Prefers bike paths, accepts some turns',  turn_penalty: 160, neighbourhood_penalty: 1.4,  mainroad_penalty: 1.1, signal_cost: 40 },
  direct:   { label: 'Direct',   desc: 'Shorter, still avoids busy roads',        turn_penalty: 70,  neighbourhood_penalty: 1.15, mainroad_penalty: 1.0, signal_cost: 25 },
  offroad:  { label: 'Off-road', desc: 'Trails, gravel and forest paths (MTB)',   turn_penalty: 100, neighbourhood_penalty: 1.3,  mainroad_penalty: 1.3, signal_cost: 30, offroad: true },
};

const templates = {};
const uploads = new Map(loadProfileCache());

function loadProfileCache() {
  try { return JSON.parse(sessionStorage.getItem(PROFILE_CACHE_KEY)) || []; } catch { return []; }
}
function saveProfileCache() {
  try { sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify([...uploads])); } catch { /* ignore */ }
}

export function profileParams(bike, profile = 'calm') {
  const style = ROUTE_STYLES[bike.style] || ROUTE_STYLES.calm;
  return {
    turn_penalty: style.turn_penalty,
    neighbourhood_penalty: style.neighbourhood_penalty,
    mainroad_penalty: style.mainroad_penalty,
    signal_cost: profile === 'nostops' ? 250 : style.signal_cost,
    // E-bikes don't care much about hills; everyone else avoids pointless climbing.
    consider_elevation: bike.avoidHills === false || bike.type === 'ebike' ? 'false' : 'true',
    allow_steps: bike.type === 'cargo' ? 'false' : 'true',
    offroad: style.offroad ? 'true' : 'false',
    avoid_unpaved: bike.avoidUnpaved && !style.offroad ? 'true' : 'false',
  };
}

const ONLINE_TIMEOUT = 8000;       // ms before the web request counts as failed
const OFFLINE_RETRY_AFTER = 30000; // after a failure, go straight to the embedded router for a while

let downUntil = 0;                 // web routing considered unreachable until this time
let localSegments = new Set();     // downloaded BRouter segments (see refreshOfflineSegments)

function timedFetch(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ONLINE_TIMEOUT);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

export async function refreshOfflineSegments() {
  try { localSegments = new Set((await native.listSegments()).map(s => s.name)); } catch { localSegments = new Set(); }
  return localSegments;
}
refreshOfflineSegments();

// 'online' = BRouter web API, 'offline' = embedded router with downloaded data,
// 'none' = no network and no offline routing data.
export function routingMode() {
  if (navigator.onLine !== false && Date.now() >= downUntil) return 'online';
  return native.available() && localSegments.size ? 'offline' : 'none';
}

async function profileText(params, profile = 'calm') {
  const template = templates[profile] ||= await fetch(`profiles/${profile}.brf`).then(r => r.text());
  let text = template;
  for (const [k, v] of Object.entries(params)) {
    // Only the first `assign <name> =` is the parameter definition.
    text = text.replace(new RegExp(`(assign\\s+${k}\\s*=\\s*)\\S+`), `$1${v}`);
  }
  return text;
}

async function profileId(params, force = false, profile = 'calm') {
  const text = await profileText(params, profile);
  // Include the profile's size so an updated .brf gets uploaded again.
  const key = profile + JSON.stringify(params) + text.length;
  if (!force && uploads.has(key)) return uploads.get(key);
  const res = await timedFetch(`${BASE}/profile`, { method: 'POST', body: text });
  const json = await res.json();
  if (!json.profileid) throw new Error(json.error || 'Could not upload routing profile');
  uploads.set(key, json.profileid);
  saveProfileCache();
  return json.profileid;
}

// Fetch one route. `points` = [[lat, lon], ...] (start, vias..., end).
export async function fetchRoute(points, bike, alternative = 0, profile = 'calm') {
  if (navigator.onLine === false || Date.now() < downUntil) return fetchRouteOffline(points, bike, alternative, profile);
  try {
    return await fetchRouteOnline(points, bike, alternative, profile);
  } catch (e) {
    // Network error / timeout (not a routing answer from the server): use the embedded router.
    if (e.routing || !native.available()) throw e;
    downUntil = Date.now() + OFFLINE_RETRY_AFTER;
    return fetchRouteOffline(points, bike, alternative, profile);
  }
}

async function fetchRouteOffline(points, bike, alternative, profile) {
  if (!native.available()) throw new Error(t('No offline routing data for this area'));
  await refreshOfflineSegments();
  if (!native.segmentsForPoints(points).every(n => localSegments.has(n))) {
    throw new Error(t('No offline routing data for this area'));
  }
  const text = await profileText(profileParams(bike, profile), profile);
  return parseRoute(JSON.parse(await native.route(points, text, {}, alternative)));
}

async function fetchRouteOnline(points, bike, alternative, profile) {
  const params = profileParams(bike, profile);
  const lonlats = points.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join('|');
  let lastErr;
  for (const force of [false, true]) {
    const id = await profileId(params, force, profile);
    const url = `${BASE}?lonlats=${lonlats}&profile=${id}&alternativeidx=${alternative}&format=geojson&timode=2`;
    const res = await timedFetch(url);
    const body = await res.text();
    if (res.status >= 502 && res.status <= 504) throw new TypeError(`Routing server unavailable (${res.status})`);
    if (res.ok && body.trim().startsWith('{')) return parseRoute(JSON.parse(body));
    lastErr = new Error(body.trim().split('\n')[0] || `Routing failed (${res.status})`);
    lastErr.routing = true; // a real answer from the server, no point in falling back
    // An expired custom profile is the one case worth retrying with a fresh upload; the server
    // reports it either by name or with an empty 500.
    if (body.trim() && !/profile/i.test(body)) break;
  }
  throw lastErr;
}

const BIKE_TAG = /highway=cycleway|bicycle=designated|cyclestreet=yes|bicycle_road=yes|cycleway(:\w+)?=(lane|track|shared_lane|opposite_lane|opposite_track)|route_bicycle_\w+=yes/;
const BUSY_TAG = /highway=(primary|secondary|trunk)(_link)?/;
const PAVED_TAG = /surface=(paved|asphalt|concrete|paving_stones|sett)/;
const UNPAVED_TAG = /surface=(unpaved|fine_gravel|gravel|compacted|ground|dirt|grass|sand|earth|mud|pebblestone)|tracktype=grade[2-5]|highway=(track|bridleway)/;

function parseRoute(geo) {
  const f = geo.features[0];
  const p = f.properties;
  const coords = f.geometry.coordinates.map(c => [c[1], c[0]]);
  const hints = (p.voicehints || []).map(h => ({ idx: h[0], cmd: h[1], exit: h[2], angle: h[4] }));

  let total = 0, bike = 0, busy = 0, unpaved = 0;
  const rows = p.messages || [];
  for (const row of rows.slice(1)) {
    const d = Number(row[3]) || 0;
    const tags = row[9] || '';
    total += d;
    if (UNPAVED_TAG.test(tags) && !PAVED_TAG.test(tags)) unpaved += d;
    if (BIKE_TAG.test(tags)) bike += d;
    else if (BUSY_TAG.test(tags)) busy += d;
  }
  const turns = hints.filter(h => [2, 4, 5, 7, 10, 11, 12].includes(h.cmd)).length;

  const sa = analyse(rows, coords);
  return {
    coords,
    cum: cumulative(coords),
    segments: sa.segments,
    events: sa.events,
    longestBusy: sa.longestBusy,
    length: Number(p['track-length']),
    ascend: Number(p['filtered ascend']) || 0,
    hints,
    stats: {
      bikeShare: total ? bike / total : 0,
      busyShare: total ? busy / total : 0,
      unpavedShare: total ? unpaved / total : 0,
      turns,
      meters: sa.meters,
      signals: sa.signals,
      risky: sa.risky,
    },
  };
}

// A few alternatives for A -> B, de-duplicated.
export async function fetchAlternatives(from, to, bike, count = 3) {
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => fetchRoute([from, to], bike, i)));
  const routes = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const dup = routes.some(o => Math.abs(o.length - r.value.length) < 15 && o.stats.turns === r.value.stats.turns);
    if (!dup) routes.push(r.value);
  }
  if (!routes.length) {
    const err = results.find(r => r.status === 'rejected');
    throw err ? err.reason : new Error('No route found');
  }
  return routes;
}

// Turn instruction text + icon info for a BRouter voice hint.
const HINT_TEXT = {
  1: 'Continue straight', 2: 'Turn left', 3: 'Bear left', 4: 'Turn sharp left',
  5: 'Turn right', 6: 'Bear right', 7: 'Turn sharp right', 8: 'Keep left', 9: 'Keep right',
  10: 'Make a U-turn', 11: 'Make a U-turn', 12: 'Make a U-turn', 13: 'Continue',
  16: 'Head straight on', 17: 'Take the exit on the left', 18: 'Take the exit on the right',
};

export function hintText(h) {
  if (h.cmd === 14 || h.cmd === 15) {
    return h.exit ? t('At the roundabout, take exit {0}', h.exit) : t('Go through the roundabout');
  }
  return t(HINT_TEXT[h.cmd] || 'Continue');
}

export function isRoundabout(h) { return h.cmd === 14 || h.cmd === 15; }
export function isUturn(h) { return h.cmd >= 10 && h.cmd <= 12; }
