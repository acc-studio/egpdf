<p align="center"><img src="build/icon.png" width="100" alt="egPDF icon"></p>

<h1 align="center">egPDF</h1>

<p align="center">Minimal, fully local desktop PDF reader &amp; editor for Windows.<br>
No network access, no accounts, no telemetry — your files never leave your machine.</p>

<p align="center">
  <a href="https://github.com/acc-studio/egpdf/actions/workflows/ci.yml"><img src="https://github.com/acc-studio/egpdf/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/acc-studio/egpdf/releases/latest"><img src="https://img.shields.io/github/v/release/acc-studio/egpdf" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

## Download

### [⬇ Download egPDF for Windows](https://github.com/acc-studio/egpdf/releases/latest/download/egPDF-Setup.exe)

One-click installer, per-user, no admin rights needed. All versions are on the
[releases page](https://github.com/acc-studio/egpdf/releases).

> The installer is not code-signed, so Windows SmartScreen may show a warning —
> choose **More info → Run anyway**, or build from source below.

## Screenshots

| Viewing & editing | Split view + compare | Print preview |
| --- | --- | --- |
| ![Viewer with highlight and text edit](docs/screenshot-viewer.png) | ![Two documents compared side by side](docs/screenshot-compare.png) | ![M365-style print preview](docs/screenshot-print.png) |

## Viewing

- **Tabs** — open many PDFs (drag & drop anywhere, `Ctrl+O`, middle-click a tab to close, `Ctrl+Tab` to switch).
- **Clean viewer** — continuous scroll, fit-width, zoom (`Ctrl`+wheel / `Ctrl+=` / `Ctrl+-` / `Ctrl+0`), text selection, search (`Ctrl+F`).
- **Split view** — the split button shows two documents side by side; click a pane to focus it, then pick a tab for it.
- **Compare** — with two documents in split view, the compare button diffs their text word-by-word; click a difference to jump both panes to it.
- **Pages panel** — the sidebar button shows page thumbnails: drag to reorder, hover a page to rotate 90° or delete it. `Ctrl+Z` undoes page changes.
- **Text selection** — select text with the mouse to copy it, or use the popup that appears: **Highlight**, **Edit text** (whites out the selection and opens a pre-filled, size-matched text box to retype), or **Redact**.
- **Print (Ctrl+P)** — opens an M365-style print screen: settings panel (printer, copies, page range, one/two-sided, collation, orientation, paper size, color, fit/actual size) beside a live page preview with navigation and zoom. Prints the document exactly as saving would produce it: form values, highlights, comments, added text/images, and true redactions all included (pages rendered at 150 dpi through the save pipeline).

## Editing (applied on Save)

- **Redact (R)** — drag a box; on save the page is re-rendered to an image with the box burned in, so the underlying text is *actually removed* from the file.
- **Whiteout (W)** — cover an area with white.
- **Highlight (H)** — translucent yellow marker.
- **Text (T)** — click to add text. Font and size dropdowns appear in the toolbar (native Windows fonts: Arial, Calibri, Georgia, Times New Roman, Segoe UI, Verdana, …); the chosen font is embedded (subset) into the PDF on save, Unicode included. Double-click to re-edit.
- **Image (I)** — insert PNG/JPEG, drag to move, corner handle to resize.
- **Comment (C)** — click to attach a sticky-note; saved as a real PDF annotation visible in any viewer.
- **Select (V)** — move/resize/delete edits (`Del`), undo (`Ctrl+Z`).
- **PDF forms** — fillable text boxes and checkboxes render as native inputs; values are written back into the file on save.

Save with `Ctrl+S`, Save As with `Ctrl+Shift+S`; dirty tabs show a `•`.

## Run from source

```
npm install
npm start
```

## Testing

```
npm test              # e2e suite against the dev build
npm run test:packaged # packages the app (electron-builder --dir) and runs the same suite against the real .exe
```

The app has a hidden `--autotest=<dir>` mode that drives a full scenario against a generated
fixture PDF (`test/make-sample.mjs`): edit tools, true redaction, form filling with Turkish text,
search, split-view compare, page rotate/reorder/delete, comments — then saves, reopens the result,
and records assertions plus screenshots to `test/.out/<mode>/`. `test/run.mjs` launches it and
verifies 16 checks; nonzero exit on any failure.

CI: `.github/workflows/ci.yml` runs both suites on every push (windows-latest), builds the
installer, and uploads it and the test screenshots as artifacts.

## Installer (+ .pdf file association)

```
npm run dist
```

Produces `release/egPDF Setup <version>.exe`. After installing, right-click any PDF →
**Open with → Choose another app → egPDF → Always** (or Settings → Apps → Default apps) to make it the default PDF app.

## App icon

`build/icon.png` is generated from the SVG in `build/icon-gen.cjs` (brand palette: Banner Red
#CB2128, Cuban Ochre #E0A126, Petrol Teal #15706E, Pitch Green #3F7A3B, Warm Ink #1B1714,
Recycled-paper cream #FBF6EC). Regenerate with:

```
npx electron build/icon-gen.cjs
```

## Notes

- Redacting a page flattens that page to an image (its form fields are removed by design).
- Compare is text-based; images and formatting are not compared.
- Page reorder/rotate/delete are applied immediately in the tab but only written to disk on Save.
