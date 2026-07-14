// Web build: bundles the renderer with the browser bridge (src/web-main.js)
// and assembles a fully static site in web-dist/ — no server component, all
// processing stays in the browser. Deployable as-is (e.g. Vercel).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';

rmSync('web-dist', { recursive: true, force: true });
mkdirSync('web-dist/dist', { recursive: true });
mkdirSync('web-dist/src', { recursive: true });
mkdirSync('web-dist/tess/core', { recursive: true });

await build({
  entryPoints: ['src/web-main.js'],
  bundle: true,
  outfile: 'web-dist/dist/renderer.js',
  format: 'iife',
  platform: 'browser',
  target: ['chrome109', 'firefox115', 'safari16'],
  logLevel: 'info',
  minify: true,
});

// pdf.js worker + styles + annotation images (same layout as the desktop app)
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'web-dist/dist/pdf.worker.min.mjs');
cpSync('node_modules/pdfjs-dist/web/pdf_viewer.css', 'web-dist/dist/pdf_viewer.css');
cpSync('node_modules/pdfjs-dist/web/images', 'web-dist/dist/images', { recursive: true });
cpSync('src/styles.css', 'web-dist/src/styles.css');

// bundled fonts (open-licensed; license files ship alongside)
cpSync('web/fonts', 'web-dist/fonts', { recursive: true });

// OCR: language models + tesseract worker + wasm cores (LSTM variants only —
// that's the engine mode the app uses)
cpSync('vendor/tessdata', 'web-dist/tessdata', { recursive: true });
cpSync('node_modules/tesseract.js/dist/worker.min.js', 'web-dist/tess/worker.min.js');
for (const f of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  cpSync(`node_modules/tesseract.js-core/${f}`, `web-dist/tess/core/${f}`);
}

// index.html: same markup as the desktop app, with a web CSP (wasm for the
// OCR engine, workers, same-origin fetches) and @font-face for the bundled
// faces so on-page previews use them too.
let html = readFileSync('index.html', 'utf8');
html = html.replace(
  /content="default-src[^"]*"/,
  'content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; worker-src \'self\' blob:; connect-src \'self\' data: blob:"',
);
html = html.replace('</head>', `  <style>
    @font-face { font-family: "Liberation Sans"; src: url("fonts/LiberationSans-Regular.ttf"); }
    @font-face { font-family: "Liberation Serif"; src: url("fonts/LiberationSerif-Regular.ttf"); }
    @font-face { font-family: "Liberation Mono"; src: url("fonts/LiberationMono-Regular.ttf"); }
  </style>
</head>`);
writeFileSync('web-dist/index.html', html);

console.log('web build ok → web-dist/');
