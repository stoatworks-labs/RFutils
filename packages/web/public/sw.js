// Service worker: offline use, without the risk of a permanently stale app.
//
// The whole point of installing this tool to a home screen is having it in a
// loading bay with no signal. That means caching. It also means the classic
// service-worker failure is now available to us: a cached shell that outlives
// every deploy, so the app silently never updates again and there is nothing
// the user can do about it short of clearing site data.
//
// The strategy below is chosen to make that failure impossible rather than
// unlikely:
//
//   navigations     -> network first, cache as fallback
//   /assets/        -> cache first, because those filenames are content-hashed,
//                      so a given URL's bytes can never change
//   everything else -> network first, cache as fallback
//
// A navigation always asks the network first, so an online user is always on
// the current build; the cache only answers when the network does not. And
// because asset URLs change with their content, a new build fetches new URLs
// and cannot be served yesterday's JavaScript.
//
// Bump CACHE when the caching behaviour itself changes. It does not need
// bumping per deploy -- the hashed filenames already handle that -- and old
// caches are deleted on activate, so a bump costs one cold fetch.

const CACHE = 'rfutils-v1';

// Enough to boot offline. Everything else arrives through runtime caching.
//
// Anything served from the site root rather than /assets/ is neither hashed
// nor bundled, so it has to be named here or it is simply missing when it
// matters. Naming it is only half the job: the last branch of the fetch
// handler is what reads these back, and without that branch an install
// populates a cache nothing ever consults.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/about-data.js',
  '/about.js',
  '/support-footer.js',
  '/pcm-player-worklet.js',
];

// Pull in the hashed files the current build actually names.
//
// This is not belt and braces. A page's own scripts are fetched before this
// worker controls anything -- registration happens on `load`, by which time
// the browser has the bundle already -- so an install alone leaves the one
// file the app cannot start without uncached. The shell would open with no
// signal and render nothing, and "works offline" would quietly mean "from
// the second visit onwards".
//
// Reading the shell HTML back and caching whatever /assets/ URLs it names
// costs one extra fetch at activate and makes the first visit enough.
async function warmBuildAssets() {
  try {
    const cache = await caches.open(CACHE);
    const res = await fetch('/', { cache: 'reload' });
    if (!res.ok) return;
    await cache.put('/', res.clone());
    const html = await res.text();
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => u.startsWith('/assets/'));
    await Promise.all([...new Set(urls)].map((u) => cache.add(u).catch(() => {})));
  } catch {
    // No network at activate time. Runtime caching picks these up on the
    // next online visit; nothing here is worth failing an activation over.
  }
}

self.addEventListener('install', (event) => {
  // addAll rejects the whole install if any one entry 404s, which would leave
  // the old worker in place -- correct, but silent. Fetch individually so one
  // missing file cannot block an install.
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => {})),
      );
      // Take over immediately rather than waiting for every tab to close: the
      // strategy here is safe to swap under a running page, and waiting is how
      // an update sits unapplied for days.
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE).map((n) => caches.delete(n)),
      );
      await warmBuildAssets();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch anything but same-origin reads. POSTs are not cacheable, and
  // a cross-origin response is not ours to reason about.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put('/', fresh.clone());
          return fresh;
        } catch {
          // Offline. Any cached navigation will do -- this is a single-page
          // app, so '/' is the whole shell.
          const cached = (await caches.match(request)) || (await caches.match('/'));
          if (cached) return cached;
          throw new Error('offline and nothing cached');
        }
      })(),
    );
    return;
  }

  // Content-hashed build output: the URL is the version, so a hit is always
  // correct and a miss is worth storing.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })(),
    );
    return;
  }

  // Everything else same-origin: the shell files above, and anything else the
  // page asks for by a stable name. The network wins whenever there is one,
  // because none of these URLs carry their own version and a cached copy could
  // be any age. The cache answers only when the fetch throws.
  //
  // Falling through here instead -- letting the browser fetch normally -- is
  // the quiet way to have no offline support at all: install would fill a
  // cache that the fetch handler never reads, the page would load with no
  // signal, and then every script it pulls from the site root would fail.
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok && SHELL.includes(url.pathname)) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
