// Ride weather advice: one sentence (go / jacket / wait), not a weather report.
// Rain from Buienradar (NL/BE, 5-minute steps) or Open-Meteo (elsewhere); wind and temperature from Open-Meteo.
import { isOffline } from './offline.js';
import { bearing, fmtClock } from './geo.js';
import { t } from './i18n.js';

// 105 → "1 h 45 min": nobody says 105 minutes
const mins = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;

const TTL = 5 * 60 * 1000;
const WET = 0.1;            // mm/h that counts as rain
const MAX_WAIT = 30;        // minutes we are willing to suggest waiting
const cache = new Map();    // "lat,lon" cell -> { at, p }

const cellKey = (lat, lon) => `${(lat / 0.018).toFixed(0)},${(lon / (0.018 / Math.cos(lat * Math.PI / 180))).toFixed(0)}`;
const inBenelux = (lat, lon) => lat > 49.4 && lat < 53.7 && lon > 2.5 && lon < 7.3;

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// Minutes between now and a Buienradar "HH:MM" (Dutch local time).
function nlClockNow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':');
  return (+p[0] % 24) * 60 + +p[1];
}

async function buienradar(lat, lon) {
  const txt = await (await fetch(`https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, { signal: AbortSignal.timeout(7000) })).text();
  const rows = txt.trim().split(/\r?\n/).map(l => l.split('|')).filter(r => r.length === 2 && /^\d+$/.test(r[0]) && /^\d\d:\d\d$/.test(r[1]));
  if (rows.length < 6) throw new Error('raintext');
  const [h, m] = rows[0][1].split(':').map(Number);
  let ago = nlClockNow() - (h * 60 + m);
  if (ago < -720) ago += 1440; else if (ago > 720) ago -= 1440;   // across midnight
  const t0 = Math.floor(Date.now() / 60000) * 60000 - ago * 60000;
  return { t0, step: 5, mm: rows.map(r => +r[0] === 0 ? 0 : 10 ** ((+r[0] - 109) / 32)) };
}

async function openMeteo(lat, lon, { rain = true, current = true } = {}) {
  const q = [`latitude=${lat.toFixed(3)}`, `longitude=${lon.toFixed(3)}`, 'timeformat=unixtime', 'wind_speed_unit=ms'];
  if (current) q.push('current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
  if (rain) q.push('minutely_15=precipitation', 'forecast_minutely_15=16', 'past_minutely_15=1');
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?${q.join('&')}`);
  const out = {};
  if (j.minutely_15?.time) out.rain = { t0: j.minutely_15.time[0] * 1000, step: 15, mm: j.minutely_15.precipitation.map(v => (v || 0) * 4) };
  if (j.current) out.cur = { temp: j.current.temperature_2m, speed: j.current.wind_speed_10m, dir: j.current.wind_direction_10m, gust: j.current.wind_gusts_10m };
  return out;
}

// One grid cell (~2 km): { rain, cur? }, cached for 5 min. wantCur adds Open-Meteo current conditions.
async function cell(lat, lon, wantCur) {
  const key = cellKey(lat, lon) + (wantCur ? 'c' : '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = (async () => {
    if (inBenelux(lat, lon)) {
      const [rain, om] = await Promise.all([
        buienradar(lat, lon).catch(() => null),
        wantCur ? openMeteo(lat, lon, { rain: false }).catch(() => ({})) : {},
      ]);
      if (rain) return { rain, cur: om.cur };
      const f = await openMeteo(lat, lon, { current: wantCur });
      return { rain: f.rain, cur: om.cur || f.cur };
    }
    const f = await openMeteo(lat, lon, { current: wantCur });
    return { rain: f.rain, cur: f.cur };
  })();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

// mm/h at time ms (nearest slot; 0 past the end of the forecast).
export function rainAt(series, ms) {
  if (!series) return 0;
  const i = Math.floor((ms - series.t0) / (series.step * 60000));
  if (i < 0) return series.mm[0] || 0;
  return series.mm[i] || 0;
}

// ---------- sampling ----------

function samplePoints(route) {
  const total = route.cum?.[route.cum.length - 1] ?? route.length ?? 0;
  const n = Math.max(2, Math.min(5, Math.round(total / 4000) + 1));
  const pts = [];
  for (let k = 0; k < n; k++) {
    const target = total * k / (n - 1);
    let i = 0;
    if (route.cum) while (i < route.cum.length - 1 && route.cum[i] < target) i++;
    else i = Math.round((route.coords.length - 1) * k / (n - 1));
    pts.push({ frac: total ? target / total : k / (n - 1), at: route.coords[i] });
  }
  return pts;
}

// Fetch everything needed for a route: { pts:[{frac, rain}], cur }, or null when offline / failed.
export async function fetchRouteWeather(route) {
  if (isOffline()) return null;
  try {
    const pts = samplePoints(route);
    const midIdx = Math.floor(pts.length / 2);
    const got = await Promise.all(pts.map((p, i) => cell(p.at[0], p.at[1], i === midIdx)));
    if (!got.some(g => g.rain)) return null;
    return { pts: pts.map((p, i) => ({ frac: p.frac, rain: got[i].rain })), cur: got[midIdx].cur || got.find(g => g.cur)?.cur || null };
  } catch { return null; }
}

// ---------- maths ----------

const bft = ms => Math.round((ms / 0.836) ** (2 / 3));

// Rain (mm/h) at route fraction f at time ms: blend the two neighbouring sample points.
function rainAlong(pts, f, ms) {
  if (pts.length === 1 || f <= pts[0].frac) return rainAt(pts[0].rain, ms);
  for (let i = 1; i < pts.length; i++) {
    if (f <= pts[i].frac) {
      const a = pts[i - 1], b = pts[i], w = (f - a.frac) / ((b.frac - a.frac) || 1);
      return rainAt(a.rain, ms) * (1 - w) + rainAt(b.rain, ms) * w;
    }
  }
  return rainAt(pts[pts.length - 1].rain, ms);
}

// What a ride leaving at `start` (ms) takes in rain: { mm, wetMin, peak, first (ms of first rain) }.
function exposure(pts, start, durMs) {
  const N = Math.max(6, Math.min(30, Math.round(durMs / 120000)));
  let mm = 0, wet = 0, peak = 0, first = null;
  for (let i = 0; i < N; i++) {
    const f = (i + 0.5) / N, ms = start + f * durMs;
    const r = rainAlong(pts, f, ms);
    if (r >= WET) { wet++; mm += r * durMs / N / 3600000; peak = Math.max(peak, r); first ??= ms; }
  }
  return { mm, wetShare: wet / N, wetMin: wet / N * durMs / 60000, peak, first };
}

const isDry = e => e.mm < 0.03 || (e.peak < 0.2 && e.wetShare < 0.15);
const isLight = e => e.peak < 1.5 && e.mm <= 0.8;

// Wind relative to the route: { bft, share (headwind share), extra (rough minutes lost) }.
function windOnRoute(route, cur, durSec) {
  if (!cur || cur.speed == null) return null;
  const c = route.coords;
  const step = Math.max(1, Math.floor(c.length / 120));
  let n = 0, head = 0, net = 0;
  for (let i = 0; i + step < c.length; i += step) {
    const brg = bearing(c[i], c[i + step]);
    const comp = cur.speed * Math.cos((cur.dir - brg) * Math.PI / 180);   // > 0: wind in the face
    n++; if (comp > cur.speed * 0.5) head++;
    net += comp > 0 ? comp : comp * 0.5;
  }
  if (!n) return null;
  const total = route.cum?.[route.cum.length - 1] ?? route.length ?? 0;
  const v0 = total / Math.max(1, durSec);
  const h = Math.max(0, net / n);
  const extra = Math.round(durSec * (h / (v0 + h)) * 0.8 / 60);
  return { bft: bft(cur.speed), share: head / n, extra };
}

function hints(wind, cur) {
  const out = [];
  if (wind && wind.extra >= 2 && (wind.bft >= 5 || (wind.share > 0.6 && wind.bft >= 4))) out.push(t('Strong headwind: +{0}', mins(wind.extra)));
  if (cur && cur.temp != null && cur.temp <= 3) out.push(t('{0}° – wear gloves', Math.round(cur.temp)));
  return out.join(' · ') || null;
}

// Bars for the next ~90 min: the worst case along the route (or at the point) per 5-minute slot.
function bars(pts, now) {
  const out = [];
  for (let i = 0; i < 18; i++) {
    const ms = now + i * 300000;
    out.push({ t: ms, mm: Math.max(...pts.map(p => rainAt(p.rain, ms))) });
  }
  return out;
}

const clock = ms => fmtClock(new Date(ms));

// Pure part of adviseRide, so it can be tested with fake series.
// wx = { pts:[{frac, rain:{t0, step, mm[]}}], cur }, durSec = expected ride time.
export function computeAdvice(route, wx, now, durSec) {
  const pts = wx.pts, durMs = durSec * 1000;
  const wind = windOnRoute(route, wx.cur, durSec);
  const base = { hint: hints(wind, wx.cur), bars: bars(pts, now), now, cur: wx.cur, wind, depart: now };
  const ex = [];
  for (let d = 0; d <= 60; d += 5) ex.push({ d, e: exposure(pts, now + d * 60000, durMs) });
  const e0 = ex[0].e;

  if (isDry(e0)) {
    // Dry now: does rain reach some spot on the route shortly after we have passed it?
    const total = route.cum?.[route.cum.length - 1] ?? route.length ?? 0;
    let tight = null;
    for (const p of pts) {
      const pass = now + p.frac * durMs;
      for (let m = 5; m <= 20; m += 5) {
        if (rainAt(p.rain, pass + m * 60000) < WET) continue;
        if (!tight || m < tight.m) tight = { m, p, at: pass + m * 60000 };
        break;
      }
    }
    if (tight) {
      const f = tight.p.frac;
      const where = f < 0.1 ? t('the start') : f > 0.9 ? t('your destination') : t('{0} km in', Math.round(f * total / 1000));
      return { ...base, icon: '🏃', kind: 'rush', text: t('Leave now – rain reaches {0} around {1}, about {2} after you pass', where, clock(tight.at), mins(tight.m)) };
    }
    return { ...base, icon: '🟢', kind: 'go', text: t('Go now, dry all the way') };
  }
  if (isLight(e0)) {
    return { ...base, icon: '🧥', kind: 'jacket', text: t('Bring a jacket – light rain around {0}', clock(e0.first)) };
  }
  const wait = ex.find(x => x.d > 0 && x.d <= MAX_WAIT && (isDry(x.e) || (isLight(x.e) && x.e.mm <= e0.mm * 0.25)));
  if (wait) return { ...base, icon: '⏳', kind: 'wait', depart: now + wait.d * 60000, text: t('Wait {0} – dry from {1}', mins(wait.d), clock(now + wait.d * 60000)) };
  if (e0.wetShare >= 0.7) return { ...base, icon: '🌧', kind: 'rain', text: t('Rain the whole ride – rain gear needed') };
  return { ...base, icon: '🧥', kind: 'jacket', text: t('Bring a jacket – light rain around {0}', clock(e0.first)) };
}

// route: { coords, cum, length }; durSec: expected ride time. Resolves to null when there is no data.
export async function adviseRide(route, now = Date.now(), durSec = 0) {
  const wx = await fetchRouteWeather(route);
  if (!wx) return null;
  const total = route.cum?.[route.cum.length - 1] ?? route.length ?? 0;
  return computeAdvice(route, wx, now, durSec || total / 4.2);
}

// No route: what is the weather doing where I am.
export async function adviseHere(latlng, now = Date.now()) {
  if (isOffline()) return null;
  let c;
  try { c = await cell(latlng[0], latlng[1], true); } catch { return null; }
  if (!c.rain) return null;
  const pts = [{ frac: 0, rain: c.rain }];
  const base = { hint: hints(null, c.cur), bars: bars(pts, now), now, cur: c.cur, wind: c.cur ? { bft: bft(c.cur.speed) } : null, depart: null };
  const slots = [];
  for (let m = 0; m <= 120; m += 5) slots.push(rainAt(c.rain, now + m * 60000));
  if (slots[0] >= WET) {
    const dry = slots.findIndex(v => v < WET);
    return dry < 0 ? { ...base, icon: '🌧', kind: 'rain', text: t('Raining for the next two hours') }
      : { ...base, icon: '🌧', kind: 'rain', text: t('Raining now, dry from {0}', clock(now + dry * 300000)) };
  }
  const first = slots.findIndex(v => v >= WET);
  if (first < 0 || first > 12) return { ...base, icon: '🟢', kind: 'go', text: t('Dry for the next hour') };
  let end = first; while (end < slots.length && slots[end] >= WET) end++;
  return { ...base, icon: '🌦', kind: 'soon', text: t('Rain in {0}, for about {1}', mins(first * 5), mins(Math.max(5, (end - first) * 5))) };
}

