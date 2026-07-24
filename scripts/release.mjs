// Local release pipeline — replaces GitHub Actions (Actions is no longer
// available on this account). Builds the installer for the CURRENT platform and
// publishes it to a GitHub Release under a version-independent asset name, so
// the README's `latest/download` links keep working. Run it on Windows to ship
// egPDF-Setup.exe; run it on macOS/Linux to add those platforms' assets to the
// same release.
//
//   node scripts/release.mjs               # test → build → tag → publish
//   node scripts/release.mjs --skip-tests  # skip the e2e suite (faster)
//   node scripts/release.mjs --dry-run     # build + stage only; no tag/publish
//
// Prerequisites: git with push access, and the GitHub CLI authenticated
// (`gh auth login`). Bump "version" in package.json before running.
import { spawnSync } from 'child_process';
import { readFileSync, copyFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const skipTests = argv.includes('--skip-tests');
const dryRun = argv.includes('--dry-run');

// npm/npx/gh are .cmd shims on Windows and need a shell; git is a real exe.
const needsShell = (cmd) => process.platform === 'win32' && ['npm', 'npx', 'gh'].includes(cmd);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: needsShell(cmd) });
  if (r.status !== 0) { console.error(`\nFAILED: ${cmd} ${args.join(' ')}`); process.exit(r.status ?? 1); }
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: needsShell(cmd) });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = `v${pkg.version}`;

const PLATFORM = {
  win32: { glob: /^egPDF Setup .*\.exe$/, staged: 'egPDF-Setup.exe' },
  darwin: { glob: /\.dmg$/, staged: 'egPDF.dmg' },
  linux: { glob: /\.AppImage$/, staged: 'egPDF.AppImage' },
}[process.platform];
if (!PLATFORM) { console.error(`unsupported platform: ${process.platform}`); process.exit(1); }

console.log(`\n=== egPDF release ${tag} (${process.platform}) ===\n`);

// 1) sanity checks
if (!dryRun && capture('git', ['status', '--porcelain']).out) {
  console.error('working tree is not clean — commit or stash first.');
  process.exit(1);
}
const releaseExists = capture('gh', ['release', 'view', tag, '--json', 'tagName']).ok;

// 2) tests
if (skipTests) console.log('(skipping tests)\n');
else run('npm', ['test']);

// 3) build the installer for this platform
run('npm', ['run', 'dist']);

// 4) stage under the version-independent name the README links depend on
const releaseDir = path.join(root, 'release');
const built = readdirSync(releaseDir).find((f) => PLATFORM.glob.test(f));
if (!built) { console.error(`no artifact matching ${PLATFORM.glob} in release/`); process.exit(1); }
const stagedPath = path.join(releaseDir, PLATFORM.staged);
copyFileSync(path.join(releaseDir, built), stagedPath);
console.log(`\nstaged ${built} → ${PLATFORM.staged}`);

if (dryRun) { console.log('\n--dry-run: not tagging or publishing.'); process.exit(0); }

// 5) tag (create + push if it doesn't exist yet)
if (capture('git', ['tag', '--list', tag]).out !== tag) {
  run('git', ['tag', tag]);
  run('git', ['push', 'origin', tag]);
} else {
  console.log(`tag ${tag} already exists — reusing it.`);
}

// 6) publish the release, or add/replace this platform's asset on an existing one
if (releaseExists) {
  console.log(`release ${tag} exists — uploading ${PLATFORM.staged} (clobber).`);
  run('gh', ['release', 'upload', tag, stagedPath, '--clobber']);
} else {
  run('gh', ['release', 'create', tag, stagedPath, '--title', tag, '--generate-notes']);
}

console.log(`\n✔ published ${tag} with ${PLATFORM.staged}`);
console.log('  (the web build deploys separately via Vercel on push to main)');
