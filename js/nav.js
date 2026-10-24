// Turn-by-turn following of a route, ride recording, and a GPS simulator for testing.

import { bearing, dist, projectOnSegment, simplify } from './geo.js';
import { hintText } from './router.js';
import { t } from './i18n.js';

const OFF_ROUTE_M = 40;
const ARRIVED_M = 25;

export class Navigator {
  constructor(route) {
    this.route = route;
    this.seg = 0;          // index of the segment we are on
    this.offCount = 0;
    this.spoken = new Set();
  }

  // Returns the navigation state for a GPS fix: { along, remaining, offRoute, next, distToNext, arrived, say }
  update(p, accuracy = 10) {
    const { coords, cum } = this.route;
    let best = this.nearest(p, Math.max(0, this.seg - 5), Math.min(coords.length - 1, this.seg + 250));
    if (best.d > OFF_ROUTE_M) {
      const full = this.nearest(p, 0, coords.length - 1);
      if (full.d < best.d) best = full;
    }
    this.seg = best.i;
    const along = cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i] || 0);
    const remaining = Math.max(0, this.route.length - along);

    if (best.d > OFF_ROUTE_M && accuracy < 60) this.offCount++;
    else this.offCount = 0;
    const offRoute = this.offCount >= 3 || best.d > OFF_ROUTE_M * 2.5 && accuracy < 40;

    // Next instruction ahead of us (skip plain "continue" hints).
    const ahead = this.route.hints.filter(h => cum[h.idx] > along + 3);
    const next = ahead.find(h => h.cmd !== 1 && h.cmd !== 13) || null;
    const distToNext = next ? cum[next.idx] - along : remaining;
    const after = next ? ahead.find(h => h !== next && h.cmd !== 1 && h.cmd !== 13) : null;
    const afterGap = after ? cum[after.idx] - cum[next.idx] : 0;
    const thenSoon = after && afterGap < 80 ? after : null;

    const arrived = remaining < ARRIVED_M;
    let say = null;
    if (arrived && !this.spoken.has('end')) {
      this.spoken.add('end');
      say = t('You have arrived');
    } else if (next) {
      const text = thenSoon ? t('{0}, then {1}', hintText(next), hintText(thenSoon).toLowerCase()) : hintText(next);
      if (distToNext < 45 && !this.spoken.has(next.idx + 'n')) {
        this.spoken.add(next.idx + 'n').add(next.idx + 'f');
        say = text;
      } else if (distToNext < 220 && distToNext > 120 && !this.spoken.has(next.idx + 'f')) {
        this.spoken.add(next.idx + 'f');
        say = t('In {0} metres, {1}', Math.round(distToNext / 50) * 50, text.charAt(0).toLowerCase() + text.slice(1));
      }
    }
    const c0 = coords[best.i], c1 = coords[best.i + 1] || c0;
    const snap = [c0[0] + (c1[0] - c0[0]) * best.t, c0[1] + (c1[1] - c0[1]) * best.t];
    return { along, remaining, offRoute, offBy: best.d, snap, next, after, afterGap, thenSoon, distToNext, arrived, say };
  }

  nearest(p, from, to) {
    const { coords } = this.route;
    let best = { i: from, t: 0, d: Infinity };
    for (let i = from; i < Math.min(to, coords.length - 1); i++) {
      const r = projectOnSegment(p, coords[i], coords[i + 1]);
      if (r.d < best.d) best = { i, t: r.t, d: r.d };
    }
    if (best.d === Infinity) best = { i: Math.max(0, coords.length - 2), t: 1, d: dist(p, coords[coords.length - 1]) };
    return best;
  }
}

// Records a ride: distance, moving time and a simplified track.
export class Recorder {
  constructor() {
    this.points = [];
    this.distance = 0;
    this.movingTime = 0;
    this.startedAt = Date.now();
    this.last = null;
  }

  add(p, accuracy, time = Date.now()) {
    if (accuracy > 35) return;
    if (!this.last) {
      this.last = { p, time };
      this.points.push([p[0], p[1], time]);
      return;
    }
    const d = dist(this.last.p, p);
    const dt = (time - this.last.time) / 1000;
    if (d < 4 || dt <= 0) return;
    const speed = d / dt;
    if (speed > 22) return; // GPS jump, not a bike
    this.distance += d;
    if (speed > 1 && dt < 30) this.movingTime += dt;
    this.last = { p, time };
    this.points.push([p[0], p[1], time]);
  }

  get speedKmh() { return this.movingTime ? (this.distance / this.movingTime) * 3.6 : 0; }

  toRide(id, bikeId, name) {
    return {
      id, bikeId, name,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      distance: Math.round(this.distance),
      movingTime: Math.round(this.movingTime),
      // [lat, lon, seconds since start] — the time lets us export a real GPX track later
      points: simplify(this.points, 4).map(p => [+p[0].toFixed(6), +p[1].toFixed(6), Math.round((p[2] - this.startedAt) / 1000)]),
      source: 'gps',
    };
  }
}

// Pretends to ride along a route, for trying the app at your desk.
export class Simulator {
  constructor(route, kmh, onFix) {
    this.route = route;
    this.speed = kmh / 3.6 * 2.5; // a bit faster than real life so demos don't drag
    this.along = 0;
    this.onFix = onFix;
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }
  setRoute(route) { this.route = route; this.along = 0; }
  tick() {
    const { coords, cum, length } = this.route;
    this.along = Math.min(length, this.along + this.speed);
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < this.along) i++;
    const seg = cum[i + 1] - cum[i] || 1;
    const t = Math.min(1, (this.along - cum[i]) / seg);
    const a = coords[i], b = coords[i + 1] || a;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    this.onFix({ latlng: p, accuracy: 5, heading: bearing(a, b), speed: this.speed, time: Date.now() });
  }
  stop() { clearInterval(this.timer); }
}
