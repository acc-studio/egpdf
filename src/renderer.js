import { applyIcons } from './icons.js';
import { DocView, loadPdf } from './viewer.js';
import {
  editState, setTool, onEditsChanged, onToolChanged,
  undoLast, deleteSelected, clearSelection, applyTextSize, applyFontFamily,
  addSelectionRects, editTextFromSelection,
} from './edits.js';
import { openPrintPreview, isPrintPreviewOpen } from './print.js';
import { detectAvailableFonts } from './fonts.js';
import { buildSavedPdf, reorderPages, rotatePage, rotateAllPages, deletePage } from './save.js';
import { Search } from './search.js';
import { compareDocs } from './compare.js';
import { Organizer } from './organizer.js';

const $ = (id) => document.getElementById(id);
const native = window.native;

const tabs = [];
let active = null;
let tabSeq = 1;

let split = false;
let focusedPane = 0;
const paneEls = [$('pane-0'), $('pane-1')];
const paneTabs = [null, null];
let sidebarVisible = false;

const TOOL_HINTS = {
  select: '',
  redact: 'Drag over content to redact — permanently removed when you save',
  whiteout: 'Drag to cover an area with white — then add text over it if needed',
  highlight: 'Drag to highlight',
  text: 'Click where you want to add text',
  image: 'Click where you want to place the image',
  note: 'Click where you want to attach a comment',
};

// ---------------------------------------------------------------- views & panes

function makeView(tab, rootEl) {
  return new DocView({
    tab,
    root: rootEl,
    onCurrentPage: (n) => {
      if (tab === active) {
        $('page-input').value = n;
        if (sidebarVisible) organizer.setCurrent(n);
      }
    },
    onPageRendered: (n, holder) => { if (tab === active) search.onPageRendered(n, holder); },
  });
}

function isDisplayed(tab) {
  return paneTabs[0] === tab || (split && paneTabs[1] === tab);
}

function showInPane(tab, i) {
  const other = 1 - i;
  if (split && paneTabs[other] === tab) { focusPane(other); return; }
  if (paneTabs[i] && paneTabs[i] !== tab) paneTabs[i].view.hide();
  paneTabs[i] = tab;
  tab.view.attachTo(paneEls[i]);
  tab.view.show();
  tab.view.refit();
  updatePaneUI();
}

function focusPane(i) {
  focusedPane = i;
  paneEls.forEach((p, j) => p.classList.toggle('focused', j === i));
  const t = paneTabs[i] || null;
  if (t !== active) {
    active = t;
    clearSelection();
  }
  updateChrome();
  renderTabBar();
}

function activateTab(tab) {
  if (!tab) {
    active = null;
    updateChrome();
    renderTabBar();
    updatePaneUI();
    return;
  }
  showInPane(tab, focusedPane);
  active = paneTabs[focusedPane];
  clearSelection();
  updateChrome();
  renderTabBar();
}

function updatePaneUI() {
  paneEls.forEach((pane, i) => {
    const ph = pane.querySelector('.pane-empty');
    const relevant = i === 0 || split;
    ph.classList.toggle('hidden', !relevant || !!paneTabs[i] || tabs.length === 0);
  });
  $('empty-state').classList.toggle('hidden', tabs.length > 0);
}

function updateChrome() {
  if (active) {
    $('page-count').textContent = `/ ${active.pdf.numPages}`;
    $('page-input').value = active.view.currentPageNum;
    native.setTitle(`${active.title} — egPDF`);
    setStatus(active.filePath || active.title);
  } else {
    native.setTitle('egPDF');
    setStatus('');
    $('page-count').textContent = '/ 0';
    $('page-input').value = '1';
  }
  updateZoomLabel();
  if (sidebarVisible && organizer.tab !== active) organizer.show(active);
}

function toggleSplit() {
  split = !split;
  document.body.classList.toggle('split', split);
  paneEls[1].classList.toggle('hidden', !split);
  if (split) {
    if (paneTabs[1] === paneTabs[0]) paneTabs[1] = null;
    if (!paneTabs[1]) {
      const candidate = tabs.find((t) => t !== paneTabs[0]);
      if (candidate) showInPane(candidate, 1);
    } else {
      paneTabs[1].view.attachTo(paneEls[1]);
      paneTabs[1].view.show();
    }
  } else {
    closeComparePanel();
    paneTabs[1]?.view.hide();
    if (focusedPane === 1) focusPane(0);
  }
  updatePaneUI();
  refitAll();
}

function refitAll() {
  requestAnimationFrame(() => {
    for (const t of [paneTabs[0], split ? paneTabs[1] : null]) {
      if (t && t.view.el.clientWidth > 0) t.view.refit();
    }
    updateZoomLabel();
  });
}

// ---------------------------------------------------------------- tabs

function isDirty(tab) {
  return tab.formsDirty || tab.edits.length > 0 || tab.structDirty;
}

async function openBytes(bytes, name, filePath = null) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pdf;
  try {
    pdf = await loadPdf(data);
  } catch (e) {
    setStatus(`Could not open ${name}: ${e.message || e}`, true);
    return;
  }
  const tab = {
    id: tabSeq++,
    title: name,
    filePath,
    origBytes: data,
    pdf,
    edits: [],
    formsDirty: false,
    structDirty: false,
    history: [],
    pageTexts: null,
    compareCache: {},
    view: null,
  };
  hookStorage(tab);
  tab.view = makeView(tab, paneEls[focusedPane]);
  await tab.view.init();
  tabs.push(tab);
  activateTab(tab);
}

function hookStorage(tab) {
  tab.pdf.annotationStorage.onSetModified = () => {
    tab.formsDirty = true;
    renderTabBar();
  };
}

async function openPaths(paths) {
  for (const p of paths) {
    try {
      const buf = await native.readFile(p);
      await openBytes(new Uint8Array(buf), p.split(/[\\/]/).pop(), p);
    } catch {
      setStatus(`Could not read ${p}`, true);
    }
  }
}

function closeTab(tab) {
  if (isDirty(tab) && !confirm(`"${tab.title}" has unsaved changes. Close anyway?`)) return;
  tabs.splice(tabs.indexOf(tab), 1);
  for (let i = 0; i < 2; i++) if (paneTabs[i] === tab) paneTabs[i] = null;
  tab.view.destroy();

  if (!tabs.length) {
    if (split) toggleSplit();
    active = null;
    updateChrome();
    renderTabBar();
    updatePaneUI();
    return;
  }
  if (!paneTabs[0]) {
    const repl = tabs.find((t) => t !== paneTabs[1]);
    if (repl) showInPane(repl, 0);
  }
  if (split && !paneTabs[1]) {
    const repl = tabs.find((t) => t !== paneTabs[0]);
    if (repl) showInPane(repl, 1);
  }
  active = paneTabs[focusedPane];
  updateChrome();
  renderTabBar();
  updatePaneUI();
}

function renderTabBar() {
  const box = $('tabs');
  box.replaceChildren();
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === active ? ' active' : '');
    el.innerHTML = `${isDirty(tab) ? '<span class="tab-dirty">•</span>' : ''}
      <span class="tab-title"></span><button class="tab-close" title="Close (Ctrl+W)">✕</button>`;
    el.querySelector('.tab-title').textContent = tab.title;
    el.title = tab.filePath || tab.title;
    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      if (e.button === 1) { e.preventDefault(); closeTab(tab); }
      else if (tab !== active) activateTab(tab);
    });
    el.querySelector('.tab-close').addEventListener('click', () => closeTab(tab));
    box.appendChild(el);
  }
}

// ---------------------------------------------------------------- reload / save

async function reloadTab(tab, bytes, opts = {}) {
  const {
    filePath = tab.filePath,
    edits = [],
    structDirty = false,
    resetHistory = false,
  } = opts;
  const scroll = tab.view.el.scrollTop;
  const scale = tab.view.scale;
  const fitMode = tab.view.fitMode;
  const paneIdx = paneTabs.indexOf(tab);
  tab.view.destroy();
  tab.pdf = await loadPdf(bytes);
  tab.origBytes = new Uint8Array(bytes);
  tab.filePath = filePath;
  if (filePath) tab.title = filePath.split(/[\\/]/).pop();
  tab.edits = edits;
  tab.formsDirty = false;
  tab.structDirty = structDirty;
  tab.pageTexts = null;
  tab.compareCache = {};
  if (resetHistory) tab.history = [];
  hookStorage(tab);
  tab.view = makeView(tab, paneEls[paneIdx >= 0 ? paneIdx : focusedPane]);
  tab.view.scale = scale;
  tab.view.fitMode = fitMode;
  await tab.view.init();
  if (isDisplayed(tab)) {
    tab.view.show();
    tab.view.el.scrollTop = scroll;
  } else {
    tab.view.hide();
  }
  if (tab === active) updateChrome();
  if (sidebarVisible && tab === active) organizer.show(tab);
  renderTabBar();
}

let saving = false;
async function saveActive(saveAs = false) {
  if (!active || saving) return;
  const tab = active;
  let target = tab.filePath;
  if (saveAs || !target) {
    target = await native.savePdfDialog(tab.title.endsWith('.pdf') ? tab.title : tab.title + '.pdf');
    if (!target) return;
  }
  saving = true;
  setStatus('Saving…');
  try {
    const bytes = await buildSavedPdf(tab);
    await native.writeFile(target, bytes);
    await reloadTab(tab, bytes, { filePath: target, resetHistory: true });
    setStatus(`Saved  ${target}`);
  } catch (e) {
    console.error(e);
    setStatus(`Save failed: ${e.message || e}`, true);
  } finally {
    saving = false;
  }
}

// ---------------------------------------------------------------- structural ops

async function structuralOp(tab, opRunner) {
  if (!tab || saving) return;
  setStatus('Applying…');
  try {
    const baked = tab.formsDirty ? new Uint8Array(await tab.pdf.saveDocument()) : tab.origBytes;
    tab.history.push({
      bytes: baked,
      edits: tab.edits.map((e) => ({ ...e })),
      structDirty: tab.structDirty || tab.formsDirty,
    });
    if (tab.history.length > 5) tab.history.shift();
    const res = await opRunner(baked);
    const newEdits = [];
    for (const e of tab.edits) {
      const np = res.map(e.page);
      if (np !== null) newEdits.push({ ...e, page: np });
    }
    await reloadTab(tab, res.bytes, { edits: newEdits, structDirty: true });
    setStatus('');
  } catch (e) {
    console.error(e);
    tab.history.pop();
    setStatus(`Could not modify pages: ${e.message || e}`, true);
  }
}

async function structuralUndo(tab) {
  if (!tab || !tab.history.length) return false;
  const h = tab.history.pop();
  await reloadTab(tab, h.bytes, { edits: h.edits, structDirty: h.structDirty });
  setStatus('Page change undone');
  return true;
}

function undo() {
  if (!active) return;
  if (!undoLast(active)) structuralUndo(active);
}

const organizer = new Organizer({
  el: $('sidebar'),
  onSelect: (n) => active?.view.scrollToPage(n),
  onRotate: (n) => structuralOp(active, (b) => rotatePage(b, n - 1)),
  onDelete: (n) => {
    if (!active) return;
    if (confirm(`Delete page ${n}? (Ctrl+Z restores it until you save)`)) {
      structuralOp(active, (b) => deletePage(b, n - 1));
    }
  },
  onReorder: (from, to) => structuralOp(active, (b) => reorderPages(b, from, to)),
});

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  $('sidebar').classList.toggle('hidden', !sidebarVisible);
  if (sidebarVisible) organizer.show(active);
  else organizer.show(null);
  refitAll();
}

// ---------------------------------------------------------------- compare

async function runCompare() {
  if (!split) toggleSplit();
  const [ta, tb] = paneTabs;
  if (!ta || !tb || ta === tb) {
    setStatus('Open two different documents side by side, then press Compare', true);
    return null;
  }
  setStatus('Comparing…');
  let res;
  try {
    res = await compareDocs(ta.pdf, tb.pdf, ta.compareCache, tb.compareCache);
  } catch (e) {
    setStatus(`Compare failed: ${e.message || e}`, true);
    return null;
  }
  renderComparePanel(res, ta, tb);
  setStatus('');
  return res;
}

function renderComparePanel(res, ta, tb) {
  $('compare-panel').classList.remove('hidden');
  $('compare-title').textContent = `${ta.title}  ↔  ${tb.title}`;
  const list = $('compare-list');
  list.replaceChildren();
  if (res.tooDifferent) {
    $('compare-sub').textContent = '';
    list.innerHTML = '<div class="compare-note">The documents differ too much for a word-level comparison.</div>';
    return;
  }
  if (res.identical) {
    $('compare-sub').textContent = 'text is identical';
    list.innerHTML = '<div class="compare-note">No text differences found. (Images and formatting are not compared.)</div>';
    return;
  }
  $('compare-sub').textContent =
    `${res.hunks.length} difference${res.hunks.length === 1 ? '' : 's'} · text only`;
  for (const h of res.hunks) {
    const row = document.createElement('div');
    row.className = 'hunk';
    const pg = document.createElement('span');
    pg.className = 'hunk-page';
    pg.textContent = `p.${h.pageA} → p.${h.pageB}`;
    const body = document.createElement('span');
    body.className = 'hunk-body';
    const add = (tag, cls, text) => {
      if (!text) return;
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      el.textContent = text;
      body.appendChild(el);
      body.appendChild(document.createTextNode(' '));
    };
    add('span', 'ctx', h.ctxBefore ? '…' + h.ctxBefore : '');
    add('del', '', h.del);
    add('ins', '', h.ins);
    add('span', 'ctx', h.ctxAfter ? h.ctxAfter + '…' : '');
    row.append(pg, body);
    row.addEventListener('click', () => {
      paneTabs[0]?.view.scrollToPage(h.pageA);
      paneTabs[1]?.view.scrollToPage(h.pageB);
    });
    list.appendChild(row);
  }
}

function closeComparePanel() {
  $('compare-panel').classList.add('hidden');
}

// ---------------------------------------------------------------- printing

let printing = false;
async function printActive() {
  if (!active || printing || isPrintPreviewOpen()) return;
  printing = true;
  try {
    await openPrintPreview(active, setStatus);
  } catch (e) {
    console.error(e);
    setStatus(`Print failed: ${e.message || e}`, true);
  } finally {
    printing = false;
  }
}

// ---------------------------------------------------------------- selection popup

let popupTab = null;

function findTabForNode(node) {
  const el = node?.nodeType === 3 ? node.parentElement : node;
  const scrollEl = el?.closest?.('.doc-scroll');
  if (!scrollEl) return null;
  return tabs.find((t) => t.view.el === scrollEl) || null;
}

function hideSelectionPopup() {
  $('selection-popup').classList.add('hidden');
  popupTab = null;
}

function updateSelectionPopup() {
  const sel = window.getSelection();
  const popup = $('selection-popup');
  if (!sel || sel.isCollapsed || !sel.rangeCount || editState.tool !== 'select') {
    hideSelectionPopup();
    return;
  }
  const anchorEl = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
  if (!anchorEl?.closest?.('.textLayer')) { hideSelectionPopup(); return; }
  const tab = findTabForNode(sel.anchorNode);
  if (!tab) { hideSelectionPopup(); return; }
  const rects = sel.getRangeAt(sel.rangeCount - 1).getClientRects();
  if (!rects.length) { hideSelectionPopup(); return; }
  const last = rects[rects.length - 1];
  popupTab = tab;
  popup.classList.remove('hidden');
  const w = popup.offsetWidth, h = popup.offsetHeight;
  let top = last.top - h - 8;
  if (top < 96) top = last.bottom + 8;
  popup.style.top = Math.min(window.innerHeight - h - 8, Math.max(96, top)) + 'px';
  popup.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, last.right - w / 2)) + 'px';
}

document.addEventListener('pointerup', () => setTimeout(updateSelectionPopup, 10));
document.addEventListener('selectionchange', () => {
  if (window.getSelection()?.isCollapsed) hideSelectionPopup();
});
document.addEventListener('scroll', hideSelectionPopup, true);

// keep the selection alive when clicking popup buttons
$('selection-popup').addEventListener('pointerdown', (e) => e.preventDefault());
$('selection-popup').querySelector('.sp-highlight').addEventListener('click', () => {
  if (popupTab) addSelectionRects(popupTab, 'highlight');
  hideSelectionPopup();
});
$('selection-popup').querySelector('.sp-redact').addEventListener('click', () => {
  if (popupTab) addSelectionRects(popupTab, 'redact');
  hideSelectionPopup();
});
$('selection-popup').querySelector('.sp-edittext').addEventListener('click', () => {
  if (popupTab) editTextFromSelection(popupTab);
  hideSelectionPopup();
});

// ---------------------------------------------------------------- ui glue

function setStatus(msg, isError = false) {
  const el = $('status-left');
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--danger)' : '';
}

function updateZoomLabel() {
  $('zoom-label').textContent = active ? Math.round(active.view.scale * 100) + '%' : '100%';
}

function zoomBy(f) {
  if (!active) return;
  active.view.setZoom(active.view.scale * f);
  updateZoomLabel();
}

const search = new Search(() => active, $('search-status'));

function toggleSearch(show) {
  const bar = $('searchbar');
  if (show) {
    bar.classList.remove('hidden');
    $('search-input').focus();
    $('search-input').select();
  } else {
    bar.classList.add('hidden');
    search.close();
  }
}

async function startImageTool() {
  const img = await native.pickImage();
  if (!img) { setTool('select'); return; }
  const probe = new Image();
  probe.src = `data:${img.mime};base64,${img.data}`;
  await probe.decode().catch(() => {});
  editState.pendingImage = {
    data: img.data, mime: img.mime,
    naturalW: probe.naturalWidth || 300, naturalH: probe.naturalHeight || 300,
  };
  setTool('image');
}

// ---------------------------------------------------------------- wiring

applyIcons({
  'btn-sidebar': 'sidebar', 'btn-rotate-doc': 'rotate',
  'btn-open': 'open', 'btn-save': 'save', 'btn-saveas': 'saveas', 'btn-print': 'print',
  'btn-zoom-out': 'zoomout', 'btn-zoom-in': 'zoomin', 'btn-fit': 'fit',
  'btn-split': 'split', 'btn-compare': 'compare',
  'tool-select': 'select', 'tool-redact': 'redact', 'tool-whiteout': 'whiteout',
  'tool-highlight': 'highlight', 'tool-text': 'text', 'tool-image': 'image',
  'tool-note': 'note',
  'btn-undo': 'undo', 'btn-search': 'search',
});

const openDialog = async () => { const ps = await native.openPdfDialog(); if (ps.length) openPaths(ps); };
$('btn-open').addEventListener('click', openDialog);
$('btn-newtab').addEventListener('click', openDialog);
$('btn-open-empty').addEventListener('click', openDialog);
$('btn-save').addEventListener('click', () => saveActive(false));
$('btn-saveas').addEventListener('click', () => saveActive(true));
$('btn-print').addEventListener('click', printActive);
$('btn-zoom-in').addEventListener('click', () => zoomBy(1.15));
$('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.15));
$('btn-fit').addEventListener('click', () => {
  if (!active) return;
  active.view.setZoom(active.view.computeFitScale(), true);
  updateZoomLabel();
});
$('btn-sidebar').addEventListener('click', toggleSidebar);
$('btn-rotate-doc').addEventListener('click', () => structuralOp(active, (b) => rotateAllPages(b)));
$('btn-split').addEventListener('click', toggleSplit);
$('btn-compare').addEventListener('click', runCompare);
$('compare-close').addEventListener('click', closeComparePanel);
$('btn-undo').addEventListener('click', undo);
$('btn-search').addEventListener('click', () => toggleSearch($('searchbar').classList.contains('hidden')));

paneEls.forEach((pane, i) => {
  pane.addEventListener('pointerdown', () => {
    if (focusedPane !== i) focusPane(i);
  }, true);
  pane.querySelector('.pane-open-btn').addEventListener('click', () => {
    focusPane(i);
    openDialog();
  });
});

for (const btn of document.querySelectorAll('.tool')) {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    if (tool === 'image') startImageTool();
    else setTool(tool);
  });
}

function updateTextControls() {
  const show = editState.tool === 'text' || editState.selected?.edit.kind === 'text';
  $('text-size').classList.toggle('visible', show);
  $('text-font').classList.toggle('visible', show);
}

onToolChanged((tool) => {
  if (tool !== 'select') hideSelectionPopup();
  document.querySelectorAll('.tool').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
  updateTextControls();
  setStatus(TOOL_HINTS[tool] ?? '');
});

onEditsChanged(() => {
  renderTabBar();
  updateTextControls();
});

$('text-size').addEventListener('change', (e) => applyTextSize(+e.target.value));
$('text-font').addEventListener('change', (e) => applyFontFamily(e.target.value));

let availableFonts = [];
(async () => {
  availableFonts = await detectAvailableFonts(native);
  const sel = $('text-font');
  sel.replaceChildren();
  for (const f of availableFonts) {
    const o = document.createElement('option');
    o.value = o.textContent = f.name;
    o.style.fontFamily = `"${f.name}"`;
    sel.appendChild(o);
  }
  const def = availableFonts.some((f) => f.name === 'Arial') ? 'Arial' : availableFonts[0].name;
  sel.value = def;
  editState.fontFamily = def;
})();

$('page-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && active) {
    const n = parseInt(e.target.value, 10);
    if (n >= 1) active.view.scrollToPage(n);
    e.target.blur();
  }
});

// search bar
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if ($('search-input').value.toLowerCase().trim() !== search.query) search.run($('search-input').value);
    else search.next(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') toggleSearch(false);
});
$('search-next').addEventListener('click', () => search.next(1));
$('search-prev').addEventListener('click', () => search.next(-1));
$('search-close').addEventListener('click', () => toggleSearch(false));

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
  const inField = e.target.closest('input, select, textarea, [contenteditable="true"], .annotationLayer');
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); openDialog(); }
    else if (k === 's') { e.preventDefault(); saveActive(e.shiftKey); }
    else if (k === 'p') { e.preventDefault(); printActive(); }
    else if (k === 'w') { e.preventDefault(); if (active) closeTab(active); }
    else if (k === 'f') { e.preventDefault(); toggleSearch(true); }
    else if (k === 'z' && !inField) { e.preventDefault(); undo(); }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.15); }
    else if (e.key === '-') { e.preventDefault(); zoomBy(1 / 1.15); }
    else if (e.key === '0') { e.preventDefault(); if (active) { active.view.setZoom(1); updateZoomLabel(); } }
    else if (e.key === 'Tab' && tabs.length > 1) {
      e.preventDefault();
      const i = tabs.indexOf(active);
      activateTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
    }
    return;
  }
  if (inField) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelected()) e.preventDefault();
  } else if (e.key === 'Escape') {
    clearSelection();
    hideSelectionPopup();
    setTool('select');
    closeComparePanel();
  } else if (e.key === 'v') setTool('select');
  else if (e.key === 'r') setTool('redact');
  else if (e.key === 'w') setTool('whiteout');
  else if (e.key === 'h') setTool('highlight');
  else if (e.key === 't') setTool('text');
  else if (e.key === 'c') setTool('note');
  else if (e.key === 'i') startImageTool();
});

// drag & drop
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.types?.includes('Files')) document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  for (const file of e.dataTransfer.files) {
    if (!/\.pdf$/i.test(file.name)) continue;
    const path = native.pathForFile(file);
    const buf = await file.arrayBuffer();
    await openBytes(new Uint8Array(buf), file.name, path || null);
  }
});

window.addEventListener('resize', refitAll);

native.onOpenPaths((paths) => openPaths(paths));

updateZoomLabel();
setTool('select');

import('./autotest.js').then((m) =>
  m.maybeRunAutotest({
    getActive: () => active,
    openPaths,
    search,
    toggleSplit,
    runCompare,
    toggleSidebar,
    getPanes: () => paneTabs,
    getFonts: () => availableFonts,
    ops: {
      rotate: (n) => structuralOp(active, (b) => rotatePage(b, n - 1)),
      reorder: (from, to) => structuralOp(active, (b) => reorderPages(b, from, to)),
      del: (n) => structuralOp(active, (b) => deletePage(b, n - 1)),
    },
  }));
