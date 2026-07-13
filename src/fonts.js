// Native Windows fonts usable for text edits. Display uses the installed
// family via CSS; saving embeds the matching TTF (subset) so the PDF looks
// identical everywhere. Only plain .ttf files — .ttc collections (Cambria &
// co.) can't be embedded directly by pdf-lib.
export const FONTS_DIR = 'C:\\Windows\\Fonts\\';

export const FONT_FAMILIES = [
  { name: 'Arial', file: 'arial.ttf' },
  { name: 'Calibri', file: 'calibri.ttf' },
  { name: 'Comic Sans MS', file: 'comic.ttf' },
  { name: 'Consolas', file: 'consola.ttf' },
  { name: 'Courier New', file: 'cour.ttf' },
  { name: 'Georgia', file: 'georgia.ttf' },
  { name: 'Impact', file: 'impact.ttf' },
  { name: 'Segoe UI', file: 'segoeui.ttf' },
  { name: 'Tahoma', file: 'tahoma.ttf' },
  { name: 'Times New Roman', file: 'times.ttf' },
  { name: 'Trebuchet MS', file: 'trebuc.ttf' },
  { name: 'Verdana', file: 'verdana.ttf' },
];

export function fontFilePath(name) {
  const f = FONT_FAMILIES.find((x) => x.name === name);
  return FONTS_DIR + (f ? f.file : 'arial.ttf');
}

export async function detectAvailableFonts(native) {
  try {
    const paths = FONT_FAMILIES.map((f) => FONTS_DIR + f.file);
    const existing = new Set((await native.existsMany(paths)).map((p) => p.toLowerCase()));
    const avail = FONT_FAMILIES.filter((f) => existing.has((FONTS_DIR + f.file).toLowerCase()));
    return avail.length ? avail : [FONT_FAMILIES[0]];
  } catch {
    return [FONT_FAMILIES[0]];
  }
}
