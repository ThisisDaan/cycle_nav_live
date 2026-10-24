// Offline routing: thin wrapper around the native BRouter Capacitor plugin
// (android/app/src/main/java/com/cyclenav/app/BRouterPlugin.java).

let plugin = null;

function api() {
  if (!plugin && window.androidBridge && window.Capacitor?.registerPlugin) {
    plugin = window.Capacitor.registerPlugin('BRouter');
  }
  return plugin;
}

export function available() { return !!api(); }

// points = [[lat, lon], ...]; resolves the GeoJSON text, same as the web API.
export async function route(points, profile, params = {}, alternativeidx = 0) {
  const lonlats = points.map(p => [p[1], p[0]]);
  const { geojson } = await api().route({ lonlats, profile, params, alternativeidx });
  return geojson;
}

export async function listSegments() {
  if (!api()) return [];
  return (await api().listSegments()).segments || [];
}

export async function deleteSegment(name) { await api().deleteSegment({ name }); }

export async function downloadSegment(name, onProgress) {
  const h = onProgress
    ? await api().addListener('segmentProgress', e => { if (e.name === name) onProgress(e.loaded, e.total, name); })
    : null;
  try { return await api().downloadSegment({ name }); }
  finally { h?.remove(); }
}

// Accepts {south,west,north,east}, [[s,w],[n,e]] or a Leaflet LatLngBounds.
export function segmentsFor(bounds) {
  let s, w, n, e;
  if (typeof bounds.getSouth === 'function') {
    s = bounds.getSouth(); w = bounds.getWest(); n = bounds.getNorth(); e = bounds.getEast();
  } else if (Array.isArray(bounds)) {
    [[s, w], [n, e]] = bounds;
  } else {
    ({ south: s, west: w, north: n, east: e } = bounds);
  }
  const names = [];
  const cell = v => Math.floor(v / 5) * 5;
  for (let lon = cell(w); lon <= cell(e); lon += 5) {
    for (let lat = cell(s); lat <= cell(n); lat += 5) {
      names.push(`${lon < 0 ? 'W' : 'E'}${Math.abs(lon)}_${lat < 0 ? 'S' : 'N'}${Math.abs(lat)}`);
    }
  }
  return names;
}

// Segments needed for a set of [lat, lon] points (plus the cells between them).
export function segmentsForPoints(points) {
  const lats = points.map(p => p[0]), lons = points.map(p => p[1]);
  return segmentsFor({ south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) });
}
