// Reusable draggable bottom sheet with two snap points (collapsed / expanded).
// The sheet follows the finger (height set directly, content fades in step), releases with
// velocity + nearest snap, and a plain tap animates the same way. Touch only (this is a phone app).

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function bottomSheet({ el, grips = [], scroller = null, isCollapsed, apply, disabled = () => false, ms = 300 }) {
  let hE = 0, hC = 0, busy = null, suppressUntil = 0, g = null;

  const clean = () => {
    clearTimeout(busy); busy = null;
    el.classList.remove('sheeting', 'settling');
    el.style.height = ''; el.style.overflow = ''; el.style.removeProperty('--p');
  };
  // Measure both layouts without painting in between.
  const measure = () => {
    const was = isCollapsed();
    const h = el.style.height, o = el.style.overflow;
    el.style.height = ''; el.style.overflow = '';
    apply(false); hE = el.offsetHeight;
    apply(true); hC = el.offsetHeight;
    apply(was);
    el.style.height = h; el.style.overflow = o;
  };

  // Settle to a state, animating from the current height.
  function go(collapsed, { instant = false } = {}) {
    const from = el.offsetHeight;
    const wasDragging = el.classList.contains('sheeting');
    if (!wasDragging) clean();
    if (instant || reduced() || !from || el.hidden || disabled()) { clean(); apply(collapsed); return; }
    if (!wasDragging) {
      const p0 = isCollapsed() ? 0 : 1;
      measure();
      apply(false);                       // both layouts' content present while animating
      el.classList.add('sheeting');
      el.style.overflow = 'hidden';
      el.style.height = from + 'px';
      el.style.setProperty('--p', p0);
      el.offsetHeight;
    }
    const to = collapsed ? hC : hE;
    el.classList.remove('sheeting');
    el.classList.add('settling');
    el.style.transition = `height ${ms}ms ${EASE}`;
    el.style.height = to + 'px';
    el.style.setProperty('--p', collapsed ? 0 : 1);
    clearTimeout(busy);
    busy = setTimeout(() => { el.style.transition = ''; clean(); apply(collapsed); }, ms + 40);
  }

  const toggle = () => go(!isCollapsed());

  function begin(e) {
    g = null;
    if (e.touches.length !== 1 || disabled()) return;
    const t0 = e.touches[0];
    const inScroll = scroller && scroller !== el ? scroller.contains(e.target) : false;
    g = { x0: t0.clientX, y0: t0.clientY, y: t0.clientY, t: performance.now(), v: 0, on: false, inScroll, grip: grips.some(x => x?.contains(e.target)) };
  }
  function move(e) {
    if (!g || e.touches.length !== 1) return;
    const t0 = e.touches[0], dx = t0.clientX - g.x0, dy = t0.clientY - g.y0, now = performance.now();
    if (!g.on) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      const col = isCollapsed();
      const top = !scroller || scroller.scrollTop <= 0;
      // vertical drags only; when open, only a downward pull from the top (or from the handle) takes over from scrolling
      if (Math.abs(dx) > Math.abs(dy) || (!col && dy < 0) || (!col && !top && !g.grip)) { g = null; return; }
      if (busy) clean();
      measure();
      g.col = col;
      if (col) apply(false);
      g.h0 = col ? hC : hE;
      el.classList.add('sheeting');
      el.style.overflow = 'hidden';
      el.style.height = g.h0 + 'px';
      g.y0 = t0.clientY;     // start measuring from here so there is no jump
      g.on = true;
    }
    if (e.cancelable) e.preventDefault();
    const d = t0.clientY - g.y0;
    g.v = 0.8 * g.v + 0.2 * ((t0.clientY - g.y) / Math.max(1, now - g.t)); g.y = t0.clientY; g.t = now;
    let h = g.h0 - d;
    if (h > hE) h = hE + (h - hE) * 0.25;       // rubber band
    if (h < hC) h = hC - (hC - h) * 0.25;
    el.style.height = h + 'px';
    el.style.setProperty('--p', Math.max(0, Math.min(1, (h - hC) / Math.max(1, hE - hC))));
  }
  function end(e) {
    if (!g) return;
    const was = g; g = null;
    if (!was.on) return;
    suppressUntil = performance.now() + 350;
    if (e.cancelable) e.preventDefault();
    const h = el.offsetHeight, mid = (hC + hE) / 2;
    const collapsed = was.v > 0.4 ? true : was.v < -0.4 ? false : h < mid;
    go(collapsed);
  }
  el.addEventListener('touchstart', begin, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end, { passive: false });
  el.addEventListener('touchcancel', end, { passive: false });
  // a drag must not end in a click on whatever is under the finger
  el.addEventListener('click', e => {
    if (performance.now() < suppressUntil) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  return { go, toggle };
}
