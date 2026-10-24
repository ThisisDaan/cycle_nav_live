// Online details for a tapped place: OSM tags from Nominatim, rendered as compact popup rows.

import { t } from './i18n.js';
import { icon } from './icons.js';
import { DAY_NAMES, formatStatus, hoursStatus, parseHours, weekStrings } from './hours.js';

const cache = new Map();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dist = (a, b) => {
  const k = Math.PI / 180, dx = (b[1] - a[1]) * k * Math.cos(a[0] * k), dy = (b[0] - a[0]) * k;
  return Math.hypot(dx, dy) * 6371000;
};


// -> tags object or null, cached per place (name + rounded coordinates).
// Nominatim (OSM search) answers fast and returns the place's OSM tags as extratags; Overpass is often
// overloaded. Looks for the same name within ~60 m and turns the result back into OSM-style tags.
export async function lookupPlace(name, ll, category = null) {
  const key = `${category || name.toLowerCase()}|${ll[0].toFixed(4)}|${ll[1].toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  const [lat, lon] = ll, dy = category === 'station' ? 0.002 : category ? 0.0003 : 0.0006, dx = dy / Math.cos(lat * Math.PI / 180);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=5&bounded=1`
    + `&q=${encodeURIComponent(category && category !== 'station' ? category.replace(/_/g, ' ') : name)}&viewbox=${lon - dx},${lat + dy},${lon + dx},${lat - dy}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const n = name.toLowerCase();
  const hits = (await r.json()).filter(h => { if (category === 'station') return h.category === 'railway' && ['station', 'halt'].includes(h.type); if (category) return h.type === category; const m = (h.name || '').toLowerCase(); return m && (m.includes(n) || n.includes(m)); });
  const best = hits.map(h => ({ h, d: dist(ll, [+h.lat, +h.lon]) })).sort((a, b) => a.d - b.d)[0]?.h;
  let tags = null;
  if (best) {
    const a = best.address || {};
    tags = { ...best.extratags, name: best.name || name, [best.category]: best.type };
    if (a.road) tags['addr:street'] = a.road;
    if (a.house_number) tags['addr:housenumber'] = a.house_number;
    if (a.postcode) tags['addr:postcode'] = a.postcode;
    const city = a.city || a.town || a.village;
    if (city) tags['addr:city'] = city;
    if (a.country_code) tags['addr:country'] = a.country_code;
    // stations rarely carry a website in OSM, but their Wikidata item usually names the official one
    if (isStation(tags) && !tags.website && !tags['contact:website'] && tags.wikidata) {
      try {
        const w = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${encodeURIComponent(tags.wikidata)}&property=P856&format=json&origin=*`, { signal: AbortSignal.timeout(6000) })).json();
        const url = w.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
        if (url) tags.website = url;
      } catch {}
    }
  }
  cache.set(key, tags);
  return tags;
}
export const cachedPlace = (name, ll, category = null) => {
  const key = `${category || name.toLowerCase()}|${ll[0].toFixed(4)}|${ll[1].toFixed(4)}`;
  return cache.has(key) ? { tags: cache.get(key) } : null;
};

const CUISINE = {
  coffee_shop: 'Coffee shop', pizza: 'Pizza', burger: 'Burgers', italian: 'Italian', chinese: 'Chinese', sushi: 'Sushi', ice_cream: 'Ice cream',
  dutch: 'Dutch', indian: 'Indian', thai: 'Thai', japanese: 'Japanese', turkish: 'Turkish', greek: 'Greek', french: 'French', mexican: 'Mexican',
  kebab: 'Kebab', sandwich: 'Sandwiches', bakery: 'Bakery', regional: 'Regional', vegetarian: 'Vegetarian', asian: 'Asian', pancake: 'Pancakes', steak_house: 'Steakhouse',
};
const pretty = s => { s = s.trim().replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

export function website(v) {
  v = String(v).trim();
  const url = /^https?:\/\//i.test(v) ? v : 'https://' + v;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return { href: u.href, label: u.hostname.replace(/^www\./, '') }; } catch { return null; }
}

function hoursHtml(raw) {
  const week = parseHours(raw);
  if (!week) return `<div class="pp-row"><span class="pp-ic">${icon('schedule', 16)}</span><span class="selectable">${esc(raw)}</span></div>`;
  const status = formatStatus(hoursStatus(week), t);
  const today = (new Date().getDay() + 6) % 7;
  const rows = weekStrings(week, t('Closed')).map((s, i) => `<div class="${i === today ? 'pp-today' : ''}"><span>${esc(t(DAY_NAMES[i].slice(0, 3)))}</span><span>${esc(s === '24h' ? t('Open 24/7') : s)}</span></div>`).join('');
  return `<details class="pp-row pp-hours"><summary data-show="${esc(t('All hours'))}" data-hide="${esc(t('Hide'))}"><span class="pp-ic">${icon('schedule', 16)}</span><span>${esc(status)}</span></summary><div class="pp-week">${rows}</div></details>`;
}

export const isStation = tags => ['station', 'halt'].includes(tags?.railway) || tags?.public_transport === 'station' && tags?.train === 'yes';

// Where to plan a train trip from this station: the national rail planner where we know its link
// format, otherwise Google Maps public transport directions (works everywhere).
export function trainPlanner(name, ll, country) {
  const n = encodeURIComponent(name);
  return {
    nl: `https://www.ns.nl/reisplanner/#/?vertrek=${n}`,
    de: `https://www.bahn.de/buchung/fahrplan/suche#sts=true&so=${n}`,
    be: 'https://www.belgiantrain.be/nl/travel-info/journey-planner',
    lv: 'https://www.pv.lv/',
  }[country] || `https://www.google.com/maps/dir/?api=1&destination=${ll[0]},${ll[1]}&travelmode=transit`;
}

// Call / website targets for the place sheet's buttons.
export function placeLinks(tags) {
  const phone = (tags?.phone || tags?.['contact:phone'] || '').split(';')[0].trim();
  return { tel: phone ? 'tel:' + phone.replace(/[^+\d]/g, '') : null, site: website(tags?.website || tags?.['contact:website'] || '')?.href || null };
}

export function detailsHtml(tags) {
  if (!tags) return '';
  const row = (ic, inner) => `<div class="pp-row"><span class="pp-ic">${ic}</span><span>${inner}</span></div>`;
  const out = [];
  if (tags.amenity === 'bicycle_parking' || tags.bicycle_parking) {
    // what kind of bike parking: a guarded garage or a rack on the street makes a big difference
    const kind = { building: 'Indoor bike garage', lockers: 'Bike lockers', shed: 'Bike shed', stands: 'Bike stands', wall_loops: 'Wheel racks', rack: 'Bike racks', two_tier: 'Two-tier racks', ground_slots: 'Wheel slots', bollard: 'Bollards', anchors: 'Ground anchors' }[tags.bicycle_parking];
    const bits = [kind && t(kind), tags.supervised === 'yes' && t('Guarded'), tags.covered === 'yes' && t('Covered'),
      tags.fee === 'yes' ? t('Paid') : tags.fee === 'no' && t('Free'), tags.capacity && t('{0} spaces', Number(tags.capacity).toLocaleString())].filter(Boolean);
    const secure = tags.supervised === 'yes' || ['building', 'lockers'].includes(tags.bicycle_parking);
    if (bits.length) out.push(row(icon(secure ? 'lock' : 'parking', 16), esc(bits.join(' · '))));
    if (tags.operator) out.push(row(icon('business', 16), esc(tags.operator)));
  }
  if (tags.opening_hours) out.push(hoursHtml(tags.opening_hours));
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:postcode'];
  const addr = [street, city].filter(Boolean).join(', ');
  if (addr) out.push(row(icon('place', 16), `<span class="selectable">${esc(addr)}</span>`));
  // phone and website are buttons on the card, not rows
  const cu = (tags.cuisine || '').split(';').filter(Boolean).map(c => t(CUISINE[c.trim()] || pretty(c)));
  const dv = tags['diet:vegan'];
  if (dv === 'only') cu.push(t('Vegan')); else if (dv === 'yes') cu.push(t('Vegan options'));
  if (cu.length) out.push(row(icon('restaurant', 16), esc(cu.join(', '))));
  if (tags.outdoor_seating === 'yes') out.push(row(icon('sunny', 16), esc(t('Outdoor seating'))));
  const wc = { yes: 'Wheelchair accessible', limited: 'Partly wheelchair accessible', no: 'Not wheelchair accessible' }[tags.wheelchair];
  if (wc) out.push(row(icon('accessible', 16), esc(t(wc))));
  return out.length ? `<div class="pp-details">${out.join('')}</div>` : '';
}
