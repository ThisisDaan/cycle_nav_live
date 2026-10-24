// Minimal OSM opening_hours parser: enough for the common forms, gives up (null) otherwise.

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_RE = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
const DAYS_RE = new RegExp(String.raw`^(${DAY_RE}(?:\s*-\s*${DAY_RE})?(?:\s*,\s*${DAY_RE}(?:\s*-\s*${DAY_RE})?)*)\s*`);
const TIME = '[0-9]{1,2}:[0-9]{2}';
const TIMES_RE = new RegExp(String.raw`^${TIME}\s*-\s*${TIME}(?:\s*,\s*${TIME}\s*-\s*${TIME})*$`);
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function parseDays(s) {
  const out = new Set();
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(x => DAYS.indexOf(x.trim()));
    if (b === undefined) out.add(a);
    else for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
  }
  return [...out];
}

// -> array of 7 days (Mon first), each a list of [startMin, endMin] (end may exceed 1440), or null
export function parseHours(value) {
  if (!value || typeof value !== 'string') return null;
  const week = Array.from({ length: 7 }, () => []);
  let used = false;
  for (let rule of value.split(';')) {
    rule = rule.trim().replace(/\s+/g, ' ');
    if (!rule) continue;
    if (/^24\/7$/.test(rule)) { week.forEach((_, i) => { week[i] = [[0, 1440]]; }); used = true; continue; }
    // unsupported parts (holidays, months, weeks, sun events, comments) -> skip this rule
    if (/PH|SH|[A-Z][a-z]{2}\s*\d|\bJan|\bFeb|\bMar\b|\bApr|\bMay|\bJun|\bJul|\bAug|\bSep|\bOct|\bNov|\bDec|week|sunrise|sunset|dawn|dusk|"|\[|\+$|\(/.test(rule)) continue;
    // "Mo-Fr 09:00-17:00, Sa 10:00-14:00" -> split into day groups
    let days = null;
    const pieces = rule.split(/,\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su)\b)/);
    let pending = [];
    let ok = true;
    for (const piece of pieces) {
      let rest = piece, ds = null;
      const m = rest.match(DAYS_RE);
      if (m) { ds = parseDays(m[1]); rest = rest.slice(m[0].length).trim(); }
      if (!rest && ds) { pending.push(...ds); continue; }
      const target = ds ? [...pending, ...ds] : (pending.length ? pending : [0, 1, 2, 3, 4, 5, 6]);
      pending = [];
      let iv;
      if (/^(off|closed)$/i.test(rest)) iv = [];
      else if (/^open$/i.test(rest)) iv = [[0, 1440]];
      else if (TIMES_RE.test(rest) && !rest.includes('+')) {
        iv = rest.split(',').map(r => {
          const [a, b] = r.split('-').map(x => toMin(x.trim()));
          return [a, b <= a ? b + 1440 : b];
        });
        if (iv.some(([a, b]) => a > 1440 || b > 2880 || a % 60 >= 60)) { ok = false; break; }
      } else { ok = false; break; }
      for (const d of target) week[d] = iv.map(x => [...x]);
      used = true;
    }
    if (!ok) { if (value.split(';').length === 1) return null; continue; }
    if (pending.length) return null;
    void days;
  }
  return used ? week : null;
}

export function weekStrings(week, off = 'Closed') {
  const f = m => { m %= 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  return week.map(iv => !iv.length ? off : (iv.length === 1 && iv[0][0] === 0 && iv[0][1] === 1440) ? '24h' : iv.map(([a, b]) => f(a) + '–' + f(b)).join(', '));
}

// -> { kind: 'always' | 'open' | 'closing' | 'closed' | 'never', time, days, weekday }
export function hoursStatus(week, now = new Date()) {
  if (week.every(d => d.length === 1 && d[0][0] === 0 && d[0][1] === 1440)) return { kind: 'always' };
  const iv = [];
  for (let w = -1; w <= 1; w++) week.forEach((list, d) => list.forEach(([a, b]) => iv.push([(w * 7 + d) * 1440 + a, (w * 7 + d) * 1440 + b])));
  iv.sort((x, y) => x[0] - y[0]);
  const wd = (now.getDay() + 6) % 7, cur = wd * 1440 + now.getHours() * 60 + now.getMinutes();
  const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const open = iv.find(([a, b]) => a <= cur && cur < b);
  if (open) {
    let end = open[1];
    for (let again = true; again;) { again = false; for (const [a, b] of iv) if (a <= end && b > end) { end = b; again = true; } }
    if (end - cur > 7 * 1440) return { kind: 'always' };
    return { kind: end - cur <= 30 ? 'closing' : 'open', time: hhmm(end) };
  }
  const next = iv.find(([a]) => a > cur);
  if (!next) return { kind: 'never' };
  const days = Math.floor(next[0] / 1440) - Math.floor(cur / 1440);
  return { kind: 'closed', time: hhmm(next[0]), days, weekday: ((Math.floor(next[0] / 1440) % 7) + 7) % 7 };
}

export function formatStatus(st, tr = s => s) {
  switch (st.kind) {
    case 'always': return tr('Open 24/7');
    case 'open': return `${tr('Open now')} · ${tr('closes')} ${st.time}`;
    case 'closing': return `${tr('Closes soon')} · ${st.time}`;
    case 'closed': {
      const when = st.days === 0 ? '' : st.days === 1 ? tr('tomorrow') + ' ' : tr(DAY_NAMES[st.weekday]) + ' ';
      return `${tr('Closed')} · ${tr('opens')} ${when}${st.time}`;
    }
    default: return tr('Closed');
  }
}
