// Android build: web layer → Capacitor sync → Gradle → release/egPDF.apk
//
//   node scripts/android.mjs           # signed release APK → release/egPDF.apk
//   node scripts/android.mjs --debug   # debug APK (debug-signed) → release/egPDF-debug.apk
//
// Needs JDK 21 and the Android SDK (platform 36). They're found via JAVA_HOME /
// ANDROID_HOME, falling back to ~/.android-tools/{jdk-21*,sdk}. A release build
// is signed with the key named in android/keystore.properties (gitignored —
// the key itself lives outside the repo). Without it Gradle produces an
// unsigned APK, which Android won't install.
import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug');
const win = process.platform === 'win32';

const tools = path.join(os.homedir(), '.android-tools');
const env = { ...process.env };
if (!env.JAVA_HOME && existsSync(tools)) {
  const jdk = readdirSync(tools).find((d) => /^jdk-21/.test(d));
  if (jdk) env.JAVA_HOME = path.join(tools, jdk);
}
if (!env.ANDROID_HOME && existsSync(path.join(tools, 'sdk'))) env.ANDROID_HOME = path.join(tools, 'sdk');
if (!env.JAVA_HOME) { console.error('JDK 21 not found — set JAVA_HOME'); process.exit(1); }
if (!env.ANDROID_HOME) { console.error('Android SDK not found — set ANDROID_HOME'); process.exit(1); }

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: win });
  if (r.status !== 0) { console.error(`\nFAILED: ${cmd} ${args.join(' ')}`); process.exit(r.status ?? 1); }
}

run('node', ['build-web.mjs', '--android']);
run('npx', ['cap', 'sync', 'android']);
run(path.join(root, 'android', win ? 'gradlew.bat' : 'gradlew'), [debug ? 'assembleDebug' : 'assembleRelease'], path.join(root, 'android'));

const variant = debug ? 'debug' : 'release';
const built = path.join(root, 'android/app/build/outputs/apk', variant, `app-${variant}.apk`);
if (!existsSync(built)) {
  console.error(`no APK at ${built} — is android/keystore.properties set up for release signing?`);
  process.exit(1);
}
mkdirSync(path.join(root, 'release'), { recursive: true });
const staged = path.join(root, 'release', debug ? 'egPDF-debug.apk' : 'egPDF.apk');
copyFileSync(built, staged);
console.log(`\nAPK → ${path.relative(root, staged)}`);
