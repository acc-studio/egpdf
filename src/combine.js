// Combine overlay: shows every open PDF as a column of page thumbnails and lets
// you drag pages from one document into another to build a combined file.
// Dropping a page inserts a *copy* into the target (the source is untouched);
// the actual page copy is done by the save-pipeline op via the onInsert hook,
// which reloads the target tab, after which we re-render.
export class Combine {
  /**
   * opts: {
   *   el,                              // #combine-overlay
   *   colsEl,                          // #combine-cols
   *   getTabs(),                       // → open tabs, in tab-bar order
   *   onInsert(target, source, pages, atIndex),  // pages are 1-based; async
   *   onClose(),
   * }
   */
  constructor(opts) {
    this.opts = opts;
    this.el = opts.el;
    this.colsEl = opts.colsEl;
    this.previewEl = opts.previewEl;
    this.caches = new WeakMap();        // pdf → Map(pageNum → canvas) — thumbnails
    this.previewCaches = new WeakMap(); // pdf → Map(pageNum → canvas) — larger preview
    this.observer = null;
    this.previewObserver = null;
    this.previewTabId = null;    // which document is shown in the preview pane
    this.sel = null;             // { tabId, pages:Set<number> } — selection in one column
    this.drag = null;            // { tabId, pages:number[] }
    this.gen = 0;
    this.busy = false;
  }

  isOpen() { return !this.el.classList.contains('hidden'); }
  columnCount() { return this.colsEl.querySelectorAll('.combine-col').length; }

  open() {
    if (this.opts.getTabs().length < 2) return false;
    this.el.classList.remove('hidden');
    this.render();
    return true;
  }

  close() {
    this.el.classList.add('hidden');
    this.gen++;
    this.observer?.disconnect();
    this.observer = null;
    this.previewObserver?.disconnect();
    this.previewObserver = null;
    this.colsEl.replaceChildren();
    this.previewEl.replaceChildren();
    this.sel = null;
    this.drag = null;
    this.previewTabId = null;
    this.opts.onClose?.();
  }

  // Rebuild the columns from the current tab set (called on open and after an
  // insert reloads a tab's pdf).
  render() {
    if (!this.isOpen()) return;
    const gen = ++this.gen;
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderThumb(en.target);
    }, { root: this.colsEl, rootMargin: '400px 0px' });

    this.colsEl.replaceChildren();
    const tabs = this.opts.getTabs();
    for (const tab of tabs) this.colsEl.appendChild(this.buildColumn(tab, gen));

    // keep the preview in sync: re-render the previewed doc (its pdf may have
    // been reloaded by an insert), or drop the preview if that tab is gone
    if (this.previewTabId != null && tabs.some((t) => t.id === this.previewTabId)) {
      this.previewTab(tabs.find((t) => t.id === this.previewTabId));
    } else {
      this.previewTabId = null;
      this.previewObserver?.disconnect();
      this.previewEl.replaceChildren(this.hintEl());
    }
  }

  hintEl() {
    const hint = document.createElement('div');
    hint.id = 'combine-preview-hint';
    hint.className = 'dim';
    hint.textContent = 'Click a document’s title to preview it here.';
    return hint;
  }

  buildColumn(tab, gen) {
    const col = document.createElement('div');
    col.className = 'combine-col';
    col.dataset.tabId = tab.id;

    const head = document.createElement('div');
    head.className = 'combine-col-head' + (this.previewTabId === tab.id ? ' previewing' : '');
    head.textContent = tab.title;
    head.title = `${tab.filePath || tab.title}\nClick to preview`;
    const count = document.createElement('span');
    count.className = 'combine-col-count dim';
    count.textContent = `${tab.pdf.numPages} page${tab.pdf.numPages === 1 ? '' : 's'}`;
    head.appendChild(count);
    head.addEventListener('click', () => this.previewTab(tab));

    const body = document.createElement('div');
    body.className = 'combine-col-body';

    for (let n = 1; n <= tab.pdf.numPages; n++) {
      body.appendChild(this.buildThumb(tab, n, gen));
    }
    // a tail drop-zone so pages can be appended after the last one
    const tail = document.createElement('div');
    tail.className = 'combine-tail';
    tail.dataset.tabId = tab.id;
    tail.dataset.at = tab.pdf.numPages; // insert index (0-based) = page count
    this.wireDropZone(tail, tab, tab.pdf.numPages);
    body.appendChild(tail);

    col.append(head, body);
    return col;
  }

  buildThumb(tab, n, gen) {
    const thumb = document.createElement('div');
    thumb.className = 'combine-thumb';
    thumb.dataset.tabId = tab.id;
    thumb.dataset.page = n;
    thumb.draggable = true;
    thumb.innerHTML = `<div class="combine-thumb-box"></div><div class="combine-thumb-num">${n}</div>`;
    if (this.sel?.tabId === tab.id && this.sel.pages.has(n)) thumb.classList.add('selected');

    thumb.addEventListener('click', (e) => this.onThumbClick(tab, n, e));

    thumb.addEventListener('dragstart', (e) => {
      // drag the current selection when the grabbed page is part of it,
      // otherwise just this page
      let pages;
      if (this.sel?.tabId === tab.id && this.sel.pages.has(n)) {
        pages = [...this.sel.pages].sort((a, b) => a - b);
      } else {
        pages = [n];
        this.setSelection(tab.id, new Set([n]));
      }
      this.drag = { tabId: tab.id, pages };
      thumb.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', pages.join(','));
    });
    thumb.addEventListener('dragend', () => {
      thumb.classList.remove('dragging');
      this.clearDropMarkers();
      this.drag = null;
    });

    this.wireDropZone(thumb, tab, n - 1); // dropping "before" this page
    const cached = this.cacheFor(tab.pdf).get(n);
    if (cached) {
      thumb.querySelector('.combine-thumb-box').replaceChildren(cached);
      thumb._rendered = true;
    } else {
      this.observer?.observe(thumb);
    }
    return thumb;
  }

  // A thumb accepts drops before/after itself; a tail accepts drops at the end.
  wireDropZone(el, tab, baseIndex) {
    el.addEventListener('dragover', (e) => {
      if (!this.drag || this.drag.tabId === tab.id) return; // cross-document only
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.clearDropMarkers();
      if (el.classList.contains('combine-tail')) {
        el.classList.add('drop-here');
      } else {
        const rect = el.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        el.classList.add(before ? 'drop-before' : 'drop-after');
      }
    });
    el.addEventListener('drop', (e) => {
      if (!this.drag || this.drag.tabId === tab.id) return;
      e.preventDefault();
      let at = baseIndex;
      if (!el.classList.contains('combine-tail')) {
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top + rect.height / 2) at = baseIndex + 1;
      }
      const drag = this.drag;
      this.clearDropMarkers();
      this.drag = null;
      this.applyInsert(tab, drag, at);
    });
  }

  async applyInsert(targetTab, drag, atIndex) {
    if (this.busy) return;
    const source = this.opts.getTabs().find((t) => t.id === drag.tabId);
    if (!source || source === targetTab) return;
    this.busy = true;
    this.el.classList.add('working');
    try {
      await this.opts.onInsert(targetTab, source, drag.pages, atIndex);
    } finally {
      this.busy = false;
      this.el.classList.remove('working');
      this.render(); // the target's pdf was reloaded by the insert
    }
  }

  onThumbClick(tab, n, e) {
    if (e.ctrlKey || e.metaKey) {
      if (this.sel?.tabId === tab.id) {
        const pages = new Set(this.sel.pages);
        pages.has(n) ? pages.delete(n) : pages.add(n);
        this.setSelection(tab.id, pages);
      } else {
        this.setSelection(tab.id, new Set([n]));
      }
    } else if (e.shiftKey && this.sel?.tabId === tab.id && this.sel.pages.size) {
      const anchor = Math.min(...this.sel.pages);
      const [lo, hi] = anchor < n ? [anchor, n] : [n, anchor];
      const pages = new Set();
      for (let i = lo; i <= hi; i++) pages.add(i);
      this.setSelection(tab.id, pages);
    } else {
      this.setSelection(tab.id, new Set([n]));
    }
  }

  setSelection(tabId, pages) {
    this.sel = pages.size ? { tabId, pages } : null;
    for (const el of this.colsEl.querySelectorAll('.combine-thumb')) {
      const on = this.sel && +el.dataset.tabId === tabId && this.sel.pages.has(+el.dataset.page);
      el.classList.toggle('selected', !!on);
    }
  }

  clearDropMarkers() {
    for (const el of this.colsEl.querySelectorAll('.drop-before, .drop-after, .drop-here')) {
      el.classList.remove('drop-before', 'drop-after', 'drop-here');
    }
  }

  cacheFor(pdf) {
    let c = this.caches.get(pdf);
    if (!c) { c = new Map(); this.caches.set(pdf, c); }
    return c;
  }

  async renderThumb(thumb) {
    if (thumb._rendered || thumb._rendering) return;
    thumb._rendering = true;
    const gen = this.gen;
    try {
      const tab = this.opts.getTabs().find((t) => t.id === +thumb.dataset.tabId);
      if (!tab) return;
      const n = +thumb.dataset.page;
      const cache = this.cacheFor(tab.pdf);
      let canvas = cache.get(n);
      if (!canvas) {
        const page = await tab.pdf.getPage(n);
        const scale = 132 / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        canvas = document.createElement('canvas');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        await page.render({
          canvasContext: canvas.getContext('2d', { alpha: false }),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        }).promise;
        cache.set(n, canvas);
      }
      if (this.gen !== gen) return; // overlay re-rendered while we waited
      thumb.querySelector('.combine-thumb-box').replaceChildren(canvas);
      thumb._rendered = true;
    } catch { /* thumbnail is cosmetic */ }
    finally { thumb._rendering = false; }
  }

  // ---- preview pane ---------------------------------------------------------
  // Clicking a column header shows that document's pages (larger) on the right.

  previewTab(tab) {
    if (!tab) return;
    this.previewTabId = tab.id;
    for (const h of this.colsEl.querySelectorAll('.combine-col-head')) {
      h.classList.toggle('previewing', h.parentElement?.dataset.tabId === String(tab.id));
    }
    this.renderPreview(tab);
  }

  renderPreview(tab) {
    this.previewObserver?.disconnect();
    this.previewEl.replaceChildren();
    const title = document.createElement('div');
    title.id = 'combine-preview-title';
    title.textContent = tab.title;
    this.previewEl.appendChild(title);

    this.previewObserver = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderPreviewPage(en.target);
    }, { root: this.previewEl, rootMargin: '600px 0px' });

    for (let n = 1; n <= tab.pdf.numPages; n++) {
      const wrap = document.createElement('div');
      wrap.className = 'cp-page-wrap';
      wrap.dataset.tabId = tab.id;
      wrap.dataset.page = n;
      wrap.innerHTML = `<div class="cp-page"></div><div class="cp-page-num">${n}</div>`;
      this.previewEl.appendChild(wrap);
      this.previewObserver.observe(wrap);
    }
    // render the first page right away so the pane is never blank
    const first = this.previewEl.querySelector('.cp-page-wrap');
    if (first) this.renderPreviewPage(first);
  }

  previewCacheFor(pdf) {
    let c = this.previewCaches.get(pdf);
    if (!c) { c = new Map(); this.previewCaches.set(pdf, c); }
    return c;
  }

  async renderPreviewPage(wrap) {
    if (wrap._rendered || wrap._rendering) return;
    wrap._rendering = true;
    const gen = this.gen;
    try {
      const tab = this.opts.getTabs().find((t) => t.id === +wrap.dataset.tabId);
      if (!tab) return;
      const n = +wrap.dataset.page;
      const cache = this.previewCacheFor(tab.pdf);
      let canvas = cache.get(n);
      if (!canvas) {
        const page = await tab.pdf.getPage(n);
        const targetW = Math.max(240, Math.min(620, this.previewEl.clientWidth - 48));
        const scale = targetW / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        canvas = document.createElement('canvas');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        await page.render({
          canvasContext: canvas.getContext('2d', { alpha: false }),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        }).promise;
        cache.set(n, canvas);
      }
      if (this.gen !== gen) return; // overlay re-rendered while we waited
      wrap.querySelector('.cp-page').replaceChildren(canvas);
      wrap._rendered = true;
    } catch { /* preview is cosmetic */ }
    finally { wrap._rendering = false; }
  }
}
