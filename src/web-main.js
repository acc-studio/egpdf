// Web entry point: install the browser bridge, then boot the same renderer
// the desktop app uses. The dynamic import guarantees window.native exists
// before renderer.js captures it at module scope.
import { createNativeWeb } from './native-web.js';

window.native = createNativeWeb();
import('./renderer.js');
