// Web build: bundles the renderer with the browser bridge (src/web-main.js)
// and assembles a fully static site in web-dist/ — no server component, all
// processing stays in the browser. Deployable as-is (e.g. Vercel).
//
// `node build-web.mjs --extension` builds the same app as the browser
// extension's viewer page instead: src/ext-main.js as entry, output in
// extension/viewer/, no meta CSP (the manifest's extension_pages CSP applies).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';

const EXT = process.argv.includes('--extension');
const OUT = EXT ? 'extension/viewer' : 'web-dist';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/dist`, { recursive: true });
mkdirSync(`${OUT}/src`, { recursive: true });
mkdirSync(`${OUT}/tess/core`, { recursive: true });

await build({
  entryPoints: [EXT ? 'src/ext-main.js' : 'src/web-main.js'],
  bundle: true,
  outfile: `${OUT}/dist/renderer.js`,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109', 'firefox115', 'safari16'],
  logLevel: 'info',
  minify: true,
});

// pdf.js worker + styles + annotation images (same layout as the desktop app)
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', `${OUT}/dist/pdf.worker.min.mjs`);
cpSync('node_modules/pdfjs-dist/web/pdf_viewer.css', `${OUT}/dist/pdf_viewer.css`);
cpSync('node_modules/pdfjs-dist/web/images', `${OUT}/dist/images`, { recursive: true });
cpSync('src/styles.css', `${OUT}/src/styles.css`);

// bundled fonts (open-licensed; license files ship alongside)
cpSync('web/fonts', `${OUT}/fonts`, { recursive: true });

// OCR: language models + tesseract worker + wasm cores (LSTM variants only —
// that's the engine mode the app uses)
cpSync('vendor/tessdata', `${OUT}/tessdata`, { recursive: true });
// OCR-repair word lists (license file ships alongside)
cpSync('vendor/dict', `${OUT}/dict`, { recursive: true });
cpSync('node_modules/tesseract.js/dist/worker.min.js', `${OUT}/tess/worker.min.js`);
for (const f of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  cpSync(`node_modules/tesseract.js-core/${f}`, `${OUT}/tess/core/${f}`);
}

// index.html: same markup as the desktop app, with a web CSP (wasm for the
// OCR engine, workers, same-origin fetches) and @font-face for the bundled
// faces so on-page previews use them too. The extension viewer drops the meta
// CSP: extension pages are governed by the manifest's CSP, and the viewer must
// be able to fetch the PDF it was asked to show.
let html = readFileSync('index.html', 'utf8');
html = EXT
  ? html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '')
  : html.replace(
    /content="default-src[^"]*"/,
    'content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; worker-src \'self\' blob:; connect-src \'self\' data: blob:"',
  );
html = html.replace('</head>', `  <style>
    @font-face { font-family: "Liberation Sans"; src: url("fonts/LiberationSans-Regular.ttf"); }
    @font-face { font-family: "Liberation Serif"; src: url("fonts/LiberationSerif-Regular.ttf"); }
    @font-face { font-family: "Liberation Mono"; src: url("fonts/LiberationMono-Regular.ttf"); }
  </style>
</head>`);
if (EXT) html = html.replace('<title>egPDF</title>', '<title>egPDF</title>\n  <link rel="icon" href="../icons/icon48.png" />');
writeFileSync(`${OUT}/index.html`, html);

console.log(`${EXT ? 'extension viewer' : 'web'} build ok → ${OUT}/`);
