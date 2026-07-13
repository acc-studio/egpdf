import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/renderer.js'],
  bundle: true,
  outfile: 'dist/renderer.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome126',
  logLevel: 'info',
});

cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
cpSync('node_modules/pdfjs-dist/web/pdf_viewer.css', 'dist/pdf_viewer.css');
cpSync('node_modules/pdfjs-dist/web/images', 'dist/images', { recursive: true });
console.log('build ok');
