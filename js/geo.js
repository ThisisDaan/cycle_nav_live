// Small geometry helpers. Points are always [lat, lon].

const R = 6371000;
const RAD = Math.PI / 180;

export function dist(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) -
    Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// Local flat projection around a reference latitude, in metres.
function toXY(p, refLat) {
  return [p[1] * RAD * R * Math.cos(refLat * RAD), p[0] * RAD * R];
}

// Project p onto segment a-b. Returns { t (0..1), d (metres from segment) }.
export function projectOnSegment(p, a, b) {
  const ref = p[0];
  const [px, py] = toXY(p, ref), [ax, ay] = toXY(a, ref), [bx, by] = toXY(b, ref);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { t, d: Math.hypot(px - qx, py - qy) };
}

export function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  return cum;
}

export function lengthOf(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += dist(coords[i - 1], coords[i]);
  return d;
}

// Points every `step` metres along a polyline.
export function resample(coords, step) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seg = dist(a, b);
    let pos = step - carry;
    while (pos <= seg) {
      const t = pos / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      pos += step;
    }
    carry = seg - (pos - step);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// Ramer-Douglas-Peucker; keeps any extra fields on the points (e.g. timestamps).
export function simplify(points, tol) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projectOnSegment(points[i], points[s], points[e]).d;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// ~20 m grid cell used to remember where you have ridden.
export function cellKey(lat, lon, dy = 0, dx = 0) {
  return (Math.round(lat / 0.0002) + dy) + ':' + (Math.round(lon / 0.0003) + dx);
}

export function nearestIndex(coords, p) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = dist(coords[i], p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, d: bestD };
}

export function fmtDist(m) {
  if (m < 950) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

export function fmtDuration(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

export function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
