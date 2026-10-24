// Safety classification of a BRouter route: per-segment road class from the
// message rows (WayTags), plus traffic lights / risky crossings from NodeTags.

export const CLASS_COLORS = {
  path: '#1e8e3e', calm: '#e6c229', shared: '#f08c00', busy: '#d93025', unpaved: '#8d6e63', walk: '#7d8a90',
};
export const CLASS_ORDER = ['path', 'calm', 'shared', 'busy', 'unpaved', 'walk'];

const PAVED = /surface=(paved|asphalt|concrete|paving_stones|sett|concrete:plates|concrete:lanes)/;
const UNPAVED = /surface=(unpaved|fine_gravel|gravel|compacted|ground|dirt|grass|sand|earth|mud|pebblestone)|tracktype=grade[2-5]/;

function parse(tags) {
  const o = {};
  for (const kv of (tags || '').split(' ')) {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return o;
}

function maxspeed(o) {
  const v = o.maxspeed;
  if (!v) return null;
  if (/zone30|living_street/.test(v)) return 30;
  if (/urban/.test(v)) return 50;
  if (/rural|nsl_single/.test(v)) return 80;
  if (/walk/.test(v)) return 7;
  if (v === 'none') return 130;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function classify(tags) {
  const o = parse(tags);
  const hw = (o.highway || '').replace('_link', '');
  const bikeOk = o.bicycle === 'yes' || o.bicycle === 'designated';
  const cw = Object.entries(o).filter(([k]) => k === 'cycleway' || k.startsWith('cycleway:')).map(([, v]) => v);
  const hasTrack = cw.includes('track') || cw.includes('separate');
  const hasLane = cw.some(v => v === 'lane' || v === 'shared_lane');
  const unpaved = (UNPAVED.test(tags) || hw === 'track' || hw === 'bridleway') && !PAVED.test(tags);

  // Walking: pedestrian ways without bike permission, steps, riding against a one-way.
  if (hw === 'steps' || ((hw === 'footway' || hw === 'pedestrian') && !bikeOk)) return 'walk';
  const oneway = o.oneway;
  const wrong = (o.reversedirection === 'yes' && (oneway === 'yes' || oneway === 'true' || oneway === '1'))
    || (o.reversedirection !== 'yes' && oneway === '-1');
  if (wrong && o['oneway:bicycle'] !== 'no' && !cw.some(v => /opposite/.test(v)) && hw !== 'cycleway' && o.junction == null) return 'walk';

  const carFree = hw === 'cycleway' || hw === 'path' || hw === 'track' || hw === 'bridleway' || hw === 'footway' || hw === 'pedestrian';
  if (unpaved && (carFree || !hw || hasTrack || hasLane || hw === 'service' || hw === 'residential' || hw === 'unclassified')) return 'unpaved';
  if (carFree || hasTrack) return 'path';

  const ms = maxspeed(o);
  if (hasLane || o.cyclestreet === 'yes' || o.bicycle_road === 'yes' || hw === 'living_street') return 'calm';
  if (/^(primary|secondary|trunk|motorway)$/.test(hw) || (ms != null && ms >= 60)) return 'busy';
  if (/^(residential|service|unclassified)$/.test(hw)) return ms == null || ms <= 30 ? 'calm' : 'shared';
  return 'shared';
}

// rows = BRouter `messages` (header first), coords = [[lat, lon], ...] of the route.
export function analyse(rows, coords) {
  const out = { segments: [], events: [], meters: {}, signals: 0, risky: 0, longestBusy: null };
  if (!rows || rows.length < 2 || !coords.length) return out;
  const head = rows[0];
  const iLon = head.indexOf('Longitude'), iLat = head.indexOf('Latitude'), iD = head.indexOf('Distance');
  const iW = head.indexOf('WayTags'), iN = head.indexOf('NodeTags');
  if (iLon < 0 || iW < 0) return out;

  let ci = 0, prev = 0, run = null;
  const seg = [];
  // one icon per continuous bridge / tunnel (skipping tiny ones, e.g. over a ditch)
  const endRun = () => { if (run && run.m >= 40) out.events.push({ type: run.type, idx: run.idx, latlng: run.latlng }); run = null; };
  const close = (k, lat, lon) => Math.abs(coords[k][1] - lon) < 3e-6 && Math.abs(coords[k][0] - lat) < 3e-6;
  for (const row of rows.slice(1)) {
    const lon = Number(row[iLon]) / 1e6, lat = Number(row[iLat]) / 1e6;
    let k = ci;
    while (k < coords.length && !close(k, lat, lon)) k++;
    if (k >= coords.length) continue; // couldn't match this row
    ci = k;
    const tags = row[iW] || '';
    const d = Number(row[iD]) || 0;
    if (ci > prev) {
      const o = parse(tags), bt = o.tunnel && o.tunnel !== 'no' ? 'tunnel' : o.bridge && o.bridge !== 'no' ? 'bridge' : null;
      if (run && run.type !== bt) endRun();
      if (bt) { if (!run) run = { type: bt, idx: prev, latlng: [coords[prev][0], coords[prev][1]], m: 0 }; run.m += d; }
      const cls = classify(tags);
      const last = seg[seg.length - 1];
      if (last && last.cls === cls) { last.b = ci; last.m += d; } else seg.push({ cls, a: prev, b: ci, m: d });
      out.meters[cls] = (out.meters[cls] || 0) + d;
      prev = ci;
    }
    const nt = iN >= 0 ? row[iN] || '' : '';
    if (nt) {
      const p = [coords[ci][0], coords[ci][1]];
      const lights = /highway=traffic_signals|crossing=traffic_signals/.test(nt);
      // Crossing a major road (BRouter's estimated crossing class) with no lights.
      const risky = !lights && /estimated_crossing_class=[45]/.test(nt);
      const type = lights ? 'signal' : risky ? 'risky' : null;
      if (type) {
        const near = out.events.some(e => (e.type === type || type === 'risky')
          && Math.hypot((e.latlng[0] - p[0]) * 111000, (e.latlng[1] - p[1]) * 69000) < (e.type === type ? 25 : 40));
        if (!near) { out.events.push({ type, idx: ci, latlng: p }); out[type === 'signal' ? 'signals' : 'risky']++; }
      }
    }
  }
  endRun();
  out.segments = seg;
  for (const s of seg) if (s.cls === 'busy' && (!out.longestBusy || s.m > out.longestBusy.m)) out.longestBusy = s;
  return out;
}
