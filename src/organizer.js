// Thumbnail sidebar: page previews with drag-to-reorder, rotate, OCR and delete.
import { ICONS } from './icons.js';

export class Organizer {
  /**
   * opts: { el, onReorder(from,to), onRotate(n), onOcr(n), onDelete(n), onSelect(n) }
   * (page numbers are 1-based; from/to are 0-based indices)
   */
  constructor(opts) {
    this.el = opts.el;
    this.opts = opts;
    this.tab = null;
    this.observer = null;
    this.dragFrom = null;
    // thumbnail bitmaps per document (keyed by page inside) — kept across tab
    // switches, retained across structural ops
    this.caches = new WeakMap();
    this.cache = new Map();
    this.cachePdf = null;
    this.pending = new Map();
    this.gen = 0;
  }

  getStore(tab) {
    if (!tab) return { cache: new Map(), pending: new Map() };
    if (!tab._thumbStore) {
      tab._thumbStore = this.caches.get(tab.pdf) || { cache: new Map(), pending: new Map() };
    }
    this.caches.set(tab.pdf, tab._thumbStore);
    return tab._thumbStore;
  }

  async show(tab) {
    if (!tab) {
      this.tab = null;
      this.cachePdf = null;
      this.el.replaceChildren();
      this.observer?.disconnect();
      return;
    }

    const sameTab = this.tab === tab;
    const samePdf = this.cachePdf === tab.pdf;
    this.tab = tab;

    const store = this.getStore(tab);
    this.cache = store.cache;
    this.pending = store.pending;
    this.cachePdf = tab.pdf;

    // If already showing this tab with matching thumbs count, just keep DOM
    if (sameTab && samePdf && this.el.children.length === tab.pdf.numPages) {
      return;
    }

    this.el.replaceChildren();
    this.observer?.disconnect();
    this.gen++;

    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) this.renderThumb(en.target);
      }
    }, { root: this.el, rootMargin: '400px 0px' });

    for (let n = 1; n <= tab.pdf.numPages; n++) {
      const thumb = this.buildThumb(n);
      this.el.appendChild(thumb);
      this.observer.observe(thumb);
    }
    this.prefetch(this.gen);
  }

  buildThumb(n) {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.dataset.page = n;
    thumb.draggable = true;
    thumb.innerHTML = `
      <div class="thumb-canvas-box"></div>
      <div class="thumb-actions">
        <button class="th-rotate" title="Rotate 90°">${ICONS.rotate}</button>
        <button class="th-ocr" title="OCR this page — make its text searchable">${ICONS.ocr}</button>
        <button class="th-delete" title="Delete page">${ICONS.trash}</button>
      </div>
      <div class="thumb-num">${n}</div>`;

    thumb.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      this.opts.onSelect(+thumb.dataset.page);
    });
    thumb.querySelector('.th-rotate').addEventListener('click', () => this.opts.onRotate(+thumb.dataset.page));
    thumb.querySelector('.th-ocr').addEventListener('click', () => this.opts.onOcr(+thumb.dataset.page));
    thumb.querySelector('.th-delete').addEventListener('click', () => this.opts.onDelete(+thumb.dataset.page));

    thumb.addEventListener('dragstart', (e) => {
      const p = +thumb.dataset.page;
      this.dragFrom = p - 1;
      thumb.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(p));
    });
    thumb.addEventListener('dragend', () => {
      thumb.classList.remove('dragging');
      this.clearDragMarkers();
      this.dragFrom = null;
    });
    thumb.addEventListener('dragover', (e) => {
      if (this.dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.clearDragMarkers();
      const rect = thumb.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      thumb.classList.add(before ? 'drag-over-before' : 'drag-over-after');
    });
    thumb.addEventListener('drop', (e) => {
      if (this.dragFrom === null) return;
      e.preventDefault();
      const p = +thumb.dataset.page;
      const rect = thumb.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      let to = (p - 1) + (before ? 0 : 1);
      const from = this.dragFrom;
      this.clearDragMarkers();
      this.dragFrom = null;
      if (to > from) to--;
      if (to !== from) this.opts.onReorder(from, to);
    });

    // Cached bitmap → show it immediately, no render round-trip.
    const cached = this.cache.get(n);
    if (cached) {
      thumb.querySelector('.thumb-canvas-box').replaceChildren(cached);
      thumb._rendered = true;
    }

    return thumb;
  }

  // Fast incremental deletion: removes target thumbnail DOM element, renumbers
  // remaining thumbnails and remaps cached canvases without reloading sidebar.
  deleteThumb(n, newPdf) {
    const thumb = this.el.querySelector(`.thumb[data-page="${n}"]`);
    if (thumb) {
      this.observer?.unobserve(thumb);
      thumb.remove();
    }
    // Renumber subsequent thumbnails in DOM
    const thumbs = this.el.querySelectorAll('.thumb');
    for (const t of thumbs) {
      const cur = +t.dataset.page;
      if (cur > n) {
        const next = cur - 1;
        t.dataset.page = next;
        const numEl = t.querySelector('.thumb-num');
        if (numEl) numEl.textContent = next;
      }
    }
    // Remap cache entries
    const nextCache = new Map();
    for (const [p, canvas] of this.cache) {
      if (p < n) nextCache.set(p, canvas);
      else if (p > n) nextCache.set(p - 1, canvas);
    }
    this.cache = nextCache;
    this.pending.clear();
    if (this.tab) {
      const store = this.getStore(this.tab);
      store.cache = this.cache;
      store.pending = this.pending;
      this.tab.pdf = newPdf;
      this.caches.set(newPdf, store);
      this.cachePdf = newPdf;
    }
  }

  // Fast incremental rotation: invalidates and re-renders only page n's thumbnail
  rotateThumb(n, newPdf) {
    this.cache.delete(n);
    if (this.tab) {
      const store = this.getStore(this.tab);
      store.cache = this.cache;
      this.tab.pdf = newPdf;
      this.caches.set(newPdf, store);
      this.cachePdf = newPdf;
    }
    const thumb = this.el.querySelector(`.thumb[data-page="${n}"]`);
    if (thumb) {
      thumb._rendered = false;
      thumb.querySelector('.thumb-canvas-box').replaceChildren();
      this.renderThumb(thumb);
    }
  }

    // Fast incremental reordering: repositions DOM element and remaps cache
  reorderThumb(from, to, newPdf, map) {
    const thumbs = [...this.el.querySelectorAll('.thumb')];
    const moving = thumbs[from];
    if (moving) {
      if (to >= thumbs.length - 1) {
        this.el.appendChild(moving);
      } else {
        const target = thumbs[to];
        this.el.insertBefore(moving, to > from ? target.nextSibling : target);
      }
    }
    // Re-index all thumbnails in DOM order
    this.el.querySelectorAll('.thumb').forEach((t, i) => {
      const p = i + 1;
      t.dataset.page = p;
      const numEl = t.querySelector('.thumb-num');
      if (numEl) numEl.textContent = p;
    });
    // Remap cache
    const nextCache = new Map();
    for (const [p, canvas] of this.cache) {
      const np = map(p);
      if (np !== null) nextCache.set(np, canvas);
    }
    this.cache = nextCache;
    this.pending.clear();
    if (this.tab) {
      const store = this.getStore(this.tab);
      store.cache = this.cache;
      store.pending = this.pending;
      this.tab.pdf = newPdf;
      this.caches.set(newPdf, store);
      this.cachePdf = newPdf;
    }
  }

  // Fast incremental insertion: remaps cached canvases and re-renders sidebar
  insertThumbs(at, count, newPdf) {
    const nextCache = new Map();
    for (const [p, canvas] of this.cache) {
      if (p <= at) nextCache.set(p, canvas);
      else nextCache.set(p + count, canvas);
    }
    this.cache = nextCache;
    this.pending.clear();
    if (this.tab) {
      const store = this.getStore(this.tab);
      store.cache = this.cache;
      store.pending = this.pending;
      this.tab.pdf = newPdf;
      this.caches.set(newPdf, store);
      this.cachePdf = newPdf;
    }
    this.show(this.tab);
  }

  // Warm the thumbnail cache in the background so scrolling the panel (and
  // reopening it) doesn't wait on renders. Paced to leave the pdf.js worker
  // mostly free for the main view; capped for very large documents.
  async prefetch(gen) {
    const pdf = this.cachePdf;
    const N = Math.min(this.tab?.pdf.numPages || 0, 300);
    for (let n = 1; n <= N; n++) {
      if (this.gen !== gen || this.cachePdf !== pdf) return;
      if (this.cache.has(n)) continue;
      try { await this.renderThumbCanvas(n, pdf); } catch { return; }
      if (this.gen !== gen || this.cachePdf !== pdf) return;
      const t = this.el.querySelector(`.thumb[data-page="${n}"]`);
      if (t && !t._rendered) {
        const c = this.cache.get(n);
        if (c) {
          t.querySelector('.thumb-canvas-box').replaceChildren(c);
          t._rendered = true;
        }
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  clearDragMarkers() {
    this.el.querySelectorAll('.drag-over-before, .drag-over-after')
      .forEach((t) => t.classList.remove('drag-over-before', 'drag-over-after'));
  }

  // Render (or fetch from cache) the bitmap for one page. Deduplicates
  // concurrent requests for the same page via `pending`.
  renderThumbCanvas(n, pdf) {
    if (this.cache.has(n)) return Promise.resolve(this.cache.get(n));
    if (this.pending.has(n)) return this.pending.get(n);
    const job = (async () => {
      const page = await pdf.getPage(n);
      const scale = 120 / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      if (this.cachePdf === pdf) {
        this.cache.set(n, canvas);
        // ~0.3 MB per thumb; keep the cache bounded for huge documents
        if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
      }
      return canvas;
    })();
    this.pending.set(n, job);
    // both handlers, so the cleanup chain never becomes an unhandled rejection
    job.then(() => this.pending.delete(n), () => this.pending.delete(n));
    return job;
  }

  async renderThumb(thumb) {
    if (thumb._rendered || thumb._rendering || !this.tab) return;
    thumb._rendering = true;
    const tab = this.tab;
    try {
      const n = +thumb.dataset.page;
      const canvas = await this.renderThumbCanvas(n, tab.pdf);
      if (this.tab !== tab) return;
      if (canvas) {
        thumb.querySelector('.thumb-canvas-box').replaceChildren(canvas);
        thumb._rendered = true;
      }
    } catch { /* thumbnail is cosmetic */ }
    finally { thumb._rendering = false; }
  }

  setCurrent(n) {
    this.el.querySelectorAll('.thumb.current').forEach((t) => t.classList.remove('current'));
    const t = this.el.querySelector(`.thumb[data-page="${n}"]`);
    if (t) {
      t.classList.add('current');
      const r = t.getBoundingClientRect(), er = this.el.getBoundingClientRect();
      if (r.top < er.top || r.bottom > er.bottom) t.scrollIntoView({ block: 'nearest' });
    }
  }
}
