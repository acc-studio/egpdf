// End-to-end self-test, active only with --autotest=<outputDir>.
// Exercises: edit tools model, redaction rasterization, form filling,
// the full save pipeline, and reopening the saved file.
import { buildSavedPdf } from './save.js';
import { loadPdf, viewerDebug } from './viewer.js';
import { addSelectionRects, editTextFromSelection, commitActiveTextEdits } from './edits.js';
import { openPrintPreview, closePrintPreview, getPrintState } from './print.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, label = '', timeout = 30000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout: ' + label);
    await sleep(100);
  }
}

function makeTestImageB64() {
  const c = document.createElement('canvas');
  c.width = 120; c.height = 80;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 120, 80);
  g.addColorStop(0, '#3b6ff5'); g.addColorStop(1, '#9b3bf5');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 120, 80);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif';
  ctx.fillText('IMG', 42, 46);
  return c.toDataURL('image/png').split(',')[1];
}

export async function maybeRunAutotest(ctx) {
  const dir = await window.native.getTestConfig();
  if (!dir) return;
  // Join with the host's separator (the dir is passed in OS-native form).
  const sep = dir.includes('\\') ? '\\' : '/';
  const base = dir.endsWith(sep) ? dir : dir + sep;
  const out = (name) => base + name;
  const results = {};
  const logs = [];
  for (const m of ['warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => {
      logs.push(m + ': ' + a.map((x) => String(x?.stack ?? x?.message ?? x)).join(' | '));
      orig(...a);
    };
  }
  window.addEventListener('error', (e) => logs.push('window.onerror: ' + (e.error?.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => logs.push('unhandledrejection: ' + (e.reason?.stack || e.reason)));
  try {
    await waitFor(() => ctx.getActive(), 'first tab');
    const tab = ctx.getActive();
    await waitFor(() => tab.view.holders[0]?._rendered, 'tab1 p1');

    // 1) programmatic edits (same model the tools produce)
    tab.edits.push(
      { id: 9001, kind: 'redact', page: 1, x: 55, y: 692, w: 330, h: 24 },
      { id: 9002, kind: 'whiteout', page: 1, x: 55, y: 652, w: 420, h: 22 },
      { id: 9003, kind: 'text', page: 1, x: 60, yTop: 672, size: 12, font: 'Georgia', text: 'Değişiklik: Şğİçöü — amended clause text.' },
      { id: 9004, kind: 'image', page: 3, x: 60, yTop: 700, w: 120, h: 80, data: makeTestImageB64(), mime: 'image/png' },
    );
    tab.view.refreshEditLayer(1);
    await sleep(300);
    await window.native.testCapture(out('t1-edit-overlay.png'));

    // 2) fill the form on page 2 through the real annotation layer inputs
    tab.view.scrollToPage(2);
    await waitFor(() => tab.view.holders[1]?._rendered, 'tab1 p2');
    await sleep(400);
    const holder2 = tab.view.holders[1];
    const inputs = holder2.querySelectorAll('.annotationLayer input[type="text"]');
    const textarea = holder2.querySelector('.annotationLayer textarea');
    const checkbox = holder2.querySelector('.annotationLayer input[type="checkbox"]');
    results.formWidgets = { texts: inputs.length, textarea: !!textarea, checkbox: !!checkbox };
    const fire = (el, val) => {
      el.focus(); el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    };
    if (inputs[0]) fire(inputs[0], 'Jane Doe');
    if (inputs[1]) fire(inputs[1], '2026/0713-K');
    if (textarea) fire(textarea, 'Multiline note line 1\nline 2 with Türkçe: ğüşiöç');
    if (checkbox) { checkbox.click(); }
    await sleep(300);
    results.formsDirty = tab.formsDirty;
    await window.native.testCapture(out('t2-forms-filled.png'));

    // 2b) search: "aardvark" appears twice on page 3
    await ctx.search.run('aardvark');
    results.search = {
      matches: ctx.search.matches.length,
      firstPage: ctx.search.matches[0]?.page ?? null,
    };
    await sleep(500);
    await window.native.testCapture(out('t2b-search.png'));
    ctx.search.close();

    // 2c) text-selection actions on page 3 (where search left us)
    tab.view.scrollToPage(3);
    await waitFor(() => tab.view.holders[2]?._rendered, 'tab1 p3');
    await sleep(300);
    const textLayer3 = tab.view.holders[2].querySelector('.textLayer');
    const spans = [...textLayer3.querySelectorAll('span')].filter((s) => s.textContent.trim().length > 5);
    results.selection = { spans: spans.length };
    if (spans.length) {
      results.selection.userSelect = getComputedStyle(spans[0]).userSelect;
      // select a span → highlight it
      const mkSel = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      };
      mkSel(spans[0]);
      const before = tab.edits.length;
      results.selection.highlights = addSelectionRects(tab, 'highlight');
      results.selection.highlightEditAdded =
        tab.edits.length === before + results.selection.highlights &&
        tab.edits[tab.edits.length - 1].kind === 'highlight';
      // select another span → edit its text (whiteout + pre-filled text box)
      mkSel(spans[1] || spans[0]);
      const selText = window.getSelection().toString().trim();
      const started = editTextFromSelection(tab);
      await sleep(300);
      // commit the pre-filled text box
      commitActiveTextEdits();
      await sleep(200);
      const textEdit = tab.edits.find((e) => e.kind === 'text' && e.page === 3);
      const whiteEdit = tab.edits.find((e) => e.kind === 'whiteout' && e.page === 3);
      results.selection.editText = {
        started,
        whiteoutAdded: !!whiteEdit,
        textPrefilled: !!textEdit && textEdit.text === selText,
        size: textEdit?.size ?? null,
      };
      await window.native.testCapture(out('t2c-selection-actions.png'));
    }

    // diagnostics: what's in annotationStorage, and what does pdf.js's own
    // saveDocument output contain before pdf-lib touches it?
    try {
      const all = tab.pdf.annotationStorage.getAll();
      results.storageEntries = all
        ? Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v?.value ?? v]))
        : null;
      const rawBytes = await tab.pdf.saveDocument();
      const { PDFDocument } = await import('pdf-lib');
      const rawLib = await PDFDocument.load(new Uint8Array(rawBytes));
      const rawForm = rawLib.getForm();
      results.pdfjsSavedValues = {
        name: rawForm.getTextField('client.name').getText() ?? null,
        notes: rawForm.getTextField('notes').getText() ?? null,
        retainer: rawForm.getCheckBox('retainer.signed').isChecked(),
      };
    } catch (e) { results.diagError = String(e); }

    // 3) save pipeline
    const bytes = await buildSavedPdf(tab);
    results.savedBytes = bytes.length;
    await window.native.writeFile(out('saved.pdf'), bytes);

    // 4) verify saved doc: redacted text gone, form values persisted
    const saved = await loadPdf(new Uint8Array(bytes));
    const p1 = await saved.getPage(1);
    const p1text = (await p1.getTextContent()).items.map((i) => i.str).join(' ');
    results.ssnRemoved = !p1text.includes('123-45-6789');
    results.page1TextLength = p1text.length;
    try {
      const { PDFDocument } = await import('pdf-lib');
      const savedLib = await PDFDocument.load(new Uint8Array(bytes));
      const savedForm = savedLib.getForm();
      results.savedFieldValues = {
        name: savedForm.getTextField('client.name').getText() ?? null,
        caseNo: savedForm.getTextField('case.number').getText() ?? null,
        retainer: savedForm.getCheckBox('retainer.signed').isChecked(),
        notes: savedForm.getTextField('notes').getText() ?? null,
      };
    } catch (e) { results.savedFieldError = String(e); }
    saved.destroy();

    // 5) open the saved file in a new tab and screenshot pages 1 and 3
    await ctx.openPaths([out('saved.pdf')]);
    const tab2 = ctx.getActive();
    await waitFor(() => tab2.view.holders[0]?._rendered, 'saved p1');
    await sleep(400);
    await window.native.testCapture(out('t3-saved-page1.png'));
    tab2.view.scrollToPage(2);
    await waitFor(() => tab2.view.holders[1]?._rendered, 'saved p2');
    await sleep(400);
    await window.native.testCapture(out('t4-saved-page2-forms.png'));
    {
      const h2 = tab2.view.holders[1];
      const ta = h2.querySelector('.annotationLayer textarea');
      results.notesTA = ta
        ? { inline: ta.style.fontSize, computed: getComputedStyle(ta).fontSize,
            sectionAttr: ta.closest('[data-annotation-id]')?.getAttribute('data-annotation-id') ?? 'none' }
        : 'no textarea found';
      const p2s = await tab2.pdf.getPage(2);
      const annots2 = await p2s.getAnnotations({ intent: 'display' });
      const notesA = annots2.find((a) => a.fieldName === 'notes');
      results.notesAnnot = notesA
        ? { id: notesA.id, fs: notesA.defaultAppearanceData?.fontSize,
            multiLine: notesA.multiLine, fieldType: notesA.fieldType }
        : 'not found';
    }
    tab2.view.scrollToPage(3);
    await waitFor(() => tab2.view.holders[2]?._rendered, 'saved p3');
    await sleep(400);
    await window.native.testCapture(out('t5-saved-page3.png'));

    // 6) split view + compare (saved.pdf in left pane vs sample.pdf right)
    ctx.toggleSplit();
    await sleep(700);
    const cmp = await ctx.runCompare();
    results.compare = cmp
      ? { hunks: cmp.hunks.length, identical: cmp.identical, tooDifferent: cmp.tooDifferent }
      : 'failed';
    await sleep(400);
    await window.native.testCapture(out('t6-split-compare.png'));
    document.getElementById('compare-close').click();
    ctx.toggleSplit();
    await sleep(300);

    // 7) structural ops on the saved doc: rotate p3, move p3 to front, delete the form page
    ctx.toggleSidebar();
    await ctx.ops.rotate(3);
    await ctx.ops.reorder(2, 0);
    await ctx.ops.del(3);
    const t2 = ctx.getActive();
    await waitFor(() => t2.view.holders[0]?._rendered, 'struct p1');
    await sleep(500);
    results.structural = {
      numPages: t2.pdf.numPages,
      page1Rotate: (await t2.pdf.getPage(1)).rotate,
      page1HasAardvark: (await t2.pdf.getPage(1).then((p) => p.getTextContent()))
        .items.map((i) => i.str).join(' ').includes('aardvark'),
      historyDepth: t2.history.length,
    };
    await window.native.testCapture(out('t7-organizer.png'));

    // 8) highlight + comment on page 2, save, verify a real /Text annotation exists
    t2.edits.push(
      { id: 9101, kind: 'highlight', page: 2, x: 55, y: 620, w: 330, h: 60 },
      { id: 9102, kind: 'note', page: 2, x: 500, yTop: 780, text: 'Gözden geçir: bu bölüm önemli.' },
    );
    t2.view.refreshEditLayer(2);
    const bytes2 = await buildSavedPdf(t2);
    await window.native.writeFile(out('saved2.pdf'), bytes2);
    const saved2 = await loadPdf(new Uint8Array(bytes2));
    const s2p2 = await saved2.getPage(2);
    const s2annots = await s2p2.getAnnotations({ intent: 'display' });
    const noteAnnot = s2annots.find((a) => a.subtype === 'Text');
    results.noteSaved = noteAnnot
      ? { contents: noteAnnot.contentsObj?.str ?? null, name: noteAnnot.name ?? null }
      : 'no Text annotation found';
    saved2.destroy();
    await ctx.openPaths([out('saved2.pdf')]);
    const tab3 = ctx.getActive();
    await waitFor(() => tab3.view.holders[0]?._rendered, 'saved2 p1');
    tab3.view.scrollToPage(2);
    await waitFor(() => tab3.view.holders[1]?._rendered, 'saved2 p2');
    await sleep(500);
    await window.native.testCapture(out('t8-highlight-note.png'));

    // 9) fonts + print preview (actual dispatch to a printer isn't driven —
    // everything up to the Print click is)
    results.fonts = { count: ctx.getFonts().length, names: ctx.getFonts().map((f) => f.name).slice(0, 5) };
    const pv = await openPrintPreview(tab3, () => {});
    const overlay = document.getElementById('print-overlay');
    const container = document.getElementById('print-container');
    results.print = {
      pages: pv.pages,
      printers: pv.printers,
      overlayVisible: !overlay.classList.contains('hidden'),
      images: container.querySelectorAll('.print-page img').length,
      firstImageBytes: document.getElementById('pp-page-img').src.length,
      pageInfo: document.getElementById('pp-pageinfo').textContent,
    };
    // saved2.pdf is a mixed-orientation doc: page 1 landscape (rotated
    // earlier), page 2 portrait. Auto orientation should pick a portrait
    // sheet and rotate page 1's image to fill it.
    results.print.mixed = await getPrintState();
    await sleep(400);
    await window.native.testCapture(out('t9-print-preview.png'));
    document.getElementById('pp-next').click();
    await sleep(300);
    results.print.pageInfo2 = document.getElementById('pp-pageinfo').textContent;
    closePrintPreview();
    results.print.closed = overlay.classList.contains('hidden') && container.children.length === 0;

    results.ok = true;
  } catch (e) {
    results.ok = false;
    results.error = String(e && e.stack || e);
    try {
      const t = ctx.getActive();
      const h0 = t?.view.holders[0];
      results.debug = t ? {
        holders: t.view.holders.length,
        h0: h0 ? {
          rendered: !!h0._rendered, rendering: !!h0._rendering,
          w: h0.style.width, children: h0.childNodes.length,
          inDoc: document.contains(h0),
        } : null,
        elW: t.view.el.clientWidth, elH: t.view.el.clientHeight,
        elClass: t.view.el.className, scale: t.view.scale,
      } : 'no active tab';
    } catch (e2) { results.debug = String(e2); }
  }
  results.logs = logs.slice(0, 30);
  if (!results.ok) results.trace = viewerDebug.slice(0, 120);
  const enc = new TextEncoder().encode(JSON.stringify(results, null, 2));
  await window.native.writeFile(out('test-results.json'), enc);
  await window.native.testQuit();
}
