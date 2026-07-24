// End-to-end test runner.
//
//   node test/run.mjs              — build renderer, run suite via dev electron
//   node test/run.mjs --packaged   — package the app (electron-builder --dir)
//                                    and run the same suite against the .exe
//
// The app itself drives the scenario (src/autotest.js) and writes
// test-results.json + screenshots into test/.out/<mode>/; this script launches
// it, then asserts on the results. Exit code 0 = all green.
import { spawnSync, spawn } from 'child_process';
import { mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const mode = packaged ? 'packaged' : 'dev';
const outDir = path.join(rootDir, 'test', '.out', mode);
const TIMEOUT_MS = 240_000;

const run = (cmd, args) => {
  // npx is a .cmd shim on Windows and needs a shell; node does not.
  const shell = cmd === 'npx' && process.platform === 'win32';
  const r = spawnSync(cmd, args, { cwd: rootDir, stdio: 'inherit', shell });
  if (r.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`\n=== egPDF e2e suite (${mode}) ===\n`);
run('node', ['build.mjs']);

// Locate the unpacked app binary electron-builder --dir produces. The output
// folder name carries an arch suffix on non-default architectures (e.g.
// mac-arm64, win-arm64-unpacked), so scan rather than hardcode it.
function findPackagedExe() {
  const releaseDir = path.join(rootDir, 'release');
  const entries = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  if (process.platform === 'win32') {
    const dir = entries.find((d) => /^win(-\w+)?-unpacked$/.test(d));
    return dir ? path.join(releaseDir, dir, 'egPDF.exe') : null;
  }
  if (process.platform === 'darwin') {
    const dir = entries.find((d) => /^mac(-\w+)?$/.test(d));
    return dir ? path.join(releaseDir, dir, 'egPDF.app', 'Contents', 'MacOS', 'egPDF') : null;
  }
  const dir = entries.find((d) => /^linux(-\w+)?-unpacked$/.test(d));
  return dir ? path.join(releaseDir, dir, 'egpdf') : null;
}

let exe, exeArgs;
if (packaged) {
  run('npx', ['electron-builder', '--dir']);
  exe = findPackagedExe();
  exeArgs = [];
  if (!exe || !existsSync(exe)) {
    console.error('packaged exe not found: ' + (exe || '(no matching release/ dir)'));
    process.exit(1);
  }
} else {
  exe = require('electron'); // path to electron binary
  exeArgs = ['.'];
}

const samplePath = path.join(outDir, 'sample.pdf');
run('node', [path.join('test', 'make-sample.mjs'), samplePath]);

console.log('\nlaunching app…');
const args = [...exeArgs, samplePath, `--autotest=${outDir}`];
if (process.env.CI) args.push('--disable-gpu');
// GitHub-hosted Linux runners don't have chrome-sandbox installed setuid-root,
// which makes Chromium abort on launch; --no-sandbox is safe for a CI test run.
if (process.env.CI && process.platform === 'linux') args.push('--no-sandbox');
const child = spawn(exe, args, { cwd: rootDir, stdio: 'inherit' });

const exited = await new Promise((resolve) => {
  const killer = setTimeout(() => {
    console.error(`app did not finish within ${TIMEOUT_MS / 1000}s — killing`);
    child.kill('SIGKILL');
    resolve(false);
  }, TIMEOUT_MS);
  child.on('exit', () => { clearTimeout(killer); resolve(true); });
});

const resultsPath = path.join(outDir, 'test-results.json');
if (!exited || !existsSync(resultsPath)) {
  console.error('no test-results.json produced — app crashed or hung');
  process.exit(1);
}
const r = JSON.parse(readFileSync(resultsPath, 'utf8'));

const checks = [
  ['scenario completed', r.ok === true, r.error],
  ['form widgets rendered', r.formWidgets?.texts === 2 && r.formWidgets?.textarea === true && r.formWidgets?.checkbox === true],
  ['redaction removed text from file', r.ssnRemoved === true],
  ['form text value saved', r.savedFieldValues?.name === 'Jane Doe'],
  ['form case number saved', r.savedFieldValues?.caseNo === '2026/0713-K'],
  ['form checkbox saved', r.savedFieldValues?.retainer === true],
  ['form unicode (Turkish) saved', (r.savedFieldValues?.notes || '').includes('Türkçe: ğüşiöç')],
  ['multiline auto-font capped', String(r.notesTA?.inline || '').includes('11px')],
  ['multiline DA fixed in file', r.notesAnnot?.fs === 11],
  ['search finds 3 hits on page 3', r.search?.matches === 3 && r.search?.firstPage === 3],
  ['compare finds the difference', r.compare?.hunks >= 1 && r.compare?.tooDifferent === false],
  ['page delete', r.structural?.numPages === 2],
  ['page rotate 90°', r.structural?.page1Rotate === 90],
  ['page reorder', r.structural?.page1HasAardvark === true],
  ['structural undo history kept', r.structural?.historyDepth === 3],
  ['comment saved as /Text annotation', r.noteSaved?.contents === 'Gözden geçir: bu bölüm önemli.'],
  ['text layer is selectable', r.selection?.userSelect === 'text'],
  ['selection → highlight', r.selection?.highlights >= 1 && r.selection?.highlightEditAdded === true],
  ['selection → edit text (whiteout + prefill)', r.selection?.editText?.whiteoutAdded === true && r.selection?.editText?.textPrefilled === true],
  ['system fonts detected', r.fonts?.count >= 3],
  ['print preview opens with pages', r.print?.pages === 2 && r.print?.images === 2 && r.print?.overlayVisible === true && r.print?.firstImageBytes > 10_000],
  ['print preview shows "1 of 2"', r.print?.pageInfo === '1 of 2'],
  ['print preview navigation', r.print?.pageInfo2 === '2 of 2'],
  ['print preview closes cleanly', r.print?.closed === true],
  ['mixed orientation: auto sheet + rotation',
    r.print?.mixed?.orientations?.[0] === true && r.print?.mixed?.orientations?.[1] === false
    && r.print?.mixed?.sheetLandscape === false && r.print?.mixed?.page1Rotated === true],
  ['OCR: scan page starts with no text', r.ocr?.preTextItems === 0],
  ['OCR: Turkish + English text recognized',
    r.ocr?.turkishFound === true && r.ocr?.englishFound === true && r.ocr?.yearFound === true],
  ['OCR: recognized text is searchable', r.ocr?.searchMatches >= 1],
  ['OCR area: box text extracted, document untouched',
    r.ocrBox?.turkish === true && r.ocrBox?.english === true && r.ocrBox?.editsUntouched === true],
  ['OCR area: popup opens and closes', r.ocrBox?.popupVisible === true && r.ocrBox?.popupClosed === true],
  ['OCR cleanup: merged words split', r.ocrClean?.merged === 'kelime Başka'],
  ['OCR cleanup: punctuation spacing', r.ocrClean?.punct === 'Ancak, davacı'],
  ['OCR cleanup: abbreviations & case numbers untouched',
    r.ocrClean?.abbrev === 'T.C.' && r.ocrClean?.caseNo === '2026/713-K'],
  ['OCR cleanup: ligatures + line-end hyphenation',
    r.ocrClean?.ligature === 'finans' && r.ocrClean?.hyphen === 'kelimeler\ndevamı'],
  ['OCR popup: wrapped lines unwrapped, paragraphs kept',
    r.ocrClean?.unwrap === 'Bu kelimeler uzun\n\nYeni paragraf'],
  ['OCR spellfix: confusion matcher accepts g↔q, rejects other edits',
    r.ocrSpell?.confusion === true && r.ocrSpell?.notConfusion === false],
  ['OCR spellfix: reguested → requested (bundled dictionary)', r.ocrSpell?.fixed === 'requested'],
  ['OCR spellfix: Turkish diacritics restored (davaci → davacı)', r.ocrSpell?.turkish === 'davacı'],
  ['OCR spellfix: German (Gerlcht → Gericht)', r.ocrSpell?.german === 'Gericht'],
  ['OCR spellfix: Arabic dot confusion repaired', r.ocrSpell?.arabic === 'مستشفى'],
  ['OCR spellfix: valid words untouched',
    r.ocrSpell?.validKept === 'document' && r.ocrSpell?.turkishSolid === 'mahkeme'],
  ['OCR selection geometry: words do not overlap', (r.ocr?.maxOverlap ?? 1) < 0.15],
  ['OCR text layer: whole lines are single text items', r.ocr?.lineItems >= 2],
  ['zoom: typed percentage applies', r.zoom?.typedScale === 1.5 && r.zoom?.label === '150%'],
  ['zoom: preference persisted', r.zoom?.pref?.scale === 1.5],
  ['zoom: remembered for later documents', r.zoom?.newTabScale === 1.5 && r.zoom?.newTabFit === false],
  ['combine: pages copied across documents', r.combine?.pages === 3],
  ['combine: edits before the insertion point keep their page', r.combine?.mapBefore === 1],
  ['combine: overlay shows a column per open document, closes cleanly',
    r.combine?.columns >= 2 && r.combine?.closed === true],
  ['combine: header click renders a preview', r.combine?.previewCanvases >= 1],
  ['combine: drop copies a page in, leaves the source untouched',
    r.combine?.insert?.grew === true && r.combine?.insert?.sourceUntouched === true],
  ['combine: Ctrl+Z undoes a combine', r.combine?.undoRestored === true],
];

console.log('');
let failed = 0;
for (const [name, pass, extra] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && extra ? '  — ' + extra : ''}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed (${mode}). Screenshots: ${outDir}`);
if (failed) {
  console.error('\nresults dump:\n' + JSON.stringify(r, null, 2));
  process.exit(1);
}
