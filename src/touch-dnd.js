// HTML5 drag-and-drop for touch screens. Android WebViews don't start drags
// from touches, so the page organizer (reorder) and Combine (copy pages across
// documents) would be dead on a phone. This translates a long-press + move on
// any [draggable="true"] element into the same dragstart / dragover / drop /
// dragend sequence a mouse produces — the existing handlers run unchanged.
const HOLD_MS = 380;
const SLOP_PX = 10;
const EDGE_PX = 48;

function fire(type, target, x, y, dt) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    clientX: { value: x }, clientY: { value: y }, dataTransfer: { value: dt },
  });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function scrollableAncestors(el) {
  const out = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if ((/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight)
      || (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth)) out.push(n);
  }
  return out;
}

export function installTouchDnd() {
  let pending = null; // { src, x, y, timer }
  let drag = null;    // { src, dt, ghost, over, accepted, x, y, raf }

  // A trusted (browser-started) drag would fight ours.
  document.addEventListener('dragstart', (e) => { if (e.isTrusted) e.preventDefault(); }, true);
  document.addEventListener('contextmenu', (e) => {
    if (pending || drag || e.target.closest?.('[draggable="true"]')) e.preventDefault();
  }, true);

  const cancelPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  function begin() {
    const { src, x, y } = pending;
    pending = null;
    const dt = {
      effectAllowed: 'all', dropEffect: 'none', types: ['text/plain'],
      _data: {}, setData(k, v) { this._data[k] = v; }, getData(k) { return this._data[k] || ''; },
    };
    fire('dragstart', src, x, y, dt);
    navigator.vibrate?.(12);

    // a small floating copy of the grabbed page under the finger
    const ghost = document.createElement('div');
    ghost.className = 'touch-drag-ghost';
    const canvas = src.querySelector('canvas');
    if (canvas) {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, 0, 0);
      ghost.appendChild(c);
    }
    document.body.appendChild(ghost);
    drag = { src, dt, ghost, over: null, accepted: false, x, y, raf: 0 };
    moveTo(x, y);
    autoScroll();
  }

  function moveTo(x, y) {
    drag.x = x; drag.y = y;
    drag.ghost.style.transform = `translate(${x - 36}px, ${y - 60}px)`;
    const over = document.elementFromPoint(x, y);
    drag.over = over;
    drag.accepted = over ? fire('dragover', over, x, y, drag.dt) : false;
  }

  // Scroll whatever list the finger is near the edge of, so long documents
  // can be reordered end to end.
  function autoScroll() {
    if (!drag) return;
    if (drag.over) {
      for (const s of scrollableAncestors(drag.over)) {
        const r = s.getBoundingClientRect();
        const dy = drag.y < r.top + EDGE_PX ? -14 : drag.y > r.bottom - EDGE_PX ? 14 : 0;
        const dx = drag.x < r.left + EDGE_PX ? -14 : drag.x > r.right - EDGE_PX ? 14 : 0;
        if (dy && s.scrollHeight > s.clientHeight) s.scrollTop += dy;
        if (dx && s.scrollWidth > s.clientWidth) s.scrollLeft += dx;
      }
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function finish(dropIt) {
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    if (dropIt && d.over && d.accepted) fire('drop', d.over, d.x, d.y, d.dt);
    fire('dragend', d.src, d.x, d.y, d.dt);
    // the lifted finger must not also "tap" the page under it
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 350);
  }

  document.addEventListener('touchstart', (e) => {
    if (drag) return;
    cancelPending();
    if (e.touches.length !== 1) return;
    const src = e.target.closest?.('[draggable="true"]');
    if (!src || e.target.closest('button')) return;
    const t = e.touches[0];
    pending = { src, x: t.clientX, y: t.clientY, timer: setTimeout(begin, HOLD_MS) };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (pending) {
      // moved before the hold completed: it's a scroll, not a drag
      if (Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > SLOP_PX) cancelPending();
      return;
    }
    if (!drag) return;
    e.preventDefault();
    moveTo(t.clientX, t.clientY);
  }, { passive: false });

  document.addEventListener('touchend', () => {
    cancelPending();
    if (drag) finish(true);
  });
  document.addEventListener('touchcancel', () => {
    cancelPending();
    if (drag) finish(false);
  });
}
