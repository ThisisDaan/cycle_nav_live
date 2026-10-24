// Online details for a tapped place: OSM tags from Overpass, rendered as compact popup rows.

import { t } from './i18n.js';
import { DAY_NAMES, formatStatus, hoursStatus, parseHours, weekStrings } from './hours.js';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const cache = new Map();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rx = s => s.replace(/[.*+?^${}()|[\]\\"]/g, '\$&');
const dist = (a, b) => {
  const k = Math.PI / 180, dx = (b[1] - a[1]) * k * Math.cos(a[0] * k), dy = (b[0] - a[0]) * k;
  return Math.hypot(dx, dy) * 6371000;
};
const centre = el => el.center ? [el.center.lat, el.center.lon] : (el.lat != null ? [el.lat, el.lon] : null);

async function overpass(q) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(ENDPOINT, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
    if (!r.ok) throw new Error('overpass ' + r.status);
    return (await r.json()).elements || [];
  } finally { clearTimeout(timer); }
}

// -> tags object or null. Cached per place (name + rounded coordinates).
export async function lookupPlace(name, ll) {
  const key = `${name.toLowerCase()}|${ll[0].toFixed(4)}|${ll[1].toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  const [lat, lon] = ll;
  const nearest = els => els.map(e => ({ e, d: dist(ll, centre(e) || ll) })).sort((a, b) => a.d - b.d)[0]?.e;
  let tags = null;
  const named = await overpass(`[out:json][timeout:8];nwr(around:40,${lat},${lon})["name"~"^${rx(name)}$",i];out tags center 5;`);
  let best = nearest(named);
  if (!best) {
    // names in the map and in OSM can differ a little ("Rijksmuseum" / "Rijksmuseum Amsterdam"), but never
    // borrow details from an unrelated neighbour such as a toilet next door
    const n = name.toLowerCase(), alike = e => { const m = (e.tags?.name || '').toLowerCase(); return m && (m.includes(n) || n.includes(m)); };
    const near = await overpass(`[out:json][timeout:8];nwr(around:60,${lat},${lon})["name"][~"^(amenity|shop|tourism|leisure)$"~"."];out tags center 10;`);
    best = nearest(near.filter(alike));
  }
  tags = best?.tags || null;
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
