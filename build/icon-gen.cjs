// Renders the app icon SVG to a transparent 512x512 PNG via offscreen Electron.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

const OUT = process.env.ICON_OUT || 'build/icon.png';

const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="s" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#1B1714" flood-opacity="0.30"/>
    </filter>
  </defs>
  <g filter="url(#s)">
    <path d="M140 58 H310 L394 142 V432 Q394 454 372 454 H140 Q118 454 118 432 V80 Q118 58 140 58 Z" fill="#FBF6EC"/>
    <path d="M310 58 L394 142 H332 Q310 142 310 120 Z" fill="#E0A126"/>
  </g>
  <rect x="152" y="150" width="120" height="14" rx="7" fill="#1B1714" opacity="0.85"/>
  <rect x="152" y="196" width="200" height="26" rx="7" fill="#CB2128"/>
  <rect x="152" y="258" width="200" height="14" rx="7" fill="#1B1714" opacity="0.85"/>
  <rect x="152" y="304" width="132" height="26" rx="7" fill="#15706E"/>
  <rect x="152" y="366" width="168" height="14" rx="7" fill="#1B1714" opacity="0.85"/>
  <rect x="152" y="408" width="84" height="14" rx="7" fill="#3F7A3B"/>
</svg>`;

const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512, height: 512, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('icon written:', OUT, img.getSize());
  app.quit();
});
