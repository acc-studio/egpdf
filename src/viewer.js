import * as pdfjsLib from 'pdfjs-dist';
import { mountEditLayer, commitActiveTextEdits } from './edits.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './dist/pdf.worker.min.mjs';

export { pdfjsLib };

// temporary trace buffer for self-test debugging
export const viewerDebug = [];
const dbg = (msg) => { if (viewerDebug.length < 400) viewerDebug.push(performance.now().toFixed(0) + ' ' + msg); };

export async function loadPdf(bytes) {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  return await task.promise;
}

// Minimal link service: enough for the annotation layer to render links and
// interactive form widgets without pulling in the full pdf.js viewer.
class MiniLinkService {
  constructor(view) {
    this.view = view;
    this.externalLinkTarget = 2; // BLANK
    this.externalLinkRel = 'noopener noreferrer';
    this.externalLinkEnabled = true;
    this.isInPresentationMode = false;
  }
  getDestinationHash() { return '#'; }
  getAnchorUrl() { return '#'; }
  addLinkAttributes(link, url) { link.href = url; }
  async goToDestination(dest) {
    try {
      const pdf = this.view.pdf;
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const pageIndex = typeof ref === 'object' && ref !== null
        ? await pdf.getPageIndex(ref) : ref;
      this.view.scrollToPage(pageIndex + 1);
    } catch { /* broken destination — ignore */ }
  }
  goToPage(n) { this.view.scrollToPage(n); }
  executeNamedAction() {}
  executeSetOCGState() {}
}

export class DocView {
  /**
   * opts: { tab, root, onCurrentPage(n), onPageRendered(pageNum, holder) }
   */
  constructor(opts) {
    this.tab = opts.tab;
    this.pdf = opts.tab.pdf;
    this.onCurrentPage = opts.onCurrentPage || (() => {});
    this.onPageRendered = opts.onPageRendered || (() => {});
    this.scale = 1;
    this.fitMode = true;
    this.epoch = 0;
    this.holders = [];
    this.baseSizes = [];
    this.linkService = new MiniLinkService(this);
    this.fieldObjects = null;
    this.currentPageNum = 1;

    this.el = document.createElement('div');
    this.el.className = 'doc-scroll';
    opts.root.appendChild(this.el);

    this.el.addEventListener('scroll', () => {
      this.trackCurrentPage();
      // IO may be paused while the window is occluded; keep scroll rendering.
      this.renderVisible();
    });
    this.el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    this.buildObserver();
  }

  buildObserver() {
    this.observer?.disconnect();
    dbg('buildObserver holders=' + this.holders.length);
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = +en.target.dataset.page;
        dbg(`io p${n} intersecting=${en.isIntersecting}`);
        if (en.isIntersecting) this.renderPage(n);
        else this.destroyPage(n);
      }
    }, { root: this.el, rootMargin: '900px 0px' });
    for (const h of this.holders) this.observer.observe(h);
  }

  // Reparent the view. Detaching an IntersectionObserver's root kills it in
  // Chromium, so rebuild the observer after any DOM move.
  attachTo(rootEl) {
    if (this.el.parentElement === rootEl) return;
    rootEl.appendChild(this.el);
    this.buildObserver();
    setTimeout(() => this.renderVisible(), 0);
  }

  async init() {
    const N = this.pdf.numPages;
    try { this.fieldObjects = await this.pdf.getFieldObjects(); } catch { this.fieldObjects = null; }
    for (let n = 1; n <= N; n++) {
      const page = await this.pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      this.baseSizes.push({ w: vp.width, h: vp.height });
    }
    if (this.fitMode) this.scale = this.computeFitScale();
    for (let n = 1; n <= N; n++) {
      const holder = document.createElement('div');
      holder.className = 'page-holder';
      holder.dataset.page = n;
      this.sizeHolder(holder, n);
      this.el.appendChild(holder);
      this.holders.push(holder);
      this.observer.observe(holder);
    }
    this.el.scrollTop = 0;
    setTimeout(() => this.renderVisible(), 0);
  }

  computeFitScale() {
    const maxW = Math.max(...this.baseSizes.map(s => s.w), 1);
    return Math.max(0.2, (this.el.clientWidth - 56) / maxW);
  }

  sizeHolder(holder, n) {
    const s = this.baseSizes[n - 1];
    holder.style.width = Math.floor(s.w * this.scale) + 'px';
    holder.style.height = Math.floor(s.h * this.scale) + 'px';
  }

  setZoom(scale, fitMode = false) {
    scale = Math.min(6, Math.max(0.2, scale));
    dbg(`setZoom ${this.scale}->${scale} fit=${fitMode}`);
    if (Math.abs(scale - this.scale) < 0.001 && fitMode === this.fitMode) return;
    this.fitMode = fitMode;
    const ratio = this.el.scrollHeight > 0 ? this.el.scrollTop / this.el.scrollHeight : 0;
    this.scale = scale;
    this.epoch++;
    for (let n = 1; n <= this.holders.length; n++) {
      this.destroyPage(n);
      this.sizeHolder(this.holders[n - 1], n);
    }
    this.el.scrollTop = ratio * this.el.scrollHeight;
    // IntersectionObserver re-fires for visible holders after resize, but not
    // when the window is occluded — render the visible range directly.
    setTimeout(() => this.renderVisible(), 0);
  }

  refit() {
    if (this.fitMode) this.setZoom(this.computeFitScale(), true);
  }

  renderVisible() {
    const top = this.el.scrollTop - 900;
    const bottom = this.el.scrollTop + this.el.clientHeight + 900;
    for (let n = 1; n <= this.holders.length; n++) {
      const h = this.holders[n - 1];
      if (h.offsetTop + h.offsetHeight >= top && h.offsetTop <= bottom) this.renderPage(n);
    }
  }

  trackCurrentPage() {
    const mid = this.el.scrollTop + this.el.clientHeight * 0.4;
    let cur = 1;
    for (let n = 1; n <= this.holders.length; n++) {
      const h = this.holders[n - 1];
      if (h.offsetTop <= mid) cur = n; else break;
    }
    if (cur !== this.currentPageNum) {
      this.currentPageNum = cur;
      this.onCurrentPage(cur);
    }
  }

  scrollToPage(n, cssOffsetY = 0) {
    n = Math.min(this.holders.length, Math.max(1, n));
    this.el.scrollTop = this.holders[n - 1].offsetTop - 16 + cssOffsetY;
  }

  async renderPage(n) {
    const holder = this.holders[n - 1];
    if (!holder || holder._rendered || holder._rendering) { dbg(`rp p${n} skip`); return; }
    dbg(`rp p${n} start epoch=${this.epoch}`);
    holder._rendering = true;
    const myEpoch = this.epoch;
    // A zoom bump (epoch change) or cancel aborts this render. The page may
    // still be visible with nothing to re-trigger it (the IntersectionObserver
    // only fires on transitions), so retry once the abort fully unwinds.
    let retry = false;
    try {
      const page = await this.pdf.getPage(n);
      if (myEpoch !== this.epoch) { retry = true; return; }
      const viewport = page.getViewport({ scale: this.scale });
      holder.style.setProperty('--scale-factor', viewport.scale);

      const canvas = document.createElement('canvas');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const ctx = canvas.getContext('2d', { alpha: false });

      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
      });
      holder._task = task;
      await task.promise;
      holder._task = null;
      if (myEpoch !== this.epoch) { retry = true; return; }
      holder.replaceChildren(canvas);

      // Text layer (selection + search highlighting)
      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      holder.appendChild(textDiv);
      try {
        const tl = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textDiv,
          viewport,
        });
        holder._textLayer = tl;
        await tl.render();
      } catch (e) { console.warn('text layer failed', e); }
      if (myEpoch !== this.epoch) { retry = true; return; }

      // Annotation layer (interactive forms, links)
      try {
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (annotations.length) {
          const annotDiv = document.createElement('div');
          annotDiv.className = 'annotationLayer';
          holder.appendChild(annotDiv);
          const layer = new pdfjsLib.AnnotationLayer({
            div: annotDiv,
            accessibilityManager: null,
            annotationCanvasMap: null,
            annotationEditorUIManager: null,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            structTreeLayer: null,
          });
          await layer.render({
            annotations,
            imageResourcesPath: './dist/images/',
            renderForms: true,
            linkService: this.linkService,
            downloadManager: null,
            annotationStorage: this.pdf.annotationStorage,
            enableScripting: false,
            hasJSActions: false,
            fieldObjects: this.fieldObjects,
          });
          // Some generators write an auto-computed "fit the box" font size into
          // multiline fields' DA, which turns short values into billboard
          // text — cap anything absurd at a readable size.
          for (const ta of annotDiv.querySelectorAll('textarea')) {
            const m = /calc\(([\d.]+)px/.exec(ta.style.fontSize || '');
            if (!m || +m[1] > 24) ta.style.fontSize = 'calc(11px * var(--scale-factor))';
          }
          annotDiv.querySelectorAll('input, textarea').forEach((el) => { el.spellcheck = false; });
        }
      } catch (e) { console.warn('annotation layer failed', e); }
      if (myEpoch !== this.epoch) { retry = true; return; }

      // Edit overlay
      const editLayer = document.createElement('div');
      editLayer.className = 'edit-layer';
      holder.appendChild(editLayer);
      mountEditLayer(this.tab, n, editLayer, viewport, holder);

      holder._viewport = viewport;
      holder._rendered = true;
      dbg(`rp p${n} done`);
      this.onPageRendered(n, holder);
    } catch (e) {
      dbg(`rp p${n} error ${e?.name}: ${e?.message}`);
      if (e?.name === 'RenderingCancelledException') retry = true;
      else console.warn('render page failed', n, e);
    } finally {
      holder._rendering = false;
      if (retry) queueMicrotask(() => this.renderVisible());
    }
  }

  destroyPage(n) {
    const holder = this.holders[n - 1];
    if (!holder) return;
    dbg(`dp p${n}`);
    if (holder._task) { try { holder._task.cancel(); } catch {} holder._task = null; }
    if (holder._rendered || holder.childNodes.length) {
      holder.replaceChildren();
      holder._rendered = false;
      holder._viewport = null;
    }
  }

  refreshEditLayer(pageNum) {
    const holder = this.holders[pageNum - 1];
    if (!holder || !holder._rendered) return;
    const layer = holder.querySelector('.edit-layer');
    if (layer) {
      commitActiveTextEdits();
      layer.replaceChildren();
      mountEditLayer(this.tab, pageNum, layer, holder._viewport, holder, true);
    }
  }

  show() { this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }

  destroy() {
    this.observer.disconnect();
    for (let n = 1; n <= this.holders.length; n++) this.destroyPage(n);
    this.el.remove();
    try { this.pdf.destroy(); } catch {}
  }
}
