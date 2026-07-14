// Font availability is resolved in the main process (which has filesystem
// access to the host OS) and bridged in. The dropdown only ever shows fonts
// actually installed on the user's machine, so the list differs per OS.

export async function detectAvailableFonts(native) {
  try {
    const families = await native.fontFamilies();
    return families.length ? families : [];
  } catch {
    return [];
  }
}
