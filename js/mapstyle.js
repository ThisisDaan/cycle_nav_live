// A calm, Apple Maps-like look for OpenFreeMap's vector tiles (OpenStreetMap data).
// We take the "liberty" style and repaint it with a soft palette, plus bike paths.

import { loadStyle } from './offline.js';

const BASE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const PALETTES = {
  light: {
    land: '#f4f2ee', residential: '#efece6', park: '#cdeac0', wood: '#c4e4b3', sand: '#f3eedd',
    civic: '#ece8e3', water: '#a6d3f6', building: '#e7e3dd', buildingLine: '#dbd6ce', roof: '#f7f4ef', wall: '#cdc7bd',
    motorway: '#f8cf63', motorwayCasing: '#e2ae3e', major: '#fde7a4', majorCasing: '#e8cf86',
    road: '#ffffff', roadCasing: '#dad5cd', path: '#ffffff', rail: '#cfcac3', boundary: '#b9b4ad',
    cycle: '#5cb88a',
    text: '#5d5f63', placeText: '#2f3135', waterText: '#4c7fae', poiText: '#7d7f84', halo: '#ffffff',
  },
  dark: {
    land: '#26282c', residential: '#2a2c31', park: '#26392b', wood: '#24362a', sand: '#34322b',
    civic: '#2c2e33', water: '#183049', building: '#34363b', buildingLine: '#2f3135', roof: '#43464c', wall: '#202226',
    motorway: '#9b7a3a', motorwayCasing: '#6d5528', major: '#5c5a52', majorCasing: '#45443f',
    road: '#45484e', roadCasing: '#34363b', path: '#3d4045', rail: '#4a4c51', boundary: '#5d6066',
    cycle: '#3f8f69',
    text: '#b5b8bd', placeText: '#e4e6ea', waterText: '#7aa6d1', poiText: '#8d9096', halo: '#1d1f22',
  },
};

// [layer id pattern, palette key] — first match wins. Casings before fills.
const RULES = [
  [/^background$/, 'land'],
  [/^park(_outline)?$/, 'park'],
  [/landuse_residential/, 'residential'],
  [/landcover_wood/, 'wood'],
  [/landcover_grass|landuse_pitch|landuse_track|landuse_cemetery|landcover_wetland/, 'park'],
  [/landcover_(ice|sand)/, 'sand'],
  [/landuse_(hospital|school)|aeroway/, 'civic'],
  [/^water$|^waterway(?!.*label)/, 'water'],
  [/motorway.*casing/, 'motorwayCasing'],
  [/motorway/, 'motorway'],
  [/(trunk_primary|link).*casing/, 'majorCasing'],
  [/trunk_primary|_link$/, 'major'],
  [/path_pedestrian.*casing/, 'roadCasing'],
  [/path_pedestrian/, 'path'],
  [/casing/, 'roadCasing'],
  [/secondary_tertiary|minor|street|service_track/, 'road'],
  [/rail/, 'rail'],
  [/^building/, 'building'],
  [/^boundary/, 'boundary'],
];

const TEXT_RULES = [
  [/water/, 'waterText'],
  [/^label_|airport/, 'placeText'],
  [/^poi/, 'poiText'],
];

let baseStyle = null;

async function loadBase() {
  if (!baseStyle) baseStyle = await loadStyle(BASE_STYLE); // tiles, glyphs and sprites go through cnoff:// (offline-capable)
  return structuredClone(baseStyle);
}

export const BIKE_POI = ['bicycle_parking', 'bicycle', 'drinking_water', 'toilets'];

export async function calmStyle(dark) {
  const P = PALETTES[dark ? 'dark' : 'light'];
  const style = await loadBase();

  // Drop the hillshade raster and the busier POI icons for a cleaner map.
  style.layers = style.layers.filter(l => l.id !== 'natural_earth' && l.id !== 'poi_r20');
  delete style.sources.ne2_shaded;

  for (const layer of style.layers) {
    if (layer.id === 'poi_transit' || layer.id === 'poi_r7') layer.minzoom = 16; // fewer icons, like Apple Maps
    const paint = layer.paint ||= {};
    if (layer.type === 'symbol') {
      if (!layer.layout?.['text-field']) continue;
      const rule = TEXT_RULES.find(([re]) => re.test(layer.id));
      paint['text-color'] = P[rule ? rule[1] : 'text'];
      paint['text-halo-color'] = P.halo;
      paint['text-halo-width'] = 1.4;
      continue;
    }
    const rule = RULES.find(([re]) => re.test(layer.id));
    if (!rule) continue;
    const color = P[rule[1]];
    if (layer.type === 'background') paint['background-color'] = color;
    else if (layer.type === 'line') paint['line-color'] = color;
    else if (layer.type === 'fill') {
      paint['fill-color'] = color;
      paint['fill-outline-color'] = rule[1] === 'building' ? P.buildingLine : color;
      if (rule[1] === 'residential') paint['fill-opacity'] = 1;
    } else if (layer.type === 'fill-extrusion') {
      paint['fill-extrusion-color'] = color;
      paint['fill-extrusion-opacity'] = 0.6;
    }
  }

  // Bike paths get a soft green line so you can see the cycling network.
  const at = style.layers.findIndex(l => l.id === 'road_path_pedestrian');
  style.layers.splice(at + 1, 0, {
    id: 'cycleway',
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'transportation',
    minzoom: 12,
    filter: ['all', ['==', ['get', 'class'], 'path'], ['==', ['get', 'subclass'], 'cycleway']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': P.cycle,
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.8, 15, 2, 18, 5],
      'line-opacity': 0.85,
    },
  });

  // Dashed brown line for unpaved roads and tracks; only shown for mountain bikes (see syncBikeLayers in app.js).
  const symAt = style.layers.findIndex(l => l.type === 'symbol');
  style.layers.splice(symAt < 0 ? style.layers.length : symAt, 0, {
    id: 'unpaved-mtb', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 12,
    filter: ['all', ['!', ['in', ['get', 'class'], ['literal', ['rail', 'transit', 'motorway', 'ferry']]]], ['any', ['==', ['get', 'surface'], 'unpaved'], ['==', ['get', 'class'], 'track']]],
    layout: { visibility: 'none', 'line-cap': 'butt' },
    paint: { 'line-color': dark ? '#c9a58f' : '#8d6e63', 'line-dasharray': [2, 2], 'line-opacity': 0.9, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 0.8, 15, 2, 18, 5] },
  });

  // Bike essentials: parking, bike shops, drinking water and toilets as small badges (images made on demand, see bikeBadge in app.js).
  style.layers.push({
    id: 'bike-essentials', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 15,
    filter: ['in', ['get', 'class'], ['literal', BIKE_POI]],
    layout: { 'icon-image': ['concat', 'bk-', ['get', 'class']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 17, 0.85], 'icon-allow-overlap': false, 'icon-padding': 2, 'symbol-sort-key': ['get', 'rank'] },
  });

  // Fake building height for the tilted 3D view: stacked flat fills, shifted "up" on screen
  // (see applyBuildings). Hidden until the 3D view switches them on, so 2D looks as before.
  const bAt = style.layers.reduce((n, l, i) => /^building/.test(l.id) && l.type === 'fill' ? i : n, -1);
  const extra = [];
  BUILDING_CLASSES.forEach((c, k) => {
    const filter = ['all', ['>=', ['coalesce', ['get', 'render_height'], 6], c.min], ['<', ['coalesce', ['get', 'render_height'], 6], c.max]];
    const make = (id, color) => ({
      id: `${id}-${k}`, type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15, filter,
      layout: { visibility: 'none' },
      paint: { 'fill-color': color, 'fill-outline-color': P.wall, 'fill-antialias': true, 'fill-translate': [0, 0], 'fill-translate-anchor': 'viewport' },
    });
    for (let i = 1; i <= WALL_STEPS; i++) extra.push(make(`bld-wall${i}`, P.wall));
    // thick outlines halfway between the slices fill the gaps, so the walls read as solid instead of stacked plates
    for (let i = 0; i <= WALL_STEPS; i++) extra.push({
      id: `bld-seam${i}-${k}`, type: 'line', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15, filter,
      layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': P.wall, 'line-width': 1, 'line-translate': [0, 0], 'line-translate-anchor': 'viewport' },
    });
    extra.push(make('bld-roof', P.roof));
  });
  if (bAt >= 0) style.layers.splice(bAt + 1, 0, ...extra);
  return style;
}

// height class: render_height range (m) and the height drawn for it
const BUILDING_CLASSES = [{ min: 0, max: 10, m: 7 }, { min: 10, max: 25, m: 16 }, { min: 25, max: 1e5, m: 34 }];
const WALL_STEPS = 3;

// Shift the roof layers "up" on screen. The GL canvas is kept screen-aligned (the app turns it back
// against the rotated map), so a viewport-anchored offset straight up is all that is needed.
// `lift` scales the height (pixels per metre at zoom 17).
export function applyBuildings(gl, on, zoom, lift = 1.9) {
  if (!gl?.getLayer?.('bld-roof-0')) return;
  const px = lift * 2 ** (zoom - 17);
  const st = gl._bld || (gl._bld = { on: null, key: '' });
  // quantise to half pixels and skip no-op updates, so tiny jitter never re-styles the map
  const q = v => Math.round(v * 2) / 2;
  const key = on ? [q(px * 34), q(px * 7)].join() : '';
  if (st.on === on && st.key === key) return;
  const first = st.on === null;
  st.on = on; st.key = key;
  BUILDING_CLASSES.forEach((c, k) => {
    for (let i = 1; i <= WALL_STEPS + 1; i++) {
      const id = i > WALL_STEPS ? `bld-roof-${k}` : `bld-wall${i}-${k}`;
      const h = c.m * px * i / (WALL_STEPS + 1);
      if (first) {
        gl.setPaintProperty(id, 'fill-translate-transition', { duration: 0, delay: 0 });
        gl.setPaintProperty(id, 'fill-translate-anchor', 'viewport');
      }
      gl.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      if (on) gl.setPaintProperty(id, 'fill-translate', [0, -q(h)]);
    }
    const gap = c.m * px / (WALL_STEPS + 1);
    for (let i = 0; i <= WALL_STEPS; i++) {
      const id = `bld-seam${i}-${k}`;
      if (first) for (const p of ['line-translate-transition', 'line-width-transition']) gl.setPaintProperty(id, p, { duration: 0, delay: 0 });
      gl.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      if (on) {
        gl.setPaintProperty(id, 'line-translate', [0, -q(gap * (i + 0.5))]);
        gl.setPaintProperty(id, 'line-width', q(gap) + 1);
      }
    }
  });
  // the real extrusions are flat at pitch 0 and would hide the fake walls
  for (const l of gl.getStyle().layers) if (l.type === 'fill-extrusion') gl.setLayoutProperty(l.id, 'visibility', on ? 'none' : 'visible');
}
