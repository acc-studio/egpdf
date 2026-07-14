# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

egPDF is a minimal, fully-local PDF reader/editor (Electron desktop + static web build). Privacy is a hard constraint: documents must never leave the machine — no network calls, no telemetry, no server component. OCR, fonts, and spellcheck all run locally.

## Commands

```
npm run build          # esbuild bundle: src/renderer.js → dist/renderer.js
npm start              # build + run the Electron app
npm test               # e2e suite against dev electron (test/run.mjs)
npm run test:packaged  # same suite against a real packaged .exe (electron-builder --dir)
npm run dist           # native installer for current platform → release/
node build-web.mjs     # static web build → web-dist/ (deployed to egpdf.vercel.app)
```

There is no lint/typecheck step and no unit tests. The test suite is one monolithic e2e scenario: `test/run.mjs` builds, generates a fixture (`test/make-sample.mjs`), launches the app with `--autotest=<dir>`, and the app drives itself via `src/autotest.js`, writing `test-results.json` + screenshots to `test/.out/<mode>/`. Individual checks cannot be run in isolation — to add coverage, extend the scenario in `src/autotest.js` and add a matching assertion to the `checks` array in `test/run.mjs`.

## Architecture

Two build targets share one renderer codebase; the split point is the `window.native` bridge:

- **Desktop**: `main.js` (Electron main: windows, dialogs, file IO, font path resolution, Tesseract OCR, printers, single-instance lock) + `preload.js` (exposes `window.native` via contextBridge, incl. the OS spellchecker probe) + `index.html` + `dist/renderer.js`.
- **Web**: `src/web-main.js` installs `src/native-web.js` as `window.native` (File System Access API, bundled Liberation fonts, tesseract.js in a Web Worker), then dynamically imports the same `renderer.js`. `build-web.mjs` assembles the static site and rewrites the CSP in `index.html`. Web has no spellcheck-repair stage (that needs the OS dictionary).

Renderer modules (all bundled by esbuild, pdf.js for viewing / pdf-lib for writing):

- `src/renderer.js` — app shell: tabs, split view, toolbar wiring.
- `src/viewer.js` — pdf.js document/page rendering, text layer, zoom (persisted in localStorage under `egpdf.zoom`).
- `src/edits.js` — edit model. Edits are stored per-tab in **PDF user-space coordinates** (origin bottom-left, points) so they survive zoom; kinds: redact, whiteout, highlight, text, image, note. Nothing touches the file until save.
- `src/save.js` — the save pipeline (see gotchas) plus structural page ops (reorder/rotate/delete) and `makeFontLoader` (per-family TTF subset embedding with cache).
- `src/ocr.js` / `src/ocrbox.js` — full-page OCR (invisible text layer written into the PDF) and area OCR (popup text only); `ocrbox.js` also holds the conservative text-cleanup pass (ligatures, merged words, hyphenation, image preprocessing) shared by both.
- `src/spellfix.js` — dictionary-backed OCR spelling repair: bundled tr+en frequency lists (`vendor/dict`, loaded via the `dictText` bridge so it works on desktop *and* web) generate candidate corrections, but a candidate is only ever accepted when it differs from the OCR output purely by known glyph confusions (`CONFUSION_PAIRS`) — **a fix must never change what the page visually says**; keep that invariant when touching anything here. The OS spellchecker (desktop only) is a fallback candidate source behind the same gate.
- `src/print.js` — renders pages at print DPI **through the save pipeline** (so redactions/forms/edits print exactly as saved), M365-style preview, silent `webContents.print`.
- `src/search.js`, `src/compare.js` (word-level Myers diff), `src/organizer.js` (thumbnail sidebar), `src/fonts.js`, `src/icons.js`.

## Save-pipeline gotchas (breakage-prone, verified by the test suite)

- Form values are saved via pdf.js `saveDocument()` **first** (writes appearance streams), then pdf-lib applies edits. pdf-lib must save with `{ updateFieldAppearances: false }` — otherwise it re-encodes appearances in WinAnsi and throws on Turkish characters.
- True redaction rasterizes the page at 300 dpi via pdf.js with boxes burned in, then replaces the page in pdf-lib; AcroForm fields on that page must be removed first.
- Unicode text needs an embedded TTF via @pdf-lib/fontkit (subset). Only plain `.ttf` files embed — `.ttc` collections (macOS Helvetica/Times, Windows Cambria) cannot, and are filtered out by the availability probe in `main.js`.
- Comments are real low-level `/Text` annotation dicts (visible in Acrobat); highlights are drawn rects with Multiply blend.
- Structural ops bake form values first, remap overlay-edit page numbers, and keep a 5-deep bytes history for Ctrl+Z.

## OCR gotchas

- `vendor/tessdata` holds **tessdata_best_int** (integerized best) models for tur/eng/ara/deu. Do NOT swap in float `tessdata_best` models: the tesseract.js WASM cores abort at recognition time with `missing function: DotProductSSE` — they only support integer LSTM models, and in Node the core choice ignores `legacyCore` (picked purely by OEM). Source for updates: `https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int/<lang>.traineddata.gz`.
- `vendor/dict/{tr,de,ar}.txt` are CC-BY-SA-4.0 (FrequencyWords/OpenSubtitles); the attribution file `LICENSE-dictionaries.txt` must ship alongside them (both desktop and `web-dist/dict`). The subtitle corpora contain typos in their frequency tail — that's why `spellfix.js` has SOLID_FREQ/BOOST thresholds; don't remove them.
- The invisible OCR text layer picks a font per word by glyph coverage (`pickFont` in `ocr.js`) — Arabic needs this because Liberation (web) and the Linux stand-ins have no Arabic glyphs; the web bundle ships Noto Sans Arabic for it.
- A gated local-LLM refinement stage (node-llama-cpp + Qwen3-0.6B) was built and **removed on 2026-07-14 at the owner's request** after measurement: the 0.6B model missed Turkish OCR errors, proposed rewrites the confusion gate had to block, and cost 7–20s/sentence on CPU — while any fix that passes the gate is already reachable by the dictionary corrector. Don't re-add an LLM stage without new evidence (a larger model changes the economics, not the structural redundancy).

## Chromium gotchas (found by testing — don't "simplify" these away)

- Detaching an IntersectionObserver's root (even `appendChild` back into the same parent) permanently kills it — `DocView.attachTo` rebuilds the observer.
- rAF + IntersectionObserver stop when the window is occluded — hence `backgroundThrottling: false`, setTimeout-based renderVisible fallbacks, and retry-on-aborted-render (epoch check) in renderPage.

## Release & deploy

- **Desktop**: pushing a `v*` tag runs CI (`.github/workflows/ci.yml`: Windows/macOS/Linux matrix, both test suites, installers) and publishes a GitHub Release. Release assets keep version-independent names (`egPDF-Setup.exe`, `egPDF.dmg`, `egPDF.AppImage`) — the README's `latest/download` links depend on this; never rename them.
- **Web**: pushes to `main` auto-deploy to Vercel (egpdf.vercel.app) via `vercel.json` (`node build-web.mjs` → `web-dist/`, `npm install --ignore-scripts`). `.vercelignore` excludes build outputs and `*.pdf`; if a new asset directory doesn't reach the deploy, check it isn't ignored there.
- Version lives in `package.json`; bump it before tagging.

## Windows dev environment notes

- Never round-trip source files or test JSON through PowerShell 5.1 `Get-Content`/`Set-Content` — it corrupts UTF-8 (Turkish characters). Read results with `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)` or use the dedicated file tools.
- `--autotest` mode skips the single-instance lock, so tests run fine while a normal egPDF instance is open. Sandboxed preloads don't see app argv — test config reaches the renderer via IPC (`test:config`).
