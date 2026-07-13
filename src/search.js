// Lightweight document search: finds pages containing the query via text
// content, navigates between matches, and highlights matching spans in the
// rendered text layer. (Matches spanning two spans are not highlighted.)

export class Search {
  constructor(getTab, statusEl) {
    this.getTab = getTab;
    this.statusEl = statusEl;
    this.query = '';
    this.matches = [];   // [{page, span}] span = index of occurrence on page
    this.current = -1;
  }

  async run(query) {
    this.clearHighlights();
    this.query = query.trim().toLowerCase();
    this.matches = [];
    this.current = -1;
    if (!this.query) { this.status(''); return; }
    const tab = this.getTab();
    if (!tab) return;

    for (let n = 1; n <= tab.pdf.numPages; n++) {
      if (!tab.pageTexts) tab.pageTexts = {};
      if (tab.pageTexts[n] === undefined) {
        try {
          const page = await tab.pdf.getPage(n);
          const tc = await page.getTextContent();
          tab.pageTexts[n] = tc.items.map((i) => i.str).join(' ');
        } catch { tab.pageTexts[n] = ''; }
      }
      const text = tab.pageTexts[n].toLowerCase();
      let idx = 0, span = 0;
      while ((idx = text.indexOf(this.query, idx)) !== -1) {
        this.matches.push({ page: n, span: span++ });
        idx += this.query.length;
      }
    }
    if (this.matches.length) this.goTo(0);
    else this.status('0 results');
  }

  next(dir = 1) {
    if (!this.matches.length) return;
    this.goTo((this.current + dir + this.matches.length) % this.matches.length);
  }

  goTo(i) {
    this.current = i;
    const m = this.matches[i];
    const tab = this.getTab();
    if (!tab) return;
    this.status(`${i + 1} of ${this.matches.length}`);
    tab.view.scrollToPage(m.page);
    // highlight after render settles
    setTimeout(() => this.highlightPage(m.page, m.span), 150);
  }

  // Called by the viewer when a page finishes rendering.
  onPageRendered(pageNum, holder) {
    if (!this.query) return;
    const m = this.matches[this.current];
    this.highlightPage(pageNum, m && m.page === pageNum ? m.span : -1, holder);
  }

  highlightPage(pageNum, currentSpan, holderArg) {
    const tab = this.getTab();
    if (!tab) return;
    const holder = holderArg || tab.view.holders[pageNum - 1];
    const textLayer = holder?.querySelector('.textLayer');
    if (!textLayer) return;
    let occurrence = 0;
    for (const span of textLayer.querySelectorAll('span')) {
      span.classList.remove('search-hit', 'current');
      const t = span.textContent.toLowerCase();
      if (t.includes(this.query)) {
        span.classList.add('search-hit');
        let count = 0, idx = 0;
        while ((idx = t.indexOf(this.query, idx)) !== -1) { count++; idx += this.query.length; }
        if (currentSpan >= occurrence && currentSpan < occurrence + count) {
          span.classList.add('current');
          span.scrollIntoView({ block: 'center' });
        }
        occurrence += count;
      }
    }
  }

  clearHighlights() {
    document.querySelectorAll('.textLayer .search-hit').forEach((s) =>
      s.classList.remove('search-hit', 'current'));
  }

  close() {
    this.clearHighlights();
    this.query = '';
    this.matches = [];
    this.current = -1;
    this.status('');
  }

  status(t) { this.statusEl.textContent = t; }
}
