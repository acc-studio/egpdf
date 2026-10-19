// Android implementation of the window.native bridge. The app is the web build
// running in a Capacitor WebView; this replaces the parts the browser can't do
// with the native EgPdf plugin (android/app/src/main/java/.../EgPdfPlugin.java):
// real file paths and content:// URIs, the system file pickers, Android print
// and share, and the self-updater (APK from GitHub releases). OCR, fonts and
// the spellfix dictionaries are exactly the web build's — all bundled, local.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createNativeWeb } from './native-web.js';

export const EgPdf = registerPlugin('EgPdf');

// ---- opened-file registry ---------------------------------------------------
// Files reachable as plain paths (the PDF list, and anything the plugin could
// map to one) are used as-is, so saving writes straight back to them.
// Everything else (Open with, Share, the system picker, Save As) is a
// content:// URI — those get a path-shaped key (egand/<n>/<name>) so the
// renderer's `path.split(/[\\/]/).pop()` still yields the real display name.
const uris = new Map();
let seq = 1;
export function registerUri(uri, name) {
  if (uri.startsWith('/')) return uri;
  const key = `egand/${seq++}/${(name || 'document.pdf').replace(/[\\/]/g, '_')}`;
  uris.set(key, uri);
  return key;
}
const targetOf = (p) => uris.get(p) || p;

function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Bytes travel to the plugin base64-encoded; big files go in slices so no
// single bridge message gets huge. The plugin stages them and replaces the
// destination only after the last slice.
async function writeChunked(target, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const CHUNK = 3 * 1024 * 1024;
  for (let off = 0; off === 0 || off < bytes.length; off += CHUNK) {
    await EgPdf.writeFile({
      target,
      data: toBase64(bytes.subarray(off, off + CHUNK)),
      append: off > 0,
      done: off + CHUNK >= bytes.length,
    });
  }
}

export function createNativeAndroid() {
  const web = createNativeWeb();
  const openListeners = [];
  const progressListeners = [];
  const availableListeners = [];

  // Open with / Share into egPDF while the app is already running.
  EgPdf.addListener('openFiles', ({ files }) => {
    const keys = (files || []).map((f) => registerUri(f.uri, f.name));
    if (keys.length) openListeners.forEach((cb) => cb(keys));
  });
  EgPdf.addListener('updateProgress', ({ pct }) => progressListeners.forEach((cb) => cb(pct)));

  return {
    ...web,

    async openPdfDialog() {
      const { files } = await EgPdf.openDocuments();
      return (files || []).map((f) => registerUri(f.uri, f.name));
    },

    async savePdfDialog(defaultName) {
      const res = await EgPdf.createDocument({ name: defaultName || 'document.pdf' });
      return res?.uri ? registerUri(res.uri, res.name || defaultName) : null;
    },

    async readFile(p) {
      const target = targetOf(p);
      if (!target.startsWith('/') && !target.startsWith('content:')) return web.readFile(p); // bundled asset
      // Fast path: the WebView's local server streams the file (no base64).
      try {
        const res = await fetch(Capacitor.convertFileSrc(target.startsWith('/') ? 'file://' + target : target));
        if (res.ok) return await res.arrayBuffer();
      } catch { /* fall back to the plugin */ }
      const { data } = await EgPdf.readFile({ target });
      return fromBase64(data).buffer;
    },

    async writeFile(p, data) {
      const target = targetOf(p);
      try {
        await writeChunked(target, data);
      } catch (e) {
        // Files shared into egPDF are often read-only (WhatsApp, Gmail):
        // save the edited copy wherever the user picks instead.
        if (!target.startsWith('content:')) throw e;
        const res = await EgPdf.createDocument({ name: p.split('/').pop() });
        if (!res?.uri) throw new Error('not saved');
        uris.set(p, res.uri);
        await writeChunked(res.uri, data);
      }
      return true;
    },

    setTitle() { /* no window title on a phone */ },
    pathForFile() { return null; },
    onOpenPaths(cb) {
      openListeners.push(cb);
      // files the app was launched with (Open with… from WhatsApp, Gmail, …)
      EgPdf.getIntentFiles().then(({ files }) => {
        const keys = (files || []).map((f) => registerUri(f.uri, f.name));
        if (keys.length) cb(keys);
      });
    },

    async listPrinters() {
      return [{ name: 'android', displayName: 'Android printing', isDefault: true }];
    },
    async printNow(opts) {
      // Android prints the WebView itself; the print stylesheet shows only the
      // pages print.js rendered into #print-container. Copies, duplex, paper
      // and color are chosen in Android's own print dialog.
      try {
        await EgPdf.print({ name: document.title || 'egPDF', landscape: !!opts?.landscape });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) };
      }
    },

    async share(bytes, name) {
      const target = await EgPdf.shareTarget({ name });
      await writeChunked(target.path, bytes);
      await EgPdf.share({ path: target.path, name });
    },

    async getVersion() { return (await EgPdf.getVersion()).version; },
    openExternal(url) { if (/^https?:/i.test(url)) EgPdf.openExternal({ url }); },

    // Self-update: the plugin talks to GitHub (latest release version, then the
    // egPDF.apk asset on request) — never with document data.
    update: {
      check: () => EgPdf.updateCheck(),
      download: async (info) => (await EgPdf.updateDownload({ url: info.url, version: info.version })).path,
      install: (filePath) => EgPdf.updateInstall({ path: filePath }),
      getAutoCheck: async () => (await EgPdf.getAutoCheck()).value,
      setAutoCheck: (v) => EgPdf.setAutoCheck({ value: !!v }),
      onProgress: (cb) => progressListeners.push(cb),
      onAvailable: (cb) => availableListeners.push(cb),
    },

    // used by mobile-ui.js for the startup auto-check
    _emitUpdateAvailable(info) { availableListeners.forEach((cb) => cb(info)); },
  };
}
