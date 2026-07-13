// Thumbnail sidebar: page previews with drag-to-reorder, rotate and delete.
import { ICONS } from './icons.js';

export class Organizer {
  /**
   * opts: { el, onReorder(from,to), onRotate(n), onDelete(n), onSelect(n) }
   * (page numbers are 1-based; from/to are 0-based indices)
   */
  constructor(opts) {
    this.el = opts.el;
    this.opts = opts;
    this.tab = null;
    this.observer = null;
    this.dragFrom = null;
  }

  async show(tab) {
    this.tab = tab;
    this.el.replaceChildren();
    this.observer?.disconnect();
    if (!tab) return;
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
          <button class="th-delete" title="Delete page">${ICONS.trash}</button>
        </div>
        <div class="thumb-num">${n}</div>`;
      thumb.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.opts.onSelect(n);
      });
      thumb.querySelector('.th-rotate').addEventListener('click', () => this.opts.onRotate(n));
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

      this.el.appendChild(thumb);
      this.observer.observe(thumb);
    }
  }

  clearDragMarkers() {
    this.el.querySelectorAll('.drag-over-before, .drag-over-after')
      .forEach((t) => t.classList.remove('drag-over-before', 'drag-over-after'));
  }

  async renderThumb(thumb) {
    if (thumb._rendered || thumb._rendering || !this.tab) return;
    thumb._rendering = true;
    const tab = this.tab;
    try {
      const n = +thumb.dataset.page;
      const page = await tab.pdf.getPage(n);
      if (this.tab !== tab) return;
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
