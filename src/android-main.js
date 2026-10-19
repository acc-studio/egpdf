// Android entry point (built by `node build-web.mjs --android`, wrapped by
// Capacitor in android/). Installs the Android bridge, tunes the viewer for a
// phone, boots the same renderer as desktop and web, then puts the phone
// layout (mobile-ui.js) around it.
import { createNativeAndroid } from './native-android.js';
import { DocView } from './viewer.js';
import { installTouchDnd } from './touch-dnd.js';

window.native = createNativeAndroid();
document.documentElement.classList.add('mobile');

// Pages fill the screen width; every document opens fit-to-width (pinch-zoom
// is per document); and a much smaller bitmap cache than desktop — WebView
// memory on a phone is tight.
DocView.FIT_MARGIN = 12;
DocView.PERSIST_ZOOM = false;
DocView.MAX_CACHED_PIXELS = 28e6;

installTouchDnd();

// The dynamic import guarantees window.native exists before renderer.js
// captures it at module scope.
import('./renderer.js')
  .then(() => import('./mobile-ui.js'))
  .then((m) => m.initMobile());
