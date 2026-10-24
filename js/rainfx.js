// Illustrated weather effect driven by RainViewer radar.
// The radar tiles are never shown: every tile is decoded into a small intensity grid (0..1) and a
// screen-aligned canvas draws soft cloud shade, rain streaks, wind gusts and the odd flash from it.

const GRID = 32;           // intensity samples per radar tile edge
const CELL = 22;           // css px per screen sample cell
const MAX_Z = 7;           // RainViewer serves nothing sharper
const FADE_MS = 400;       // crossfade between radar frames
const FRAME_MS = 33;       // ~30 fps

// RainViewer colour scheme 2 ("Universal Blue") -> 0..1. Teal/blue = light to moderate, light blue/violet
// = heavy, yellow/orange/red = very heavy. Low alpha is clutter, ignored.
function colourIntensity(r, g, b, a) {
  if (a < 120) return 0;
  if (r > 200 && b < 120) return 0.86 + 0.14 * (1 - g / 255);
  const x = Math.min(1, Math.max(0, (g - 70) / 170)) * 0.65 + 0.25 * Math.min(1, r / 150);
  return Math.min(0.9, x);
}

export function createRainFx(map, { canvas, toContainer, getWind, getRotation, isDark }) {
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const frames = [];                       // { layer, tiles: Map<'z/x/y', Uint8Array> }
  let on = false, moving = false, raf = 0, last = 0;
  let cur = -1, prev = -1, fadeAt = 0;
  let cols = 0, rows = 0, W = 0, H = 0, dpr = 1;
  let gridA = null, gridB = null, blend = null, dirty = true;   // gridA = previous frame, gridB = current
  let shade = null, shadeCtx = null;
  let parts = [], gusts = [], maxParts = 0;
  let flash = null, nextFlash = 0, stormCells = [];
  let wind = { speed: 0, dir: null };

  // ---- radar tiles -> intensity grids
  const TileLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const el = document.createElement('div');   // invisible: only the data matters
      const n = 2 ** coords.z, x = ((coords.x % n) + n) % n;
      if (coords.y < 0 || coords.y >= n) { setTimeout(done, 0); return el; }
      const fr = this.options.fx, key = `${coords.z}/${x}/${coords.y}`;
      if (fr.tiles.has(key)) { setTimeout(done, 0); return el; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 256;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          const p = g.getImageData(0, 0, 256, 256).data, out = new Uint8Array(GRID * GRID), B = 256 / GRID;
          for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
            let s = 0;
            for (let py = 0; py < B; py += 2) for (let px = 0; px < B; px += 2) {
              const i = ((gy * B + py) * 256 + gx * B + px) * 4;
              s += colourIntensity(p[i], p[i + 1], p[i + 2], p[i + 3]);
            }
            out[gy * GRID + gx] = Math.round(255 * s / ((B / 2) * (B / 2)));
          }
          fr.tiles.set(key, out);
          if (fr === frames[cur] || fr === frames[prev]) dirty = true;
        } catch { /* tainted canvas: no rain data for this tile */ }
        done();
      };
      img.onerror = () => done();
      img.src = this.options.tileUrl.replace('{z}', coords.z).replace('{x}', x).replace('{y}', coords.y);
      return el;
    },
  });

  // bilinear intensity of frame f at a latlng (0 when the tile is not loaded)
  function sample(f, lat, lng) {
    const z = Math.max(0, Math.min(MAX_Z, Math.round(map.getZoom())));
    const n = 2 ** z, s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
    const px = ((lng + 180) / 360) * n * GRID - 0.5, py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * GRID - 0.5;
    const tile = (gx, gy) => {
      const tx = Math.floor(gx / GRID), ty = Math.floor(gy / GRID);
      if (ty < 0 || ty >= n) return 0;
      const t = f.tiles.get(`${z}/${((tx % n) + n) % n}/${ty}`);
      return t ? t[(gy - ty * GRID) * GRID + (((gx % GRID) + GRID) % GRID)] / 255 : 0;
    };
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
    return (tile(x0, y0) * (1 - fx) + tile(x0 + 1, y0) * fx) * (1 - fy) + (tile(x0, y0 + 1) * (1 - fx) + tile(x0 + 1, y0 + 1) * fx) * fy;
  }

  function gridFor(f) {
    const g = new Float32Array(cols * rows);
    if (!f) return g;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ll = map.containerPointToLatLng(toContainer((c + 0.5) * CELL, (r + 0.5) * CELL));
      g[r * cols + c] = sample(f, ll.lat, ll.lng);
    }
    return g;
  }

  function resample() {
    dirty = false;
    gridA = prev >= 0 && prev !== cur ? gridFor(frames[prev]) : null;
    gridB = gridFor(frames[cur]);
    blend = new Float32Array(cols * rows);
    stormCells = [];
    for (let i = 0; i < gridB.length; i++) if (gridB[i] > 0.85) stormCells.push(i);
  }

  function currentGrid(now) {
    const k = gridA ? Math.min(1, (now - fadeAt) / FADE_MS) : 1;
    if (k >= 1) { gridA = null; prev = cur; return gridB; }
    for (let i = 0; i < blend.length; i++) blend[i] = gridA[i] + (gridB[i] - gridA[i]) * k;
    return blend;
  }

  // ---- canvas
  function size() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    cols = Math.ceil(W / CELL); rows = Math.ceil(H / CELL);
    shade = document.createElement('canvas'); shade.width = cols; shade.height = rows;
    shadeCtx = shade.getContext('2d');
    maxParts = Math.round(Math.min(900, Math.max(250, 600 * (W * H) / (390 * 800))));
    parts = []; gusts = [];
    dirty = true;
  }

  const val = (g, x, y) => {
    const c = Math.min(cols - 1, Math.max(0, x / CELL | 0)), r = Math.min(rows - 1, Math.max(0, y / CELL | 0));
    return g[r * cols + c];
  };

  // wind in screen px/s (x right, y down), already following the map rotation
  function windVec() {
    if (wind.dir == null || !(wind.speed > 0)) return { x: 0, y: 0 };
    const th = wind.dir * Math.PI / 180, e = -wind.speed * Math.sin(th), n = -wind.speed * Math.cos(th);   // blowing towards
    const f = (getRotation() || 0) * Math.PI / 180;
    return { x: e * Math.cos(f) + n * Math.sin(f), y: e * Math.sin(f) - n * Math.cos(f) };
  }

  function spawn(p, g, anywhere) {
    for (let k = 0; k < 6; k++) {
      const x = Math.random() * (W + 120) - 60, y = anywhere ? Math.random() * H : -20 - Math.random() * 60;
      const v = val(g, Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y + 60)));
      // rain only appears where there is rain; denser where it is heavier
      if (v > 0.1 && Math.random() < v * 1.3) { p.x = x; p.y = y; p.on = true; p.z = 0.7 + Math.random() * 0.6; return; }
    }
    p.on = false;
  }

  function draw(now, dt) {
    const g = currentGrid(now);
    const dark = isDark(), w = windVec();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // cloud shade: one pixel per cell, scaled up smoothly
    const img = shadeCtx.createImageData(cols, rows), d = img.data;
    const cr = dark ? 8 : 62, cg = dark ? 14 : 76, cb = dark ? 28 : 98;
    let any = false;
    for (let i = 0; i < g.length; i++) {
      const v = g[i]; if (v < 0.06) continue;
      any = true;
      d[i * 4] = cr; d[i * 4 + 1] = cg; d[i * 4 + 2] = cb;
      d[i * 4 + 3] = Math.round(255 * (dark ? 0.46 : 0.34) * Math.min(1, v * 1.15) ** 1.3);
    }
    if (any) {
      shadeCtx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(shade, 0, 0, cols * CELL, rows * CELL);
    }

    if (reduced.matches) return;

    // rain streaks
    const bft = (wind.speed / 0.836) ** (2 / 3);
    const fall = 640 + Math.min(10, wind.speed) * 25;
    const vx = w.x * 38, vy = fall, sp = Math.hypot(vx, vy), ux = vx / sp, uy = vy / sp;
    const want = any ? maxParts : 0;
    while (parts.length < want) parts.push({ on: false, x: 0, y: 0, z: 1 });
    ctx.lineCap = 'round';
    ctx.strokeStyle = dark ? 'rgb(196,220,255)' : 'rgb(58,86,128)';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.on) { if (i < want && Math.random() < 0.2) spawn(p, g, true); continue; }
      p.x += vx * p.z * dt; p.y += vy * p.z * dt;
      if (p.y > H + 30 || p.x < -80 || p.x > W + 80) { spawn(p, g, false); if (!p.on) continue; }
      const v = val(g, Math.max(0, Math.min(W - 1, p.x)), Math.max(0, Math.min(H - 1, p.y)));
      if (v < 0.08) { if (Math.random() < 0.3) spawn(p, g, true); continue; }
      const len = (v < 0.3 ? 7 : v < 0.6 ? 13 : 19) * p.z + Math.min(8, bft * 1.2);
      ctx.globalAlpha = (dark ? 0.5 : 0.42) * (v < 0.3 ? 0.6 : 1);
      ctx.lineWidth = v < 0.3 ? 0.8 : v < 0.6 ? 1.1 : 1.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - ux * len, p.y - uy * len); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // faint gust lines across the whole screen from Beaufort 5
    if (bft >= 5 && w.x * w.x + w.y * w.y > 0) {
      const m = Math.hypot(w.x, w.y), gx = w.x / m, gy = w.y / m, target = Math.min(12, Math.round(bft * 1.2));
      if (gusts.length < target && Math.random() < 0.15) {
        gusts.push({ x: Math.random() * W - gx * 120, y: Math.random() * H - gy * 120, len: 70 + Math.random() * 90, life: 0, max: 0.7 + Math.random() * 0.6 });
      }
      const spd = 380 + bft * 55;
      for (let i = gusts.length - 1; i >= 0; i--) {
        const q = gusts[i]; q.life += dt;
        if (q.life > q.max) { gusts.splice(i, 1); continue; }
        q.x += gx * spd * dt; q.y += gy * spd * dt;
        const a = Math.sin(Math.PI * q.life / q.max) * 0.22;
        const grad = ctx.createLinearGradient(q.x - gx * q.len, q.y - gy * q.len, q.x, q.y);
        grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, `rgba(255,255,255,${a})`);
        ctx.strokeStyle = grad; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(q.x - gx * q.len, q.y - gy * q.len); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    } else gusts.length = 0;

    // decorative lightning in the very heavy cells
    if (stormCells.length) {
      if (!nextFlash) nextFlash = now + 3000 + Math.random() * 5000;
      if (now > nextFlash) {
        const c = stormCells[Math.random() * stormCells.length | 0];
        flash = { x: (c % cols + 0.5) * CELL, y: ((c / cols | 0) + 0.5) * CELL, t0: now };
        nextFlash = now + 6000 + Math.random() * 4000;
      }
    } else nextFlash = 0;
    if (flash) {
      const age = now - flash.t0;
      if (age > 600) flash = null;
      else {
        const a = (age < 120 ? age / 120 : age < 220 ? 0.4 : age < 300 ? 0.9 : 1 - (age - 300) / 300) * 0.5;
        const r = 160 + 60 * (age / 600), gr = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, r);
        gr.addColorStop(0, `rgba(255,255,255,${Math.max(0, a)})`); gr.addColorStop(1, 'rgba(235,240,255,0)');
        ctx.fillStyle = gr; ctx.fillRect(flash.x - r, flash.y - r, r * 2, r * 2);
      }
    }
  }

  function tick(now) {
    raf = 0;
    if (!on || moving || document.hidden) return;
    raf = requestAnimationFrame(tick);
    if (now - last < FRAME_MS) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (dirty) resample();
    draw(now, dt);
  }

  function kick() {
    if (on && !moving && !document.hidden && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }

  // a zoom makes the grid badly wrong, so fade it out of the way; plain pans (also the follow camera
  // every second) keep animating and just resample when they end, so the rain never flickers
  function onMoveStart() { moving = true; if (raf) cancelAnimationFrame(raf); raf = 0; canvas.style.opacity = 0.0; }
  function onMoveEnd() { moving = false; dirty = true; if (on) { resample(); draw(performance.now(), 0); canvas.style.opacity = ''; kick(); } }
  const onResize = () => { if (on) { size(); onMoveEnd(); } };
  const onVis = () => kick();
  const onMotion = () => { if (on) { dirty = true; resample(); draw(performance.now(), 0); } };

  return {
    // one hidden tile layer per radar frame, so the whole loop is preloaded
    addFrame(tileUrl) {
      const fr = { tiles: new Map(), layer: null };
      fr.layer = new TileLayer({ tileUrl, fx: fr, maxNativeZoom: MAX_Z, maxZoom: 20, opacity: 0, className: 'radar-tiles', attribution: 'RainViewer', updateWhenZooming: false, keepBuffer: 1 }).addTo(map);
      frames.push(fr);
      return fr;
    },
    show(i) {
      if (i === cur) return;
      prev = cur; cur = i; fadeAt = performance.now();
      dirty = true;
    },
    setWind(w) { wind = w || { speed: 0, dir: null }; },
    start() {
      on = true; size(); canvas.hidden = false; canvas.style.opacity = '';
      map.on('zoomstart', onMoveStart).on('moveend zoomend', onMoveEnd);
      addEventListener('resize', onResize); document.addEventListener('visibilitychange', onVis);
      reduced.addEventListener?.('change', onMotion);
      kick();
    },
    stop() {
      on = false; if (raf) cancelAnimationFrame(raf); raf = 0;
      map.off('zoomstart', onMoveStart).off('moveend zoomend', onMoveEnd);
      removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis);
      reduced.removeEventListener?.('change', onMotion);
      frames.forEach(f => f.layer.remove()); frames.length = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.hidden = true;
    },
  };
}
