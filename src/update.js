// Self-update UI (desktop only). All network access lives in the main process
// (main.js) — this module only drives the update banner and the About dialog,
// relaying user intent over the window.native.update bridge. The web build has
// no such bridge (native.update is null); there the update controls are hidden
// and only the version/About affordance remains.
export function initUpdates({ native, setStatus }) {
  const $ = (id) => document.getElementById(id);
  const upd = native.update || null;
  const banner = $('update-banner');
  const aboutPopup = $('about-popup');
  const versionBtn = $('status-version');
  let latest = null;          // last "available" info { version, htmlUrl, ... }
  let installingVersion = null;

  (async () => {
    const v = await native.getVersion?.();
    versionBtn.textContent = v ? `egPDF ${v}` : 'egPDF · web';
    $('about-version').textContent = v ? `Version ${v}` : 'Web version';
  })();

  const openAbout = () => aboutPopup.classList.remove('hidden');
  const closeAbout = () => aboutPopup.classList.add('hidden');
  const isAboutOpen = () => !aboutPopup.classList.contains('hidden');
  versionBtn.addEventListener('click', openAbout);
  $('about-close').addEventListener('click', closeAbout);
  aboutPopup.addEventListener('pointerdown', (e) => { if (e.target === aboutPopup) closeAbout(); });

  // web build: no updater — hide the checking/toggle section and the banner
  if (!upd) {
    banner.remove();
    $('about-updates').classList.add('hidden');
    return { openAbout, closeAbout, isAboutOpen };
  }

  const showBanner = (info) => {
    latest = info;
    $('update-msg').textContent = `egPDF ${info.version} is available.`;
    $('update-notes').classList.toggle('hidden', !info.htmlUrl);
    banner.classList.remove('hidden');
  };
  const hideBanner = () => banner.classList.add('hidden');

  upd.onAvailable(showBanner);
  upd.onProgress((pct) => {
    if (installingVersion != null) setStatus(`Downloading egPDF ${installingVersion}… ${pct}%`);
  });

  $('update-later').addEventListener('click', hideBanner);
  $('update-notes').addEventListener('click', () => {
    if (latest?.htmlUrl) native.openExternal?.(latest.htmlUrl);
  });

  async function install(info) {
    const btn = $('update-install');
    btn.disabled = true;
    installingVersion = info.version;
    try {
      setStatus(`Downloading egPDF ${info.version}…`);
      const filePath = await upd.download(info);
      setStatus('Starting the installer — egPDF will close…');
      await upd.install(filePath);
      // the app quits from the main process; reaching here means launch failed
    } catch (e) {
      setStatus(`Update failed: ${e.message || e}`, true);
    } finally {
      installingVersion = null;
      btn.disabled = false;
    }
  }
  $('update-install').addEventListener('click', () => { if (latest) install(latest); });

  // About dialog: auto-check toggle + manual check
  const autoBox = $('about-autocheck');
  (async () => { autoBox.checked = await upd.getAutoCheck(); })();
  autoBox.addEventListener('change', () => upd.setAutoCheck(autoBox.checked));

  const checkBtn = $('about-check');
  checkBtn.addEventListener('click', async () => {
    const st = $('about-check-status');
    checkBtn.disabled = true;
    st.textContent = 'Checking…';
    try {
      const res = await upd.check();
      if (res.available) {
        st.textContent = `egPDF ${res.version} is available.`;
        showBanner(res);
      } else {
        st.textContent = "You're on the latest version.";
      }
    } catch {
      st.textContent = 'Could not reach GitHub.';
    } finally {
      checkBtn.disabled = false;
    }
  });

  return { openAbout, closeAbout, isAboutOpen };
}
