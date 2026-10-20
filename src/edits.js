// Edit model + overlay tools. Edits are stored per-tab in PDF user-space
// coordinates (origin bottom-left, points) so they survive zoom changes.
//
// kinds:
//   redact    {page, x, y, w, h}          — baked into a raster on save (true redaction)
//   whiteout  {page, x, y, w, h}
//   highlight {page, x, y, w, h}
//   text      {page, x, yTop, size, text}
//   image     {page, x, yTop, w, h, data(b64), mime}
//   note      {page, x, yTop, text, author, date(ISO)} — saved as a real PDF comment annotation

export const editState = {
  tool: 'select',
  textSize: 14,
  fontFamily: 'Arial',
  pendingImage: null,   // {data, mime, naturalW, naturalH}
  selected: null,       // {tab, edit, el}
  _activeTextEdit: null, // {edit, tab, el} — uncommitted text edit being typed
  _activeNote: null,     // finish(keep) of the comment card being edited
};

let nextId = 1;
let changedCb = () => {};
let toolChangedCb = () => {};
let ocrAreaCb = () => {};
export function onEditsChanged(cb) { changedCb = cb; }
export function onToolChanged(cb) { toolChangedCb = cb; }
export function onOcrArea(cb) { ocrAreaCb = cb; }

export function setTool(tool) {
  editState.tool = tool;
  clearSelection();
  document.querySelectorAll('.edit-layer').forEach(l =>
    l.classList.toggle('tool-active', tool !== 'select'));
  toolChangedCb(tool);
}

export function clearSelection() {
  if (editState.selected) {
    editState.selected.el?.classList.remove('selected');
    editState.selected = null;
  }
}

function selectItem(tab, edit, el) {
  clearSelection();
  editState.selected = { tab, edit, el };
  el.classList.add('selected');
}

export function deleteSelected() {
  const sel = editState.selected;
  if (!sel) return false;
  removeEdit(sel.tab, sel.edit);
  return true;
}

export function undoLast(tab) {
  if (!tab || !tab.edits.length) return false;
  removeEdit(tab, tab.edits[tab.edits.length - 1]);
  return true;
}

function removeEdit(tab, edit) {
  const i = tab.edits.indexOf(edit);
  if (i >= 0) tab.edits.splice(i, 1);
  if (editState.selected?.edit === edit) clearSelection();
  document.querySelector(`.edit-item[data-edit-id="${edit.id}"]`)?.remove();
  changedCb(tab);
}

function addEdit(tab, edit) {
  edit.id = nextId++;
  tab.edits.push(edit);
  changedCb(tab);
  return edit;
}

// Change size of a selected text edit from the toolbar dropdown.
export function applyTextSize(size) {
  editState.textSize = size;
  const sel = editState.selected;
  if (sel && sel.edit.kind === 'text') {
    sel.edit.size = size;
    const scale = parseFloat(sel.el.closest('.page-holder')?.style.getPropertyValue('--scale-factor')) || 1;
    sel.el.style.fontSize = (size * scale) + 'px';
    changedCb(sel.tab);
  }
}

export function applyFontFamily(name) {
  editState.fontFamily = name;
  const sel = editState.selected;
  if (sel && sel.edit.kind === 'text') {
    sel.edit.font = name;
    sel.el.style.fontFamily = `"${name}", sans-serif`;
    changedCb(sel.tab);
  }
}

// ---- coordinate helpers ----------------------------------------------------

function rectToCss(viewport, r) {
  const [ax, ay] = viewport.convertToViewportPoint(r.x, r.y);
  const [bx, by] = viewport.convertToViewportPoint(r.x + r.w, r.y + r.h);
  return {
    left: Math.min(ax, bx), top: Math.min(ay, by),
    width: Math.abs(bx - ax), height: Math.abs(by - ay),
  };
}

function cssRectToPdf(viewport, left, top, width, height) {
  const [ax, ay] = viewport.convertToPdfPoint(left, top);
  const [bx, by] = viewport.convertToPdfPoint(left + width, top + height);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

function localPoint(layer, e) {
  const r = layer.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

// ---- text-selection actions -------------------------------------------------

// Collapse the selection's client rects into one rect per text line.
function selectionLineRects() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const rects = [];
  for (let i = 0; i < sel.rangeCount; i++) rects.push(...sel.getRangeAt(i).getClientRects());
  const lines = [];
  for (const r of rects) {
    if (r.width < 2 || r.height < 2) continue;
    const cy = r.top + r.height / 2;
    let line = lines.find((l) =>
      Math.abs((l.top + l.bottom) / 2 - cy) < Math.min(l.bottom - l.top, r.height) * 0.6);
    if (!line) {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    } else {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    }
  }
  return lines;
}

function linesOnHolder(lines, holder) {
  const hr = holder.getBoundingClientRect();
  return lines.filter((ln) => {
    const cx = (ln.left + ln.right) / 2, cy = (ln.top + ln.bottom) / 2;
    return cx >= hr.left && cx <= hr.right && cy >= hr.top && cy <= hr.bottom;
  }).map((ln) => ({
    left: ln.left - hr.left - 1.5, top: ln.top - hr.top - 1.5,
    w: ln.right - ln.left + 3, h: ln.bottom - ln.top + 3,
  }));
}

// Turn the current text selection into highlight/redact/whiteout rects.
export function addSelectionRects(tab, kind) {
  const lines = selectionLineRects();
  let count = 0;
  const pages = new Set();
  for (const holder of tab.view.holders) {
    if (!holder._rendered || !holder._viewport) continue;
    for (const local of linesOnHolder(lines, holder)) {
      const r = cssRectToPdf(holder._viewport, local.left, local.top, local.w, local.h);
      addEdit(tab, { kind, page: +holder.dataset.page, ...r });
      pages.add(+holder.dataset.page);
      count++;
    }
  }
  for (const p of pages) tab.view.refreshEditLayer(p);
  if (count) window.getSelection().removeAllRanges();
  return count;
}

// "Edit" selected text: whiteout the selected lines and open a pre-filled,
// size-matched text box over them (PDF text isn't reflowable, so replacing
// the region is the reliable way to change it).
export function editTextFromSelection(tab) {
  const sel = window.getSelection();
  const text = (sel?.toString() || '').replace(/\s+\n/g, '\n').trim();
  const lines = selectionLineRects();
  if (!text || !lines.length) return false;

  let holder = null, locals = null;
  for (const h of tab.view.holders) {
    if (!h._rendered || !h._viewport) continue;
    const ls = linesOnHolder(lines, h);
    if (ls.length) { holder = h; locals = ls; break; }
  }
  if (!holder) return false;
  const vp = holder._viewport;
  const page = +holder.dataset.page;

  for (const local of locals) {
    addEdit(tab, { kind: 'whiteout', page, ...cssRectToPdf(vp, local.left, local.top, local.w, local.h) });
  }
  tab.view.refreshEditLayer(page);

  const first = locals[0];
  const size = Math.min(72, Math.max(6, Math.round((first.h - 3) / vp.scale * 0.88)));
  const [px, py] = vp.convertToPdfPoint(first.left + 1.5, first.top + 1);
  const edit = { kind: 'text', page, x: px, yTop: py, size, font: editState.fontFamily, text, _editing: true };
  const layer = holder.querySelector('.edit-layer');
  if (!layer) return false;
  window.getSelection().removeAllRanges();
  const el = renderItem(tab, edit, layer, vp, true);
  el.contentEditable = 'true';
  editState._activeTextEdit = { edit, tab, el };
  return true;
}

// ---- mounting --------------------------------------------------------------

export function mountEditLayer(tab, pageNum, layer, viewport, holder) {
  layer.classList.toggle('tool-active', editState.tool !== 'select');
  layer._viewport = viewport;
  for (const edit of tab.edits) {
    if (edit.page === pageNum) renderItem(tab, edit, layer, viewport);
  }
  if (layer._mounted) return;
  layer._mounted = true;

  layer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const vp = layer._viewport;
    const tool = editState.tool;
    if (tool === 'redact' || tool === 'whiteout' || tool === 'highlight' || tool === 'ocrarea') {
      e.preventDefault();
      startRectDrag(tab, pageNum, layer, vp, e, tool);
    } else if (tool === 'text') {
      e.preventDefault();
      const [cx, cy] = localPoint(layer, e);
      createTextItem(tab, pageNum, layer, vp, cx, cy);
    } else if (tool === 'note') {
      e.preventDefault();
      const [cx, cy] = localPoint(layer, e);
      createNoteItem(tab, pageNum, layer, vp, cx, cy);
    } else if (tool === 'image' && editState.pendingImage) {
      e.preventDefault();
      placeImage(tab, pageNum, layer, vp, e);
    }
  });
}

// ---- rect tools (redact / whiteout) ----------------------------------------

function startRectDrag(tab, pageNum, layer, viewport, e, kind) {
  const [sx, sy] = localPoint(layer, e);
  const ghost = document.createElement('div');
  ghost.className = 'drag-rect';
  layer.appendChild(ghost);
  layer.setPointerCapture(e.pointerId);

  const update = (ev) => {
    const [cx, cy] = localPoint(layer, ev);
    ghost.style.left = Math.min(sx, cx) + 'px';
    ghost.style.top = Math.min(sy, cy) + 'px';
    ghost.style.width = Math.abs(cx - sx) + 'px';
    ghost.style.height = Math.abs(cy - sy) + 'px';
  };
  const finish = (ev) => {
    layer.removeEventListener('pointermove', update);
    layer.removeEventListener('pointerup', finish);
    const [cx, cy] = localPoint(layer, ev);
    ghost.remove();
    const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
    if (w > 4 && h > 4) {
      const rect = cssRectToPdf(viewport, Math.min(sx, cx), Math.min(sy, cy), w, h);
      if (kind === 'ocrarea') {
        // not an edit — the rect goes to the OCR extractor
        ocrAreaCb(tab, pageNum, rect);
      } else {
        const edit = addEdit(tab, { kind, page: pageNum, ...rect });
        renderItem(tab, edit, layer, viewport);
      }
    }
  };
  layer.addEventListener('pointermove', update);
  layer.addEventListener('pointerup', finish);
}

// ---- text tool -------------------------------------------------------------

function createTextItem(tab, pageNum, layer, viewport, cx, cy) {
  const [px, py] = viewport.convertToPdfPoint(cx, cy);
  const edit = {
    kind: 'text', page: pageNum, x: px, yTop: py,
    size: editState.textSize, font: editState.fontFamily, text: '', _editing: true,
  };
  const el = renderItem(tab, edit, layer, viewport, true);
  el.focus();
  editState._activeTextEdit = { edit, tab, el };
}

function commitText(tab, edit, el) {
  const text = el.isConnected
    ? el.innerText.replace(/\n+$/, '')
    : (edit.text || '').replace(/\n+$/, '');
  el.contentEditable = 'false';
  edit._editing = false;
  if (editState._activeTextEdit?.edit === edit) editState._activeTextEdit = null;
  if (!text.trim()) {
    if (edit.id) removeEdit(tab, edit); else el.remove();
    return;
  }
  edit.text = text;
  if (!edit.id) addEdit(tab, edit);
  else changedCb(tab);
}

export function commitActiveTextEdits() {
  const at = editState._activeTextEdit;
  if (at) {
    const { edit, tab, el } = at;
    editState._activeTextEdit = null;
    commitText(tab, edit, el);
  }
  editState._activeNote?.(true);
}

// ---- note (comment) tool ----------------------------------------------------

const NOTE_SVG = '<svg viewBox="0 0 24 24"><path d="M4 5.5C4 4.7 4.7 4 5.5 4h13c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5H12l-4.5 4v-4h-2c-.8 0-1.5-.7-1.5-1.5v-9Z"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';

const AUTHOR_KEY = 'egpdf.author';

// Default author for new comments; editing the name on any comment updates it.
export function getNoteAuthor() {
  try { return localStorage.getItem(AUTHOR_KEY) || ''; } catch { return ''; }
}
function setNoteAuthor(name) {
  try { localStorage.setItem(AUTHOR_KEY, name); } catch { /* storage unavailable */ }
}

export function noteInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0], b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toLocaleUpperCase();
}

export function noteHue(name) {
  let h = 0;
  for (const ch of name || '') h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

export function formatNoteDate(d) {
  if (!d || isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function createNoteItem(tab, pageNum, layer, viewport, cx, cy) {
  // anchor the icon's centre on the click point
  const [px, py] = viewport.convertToPdfPoint(cx - 11, cy - 11);
  const edit = {
    kind: 'note', page: pageNum, x: px, yTop: py, text: '',
    author: getNoteAuthor(), date: new Date().toISOString(),
  };
  const el = renderItem(tab, edit, layer, viewport, true);
  setTool('select');
  selectItem(tab, edit, el);
}

function buildNoteCard(tab, edit, el, startEditing) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.tabIndex = -1; // clicks on the card's chrome keep focus inside it
  card.innerHTML = `
    <div class="note-head">
      <div class="note-avatar"></div>
      <div class="note-meta">
        <input class="note-author" type="text" placeholder="Your name" spellcheck="false" maxlength="80" readonly>
        <div class="note-date"></div>
      </div>
      <div class="note-actions">
        <button class="note-btn note-edit" title="Edit comment">${PENCIL_SVG}</button>
        <button class="note-btn note-delete" title="Delete comment">${TRASH_SVG}</button>
      </div>
    </div>
    <div class="note-text"></div>
    <textarea class="note-input" rows="3" placeholder="Write a comment…" spellcheck="false"></textarea>
    <div class="note-foot">
      <span class="note-hint">Ctrl+Enter to save</span>
      <button class="note-cancel">Cancel</button>
      <button class="note-save">Save</button>
    </div>`;
  const $q = (s) => card.querySelector(s);
  const avatar = $q('.note-avatar'), author = $q('.note-author'), date = $q('.note-date');
  const textView = $q('.note-text'), input = $q('.note-input'), save = $q('.note-save');

  const paintAvatar = (name) => {
    avatar.textContent = noteInitials(name);
    avatar.style.setProperty('--hue', noteHue(name));
  };
  const show = () => {
    author.value = edit.author || '';
    paintAvatar(edit.author);
    date.textContent = formatNoteDate(new Date(edit.date));
    textView.textContent = edit.text;
  };
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight + 2) + 'px';
  };
  const syncSave = () => { save.disabled = !input.value.trim(); };

  let editing = false;
  const begin = () => {
    if (editing) return;
    editState._activeNote?.(true);
    editing = true;
    editState._activeNote = finish;
    el.classList.add('editing');
    placeNoteCard(el);
    author.readOnly = false;
    input.value = edit.text;
    autosize();
    syncSave();
    requestAnimationFrame(() => {
      // a fresh comment with no name yet asks for the name first
      const target = !edit.id && !author.value ? author : input;
      target.focus();
      if (target === input) input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  function finish(keep) {
    if (!editing) return;
    editing = false;
    if (editState._activeNote === finish) editState._activeNote = null;
    el.classList.remove('editing');
    author.readOnly = true;
    const text = input.value.replace(/\s+$/, '');
    if (!keep) {
      if (!edit.id) el.remove();
      show();
      return;
    }
    if (!text.trim()) {
      if (edit.id) removeEdit(tab, edit); else el.remove();
      return;
    }
    const name = author.value.trim();
    if (name !== (edit.author || '')) setNoteAuthor(name);
    if (text !== edit.text || name !== (edit.author || '')) edit.date = new Date().toISOString();
    edit.text = text;
    edit.author = name;
    show();
    if (!edit.id) { addEdit(tab, edit); el.dataset.editId = edit.id; }
    else changedCb(tab);
  }

  // clicks inside the card never start a drag of the comment
  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('dblclick', (e) => { e.stopPropagation(); begin(); });
  card.addEventListener('focusout', (e) => {
    if (editing && !card.contains(e.relatedTarget)) finish(true);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    else if (e.key === 'Enter' && e.target === author) { e.preventDefault(); input.focus(); }
  });
  author.addEventListener('input', () => paintAvatar(author.value));
  input.addEventListener('input', () => { autosize(); syncSave(); });
  $q('.note-edit').addEventListener('click', begin);
  $q('.note-delete').addEventListener('click', () => {
    editing = false;
    if (editState._activeNote === finish) editState._activeNote = null;
    if (edit.id) removeEdit(tab, edit); else el.remove();
  });
  $q('.note-cancel').addEventListener('click', () => finish(false));
  save.addEventListener('click', () => finish(true));
  el.addEventListener('pointerenter', () => { if (!editing) placeNoteCard(el); });
  el.addEventListener('dblclick', begin);

  show();
  if (startEditing) begin();
  return card;
}

// Open the card on whichever side of the icon has room on the page.
function placeNoteCard(el) {
  const layer = el.parentElement;
  if (!layer) return;
  const left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0;
  el.classList.toggle('flip-x', left + 30 + 290 > layer.clientWidth && left > 300);
  el.classList.toggle('flip-y', top + 200 > layer.clientHeight && top > 200);
}

// ---- image tool ------------------------------------------------------------

function placeImage(tab, pageNum, layer, viewport, e) {
  const img = editState.pendingImage;
  const [cx, cy] = localPoint(layer, e);
  const [px, py] = viewport.convertToPdfPoint(cx, cy);
  const pageW = viewport.width / viewport.scale;
  // natural px → points (96dpi css → 72dpi pdf), capped to half the page width
  let w = img.naturalW * 0.75;
  const maxW = pageW * 0.5;
  if (w > maxW) w = maxW;
  const h = w * (img.naturalH / img.naturalW);
  const edit = addEdit(tab, {
    kind: 'image', page: pageNum, x: px, yTop: py, w, h,
    data: img.data, mime: img.mime,
  });
  const el = renderItem(tab, edit, layer, viewport);
  setTool('select');
  selectItem(tab, edit, el);
  editState.pendingImage = null;
}

// ---- item rendering & manipulation -----------------------------------------

function renderItem(tab, edit, layer, viewport, startEditing = false) {
  const el = document.createElement('div');
  el.className = 'edit-item ' + (edit.kind === 'text' ? 'textedit'
    : edit.kind === 'image' ? 'imgedit'
    : edit.kind === 'note' ? 'noteedit' : edit.kind);
  if (edit.id) el.dataset.editId = edit.id;

  if (edit.kind === 'redact' || edit.kind === 'whiteout' || edit.kind === 'highlight') {
    const css = rectToCss(viewport, edit);
    Object.assign(el.style, {
      left: css.left + 'px', top: css.top + 'px',
      width: css.width + 'px', height: css.height + 'px',
    });
    addResizeHandle(tab, edit, el, layer);
  } else if (edit.kind === 'text') {
    const [lx, ly] = viewport.convertToViewportPoint(edit.x, edit.yTop);
    Object.assign(el.style, {
      left: lx + 'px', top: ly + 'px',
      fontSize: (edit.size * viewport.scale) + 'px',
      fontFamily: `"${edit.font || 'Arial'}", sans-serif`,
    });
    el.innerText = edit.text;
    el.spellcheck = false;
    el.addEventListener('blur', () => commitText(tab, edit, el));
    el.addEventListener('dblclick', () => {
      edit._editing = true;
      el.contentEditable = 'true';
      el.focus();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); el.blur(); }
    });
    if (startEditing || edit._editing) el.contentEditable = 'true';
  } else if (edit.kind === 'note') {
    const [lx, ly] = viewport.convertToViewportPoint(edit.x, edit.yTop);
    Object.assign(el.style, { left: lx + 'px', top: ly + 'px' });
    const icon = document.createElement('div');
    icon.className = 'note-icon';
    icon.innerHTML = NOTE_SVG;
    el.appendChild(icon);
    el.appendChild(buildNoteCard(tab, edit, el, startEditing));
  } else if (edit.kind === 'image') {
    const [lx, ly] = viewport.convertToViewportPoint(edit.x, edit.yTop);
    Object.assign(el.style, {
      left: lx + 'px', top: ly + 'px',
      width: (edit.w * viewport.scale) + 'px',
      height: (edit.h * viewport.scale) + 'px',
    });
    const img = document.createElement('img');
    img.src = `data:${edit.mime};base64,${edit.data}`;
    img.draggable = false;
    el.appendChild(img);
    addResizeHandle(tab, edit, el, layer, true);
  }

  // select + move (select tool only)
  el.addEventListener('pointerdown', (e) => {
    if (editState.tool !== 'select' || e.button !== 0) return;
    if (el.isContentEditable) return;
    if (e.target.classList.contains('resize-handle')) return;
    e.preventDefault();
    e.stopPropagation();
    selectItem(tab, edit, el);
    startMove(tab, edit, el, layer, e);
  });

  layer.appendChild(el);
  if (edit.kind === 'note') placeNoteCard(el);
  if (startEditing) requestAnimationFrame(() => el.focus());
  return el;
}

function startMove(tab, edit, el, layer, e) {
  const vp = layer._viewport;
  const startLeft = parseFloat(el.style.left), startTop = parseFloat(el.style.top);
  const [ox, oy] = [e.clientX, e.clientY];
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    const dx = ev.clientX - ox, dy = ev.clientY - oy;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    el.style.left = (startLeft + dx) + 'px';
    el.style.top = (startTop + dy) + 'px';
  };
  const onUp = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    if (!moved) return;
    const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
    if (edit.kind === 'redact' || edit.kind === 'whiteout') {
      const r = cssRectToPdf(vp, left, top, parseFloat(el.style.width), parseFloat(el.style.height));
      Object.assign(edit, r);
    } else {
      const [px, py] = vp.convertToPdfPoint(left, top);
      edit.x = px; edit.yTop = py;
    }
    changedCb(tab);
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

function addResizeHandle(tab, edit, el, layer, keepAspect = false) {
  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  el.appendChild(handle);
  handle.addEventListener('pointerdown', (e) => {
    if (editState.tool !== 'select' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectItem(tab, edit, el);
    const vp = layer._viewport;
    const startW = parseFloat(el.style.width), startH = parseFloat(el.style.height);
    const [ox, oy] = [e.clientX, e.clientY];
    const aspect = startH / startW;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      let w = Math.max(8, startW + (ev.clientX - ox));
      let h = keepAspect ? w * aspect : Math.max(8, startH + (ev.clientY - oy));
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      const left = parseFloat(el.style.left), top = parseFloat(el.style.top);
      const w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      if (edit.kind === 'image') {
        edit.w = w / vp.scale;
        edit.h = h / vp.scale;
        const [px, py] = vp.convertToPdfPoint(left, top);
        edit.x = px; edit.yTop = py;
      } else {
        Object.assign(edit, cssRectToPdf(vp, left, top, w, h));
      }
      changedCb(tab);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}
