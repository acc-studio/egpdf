// Split PDF overlay: visual page extraction dialog with range input and thumbnail grid.
import { extractPages, buildSavedPdf } from './save.js';

export function parsePageRange(str, maxPages) {
  if (!str || !str.trim()) return [];
  const parts = str.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const result = new Set();
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        const lo = Math.max(1, Math.min(start, end));
        const hi = Math.min(maxPages, Math.max(start, end));
        for (let i = lo; i <= hi; i++) result.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 1 && n <= maxPages) {
        result.add(n);
      }
    }
  }
  return [...result].sort((a, b) => a - b);
}

export function formatPageRange(pageNums) {
  const sorted = [...new Set(pageNums)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const ranges = [];
  let start = sorted[0];
  let prev = start;

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
      prev = cur;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(', ');
}

export class SplitPdf {
  /**
   * opts: {
   *   el,                  // #split-overlay
   *   getActiveTab(),      // () => Tab | null
   *   onExtractToTab(tab, pageNums),
   *   onSaveExtracted(tab, pageNums),
   *   onClose(),
   * }
   */
  constructor(opts) {
    this.opts = opts;
    this.el = opts.el;
    this.tab = null;
    this.selectedPages = new Set();
    this.lastClicked = null;
    this.observer = null;
    this.caches = new WeakMap();
    this.gen = 0;
    this.isApplyingRangeInput = false;

    this.gridEl = this.el.querySelector('#split-grid');
    this.rangeInput = this.el.querySelector('#split-range-input');
    this.countEl = this.el.querySelector('#split-selected-count');
    this.titleEl = this.el.querySelector('#split-doc-title');
    this.btnExtractTab = this.el.querySelector('#split-btn-extract-tab');
    this.btnSaveAs = this.el.querySelector('#split-btn-save-as');

    this.wireEvents();
  }

  wireEvents() {
    this.el.querySelector('#split-close')?.addEventListener('click', () => this.close());
    this.el.querySelector('#split-btn-cancel')?.addEventListener('click', () => this.close());

    this.rangeInput?.addEventListener('input', () => {
      if (!this.tab || this.isApplyingRangeInput) return;
      const pages = parsePageRange(this.rangeInput.value, this.tab.pdf.numPages);
      this.selectedPages = new Set(pages);
      this.syncSelectionToGrid();
      this.updateStatus();
    });

    this.el.querySelector('#split-btn-all')?.addEventListener('click', () => {
      if (!this.tab) return;
      this.selectAll();
    });

    this.el.querySelector('#split-btn-none')?.addEventListener('click', () => {
      if (!this.tab) return;
      this.clearAll();
    });

    this.el.querySelector('#split-btn-odd')?.addEventListener('click', () => {
      if (!this.tab) return;
      this.selectPattern((n) => n % 2 === 1);
    });

    this.el.querySelector('#split-btn-even')?.addEventListener('click', () => {
      if (!this.tab) return;
      this.selectPattern((n) => n % 2 === 0);
    });

    this.btnExtractTab?.addEventListener('click', () => this.doExtract(false));
    this.btnSaveAs?.addEventListener('click', () => this.doExtract(true));

    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.doExtract(false);
      }
    });
  }

  isOpen() {
    return !this.el.classList.contains('hidden');
  }

  open() {
    const tab = this.opts.getActiveTab();
    if (!tab) return false;
    this.tab = tab;
    this.selectedPages = new Set([tab.view?.currentPageNum || 1]);
    this.lastClicked = tab.view?.currentPageNum || 1;
    this.el.classList.remove('hidden');

    if (this.titleEl) {
      this.titleEl.textContent = `${tab.title} (${tab.pdf.numPages} page${tab.pdf.numPages === 1 ? '' : 's'})`;
    }

    this.render();
    this.rangeInput?.focus();
    return true;
  }

  close() {
    this.el.classList.add('hidden');
    this.gen++;
    this.observer?.disconnect();
    this.observer = null;
    this.gridEl.replaceChildren();
    this.tab = null;
    this.selectedPages.clear();
    this.lastClicked = null;
    this.opts.onClose?.();
  }

  selectAll() {
    if (!this.tab) return;
    this.selectedPages = new Set(Array.from({ length: this.tab.pdf.numPages }, (_, i) => i + 1));
    this.syncSelection();
  }

  clearAll() {
    this.selectedPages.clear();
    this.syncSelection();
  }

  selectPattern(predicate) {
    if (!this.tab) return;
    const pages = [];
    for (let n = 1; n <= this.tab.pdf.numPages; n++) {
      if (predicate(n)) pages.push(n);
    }
    this.selectedPages = new Set(pages);
    this.syncSelection();
  }

  syncSelection() {
    this.syncSelectionToGrid();
    this.syncSelectionToInput();
    this.updateStatus();
  }

  syncSelectionToGrid() {
    const cards = this.gridEl.querySelectorAll('.split-card');
    for (const card of cards) {
      const page = +card.dataset.page;
      const selected = this.selectedPages.has(page);
      card.classList.toggle('selected', selected);
      const chk = card.querySelector('.split-card-checkbox');
      if (chk) chk.checked = selected;
    }
  }

  syncSelectionToInput() {
    this.isApplyingRangeInput = true;
    if (this.rangeInput) {
      this.rangeInput.value = formatPageRange([...this.selectedPages]);
    }
    this.isApplyingRangeInput = false;
  }

  updateStatus() {
    const count = this.selectedPages.size;
    const total = this.tab?.pdf.numPages || 0;
    if (this.countEl) {
      this.countEl.textContent = `${count} of ${total} page${total === 1 ? '' : 's'} selected`;
    }
    const disabled = count === 0;
    if (this.btnExtractTab) this.btnExtractTab.disabled = disabled;
    if (this.btnSaveAs) this.btnSaveAs.disabled = disabled;
  }

  render() {
    if (!this.isOpen() || !this.tab) return;
    const tab = this.tab;
    const gen = ++this.gen;

    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) this.renderThumb(en.target, tab, gen);
      }
    }, { root: this.gridEl, rootMargin: '300px 0px' });

    this.gridEl.replaceChildren();

    for (let n = 1; n <= tab.pdf.numPages; n++) {
      const card = document.createElement('div');
      card.className = 'split-card' + (this.selectedPages.has(n) ? ' selected' : '');
      card.dataset.page = n;
      card.innerHTML = `
        <div class="split-card-head">
          <input type="checkbox" class="split-card-checkbox" ${this.selectedPages.has(n) ? 'checked' : ''} />
          <span class="split-card-num">Page ${n}</span>
        </div>
        <div class="split-card-preview">
          <div class="split-card-canvas-box"></div>
        </div>`;

      const chk = card.querySelector('.split-card-checkbox');
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', () => this.togglePage(n, chk.checked));

      card.addEventListener('click', (e) => {
        if (e.shiftKey && this.lastClicked !== null) {
          const lo = Math.min(this.lastClicked, n);
          const hi = Math.max(this.lastClicked, n);
          for (let p = lo; p <= hi; p++) this.selectedPages.add(p);
          this.syncSelection();
        } else {
          this.togglePage(n, !this.selectedPages.has(n));
          this.lastClicked = n;
        }
      });

      // Quick-use cached thumbnail if available
      const store = tab._thumbStore || this.caches.get(tab.pdf);
      const cached = store?.cache?.get(n);
      if (cached) {
        const copyCanvas = document.createElement('canvas');
        copyCanvas.width = cached.width;
        copyCanvas.height = cached.height;
        const ctx = copyCanvas.getContext('2d');
        ctx.drawImage(cached, 0, 0);
        card.querySelector('.split-card-canvas-box').replaceChildren(copyCanvas);
        card._rendered = true;
      } else {
        this.observer.observe(card);
      }

      this.gridEl.appendChild(card);
    }

    this.syncSelectionToInput();
    this.updateStatus();
  }

  togglePage(n, selected) {
    if (selected) this.selectedPages.add(n);
    else this.selectedPages.delete(n);
    this.syncSelection();
  }

  async renderThumb(card, tab, gen) {
    if (card._rendered || card._rendering) return;
    card._rendering = true;
    try {
      const n = +card.dataset.page;
      const page = await tab.pdf.getPage(n);
      const scale = 140 / page.getViewport({ scale: 1 }).width;
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

      if (this.gen !== gen || !this.isOpen() || this.tab !== tab) return;
      if (canvas) {
        card.querySelector('.split-card-canvas-box').replaceChildren(canvas);
        card._rendered = true;
      }
    } catch { /* cosmetic preview */ }
    finally { card._rendering = false; }
  }

  async doExtract(saveAs = false) {
    const pageNums = [...this.selectedPages].sort((a, b) => a - b);
    if (!this.tab || !pageNums.length) return;
    const tab = this.tab;
    this.close();
    if (saveAs) {
      await this.opts.onSaveExtracted(tab, pageNums);
    } else {
      await this.opts.onExtractToTab(tab, pageNums);
    }
  }
}
