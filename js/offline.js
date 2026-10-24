// Offline maps: tile/asset cache in IndexedDB, a `cnoff://` protocol for MapLibre, region downloads
// and a small place index (streets, places, POIs, house numbers) decoded from the downloaded tiles.
import Pbf from '../vendor/pbf.js';
import { VectorTile } from '../vendor/vector-tile.js';

const ORIGIN = 'https://tiles.openfreemap.org/';
const TILEJSON_URL = ORIGIN + 'planet';
const STYLE_URL = ORIGIN + 'styles/liberty';
const SCHEME = 'cnoff://';
const MAX_Z = 14;
const NET_TIMEOUT = 6000;
const RECENT_MAX = 6000;              // ~150 MB of "recently viewed" tiles
const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];
const RANGES = ['0-255', '256-511', '8192-8447'];
const SPRITE_FILES = ['.json', '.png', '@2x.json', '@2x.png'];

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  return dbp ||= new Promise((resolve, reject) => {
    const open = indexedDB.open('cyclenav-offline', 1);
    open.onupgradeneeded = () => {
      const d = open.result;
      d.createObjectStore('tiles');
      d.createObjectStore('recent').createIndex('t', 't');
      d.createObjectStore('assets');
      d.createObjectStore('places');
      d.createObjectStore('regions', { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => { dbp = null; reject(open.error); };
  });
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function tx(stores, mode, fn) {
  const d = await db();
  const t = d.transaction(stores, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  const out = await fn(...[].concat(stores).map(s => t.objectStore(s)));
  await done;
  return out;
}
const get = (store, key) => tx(store, 'readonly', s => wrap(s.get(key)));
const put = (store, key, val) => tx(store, 'readwrite', s => wrap(s.put(val, key)));
const getAll = store => tx(store, 'readonly', s => wrap(s.getAll()));

// ---------- online / offline state ----------
let failedAt = 0;
const listeners = new Set();
let lastState = null;
function noteNet(ok) {
  failedAt = ok ? 0 : Date.now();
  const o = isOffline();
  if (o !== lastState) { lastState = o; listeners.forEach(f => { try { f(o); } catch { /* ignore */ } }); }
}
// True when the browser says we are offline, or a network request failed in the last 30 s.
export function isOffline() {
  return (typeof navigator !== 'undefined' && navigator.onLine === false) || (failedAt > 0 && Date.now() - failedAt < 30000);
}
// Subscribe to online/offline changes; returns an unsubscribe function.
export function onOfflineChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => noteNet(true));
  window.addEventListener('offline', () => noteNet(false));
}

async function netFetch(url, outer, timeout = NET_TIMEOUT) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    noteNet(true);
    return res;
  } catch (e) {
    if (!outer?.aborted) noteNet(false);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

// ---------- cached assets (style, TileJSON, glyphs, sprites) ----------
async function cachedBuffer(url, signal) {
  if (!isOffline()) {
    try {
      const res = await netFetch(url, signal);
      if (res.ok) {
        const d = await res.arrayBuffer();
        put('assets', url, d).catch(() => {});
        return d;
      }
    } catch (e) { if (signal?.aborted) throw e; }
  }
  const d = await get('assets', url);
  if (d) return d;
  throw new Error('Not available offline: ' + url);
}
async function cachedJSON(url) {
  return JSON.parse(new TextDecoder().decode(await cachedBuffer(url)));
}

let tileTemplate = null;
async function ensureTemplate() {
  if (!tileTemplate) tileTemplate = (await cachedJSON(TILEJSON_URL)).tiles[0];
  return tileTemplate;
}
const tileUrl = (tpl, z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// Fetches a style (network first, else the cached copy) and points its vector tiles, glyphs and
// sprites at the cnoff:// protocol so they work offline.
export async function loadStyle(styleUrl = STYLE_URL) {
  const style = await cachedJSON(styleUrl);
  const tj = await cachedJSON(TILEJSON_URL);
  tileTemplate = tj.tiles[0];
  for (const [k, src] of Object.entries(style.sources)) {
    if (src.type !== 'vector') continue;
    const s = { type: 'vector', tiles: [SCHEME + 't/{z}/{x}/{y}'], minzoom: 0, maxzoom: tj.maxzoom ?? MAX_Z };
    if (tj.bounds) s.bounds = tj.bounds;
    if (src.attribution || tj.attribution) s.attribution = src.attribution || tj.attribution;
    style.sources[k] = s;
  }
  const re = s => typeof s === 'string' && s.startsWith(ORIGIN) ? SCHEME + 'a/' + s.slice(ORIGIN.length) : s;
  if (style.glyphs) style.glyphs = re(style.glyphs);
  if (style.sprite) style.sprite = re(style.sprite);
  return style;
}

// ---------- tile math ----------
function norm(b) {
  if (!b) throw new Error('Bounds required');
  if (typeof b.getSouth === 'function') return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  if (Array.isArray(b) && Array.isArray(b[0])) return { s: Math.min(b[0][0], b[1][0]), w: Math.min(b[0][1], b[1][1]), n: Math.max(b[0][0], b[1][0]), e: Math.max(b[0][1], b[1][1]) };
  if ('south' in b) return { s: b.south, w: b.west, n: b.north, e: b.east };
  if ('s' in b) return { s: b.s, w: b.w, n: b.n, e: b.e };
  throw new Error('Unsupported bounds');
}
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
};
function ranges(b) {
  const out = [];
  for (let z = 0; z <= MAX_Z; z++) {
    const m = 2 ** z - 1;
    out.push({ z, x0: Math.max(0, lon2x(b.w, z)), x1: Math.min(m, lon2x(b.e, z)), y0: Math.max(0, lat2y(Math.min(b.n, 85.05), z)), y1: Math.min(m, lat2y(Math.max(b.s, -85.05), z)) });
  }
  return out;
}
const count = r => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
// Measured average vector tile sizes per zoom (urban NL; rural tiles are smaller).
const TILE_KB = [80, 220, 1560, 1100, 790, 500, 440, 400, 255, 280, 170, 90, 70, 56, 73];
const perTile = z => TILE_KB[z] * 1000;

// Tile count and approximate size in bytes of a map region (bounds as [[s,w],[n,e]] or a Leaflet LatLngBounds).
export function estimateRegion(bounds) {
  const rs = ranges(norm(bounds));
  let tiles = 0, bytes = 0;
  for (const r of rs) { tiles += count(r); bytes += count(r) * perTile(r.z); }
  // Every region also carries the ~5 MB of z0-9 tiles plus fonts/sprites/index (~7 MB fixed).
  return { tiles, bytes: bytes + 7e6 };
}

// ---------- MapLibre protocol ----------
async function trimRecent() {
  const n = await tx('recent', 'readonly', s => wrap(s.count()));
  if (n <= RECENT_MAX) return;
  await tx('recent', 'readwrite', s => new Promise(res => {
    let left = n - RECENT_MAX + 200;
    const c = s.index('t').openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || left-- <= 0) return res();
      cur.delete(); cur.continue();
    };
    c.onerror = () => res();
  }));
}
let recentWrites = 0;

// Downloaded region tiles win (fast, no data); otherwise network, remembered in the "recent" cache.
async function handleTile(key, signal) {
  const [z, x, y] = key.split('/').map(Number);
  const stored = await get('tiles', key).catch(() => null);
  if (stored) return stored.d;
  if (!isOffline()) {
    try {
      const res = await netFetch(tileUrl(await ensureTemplate(), z, x, y), signal);
      if (res.ok) {
        const d = await res.arrayBuffer();
        put('recent', key, { d, t: Date.now() }).then(() => { if (++recentWrites % 100 === 0) trimRecent(); }).catch(() => {});
        return d;
      }
    } catch (e) { if (signal?.aborted) throw e; }
  }
  return (await get('recent', key).catch(() => null))?.d || new ArrayBuffer(0);
}

function register() {
  if (typeof maplibregl === 'undefined' || register.done) return;
  register.done = true;
  maplibregl.addProtocol('cnoff', async (params, abortController) => {
    const signal = abortController?.signal;
    const path = params.url.slice(SCHEME.length).split('?')[0];
    try {
      if (path.startsWith('t/')) return { data: await handleTile(path.slice(2), signal) };
      if (path.startsWith('a/')) {
        const buf = await cachedBuffer(ORIGIN + path.slice(2), signal);
        return { data: params.type === 'json' ? JSON.parse(new TextDecoder().decode(buf)) : buf };
      }
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    return { data: params.type === 'json' ? {} : new ArrayBuffer(0) };
  });
}
register();

// ---------- places index ----------
export const normalize = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const mercM = z => 40075016.686 / 2 ** z / 4096; // metres per tile unit at the equator
const toLat = (y, z, ty) => Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + y / 4096) / 2 ** z))) * 180 / Math.PI;
const toLon = (x, z, tx) => (tx + x / 4096) / 2 ** z * 360 - 180;
const r5 = v => Math.round(v * 1e5) / 1e5;

function decimate(pts, n) {
  if (pts.length <= n) return pts;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pts[Math.round(i * (pts.length - 1) / (n - 1))]);
  return out;
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function approxDist(la1, lo1, la2, lo2) {
  const dy = (la2 - la1) * 111320, dx = (lo2 - lo1) * 111320 * Math.cos(la1 * Math.PI / 180);
  return Math.hypot(dx, dy);
}

// Pulls searchable names out of a z14 vector tile.
function extractPlaces(buf, tx_, ty_) {
  const z = MAX_Z;
  const tile = new VectorTile(new Pbf(buf));
  const out = [];
  const streets = new Map();       // name -> lines [[x,y]...] in tile units
  const pt = (x, y) => [toLat(y, z, ty_), toLon(x, z, tx_)];
  const first = f => f.loadGeometry()[0]?.[0];
  const tn = tile.layers.transportation_name;
  if (tn) for (let i = 0; i < tn.length; i++) {
    const f = tn.feature(i);
    const name = f.properties.name;
    if (!name) continue;
    const lines = f.loadGeometry().map(l => l.map(p => [p.x, p.y])).filter(l => l.length > 1);
    if (!streets.has(name)) streets.set(name, []);
    streets.get(name).push(...lines);
  }
  for (const [name, lines] of streets) {
    if (!lines.length) continue;
    const ln = lines.slice(0, 8).map(l => decimate(l, 12).map(([x, y]) => pt(x, y).map(r5)));
    const mid = ln[0][Math.floor(ln[0].length / 2)];
    out.push({ name, norm: normalize(name), kind: 'street', lat: mid[0], lon: mid[1], ln });
  }
  for (const [layer, kind] of [['place', 'place'], ['poi', 'poi']]) {
    const L = tile.layers[layer];
    if (!L) continue;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      const name = f.properties.name, g = first(f);
      if (!name || !g) continue;
      const [lat, lon] = pt(g.x, g.y);
      out.push({ name, norm: normalize(name), kind, cls: f.properties.class, lat: r5(lat), lon: r5(lon) });
    }
  }
  const hn = tile.layers.housenumber;
  if (hn && streets.size) {
    const maxD = 60 / (mercM(z) * Math.cos(toLat(2048, z, ty_) * Math.PI / 180));
    for (let i = 0; i < hn.length; i++) {
      const f = hn.feature(i);
      const num = f.properties.housenumber, g = first(f);
      if (!num || !g) continue;
      let best = null, bd = maxD;
      for (const [name, lines] of streets) for (const l of lines) for (let k = 0; k < l.length - 1; k++) {
        const d = segDist(g.x, g.y, l[k], l[k + 1]);
        if (d < bd) { bd = d; best = name; }
      }
      if (!best) continue;
      const [lat, lon] = pt(g.x, g.y);
      out.push({ name: best, norm: normalize(best), kind: 'house', hn: String(num), lat: r5(lat), lon: r5(lon) });
    }
  }
  return out;
}

const placeKey = p => `${p.kind}|${p.norm}|${p.hn || ''}|${Math.round(p.lat * 600)}|${Math.round(p.lon * 600)}`;

let placeCache = null;
async function allPlaces() {
  return placeCache ||= await getAll('places');
}

// Adds a nearby town/village name so results read "Street, Town".
function addCities(list) {
  const rank = { city: 0, town: 0, village: 0, hamlet: 1, suburb: 1, borough: 1 };
  const towns = list.filter(p => p.kind === 'place' && p.cls in rank);
  for (const p of list) {
    if (p.kind === 'place') continue;
    let best = null, bd = 12000;
    for (const t of towns) {
      const d = approxDist(p.lat, p.lon, t.lat, t.lon) + rank[t.cls] * 1500;
      if (d < bd) { bd = d; best = t; }
    }
    if (best) p.city = best.name;
  }
}

// Searches downloaded regions. `near` = [lat, lon]. Returns [{ name, detail, latlng }] like Photon search.
export async function searchOffline(q, near) {
  const query = normalize(q || '');
  if (!query) return [];
  let street = query, num = null;
  const m = query.match(/^(.+?)\s+(\d+\s?[a-z]?)$/);
  if (m) { street = m[1]; num = m[2].replace(/\s/g, ''); }
  const quality = n => n === street ? 0 : n.startsWith(street) ? 1 : n.includes(' ' + street) ? 2 : n.includes(street) ? 3 : -1;
  const hits = [];
  for (const p of await allPlaces()) {
    const q0 = quality(p.norm);
    if (q0 < 0) continue;
    if (p.kind === 'house') {
      if (num !== null && p.hn.toLowerCase().replace(/\s/g, '') === num) hits.push({ p, q: q0 - 0.5 });
    } else if (num === null) hits.push({ p, q: q0 });
    else if (p.kind === 'street') hits.push({ p, q: q0 + 0.5 });  // "Street 14" without that number: the street
  }
  const kindRank = { place: 0, street: 1, poi: 2, house: 3 };
  const d = p => approxDist(near[0], near[1], p.lat, p.lon);
  hits.sort((a, b) => a.q - b.q || (near ? d(a.p) - d(b.p) : kindRank[a.p.kind] - kindRank[b.p.kind]));
  const seen = new Set(), out = [];
  for (const { p } of hits) {
    const name = p.kind === 'house' ? `${p.name} ${p.hn}` : p.name;
    const k = name + '|' + (p.city || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, detail: p.city && p.city !== name ? p.city : '', latlng: [p.lat, p.lon] });
    if (out.length >= 6) break;
  }
  return out;
}

// Nearest named street within ~150 m of a point, or null. Same shape as a search result.
export async function nearestStreet(latlng) {
  const [la, lo] = latlng;
  const kx = 111320 * Math.cos(la * Math.PI / 180), ky = 111320;
  let best = null, bd = 150;
  for (const p of await allPlaces()) {
    if (p.kind !== 'street' || Math.abs(p.lat - la) > 0.03) continue;
    for (const l of p.ln) for (let k = 0; k < l.length - 1; k++) {
      const a = l[k], b = l[k + 1];
      const d = segDist(0, 0, [(a[1] - lo) * kx, (a[0] - la) * ky], [(b[1] - lo) * kx, (b[0] - la) * ky]);
      if (d < bd) { bd = d; best = p; }
    }
  }
  return best ? { name: best.name, detail: best.city || '', latlng } : null;
}

// ---------- regions ----------
// Downloaded regions, newest first: { id, name, bounds: {s,w,n,e}, minZoom, maxZoom, tiles, bytes, places, date }.
export async function listRegions() {
  return (await getAll('regions')).sort((a, b) => b.date - a.date);
}

const inRange = (rs, z, x, y) => { const r = rs[z]; return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; };

// Removes a region; tiles and places shared with other regions are kept.
export async function deleteRegion(id) {
  const all = await getAll('regions');
  const reg = all.find(r => r.id === id);
  if (!reg) return;
  const others = all.filter(r => r.id !== id).map(r => ranges(r.bounds));
  const mine = ranges(reg.bounds);
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(['tiles', 'places', 'regions'], 'readwrite');
    const ts = t.objectStore('tiles');
    for (const r of mine) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
      if (!others.some(o => inRange(o, r.z, x, y))) ts.delete(`${r.z}/${x}/${y}`);
    }
    const c = t.objectStore('places').openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return;
      const v = cur.value;
      if (v.r.includes(id)) {
        v.r = v.r.filter(x => x !== id);
        if (v.r.length) cur.update(v); else cur.delete();
      }
      cur.continue();
    };
    t.objectStore('regions').delete(id);
    t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error);
  });
  placeCache = null;
}

// Downloads every tile of the region (z0-14), fonts, sprites and builds the search index.
// Returns { id, promise, cancel }. `promise` resolves with the region record and rejects with an
// AbortError after cancel() (partial tiles are rolled back). onProgress({ phase, done, total, bytes })
// with phase 'assets' | 'tiles' | 'index'.
export function downloadRegion(name, bounds, onProgress = () => {}) {
  const b = norm(bounds);
  const id = 'r' + Date.now().toString(36);
  const ctl = new AbortController();
  const promise = run();
  return { id, promise, cancel: () => ctl.abort() };

  async function run() {
    const signal = ctl.signal;
    const abortErr = () => new DOMException('Cancelled', 'AbortError');
    const fetchBuf = async url => {
      let err;
      for (let i = 0; i < 3; i++) {
        if (signal.aborted) throw abortErr();
        try {
          const res = await netFetch(url, signal, 20000);
          if (res.status === 404) return null;
          if (res.ok) return await res.arrayBuffer();
          err = new Error('HTTP ' + res.status);
        } catch (e) { if (signal.aborted) throw abortErr(); err = e; }
        await new Promise(r => setTimeout(r, 400 * (i + 1)));
      }
      throw err;
    };
    const rs = ranges(b);
    const added = [];
    let bytes = 0;
    try {
      const style = await loadStyle();
      const tpl = await ensureTemplate();

      // 1. fonts and sprites
      const urls = [];
      for (const f of FONTS) for (const r of RANGES) urls.push(ORIGIN + 'fonts/' + encodeURIComponent(f) + '/' + r + '.pbf');
      const spriteBase = style.sprite.replace(SCHEME + 'a/', ORIGIN);
      for (const ext of SPRITE_FILES) urls.push(spriteBase + ext);
      let done = 0;
      onProgress({ phase: 'assets', done, total: urls.length, bytes });
      for (const u of urls) {
        const d = await fetchBuf(u);
        if (d) { await put('assets', u, d); bytes += d.byteLength; }
        onProgress({ phase: 'assets', done: ++done, total: urls.length, bytes });
      }

      // 2. tiles (z14 ones also feed the search index)
      const jobs = [];
      for (const r of rs) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push([r.z, x, y]);
      const total = jobs.length;
      let next = 0;
      done = 0;
      const places = new Map();
      onProgress({ phase: 'tiles', done, total, bytes });
      const worker = async () => {
        while (next < total) {
          if (signal.aborted) throw abortErr();
          const [z, x, y] = jobs[next++];
          const key = `${z}/${x}/${y}`;
          let rec = await get('tiles', key);
          if (!rec) {
            const d = await fetchBuf(tileUrl(tpl, z, x, y));
            rec = { d: d || new ArrayBuffer(0) };
            await put('tiles', key, rec);
            added.push(key);
          }
          bytes += rec.d.byteLength;
          if (z === MAX_Z && rec.d.byteLength) {
            try { for (const p of extractPlaces(rec.d, x, y)) places.set(placeKey(p), p); } catch { /* bad tile: skip its index */ }
          }
          onProgress({ phase: 'tiles', done: ++done, total, bytes });
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      if (signal.aborted) throw abortErr();

      // 3. search index
      const list = [...places.values()];
      addCities(list);
      onProgress({ phase: 'index', done: 0, total: list.length, bytes });
      const d = await db();
      await new Promise((res, rej) => {
        const t = d.transaction('places', 'readwrite');
        const s = t.objectStore('places');
        for (const p of list) {
          const k = placeKey(p);
          const g = s.get(k);
          g.onsuccess = () => { const old = g.result; s.put({ ...p, r: old ? [...new Set([...old.r, id])] : [id] }, k); };
        }
        t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error);
      });
      placeCache = null;
      onProgress({ phase: 'index', done: list.length, total: list.length, bytes });

      const region = { id, name, bounds: b, minZoom: 0, maxZoom: MAX_Z, tiles: total, bytes, places: list.length, date: Date.now() };
      await tx('regions', 'readwrite', s => wrap(s.put(region)));
      return region;
    } catch (e) {
      // Roll back what this attempt added so a cancelled or failed download leaves nothing behind.
      if (added.length) await tx('tiles', 'readwrite', s => { added.forEach(k => s.delete(k)); }).catch(() => {});
      throw e;
    }
  }
}
