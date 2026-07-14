// Minimal 16px stroke icons (24 viewBox), injected into toolbar buttons.
const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  open: svg('<path d="M3 7V5.5C3 4.7 3.7 4 4.5 4h4l2 2.5h8c.8 0 1.5.7 1.5 1.5v1"/><path d="M3.4 9h17.2c.9 0 1.6.9 1.4 1.8l-1.5 7c-.15.7-.76 1.2-1.47 1.2H4.97c-.71 0-1.32-.5-1.47-1.2l-1.5-7C1.8 9.9 2.5 9 3.4 9Z"/>'),
  save: svg('<path d="M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="7"/>'),
  saveas: svg('<path d="M5 4h11l4 4v5"/><path d="M4 5v14a1 1 0 0 0 1 1h6"/><path d="M8 4v5h7V4"/><path d="M20.5 13.5 14 20l-2.5.5.5-2.5 6.5-6.5a1.4 1.4 0 0 1 2 2Z"/>'),
  zoomout: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9M7.8 10.5h5.4"/>'),
  zoomin: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9M7.8 10.5h5.4M10.5 7.8v5.4"/>'),
  fit: svg('<path d="M3 12h18M6 8l-3 4 3 4M18 8l3 4-3 4"/>'),
  select: svg('<path d="M6 3.5 18.2 12l-5.3 1.2L10 18.5 6 3.5Z"/>'),
  redact: svg('<rect x="3.5" y="7.5" width="17" height="9" rx="1" fill="currentColor" stroke="none"/>'),
  whiteout: svg('<rect x="3.5" y="7.5" width="17" height="9" rx="1" stroke-dasharray="3 2.4"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9.5 20h5"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17.5 5-4.5 3.5 3 3-2.5 4.5 4"/>'),
  undo: svg('<path d="M7.5 5.5 4 9l3.5 3.5"/><path d="M4 9h10a6 6 0 0 1 0 12h-4"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/>'),
  sidebar: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M9.5 4.5v15"/>'),
  split: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M12 4.5v15"/>'),
  compare: svg('<rect x="3" y="6" width="7.5" height="12" rx="1"/><rect x="13.5" y="6" width="7.5" height="12" rx="1"/><path d="M5.5 9.5h2.5M5.5 12h2.5M16 9.5h2.5M16 12h2.5M16 14.5h2.5"/>'),
  highlight: svg('<path d="m9 15-3.5 3.5H3l2.5-4L15 5l4 4-10 6Z"/><path d="M13 7l4 4"/><path d="M3 21h18" stroke-width="2.6" opacity="0.45"/>'),
  note: svg('<path d="M4 5.5C4 4.7 4.7 4 5.5 4h13c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5H12l-4.5 4v-4h-2c-.8 0-1.5-.7-1.5-1.5v-9Z"/>'),
  print: svg('<path d="M7 8V3.5h10V8"/><path d="M7 16H4.5A1.5 1.5 0 0 1 3 14.5v-5A1.5 1.5 0 0 1 4.5 8h15A1.5 1.5 0 0 1 21 9.5v5a1.5 1.5 0 0 1-1.5 1.5H17"/><rect x="7" y="13" width="10" height="7.5"/>'),
  rotate: svg('<path d="M16.5 5.5 20 9l-3.5 3.5"/><path d="M20 9H10a6 6 0 1 0 6 6"/>'),
  ocr: svg('<path d="M5.5 4.5h8.5l4 4V12"/><path d="M5.5 4.5v15H11"/><path d="M8.5 10h6M8.5 13h4"/><circle cx="16.5" cy="16.5" r="3.5"/><path d="m21.5 21.5-2.5-2.5"/>'),
  ocrarea: svg('<path d="M3.5 8V5.5c0-1.1.9-2 2-2H8M16 3.5h2.5c1.1 0 2 .9 2 2V8M3.5 16v2.5c0 1.1.9 2 2 2H8"/><path d="M7.5 9.5h9M7.5 12.5h6"/><circle cx="17" cy="17" r="3.5"/><path d="m22 22-2.5-2.5"/>'),
  trash: svg('<path d="M4.5 6.5h15M9.5 6V4.5h5V6M6.5 6.5 7.5 20h9l1-13.5M10 10v6.5M14 10v6.5"/>'),
};

export function applyIcons(map) {
  for (const [id, name] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && ICONS[name]) el.innerHTML = ICONS[name];
  }
}
