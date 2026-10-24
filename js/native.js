// Android features when running inside the Capacitor app, with browser fallbacks
// so the same code still works as a plain web app.

import { speechLang } from './i18n.js';

export const isNative = !!window.androidBridge;

let P = {};

// Load Capacitor's runtime (copied into www/ by scripts/copy-web.mjs) and the plugins we use.
export async function initNative() {
  if (!isNative) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/capacitor.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  const reg = name => window.Capacitor.registerPlugin(name);
  P = {
    TextToSpeech: reg('TextToSpeech'),
    KeepAwake: reg('KeepAwake'),
    Filesystem: reg('Filesystem'),
    Share: reg('Share'),
    App: reg('App'),
    Http: reg('CapacitorHttp'),
  };
}

// Overpass (OpenStreetMap search) query, resolving to its elements. The Android WebView adds an
// X-Requested-With header that overpass-api.de answers with 406, so the app goes through native HTTP.
const OVERPASS = 'https://overpass-api.de/api/interpreter';
export async function overpass(query, timeoutMs = 15000) {
  const body = 'data=' + encodeURIComponent(query);
  if (isNative && P?.Http) {
    const r = await P.Http.request({ url: OVERPASS, method: 'POST', data: body, connectTimeout: timeoutMs, readTimeout: timeoutMs,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CycleNav/1.0 (bike navigation app)' } });
    if (r.status !== 200) throw new Error('overpass ' + r.status);
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return d.elements || [];
  }
  const r = await fetch(OVERPASS, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error('overpass ' + r.status);
  return (await r.json()).elements || [];
}

export function speak(text) {
  if (!text) return;
  if (P.TextToSpeech) {
    P.TextToSpeech.stop()
      .catch(() => {})
      .then(() => P.TextToSpeech.speak({ text, lang: speechLang(), rate: 1.0, category: 'playback' }))
      .catch(() => {});
    return;
  }
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.lang = speechLang();
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (P.TextToSpeech) P.TextToSpeech.stop().catch(() => {});
  else window.speechSynthesis?.cancel();
}

let wakeLock = null;
export async function keepAwake(on) {
  if (P.KeepAwake) {
    (on ? P.KeepAwake.keepAwake() : P.KeepAwake.allowSleep()).catch(() => {});
    return;
  }
  try {
    if (on) wakeLock = await navigator.wakeLock?.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch { /* not supported */ }
}

// Save a text file: the share sheet on Android (to Drive, Files, mail...), a download in the browser.
export async function saveFile(name, text, mime) {
  if (P.Filesystem && P.Share) {
    const res = await P.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
    await P.Share.share({ title: name, files: [res.uri], dialogTitle: 'Save Cycle Nav backup' });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Android back button: `handler` returns true when it handled the press.
export function onBackButton(handler) {
  P.App?.addListener('backButton', () => {
    if (!handler()) P.App.minimizeApp().catch(() => P.App.exitApp());
  });
}
