/**
 * Registers the service worker, so the tool works with no signal.
 *
 * This lives in a module rather than an inline <script> in index.html on
 * purpose: it is how the rest of the fleet does it, and those
 * sites run under a `script-src 'self'` policy that blocks inline script
 * outright. Keeping the same shape here means a CSP can be added to this
 * site later without quietly un-installing it.
 *
 * Registration is deliberately deferred to `load`. A service worker install
 * fetches the shell, and doing that while the page is still fetching its own
 * assets makes first paint slower for a benefit that only matters on the
 * second visit.
 *
 * Failure here is not worth reporting to anyone. No service worker means no
 * offline use; every other thing the page does still works, and there is
 * nothing a user could do about it. It is logged and dropped.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  // A worker registered from a dev server would cache the dev shell and then
  // answer for it after the tab moves on. Vite sets DEV in `npm run dev` only.
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('offline support unavailable:', error);
    });
  });
}
