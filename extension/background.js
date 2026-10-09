// egPDF extension — shows PDFs in a browser tab with egPDF instead of the
// browser's built-in viewer (or Acrobat's), the way a PDF-viewer extension does.
//
// The viewer is the egPDF web app, bundled in viewer/ (build it with
// `node build-web.mjs --extension`). It is opened as
//   chrome-extension://<id>/viewer/index.html#<url of the pdf>
// and fetches the PDF itself — nothing leaves the machine.
//
// Three ways a PDF reaches it:
//   1. Links / address bar to a URL ending in .pdf — a declarativeNetRequest
//      redirect (no flash of the built-in viewer).
//   2. PDFs served from other URLs (detected by Content-Type) — the pending
//      navigation is swapped for the viewer.
//   3. Local files, file:///…pdf — e.g. clicking a finished download in the
//      browser's downloads list. Needs "Allow access to file URLs" for this
//      extension on the browser's extension page.
// Opening a PDF from the OS (Explorer/Finder) is unaffected: that is the
// desktop app's job.

const DEFAULTS = { intercept: true };
const RULE_ID = 1;

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

const viewerBase = () => chrome.runtime.getURL('viewer/index.html');
const viewerUrlFor = (pdfUrl) => `${viewerBase()}#${pdfUrl}`;

// ---- 1. *.pdf links ----------------------------------------------------------

// Dynamic (not static) because the redirect target contains this install's
// extension id. regexSubstitution keeps the original URL verbatim in the hash.
async function syncRules() {
  const { intercept } = await getSettings();
  const rule = {
    id: RULE_ID,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { regexSubstitution: `${viewerBase()}#\\1` },
    },
    condition: {
      regexFilter: '^(https?://[^?#]*\\.pdf(?:[?#].*)?)$',
      resourceTypes: ['main_frame'],
    },
  };
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: intercept ? [rule] : [],
  });
}

chrome.runtime.onInstalled.addListener(syncRules);
chrome.runtime.onStartup.addListener(syncRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.intercept) syncRules();
});

// ---- 2. PDFs on URLs that don't end in .pdf ---------------------------------

// Observation only: swapping the pending navigation (tabs.update) before it
// commits leaves a clean history — previous page, then the viewer.
chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId < 0) return;
  const headers = details.responseHeaders || [];
  const get = (n) => (headers.find((h) => h.name.toLowerCase() === n) || {}).value || '';
  if (!/^application\/pdf\b/i.test(get('content-type'))) return;
  // A server that explicitly asks for a download gets one.
  if (/^\s*attachment/i.test(get('content-disposition'))) return;

  getSettings().then(({ intercept }) => {
    if (!intercept) return;
    chrome.tabs.update(details.tabId, { url: viewerUrlFor(details.url) }).catch(() => {});
  });
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }, ['responseHeaders']);

// ---- 3. local PDF files -----------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0 || d.tabId < 0) return;
  const { intercept } = await getSettings();
  if (!intercept) return;
  chrome.tabs.update(d.tabId, { url: viewerUrlFor(d.url) }).catch(() => {});
}, { url: [{ schemes: ['file'], pathSuffix: '.pdf' }, { schemes: ['file'], pathSuffix: '.PDF' }] });
