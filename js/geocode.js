// Place search via Photon (komoot), which is built on OpenStreetMap data.

import { isOffline, nearestStreet, searchOffline } from './offline.js';

const BASE = 'https://photon.komoot.io';

function label(props) {
  const street = [props.street, props.housenumber].filter(Boolean).join(' ');
  const main = props.name || street || props.city || 'Unnamed place';
  const sub = [props.name && street, props.postcode, props.city || props.town || props.village, props.country]
    .filter(Boolean).filter(s => s !== main);
  return { name: main, detail: [...new Set(sub)].join(', ') };
}

export async function search(query, near, signal) {
  const fallback = async () => searchOffline(query, near).catch(() => []);
  if (isOffline()) return fallback();
  try {
    const params = new URLSearchParams({ q: query, limit: '6' });
    if (near) { params.set('lat', near[0].toFixed(4)); params.set('lon', near[1].toFixed(4)); }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    signal?.addEventListener('abort', () => ctl.abort());
    let res;
    try { res = await fetch(`${BASE}/api/?${params}`, { signal: ctl.signal }); } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('Search failed');
    const json = await res.json();
    return json.features.map(f => ({
      ...label(f.properties),
      latlng: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
    }));
  } catch (e) {
    if (signal?.aborted) throw e;
    const found = await fallback();
    if (found.length) return found;
    throw e;
  }
}

// `layer: 'street'` names the nearest street instead of the nearest shop or house.
export async function reverse(latlng, layer = '') {
  if (!isOffline()) {
    try {
      const res = await fetch(`${BASE}/reverse?lat=${latlng[0]}&lon=${latlng[1]}&limit=1${layer ? `&layer=${layer}` : ''}`);
      const json = await res.json();
      const f = json.features[0];
      if (f) return { ...label(f.properties), latlng };
    } catch { /* fall through */ }
  }
  const street = await nearestStreet(latlng).catch(() => null);
  if (street) return street;
  return { name: `${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)}`, detail: 'Dropped pin', latlng };
}
