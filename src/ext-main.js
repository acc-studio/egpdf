// Entry point of the browser-extension viewer (extension/viewer/, built by
// `node build-web.mjs --extension`). Same app as the website — web bridge, same
// renderer — plus one thing: the PDF to show is named in the page's URL hash
// (viewer/index.html#<pdf url>), exactly like a PDF viewer extension's tab.
//
// The extension page has host permissions, so fetching the PDF here needs no
// server and no CORS; the bytes go straight into the renderer and nothing is
// sent anywhere.
import { createNativeWeb } from './native-web.js';

window.native = createNativeWeb();

// Filename from Content-Disposition, else the last URL path segment.
function pdfName(url, res) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(cd) || /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name = m ? m[1] : '';
  if (!name) {
    try { name = new URL(url).pathname.split('/').pop() || ''; } catch { /* keep empty */ }
  }
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  name = name.replace(/[\\/:*?"<>|]+/g, '_').trim();
  if (!name) name = 'document.pdf';
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function showProblem(message, url) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:auto 0 48px 0;margin:0 auto;width:min(560px,92vw);padding:14px 18px;'
    + 'background:#fff;border:1px solid #e4dcc7;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);'
    + 'font:14px/1.45 "Segoe UI",system-ui,sans-serif;color:#3b3a36;z-index:99999';
  const p = document.createElement('p');
  p.style.margin = '0 0 8px';
  p.textContent = message;
  const a = document.createElement('a');
  a.href = url;
  a.textContent = 'Open the original link';
  a.style.color = '#14706d';
  box.append(p, a);
  document.body.appendChild(box);
}

async function openFromHash() {
  // The extension writes the PDF's URL into the hash verbatim; decoding it
  // here would corrupt URLs that legitimately contain %2F and the like.
  const url = location.hash.slice(1).trim();
  if (!/^(https?|file):\/\//i.test(url)) return; // no PDF named: plain app

  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await window.egpdfOpenBytes(bytes, pdfName(url, res));
  } catch (e) {
    const local = /^file:/i.test(url);
    showProblem(
      local
        ? 'Could not read this local file. Turn on “Allow access to file URLs” for the egPDF extension in your browser’s extension settings.'
        : `Could not load this PDF (${e.message || e}).`,
      url,
    );
  }
}

// The dynamic import guarantees window.native exists before renderer.js
// captures it, and resolves once window.egpdfOpenBytes is defined.
import('./renderer.js').then(openFromHash);
