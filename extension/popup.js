const DEFAULTS = { intercept: true };

(async function () {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };

  for (const key of Object.keys(DEFAULTS)) {
    const el = document.getElementById(key);
    el.checked = !!settings[key];
    el.addEventListener('change', () => chrome.storage.local.set({ [key]: el.checked }));
  }

  // Local file:// PDFs only reach the extension once the user grants access.
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  document.getElementById('fileAccess').hidden = allowed;
  document.getElementById('openSettings').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    window.close();
  });
})();
