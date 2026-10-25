// "Remember how I rode before": an index of every ~20 m cell you have ridden
// through, plus lookup of earlier rides between the same two places.

import { cellKey, dist, lengthOf, nearestIndex, resample } from './geo.js';

export function buildIndex(rideList) {
  const cells = new Set();
  for (const ride of rideList) {
    for (const p of resample(ride.points, 12)) cells.add(cellKey(p[0], p[1]));
  }
  return cells;
}

function known(cells, p) {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      if (cells.has(cellKey(p[0], p[1], dy, dx))) return true;
  return false;
}

// Share (0..1) of a route that runs over roads you have ridden before.
export function familiarity(cells, coords) {
  if (!cells.size) return 0;
  const pts = resample(coords, 25);
  let hit = 0;
  for (const p of pts) if (known(cells, p)) hit++;
  return hit / pts.length;
}

const NEAR = 300; // metres: how close a past ride must pass the start/end

// Find the way you usually ride from `from` to `to`, if you have done it before.
export function findFamiliar(rideList, from, to) {
  const straight = dist(from, to);
  const candidates = [];
  for (const ride of rideList.slice(0, 200)) {
    const pts = ride.points;
    if (!pts || pts.length < 2) continue;
    const a = nearestIndex(pts, from), b = nearestIndex(pts, to);
    if (a.d > NEAR || b.d > NEAR || a.index === b.index) continue;
    const sub = a.index < b.index ? pts.slice(a.index, b.index + 1) : pts.slice(b.index, a.index + 1).reverse();
    const len = lengthOf(sub);
    if (len < straight * 0.8 || len > straight * 2.2 + 300) continue; // loops, detours, junk
    candidates.push({ points: sub.map(p => [p[0], p[1]]), ride, len });
    if (candidates.length >= 25) break;
  }
  if (!candidates.length) return null;

  // Pick the variant that most of the other rides agree with.
  let best = null;
  for (const c of candidates) {
    const cells = buildIndex([c]);
    const agree = candidates.filter(o => o === c || familiarity(cells, o.points) > 0.7);
    const score = agree.length + c.ride.startedAt / 1e14; // tie-break: most recent
    if (!best || score > best.score) best = { ...c, score, count: agree.length };
  }
  return { points: best.points, count: best.count, lastRidden: best.ride.startedAt, saved: best.ride.source === 'planned', ride: best.ride };
}

// Via points that make the router follow a remembered track.
export function viaPointsFor(points) {
  const len = lengthOf(points);
  const n = Math.max(1, Math.min(8, Math.round(len / 900)));
  const step = len / (n + 1);
  const samples = resample(points, step);
  return samples.slice(1, n + 1);
}

// Average moving speed for a bike, learned from its rides.
export function bikeSpeed(bike, rideList) {
  const mine = rideList
    .filter(r => r.bikeId === bike.id && r.movingTime > 120 && r.distance > 500)
    .slice(0, 15);
  const d = mine.reduce((s, r) => s + r.distance, 0);
  const t = mine.reduce((s, r) => s + r.movingTime, 0);
  const learned = t ? (d / t) * 3.6 : null;
  const weight = Math.min(1, mine.length / 3);
  const kmh = learned ? weight * learned + (1 - weight) * bike.speed : bike.speed;
  return { kmh, learned, rides: mine.length };
}
