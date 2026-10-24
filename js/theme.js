// Look & feel: colours, light/dark, map style, position marker and app icon.

export const ACCENTS = ['#2f9e6e', '#1f7ae0', '#7a5cf0', '#e0457b', '#f07a1f', '#d4a20b', '#14a3b8', '#3c4650'];

const OSM = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors', noSub: true };

export const MAP_STYLES = {
  calmLight: { label: 'Calm light (soft colours, like Apple Maps)', vector: true, dark: false },
  calmDark: { label: 'Calm dark', vector: true, dark: true },
  auto:     { label: 'Calm, follows light/dark mode' },
  standard: { label: 'OpenStreetMap', ...OSM },
  night:    { label: 'OpenStreetMap, dimmed for night', ...OSM, className: 'dark-tiles' },
  cyclosm:  { label: 'CyclOSM (shows bike infrastructure)', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors, CyclOSM' },
  hot:      { label: 'Humanitarian (soft colours)', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors, HOT' },
  topo:     { label: 'OpenTopoMap (shows hills)', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors, SRTM, OpenTopoMap', noSub: true, maxZoom: 17 },
};

export const MARKERS = {
  arrow: 'Arrow',
  dot: 'Dot',
  bike: 'Your bike’s icon',
};

export const APP_ICONS = {
  wheel: 'Wheel',
  arrow: 'Arrow',
  path: 'Winding path',
  leaf: 'Leaf',
};

export function isDark(theme) {
  if (theme.mode === 'dark') return true;
  if (theme.mode === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

export function tileStyle(theme) {
  if (theme.mapStyle === 'auto' || !MAP_STYLES[theme.mapStyle]) return MAP_STYLES[isDark(theme) ? 'calmDark' : 'calmLight'];
  return MAP_STYLES[theme.mapStyle];
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Pick black or white text for a given background colour.
export function contrastText(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#101418' : '#ffffff';
}

export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = isDark(theme) ? 'dark' : 'light';
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--on-accent', contrastText(theme.accent));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.accent);
  setAppIcon(theme);
}

export function iconSvg(kind, accent, size = 96) {
  const fg = contrastText(accent);
  const glyphs = {
    wheel: `<circle cx="48" cy="48" r="24" fill="none" stroke="${fg}" stroke-width="7"/>
            <circle cx="48" cy="48" r="5" fill="${fg}"/>
            <path d="M48 24v48M24 48h48M31 31l34 34M65 31L31 65" stroke="${fg}" stroke-width="2.5"/>`,
    arrow: `<path d="M48 18 L72 74 L48 62 L24 74 Z" fill="${fg}"/>`,
    path:  `<path d="M30 76 C30 56 66 58 66 40 C66 26 44 24 40 20" fill="none" stroke="${fg}" stroke-width="8" stroke-linecap="round"/>
            <circle cx="30" cy="76" r="6" fill="${fg}"/><circle cx="40" cy="20" r="6" fill="${fg}"/>`,
    leaf:  `<path d="M26 70 C26 38 46 22 74 22 C74 50 58 70 26 70 Z" fill="${fg}"/>
            <path d="M26 70 L56 40" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="${size}" height="${size}">
    <rect width="96" height="96" rx="22" fill="${accent}"/>${glyphs[kind] || glyphs.wheel}</svg>`;
}

function setAppIcon(theme) {
  const svg = iconSvg(theme.appIcon, theme.accent);
  const url = 'data:image/svg+xml,' + encodeURIComponent(svg);
  document.querySelector('link[rel="icon"]')?.setAttribute('href', url);
  // iOS wants a PNG for the home-screen icon.
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 180;
    c.getContext('2d').drawImage(img, 0, 0, 180, 180);
    try {
      document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', c.toDataURL('image/png'));
    } catch { /* canvas blocked */ }
  };
  img.src = url;
}
