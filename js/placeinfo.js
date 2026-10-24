// Online details for a tapped place: OSM tags from Nominatim, rendered as compact popup rows.

import { t } from './i18n.js';
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
export async function lookupPlace(name, ll) {
  const key = `${name.toLowerCase()}|${ll[0].toFixed(4)}|${ll[1].toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  const [lat, lon] = ll, dy = 0.0006, dx = dy / Math.cos(lat * Math.PI / 180);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&addressdetails=1&limit=5&bounded=1`
    + `&q=${encodeURIComponent(name)}&viewbox=${lon - dx},${lat + dy},${lon + dx},${lat - dy}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const n = name.toLowerCase();
  const hits = (await r.json()).filter(h => { const m = (h.name || '').toLowerCase(); return m && (m.includes(n) || n.includes(m)); });
  const best = hits.map(h => ({ h, d: dist(ll, [+h.lat, +h.lon]) })).sort((a, b) => a.d - b.d)[0]?.h;
  let tags = null;
  if (best) {
    const a = best.address || {};
    tags = { ...best.extratags, name: best.name, [best.category]: best.type };
    if (a.road) tags['addr:street'] = a.road;
    if (a.house_number) tags['addr:housenumber'] = a.house_number;
    if (a.postcode) tags['addr:postcode'] = a.postcode;
    const city = a.city || a.town || a.village;
    if (city) tags['addr:city'] = city;
  }
  cache.set(key, tags);
  return tags;
}
export const cachedPlace = (name, ll) => {
  const key = `${name.toLowerCase()}|${ll[0].toFixed(4)}|${ll[1].toFixed(4)}`;
  return cache.has(key) ? { tags: cache.get(key) } : null;
};

const CUISINE = {
  coffee_shop: 'Coffee shop', pizza: 'Pizza', burger: 'Burgers', italian: 'Italian', chinese: 'Chinese', sushi: 'Sushi', ice_cream: 'Ice cream',
  dutch: 'Dutch', indian: 'Indian', thai: 'Thai', japanese: 'Japanese', turkish: 'Turkish', greek: 'Greek', french: 'French', mexican: 'Mexican',
  kebab: 'Kebab', sandwich: 'Sandwiches', bakery: 'Bakery', regional: 'Regional', vegetarian: 'Vegetarian', asian: 'Asian', pancake: 'Pancakes', steak_house: 'Steakhouse',
};
const pretty = s => { s = s.trim().replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

function website(v) {
  v = String(v).trim();
  const url = /^https?:\/\//i.test(v) ? v : 'https://' + v;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return { href: u.href, label: u.hostname.replace(/^www\./, '') }; } catch { return null; }
}

function hoursHtml(raw) {
  const week = parseHours(raw);
  if (!week) return `<div class="pp-row"><span class="pp-ic">🕒</span><span class="selectable">${esc(raw)}</span></div>`;
  const status = formatStatus(hoursStatus(week), t);
  const today = (new Date().getDay() + 6) % 7;
  const rows = weekStrings(week, t('Closed')).map((s, i) => `<div class="${i === today ? 'pp-today' : ''}"><span>${esc(t(DAY_NAMES[i].slice(0, 3)))}</span><span>${esc(s === '24h' ? t('Open 24/7') : s)}</span></div>`).join('');
  return `<details class="pp-row pp-hours"><summary><span class="pp-ic">🕒</span><span>${esc(status)}</span></summary><div class="pp-week">${rows}</div></details>`;
}

export function detailsHtml(tags) {
  if (!tags) return '';
  const row = (ic, inner) => `<div class="pp-row"><span class="pp-ic">${ic}</span><span>${inner}</span></div>`;
  const out = [];
  if (tags.opening_hours) out.push(hoursHtml(tags.opening_hours));
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:postcode'];
  const addr = [street, city].filter(Boolean).join(', ');
  if (addr) out.push(row('📍', `<span class="selectable">${esc(addr)}</span>`));
  const phone = tags.phone || tags['contact:phone'];
  if (phone) { const p = phone.split(';')[0].trim(); out.push(row('📞', `<a href="tel:${esc(p.replace(/[^+\d]/g, ''))}">${esc(p)}</a>`)); }
  const site = website(tags.website || tags['contact:website'] || '');
  if (site) out.push(row('🌐', `<a href="${esc(site.href)}" target="_blank" rel="noopener noreferrer">${esc(site.label)}</a>`));
  const cu = (tags.cuisine || '').split(';').filter(Boolean).map(c => t(CUISINE[c.trim()] || pretty(c)));
  const dv = tags['diet:vegan'];
  if (dv === 'only') cu.push(t('Vegan')); else if (dv === 'yes') cu.push(t('Vegan options'));
  if (cu.length) out.push(row('🍽️', esc(cu.join(', '))));
  if (tags.outdoor_seating === 'yes') out.push(row('☀️', esc(t('Outdoor seating'))));
  const wc = { yes: 'Wheelchair accessible', limited: 'Partly wheelchair accessible', no: 'Not wheelchair accessible' }[tags.wheelchair];
  if (wc) out.push(row('♿', esc(t(wc))));
  return out.length ? `<div class="pp-details">${out.join('')}</div>` : '';
}
