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
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
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

let exe, exeArgs;
if (packaged) {
  run('npx', ['electron-builder', '--win', '--dir']);
  exe = path.join(rootDir, 'release', 'win-unpacked', 'egPDF.exe');
  exeArgs = [];
  if (!existsSync(exe)) {
    console.error('packaged exe not found: ' + exe);
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
