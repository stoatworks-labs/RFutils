/**
 * Loads the browser-side implementations in `localApi.ts`. This is the only
 * place that imports them, and only the static build gets this module: the
 * server build aliases it to `loadLocalApi.server.ts` (see vite.config.ts), so
 * the dynamic import below — and pdfjs behind it — is not in the server
 * build's module graph at all.
 *
 * That is deliberately not left to dead-code elimination. Vite 8 does drop the
 * `if (staticBuild)` branches in api.ts, but rolldown still emits a chunk for
 * every dynamic import it found before dropping them, so the server build
 * shipped localApi, pdfjs and the parsers as orphan chunks nothing loads.
 */
export const loadLocalApi = () => import('./localApi.js');
