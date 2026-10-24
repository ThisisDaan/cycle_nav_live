// Persistence: small settings in localStorage, rides (GPS tracks) in IndexedDB.
// Everything stays on this device.

const KEY = 'cyclenav:v1';

export const BIKE_TYPES = {
  city:  { label: 'City / commuter', speed: 17 },
  road:  { label: 'Road bike',       speed: 25 },
  ebike: { label: 'E-bike',          speed: 23 },
  cargo: { label: 'Cargo bike',      speed: 15 },
  mtb:   { label: 'Mountain / gravel', speed: 18 },
};

export const BIKE_ICONS = ['pedal_bike', 'bike', 'electric_bolt', 'terrain', 'speed', 'shopping_bag', 'eco', 'pets'];

const uid = () => Math.random().toString(36).slice(2, 10);

export function newBike(overrides = {}) {
  const type = overrides.type || 'city';
  return {
    id: uid(),
    name: 'My bike',
    icon: 'pedal_bike',
    color: '#2f9e6e',
    type,
    style: type === 'mtb' ? 'offroad' : 'calm',
    speed: BIKE_TYPES[type].speed, // km/h until we have learned it from rides
    avoidHills: type !== 'ebike',
    avoidUnpaved: type === 'road',
    ...overrides,
  };
}

const DEFAULTS = () => {
  const bike = newBike({ name: 'City bike' });
  return {
    bikes: [bike],
    activeBikeId: bike.id,
    theme: { mode: 'light', accent: '#2f9e6e', mapStyle: 'calmLight', marker: 'arrow', appIcon: 'wheel' },
    version: 2,
    voice: true,
    lang: null,            // null = follow the phone's language
    orientation: 'course', // map while navigating: 'course' (riding direction), 'north' or 'compass'
    demo: false,
    recent: [],
    pins: [],              // saved places: { id, name, emoji, note, latlng, show }
    view: null,
  };
};

let state = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && saved.bikes?.length) {
      const d = DEFAULTS();
      // v2: the light, calm map became the default (the old default was too dark).
      if (!saved.version) {
        saved.version = 2;
        if (saved.theme?.mode === 'auto') saved.theme.mode = 'light';
        if (!saved.theme?.mapStyle || saved.theme.mapStyle === 'auto') saved.theme = { ...saved.theme, mapStyle: 'calmLight' };
      }
      return { ...d, ...saved, theme: { ...d.theme, ...saved.theme } };
    }
  } catch { /* fall back to defaults */ }
  return DEFAULTS();
}

export function get() { return state; }

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}

export function update(fn) { fn(state); save(); }

export function replaceAll(next) {
  const d = DEFAULTS();
  state = { ...d, ...next, theme: { ...d.theme, ...next.theme } };
  save();
}

export function activeBike() {
  return state.bikes.find(b => b.id === state.activeBikeId) || state.bikes[0];
}

export function addRecent(place) {
  update(s => {
    s.recent = [place, ...s.recent.filter(r => r.name !== place.name || r.detail !== place.detail)].slice(0, 8);
  });
}

// ---- rides (IndexedDB) ----

let dbPromise;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('cyclenav', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('rides', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('rides', mode);
    const out = fn(t.objectStore('rides'));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });
}

export const rides = {
  all: () => tx('readonly', s => s.getAll()).then(list => (list || []).sort((a, b) => b.startedAt - a.startedAt)),
  put: ride => tx('readwrite', s => s.put(ride)),
  remove: id => tx('readwrite', s => s.delete(id)),
  clear: () => tx('readwrite', s => s.clear()),
};

export function newRideId() { return uid(); }
