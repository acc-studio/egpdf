// Phone layout for the Android app. The desktop renderer runs unchanged
// underneath (same tabs, panes, edit tools, save pipeline); this module hides
// its toolbars and puts a small touch chrome around it:
//
//   - Home: every PDF on the phone, newest first (whatever just arrived from
//     WhatsApp, mail or a download is on top), plus the documents already open.
//   - Reader: a slim top bar (home · title · page · search · tools); the page
//     gets the rest of the screen. Pinch to zoom.
//   - Tools sheet: every desktop feature, grouped, one tap away.
//   - While an edit tool is active, a pill at the bottom says what to do and
//     has Undo / Done.
//
// Toolbar buttons are triggered by clicking the (hidden) originals, so the
// behavior is exactly the desktop app's.
import { ICONS } from './icons.js';
import { EgPdf } from './native-android.js';

const $ = (id) => document.getElementById(id);
const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const MICONS = {
  home: svg('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z"/>'),
  more: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  share: svg('<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="m8.7 10.8 6.6-4M8.7 13.2l6.6 4"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/>'),
  folder: ICONS.open,
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  pdf: svg('<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5l-5-5Z"/><path d="M14 3.5v5h5"/>'),
};

// ---------------------------------------------------------------- helpers

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(ms);
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Where a file came from, read off its folder.
function sourceOf(path) {
  const p = path.toLowerCase();
  if (p.includes('whatsapp')) return 'WhatsApp';
  if (p.includes('telegram')) return 'Telegram';
  if (p.includes('/download')) return 'Downloads';
  if (p.includes('/documents')) return 'Documents';
  if (p.includes('/dcim') || p.includes('/pictures')) return 'Photos';
  const parts = path.split('/');
  return parts[parts.length - 2] || '';
}

// ---------------------------------------------------------------- init

export function initMobile() {
  const shell = window.egpdfShell;
  const native = window.native;

  // ---- top bar -------------------------------------------------------------
  const top = el('header', '', `
    <button id="m-home" class="m-icon" aria-label="Home">${MICONS.home}</button>
    <div id="m-title"><span id="m-title-text"></span><span id="m-dirty">•</span></div>
    <button id="m-page" aria-label="Go to page"></button>
    <button id="m-search" class="m-icon" aria-label="Search">${ICONS.search}</button>
    <button id="m-more" class="m-icon" aria-label="Tools">${MICONS.more}</button>`);
  top.id = 'm-top';
  document.body.prepend(top);

  // ---- status toasts (the desktop status bar is hidden) --------------------
  const toast = el('div', 'hidden');
  toast.id = 'm-toast';
  document.body.appendChild(toast);
  let toastTimer = null;
  let lastToast = '';
  const statusEl = $('status-left');
  new MutationObserver(() => {
    const msg = statusEl.textContent.trim();
    const isErr = !!statusEl.style.color;
    const act = shell.getActive();
    // the desktop app echoes the file path on every tab switch — not news here
    if (!msg || msg === act?.filePath || msg === act?.title) { hideToast(); return; }
    if (toolActive()) { updatePill(); return; }
    if (msg === lastToast && !toast.classList.contains('hidden')) return;
    lastToast = msg;
    toast.textContent = msg;
    toast.classList.toggle('error', isErr);
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    // progress messages ("Saving…", "OCR — page 2/5…") stay until replaced
    if (!/…$/.test(msg)) toastTimer = setTimeout(hideToast, isErr ? 4500 : 2600);
  }).observe(statusEl, { childList: true, characterData: true, subtree: true, attributes: true });
  function hideToast() { toast.classList.add('hidden'); lastToast = ''; }
  toast.addEventListener('click', hideToast);

  // ---- tools sheet ---------------------------------------------------------
  const share = async () => {
    const tab = shell.getActive();
    if (!tab) return;
    shell.setStatus('Preparing to share…');
    try {
      const bytes = await shell.savedBytes(tab);
      const name = /\.pdf$/i.test(tab.title) ? tab.title : `${tab.title}.pdf`;
      await native.share(bytes, name);
      shell.setStatus('');
    } catch (e) {
      shell.setStatus(`Could not share: ${e.message || e}`, true);
    }
  };
  const SECTIONS = [
    ['File', [
      ['btn-save', 'save', 'Save'],
      ['btn-saveas', 'saveas', 'Save as'],
      [share, MICONS.share, 'Share'],
      ['btn-print', 'print', 'Print'],
      ['btn-open', 'open', 'Open file', { always: true }],
    ]],
    ['Mark up', [
      ['tool-highlight', 'highlight', 'Highlight'],
      ['tool-text', 'text', 'Text'],
      ['tool-note', 'note', 'Comment'],
      ['tool-image', 'image', 'Image'],
      ['tool-whiteout', 'whiteout', 'Whiteout'],
      ['tool-redact', 'redact', 'Redact'],
      ['tool-ocrarea', 'ocrarea', 'Copy text from area'],
      ['btn-undo', 'undo', 'Undo'],
    ]],
    ['Pages', [
      ['btn-sidebar', 'sidebar', 'Pages'],
      ['btn-rotate-doc', 'rotate', 'Rotate all'],
      ['btn-split-pdf', 'splitPdf', 'Extract pages'],
      ['btn-combine', 'combine', 'Combine'],
      ['btn-ocr', 'ocr', 'Make searchable (OCR)'],
    ]],
    ['View', [
      ['btn-fit', 'fit', 'Fit width'],
      ['btn-split', 'split', 'Two documents'],
      ['btn-compare', 'compare', 'Compare'],
      [() => shell.openAbout(), MICONS.info, 'About & updates', { always: true }],
    ]],
  ];
  const sheet = el('div', 'hidden');
  sheet.id = 'm-sheet';
  const panel = el('div', 'm-sheet-panel');
  panel.appendChild(el('div', 'm-sheet-grip'));
  const sheetItems = [];
  for (const [label, items] of SECTIONS) {
    panel.appendChild(el('div', 'm-sheet-label', label));
    const grid = el('div', 'm-sheet-grid');
    for (const [action, icon, text, opts = {}] of items) {
      const b = el('button', 'm-sheet-item', `${ICONS[icon] || icon}<span></span>`);
      b.querySelector('span').textContent = text;
      b.addEventListener('click', () => {
        closeSheet();
        if (typeof action === 'function') action();
        else $(action)?.click();
      });
      sheetItems.push({ b, opts, id: typeof action === 'string' ? action : null });
      grid.appendChild(b);
    }
    panel.appendChild(grid);
  }
  sheet.appendChild(panel);
  document.body.appendChild(sheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

  function openSheet() {
    const has = !!shell.getActive();
    for (const { b, opts, id } of sheetItems) {
      b.disabled = !has && !opts.always;
      b.classList.toggle('active', !!id && $(id)?.classList.contains('active'));
    }
    sheet.classList.remove('hidden');
  }
  function closeSheet() { sheet.classList.add('hidden'); }
  const sheetOpen = () => !sheet.classList.contains('hidden');

  // ---- active-tool pill ----------------------------------------------------
  const pill = el('div', 'hidden', `
    <span id="m-pill-icon"></span>
    <span id="m-pill-text"></span>
    <span id="m-pill-fields"></span>
    <button id="m-pill-undo" class="m-icon" aria-label="Undo">${ICONS.undo}</button>
    <button id="m-pill-done">Done</button>`);
  pill.id = 'm-pill';
  document.body.appendChild(pill);
  // the text tool's font + size pickers live in the pill on a phone
  $('m-pill-fields').append($('text-font'), $('text-size'));
  $('m-pill-undo').addEventListener('click', () => shell.undo());
  $('m-pill-done').addEventListener('click', () => $('tool-select').click());

  const toolActive = () => {
    const t = document.querySelector('#tools-group .tool.active');
    return t && t.dataset.tool !== 'select' ? t : null;
  };
  function updatePill() {
    const t = toolActive();
    const textSel = $('text-size').classList.contains('visible');
    pill.classList.toggle('hidden', !t && !textSel);
    document.body.classList.toggle('m-tool-on', !!t);
    if (!t && !textSel) return;
    $('m-pill-icon').innerHTML = t ? t.innerHTML : ICONS.text;
    $('m-pill-text').textContent = t ? statusEl.textContent.replace(/^Click/, 'Tap') : '';
  }
  for (const watched of [$('toolbar'), $('m-pill-fields')]) {
    new MutationObserver(updatePill).observe(watched, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  // ---- reader chrome -------------------------------------------------------
  function updateTop() {
    const tab = shell.getActive();
    const title = tab ? tab.title.replace(/\.pdf$/i, '') : '';
    const page = tab ? `${$('page-input').value} / ${tab.pdf.numPages}` : '';
    if ($('m-title-text').textContent !== title) $('m-title-text').textContent = title;
    if ($('m-page').textContent !== page) $('m-page').textContent = page;
    $('m-dirty').style.visibility = tab && shell.isDirty(tab) ? 'visible' : 'hidden';
    for (const id of ['m-search', 'm-page']) $(id).disabled = !tab;
  }
  new MutationObserver(updateTop).observe($('page-input'), { attributes: true });
  $('page-input').addEventListener('input', updateTop);
  // page-input's value is set as a property, which no observer sees
  setInterval(() => { if (!homeVisible()) updateTop(); }, 400);

  $('m-home').addEventListener('click', () => showHome(true));
  $('m-more').addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));
  $('m-search').addEventListener('click', () => shell.toggleSearch($('searchbar').classList.contains('hidden')));
  $('m-page').addEventListener('click', () => {
    const tab = shell.getActive();
    if (!tab) return;
    const v = prompt(`Go to page (1–${tab.pdf.numPages})`, $('page-input').value);
    const n = parseInt(v, 10);
    if (n >= 1) tab.view.scrollToPage(n);
  });

  // Pages panel: tapping a page jumps there and gets the panel out of the way.
  $('sidebar').addEventListener('click', (e) => {
    if (e.target.closest('.thumb') && !e.target.closest('button')) shell.toggleSidebar(false);
  });
  // Text selection: Android's own Copy/Share toolbar is suppressed natively
  // (EgPdfWebView) because it covered this popup, so the popup gets Copy.
  const selPopup = $('selection-popup');
  const copyBtn = el('button', 'sp-copy', 'Copy');
  selPopup.prepend(copyBtn);
  copyBtn.addEventListener('click', async () => {
    const text = window.getSelection()?.toString() || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      document.execCommand('copy');
    }
    window.getSelection()?.removeAllRanges();
    selPopup.classList.add('hidden');
    shell.setStatus('Copied');
  });
  // Dragging the selection handles changes the selection without any touch
  // event reaching the page; re-place the popup once the handles settle.
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) document.dispatchEvent(new PointerEvent('pointerup'));
    }, 250);
  });

  $('combine-hint').textContent = 'Long-press a page, then drag it into another document. The original keeps its copy.';

  // ---- home ----------------------------------------------------------------
  const home = el('section', '', `
    <div class="mh-head">
      <div class="mh-brand">egPDF</div>
      <button id="mh-browse" class="m-icon" aria-label="Browse files">${MICONS.folder}</button>
      <button id="mh-about" class="m-icon" aria-label="About">${MICONS.info}</button>
    </div>
    <label class="mh-search">${ICONS.search}<input id="mh-q" type="search" placeholder="Search PDFs on this phone" autocomplete="off" /></label>
    <div id="mh-scroll">
      <div id="mh-open" class="hidden"><div class="mh-label">Open now</div><div id="mh-open-list"></div></div>
      <div id="mh-perm" class="mh-card hidden">
        <div class="mh-card-title">See every PDF on your phone</div>
        <p>Allow “All files access” and egPDF lists the PDFs from WhatsApp, mail and your downloads here, newest first. Files are only read on this phone — nothing is uploaded.</p>
        <div class="mh-card-actions"><button id="mh-perm-allow">Allow access</button><button id="mh-perm-browse" class="mh-quiet">Pick a file instead</button></div>
      </div>
      <div id="mh-recent-label" class="mh-label">Recent on this phone</div>
      <div id="mh-list"></div>
      <div id="mh-empty" class="hidden"></div>
    </div>`);
  home.id = 'm-home-screen';
  document.body.appendChild(home);

  const homeVisible = () => !home.classList.contains('hidden');
  function showHome(on) {
    home.classList.toggle('hidden', !on);
    document.body.classList.toggle('m-at-home', on);
    if (on) { closeSheet(); renderOpenDocs(); refreshList(); } else updateTop();
  }

  const browse = () => $('btn-open').click();
  $('mh-browse').addEventListener('click', browse);
  $('mh-perm-browse').addEventListener('click', browse);
  $('mh-about').addEventListener('click', () => shell.openAbout());
  $('mh-perm-allow').addEventListener('click', () => EgPdf.requestAllFilesAccess());

  let files = [];
  let listGen = 0;
  async function refreshList() {
    const gen = ++listGen;
    let res;
    try { res = await EgPdf.listPdfs({ limit: 600 }); } catch { res = { granted: false, files: [] }; }
    if (gen !== listGen) return;
    $('mh-perm').classList.toggle('hidden', !!res.granted);
    $('mh-recent-label').classList.toggle('hidden', !res.granted);
    files = res.files || [];
    renderList();
  }

  function renderList() {
    const q = $('mh-q').value.trim().toLocaleLowerCase('tr');
    const list = $('mh-list');
    list.replaceChildren();
    thumbObserver.disconnect();
    const shown = q ? files.filter((f) => f.name.toLocaleLowerCase('tr').includes(q)) : files;
    const empty = $('mh-empty');
    empty.classList.toggle('hidden', shown.length > 0 || $('mh-recent-label').classList.contains('hidden'));
    empty.textContent = q ? 'No PDF matches that name.' : 'No PDFs on this phone yet.';
    const fresh = Date.now() - 60 * 60 * 1000;
    for (const f of shown.slice(0, 300)) {
      const row = el('button', 'mh-row', `
        <div class="mh-thumb">${MICONS.pdf}</div>
        <div class="mh-meta"><div class="mh-name"></div><div class="mh-sub"></div></div>`);
      row.querySelector('.mh-name').textContent = f.name;
      const src = sourceOf(f.path);
      row.querySelector('.mh-sub').textContent = [src, relTime(f.added), fmtSize(f.size)].filter(Boolean).join(' · ');
      if (f.added > fresh) row.classList.add('fresh');
      row._file = f;
      row.addEventListener('click', () => openFile(f, row));
      list.appendChild(row);
      // UYAP documents get a label tile; Android can't thumbnail them
      if (/\.udf$/i.test(f.name)) row.querySelector('.mh-thumb').replaceChildren(el('span', 'mh-udf', 'UDF'));
      else thumbObserver.observe(row);
    }
  }
  $('mh-q').addEventListener('input', renderList);
  $('mh-q').placeholder = 'Search PDFs and UDFs on this phone';

  // First-page thumbnails, rendered natively and cached per file version.
  const thumbCache = new Map();
  let thumbBusy = 0;
  const thumbQueue = [];
  const thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      thumbObserver.unobserve(en.target);
      thumbQueue.push(en.target);
    }
    pumpThumbs();
  }, { root: null, rootMargin: '300px 0px' });
  function pumpThumbs() {
    while (thumbBusy < 2 && thumbQueue.length) {
      const row = thumbQueue.shift();
      if (!row.isConnected) continue;
      const f = row._file;
      const key = `${f.path}|${f.modified}`;
      const put = (data) => {
        if (!data) return;
        const img = new Image();
        img.src = `data:image/jpeg;base64,${data}`;
        row.querySelector('.mh-thumb').replaceChildren(img);
      };
      if (thumbCache.has(key)) { put(thumbCache.get(key)); continue; }
      thumbBusy++;
      EgPdf.thumbnail({ path: f.path, width: 120 })
        .then(({ data }) => { thumbCache.set(key, data || null); put(data); })
        .catch(() => thumbCache.set(key, null))
        .finally(() => { thumbBusy--; pumpThumbs(); });
    }
  }

  async function openFile(f, row) {
    const already = shell.getTabs().find((t) => t.filePath === f.path || t.sourcePath === f.path);
    if (already) { shell.activateTab(already); showHome(false); return; }
    row.classList.add('loading');
    const before = shell.getTabs().length;
    await shell.openPaths([f.path]);
    row.classList.remove('loading');
    if (shell.getTabs().length > before) showHome(false);
  }

  function renderOpenDocs() {
    const tabs = shell.getTabs();
    $('mh-open').classList.toggle('hidden', !tabs.length);
    const box = $('mh-open-list');
    box.replaceChildren();
    for (const tab of tabs) {
      const chip = el('div', 'mh-chip', `<span class="mh-chip-name"></span><button class="mh-chip-x" aria-label="Close">${MICONS.close}</button>`);
      chip.querySelector('.mh-chip-name').textContent = (shell.isDirty(tab) ? '• ' : '') + tab.title;
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.mh-chip-x')) {
          shell.closeTab(tab);
          renderOpenDocs();
          return;
        }
        shell.activateTab(tab);
        showHome(false);
      });
      box.appendChild(chip);
    }
  }

  // A newly opened document (from the list, the picker, Open with… or Share)
  // takes the screen; closing the last one goes back home.
  let knownTabs = shell.getTabs().length;
  shell.onChange(() => {
    const n = shell.getTabs().length;
    if (n > knownTabs && homeVisible()) showHome(false);
    if (n === 0 && !homeVisible()) showHome(true);
    knownTabs = n;
    if (homeVisible()) renderOpenDocs();
    updateTop();
  });

  // Coming back to the app (e.g. after saving a WhatsApp attachment) — the
  // newest file should already be on top.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && homeVisible()) refreshList();
  });

  // ---- pinch zoom ------------------------------------------------------------
  // The page is scaled with a CSS transform while the fingers move (cheap,
  // smooth), then re-rendered once at the final zoom, keeping the spot under
  // the fingers in place.
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  const viewRoot = $('viewer-root');
  viewRoot.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || toolActive()) return;
    const scrollEl = e.target.closest('.doc-scroll');
    const tab = scrollEl && shell.getTabs().find((t) => t.view.el === scrollEl);
    if (!tab) return;
    const [mx, my] = mid(e.touches);
    const rect = scrollEl.getBoundingClientRect();
    // anchor: the page under the fingers and the relative spot on it
    let anchor = null;
    for (const h of tab.view.holders) {
      const r = h.getBoundingClientRect();
      if (my >= r.top && my <= r.bottom + 18) {
        anchor = { n: +h.dataset.page, rx: (mx - r.left) / r.width, ry: (my - r.top) / r.height };
        break;
      }
    }
    pinch = { tab, el: scrollEl, d0: dist(e.touches), m0: [mx, my], rect, anchor, k: 1, dx: 0, dy: 0 };
    scrollEl.style.transformOrigin = `${mx - rect.left}px ${my - rect.top}px`;
    scrollEl.style.willChange = 'transform';
  }, { passive: true });
  viewRoot.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const s0 = pinch.tab.view.scale;
    pinch.k = Math.min(6 / s0, Math.max(0.2 / s0, dist(e.touches) / pinch.d0));
    const [mx, my] = mid(e.touches);
    pinch.dx = mx - pinch.m0[0];
    pinch.dy = my - pinch.m0[1];
    pinch.el.style.transform = `translate(${pinch.dx}px, ${pinch.dy}px) scale(${pinch.k})`;
  }, { passive: false });
  const endPinch = () => {
    if (!pinch) return;
    const { tab, el: scrollEl, k, anchor, m0, rect, dx, dy } = pinch;
    pinch = null;
    scrollEl.style.transform = '';
    scrollEl.style.willChange = '';
    if (Math.abs(k - 1) < 0.02) return;
    tab.view.setZoom(tab.view.scale * k);
    if (anchor) {
      const h = tab.view.holders[anchor.n - 1];
      scrollEl.scrollTop = h.offsetTop + anchor.ry * h.offsetHeight - (m0[1] + dy - rect.top);
      scrollEl.scrollLeft = h.offsetLeft + anchor.rx * h.offsetWidth - (m0[0] + dx - rect.left);
    }
  };
  viewRoot.addEventListener('touchend', (e) => { if (e.touches.length < 2) endPinch(); });
  viewRoot.addEventListener('touchcancel', endPinch);

  // ---- Android back button --------------------------------------------------
  EgPdf.addListener('backButton', () => {
    if (sheetOpen()) return closeSheet();
    if (shell.isSidebarVisible()) return shell.toggleSidebar(false);
    if (shell.closeOverlays()) return;
    if (!homeVisible() && shell.getTabs().length) return showHome(true);
    if ($('mh-q').value) { $('mh-q').value = ''; renderList(); return; }
    // leave the app but keep open documents (and unsaved edits) as they are
    EgPdf.exitApp();
  });

  // ---- startup -----------------------------------------------------------------
  showHome(shell.getTabs().length === 0);
  updatePill();

  // Update check ~2.5 s after launch, unless turned off in About.
  setTimeout(async () => {
    try {
      if (!(await native.update.getAutoCheck())) return;
      const info = await native.update.check();
      if (info?.available) native._emitUpdateAvailable(info);
    } catch { /* offline — try again next launch */ }
  }, 2500);
}
