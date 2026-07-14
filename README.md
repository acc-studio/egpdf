<p align="center"><img src="build/icon.png" width="100" alt="egPDF icon"></p>

<h1 align="center">egPDF</h1>

<p align="center">Minimal, fully local desktop PDF reader &amp; editor for Windows, macOS, and Linux.<br>
No network access, no accounts, no telemetry — your files never leave your machine.</p>

<p align="center">
  <a href="https://github.com/acc-studio/egpdf/actions/workflows/ci.yml"><img src="https://github.com/acc-studio/egpdf/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/acc-studio/egpdf/releases/latest"><img src="https://img.shields.io/github/v/release/acc-studio/egpdf" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

## Download

All versions are on the [releases page](https://github.com/acc-studio/egpdf/releases).

- **Windows** — [⬇ egPDF-Setup.exe](https://github.com/acc-studio/egpdf/releases/latest/download/egPDF-Setup.exe) (one-click installer, per-user, no admin rights)
- **macOS** — [⬇ egPDF.dmg](https://github.com/acc-studio/egpdf/releases/latest/download/egPDF.dmg)
- **Linux** — [⬇ egPDF.AppImage](https://github.com/acc-studio/egpdf/releases/latest/download/egPDF.AppImage)

> The Windows installer is not code-signed, so SmartScreen may warn — choose
> **More info → Run anyway**, or build from source below. macOS/Linux builds are
> likewise unsigned; macOS users may need to allow the app in **System
> Settings → Privacy & Security**, and Linux users may need to `chmod +x` the
> AppImage.

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
- **Text (T)** — click to add text. Font and size dropdowns appear in the toolbar; the list shows the fonts actually installed on your machine, and the chosen font is embedded (subset) into the PDF on save, Unicode included. Double-click to re-edit.
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

## Installer / packages

```
npm run dist
```

Builds a native package for the current platform (DMG on macOS, NSIS installer
on Windows, AppImage + deb on Linux). After installing on Windows, right-click
any PDF → **Open with → Choose another app → egPDF → Always** to make it the
default PDF app.
