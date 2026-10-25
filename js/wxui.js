import * as offline from './offline.js';
import { adviseHere, adviseRide } from './weather.js';
import { createRainFx } from './rainfx.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { fmtClock, fmtDuration } from './geo.js';
import { framed, is3d, map, mapRotation } from './mapview.js';
import { nav } from './navigation.js';
import { syncMoreDot } from './nearby.js';
import { me } from './position.js';
import { options, selected } from './routing-ui.js';
import { $, esc, S, toast } from './ui.js';

export let wxAdvice = null, wxToken = 0, wxAt = 0, wxTimer = 0;   // ride weather advice
export const wxOn = () => S().wx !== false;

// ---- live rain radar (RainViewer): the last two hours of radar, looped every few seconds
// The radar tiles are only read as an intensity mask (js/rainfx.js); what you see is an illustrated rain effect.
var radar = null;
export async function toggleRadar(on = !radar) {
  $('#radarBtn').classList.toggle('active', on);
  syncMoreDot();
  if (!on) {
    clearInterval(radar?.timer); clearInterval(radar?.windTimer); radar?.fx.stop(); radar = null;
    $('#radarTime').hidden = true; return;
  }
  const fx = createRainFx(map, {
    canvas: $('#rainFx'),
    // screen px -> map container px, undoing the CSS rotation exactly like taps do
    toContainer: (x, y) => map.mouseEventToContainerPoint({ clientX: x, clientY: y }),
    getRotation: () => (framed() && !is3d() ? -mapRotation : 0),
    isDark: () => document.documentElement.dataset.theme === 'dark',
  });
  radar = { fx, timer: null, windTimer: null };
  const mine = radar;
  let d;
  try { d = await (await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal: AbortSignal.timeout(7000) })).json(); }
  catch { if (radar === mine) toggleRadar(false); toast(t('Rain radar needs a connection')); return; }
  if (radar !== mine) return;
  const frames = d.radar.past.slice(-7);
  // every frame is its own layer, hidden until it is its turn, so the loop never waits for tiles
  frames.forEach(f => fx.addFrame(`${d.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`));
  // wind for the streaks and gusts: current conditions where the map is looking (cached ~5 min by weather.js)
  const loadWind = async () => {
    const c = map.getCenter();
    const a = await adviseHere([c.lat, c.lng]).catch(() => null);
    if (radar === mine && a?.cur?.speed != null) fx.setWind({ speed: a.cur.speed, dir: a.cur.dir });
  };
  loadWind(); mine.windTimer = setInterval(loadWind, 300000);
  fx.start();
  let i = frames.length - 1, pause = 0;
  const show = () => {
    fx.show(i);
    const ago = Math.round((Date.now() / 1000 - frames[i].time) / 60);
    $('#radarTime').hidden = false;
    $('#radarTime').textContent = `${t('Rain radar')} · ${ago <= 10 ? t('now') : t('{0} ago', fmtDuration(ago * 60))}`;
  };
  show();
  radar.timer = setInterval(() => {
    if (i === frames.length - 1 && pause++ < 3) return; // linger on the latest frame
    pause = 0; i = (i + 1) % frames.length; show();
  }, 700);
}

// ---------------------------------------------------------------- ride weather advice

export async function wxUpdate() {
  const my = ++wxToken;
  const o = !$('#sheet').hidden && options[selected];
  if (!wxOn() || nav || (!o && !me)) { wxAdvice = null; return wxRender(); }
  const adv = o ? await adviseRide(o.route, Date.now(), o.time) : await adviseHere(me.latlng);
  if (my !== wxToken) return;
  wxAdvice = adv && { ...adv, _for: o ? o.route : null };
  wxAt = Date.now();
  wxRender();
}

export function wxLine(a) {
  return `<span class="wx-ic">${icon(a.icon, 22)}</span><span class="wx-tx">${esc(a.text)}${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</span>`;
}

function wxRender() {
  const a = wxAdvice;
  const o = !$('#sheet').hidden && options[selected];
  const chip = $('#wxChip');
  // on the map only when rain is on its way; a dry forecast is just clutter
  chip.hidden = !(a && a.kind !== 'go' && !o && !nav);
  if (!chip.hidden) { chip.innerHTML = wxLine(a); chip.className = `wx-chip wx-${a.kind}`; }
  const line = document.querySelector('.route-card.selected .rc-advice');
  if (line) {
    const ok = a && o && a._for === o.route;
    line.hidden = !ok;
    if (ok) { line.innerHTML = wxLine(a); line.className = `rc-advice wx-${a.kind}`; }
  }
  if (!a) closeWxPop();
}

function wxBarH(mm) { return mm < 0.1 ? 0 : Math.min(1, (Math.log10(mm) + 1.2) / 3.2); }

export function showWxPop() {
  const a = wxAdvice;
  if (!a) return;
  const pop = $('#wxPop');
  const max = Math.max(...a.bars.map(b => b.mm));
  const di = a.depart == null ? -1 : Math.round((a.depart - a.now) / 300000);
  const cols = a.bars.map((b, i) => {
    const h = wxBarH(b.mm);
    const mark = i === 0 ? t('now') : i === di ? t('go') : '';
    return `<div class="wx-col${i === 0 || i === di ? ' mark' : ''}"><span class="wx-flag">${mark}</span>
      <div class="wx-slot"><i ${h ? `style="height:${Math.max(5, h * 100)}%"` : 'class="dry"'}></i></div><b>${i % 6 === 0 ? fmtClock(new Date(b.t)) : ''}</b></div>`;
  }).join('');
  const facts = [];
  if (a.cur?.temp != null) facts.push(`${icon('thermostat', 15)} ${Math.round(a.cur.temp)}°`);
  if (a.cur?.speed != null) facts.push(`<span class="wx-arrow" style="transform:rotate(${Math.round(a.cur.dir + 180)}deg)">↑</span> ${t('Wind {0} Bft', a.wind?.bft ?? '–')} · ${Math.round(a.cur.speed * 3.6)} km/h`);
  pop.innerHTML = `<div class="wx-card" role="dialog">
    <div class="wx-head ${`wx-${a.kind}`}">${wxLine(a)}</div>
    <h4>${t('Rain forecast, next 90 min')} · ${max < 0.1 ? t('dry') : max < 1 ? t('light') : max < 5 ? t('moderate') : t('heavy')}</h4>
    <div class="wx-graph">${cols}</div>
    <div class="wx-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
    <button class="secondary-btn wx-close">${t('Close')}</button></div>`;
  pop.hidden = false;
  pop.onclick = e => { if (e.target === pop || e.target.closest('.wx-close')) closeWxPop(); };
}
function closeWxPop() { $('#wxPop').hidden = true; }

export function setupWeather() {
  $('#wxChip').onclick = showWxPop;
  wxTimer = setInterval(() => { if (!document.hidden) wxUpdate(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - wxAt > 5 * 60 * 1000) wxUpdate(); });
  offline.onOfflineChange(() => wxUpdate());
}
