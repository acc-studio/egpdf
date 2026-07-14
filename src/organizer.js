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
    // switches, dropped automatically when a pdf is destroyed/reloaded
    this.caches = new WeakMap();
    this.cache = new Map();
    this.cachePdf = null;
    this.pending = new Map();
    this.gen = 0;
  }

  async show(tab) {
    this.tab = tab;
    this.el.replaceChildren();
    this.observer?.disconnect();
    this.gen++;
    if (!tab) return;
    if (this.cachePdf !== tab.pdf) {
      this.cachePdf = tab.pdf;
      let store = this.caches.get(tab.pdf);
      if (!store) {
        store = { cache: new Map(), pending: new Map() };
        this.caches.set(tab.pdf, store);
      }
      this.cache = store.cache;
      this.pending = store.pending;
    }
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) this.renderThumb(en.target);
      }
    }, { root: this.el, rootMargin: '400px 0px' });

    for (let n = 1; n <= tab.pdf.numPages; n++) {
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
        this.opts.onSelect(n);
      });
      thumb.querySelector('.th-rotate').addEventListener('click', () => this.opts.onRotate(n));
      thumb.querySelector('.th-ocr').addEventListener('click', () => this.opts.onOcr(n));
      thumb.querySelector('.th-delete').addEventListener('click', () => this.opts.onDelete(n));

      thumb.addEventListener('dragstart', (e) => {
        this.dragFrom = n - 1;
        thumb.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(n));
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
        const rect = thumb.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        let to = (n - 1) + (before ? 0 : 1);
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

      this.el.appendChild(thumb);
      this.observer.observe(thumb);
    }
    this.prefetch(this.gen);
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
        t.querySelector('.thumb-canvas-box').replaceChildren(this.cache.get(n));
        t._rendered = true;
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
      thumb.querySelector('.thumb-canvas-box').replaceChildren(canvas);
      thumb._rendered = true;
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
