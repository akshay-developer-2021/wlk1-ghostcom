import { precacheAndRoute } from 'workbox-precaching';

// Minimal service-worker scope shapes declared locally. The project's
// tsconfig uses the DOM lib (no WebWorker lib — the two conflict), and the
// DOM lib has no ExtendableEvent/FetchEvent/Clients, so we declare exactly
// what this worker uses instead of referencing ServiceWorkerGlobalScope.
interface SwExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends Event {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface SwClients {
  claim(): Promise<void>;
}

interface SwGlobalScope {
  // Build-time precache manifest injected by vite-plugin-pwa
  // (injectManifest strategy replaces `self.__WB_MANIFEST`).
  readonly __WB_MANIFEST: Array<string | { url: string; revision?: string | null }>;
  addEventListener(type: 'install' | 'activate', listener: (event: SwExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: SwClients;
}

declare const self: SwGlobalScope;

/* WLK-1 GHOSTCOM service worker — offline shell cache.
   Network-first for navigation (fresh app), cache-first for assets. */
// bump on breaking cache changes
const CACHE_VERSION = 'v2';
const CACHE_PREFIX = 'wlk1-';
const CACHE = `${CACHE_PREFIX}${CACHE_VERSION}`;
const RUNTIME_CAP = 60;
/* Scope-relative, never root-absolute: the app ships on a SUBPATH
   (GitHub Pages project site), where '/' is the origin root and 404s. A
   failing addAll rejects the install event and discards the worker AND
   workbox's precache — the SW silently never installs. index.html is
   already in the precache manifest, so nothing is added here. */
const ASSETS: string[] = [];

// Best-effort: keep the newest entries, drop the oldest beyond the cap.
function trimRuntime(cache: Cache): Promise<void> {
  return cache
    .keys()
    .then((keys) => {
      if (keys.length <= RUNTIME_CAP) return;
      const excess = keys.slice(0, keys.length - RUNTIME_CAP);
      return Promise.all(excess.map((key) => cache.delete(key))).then(() => undefined);
    })
    .catch(() => undefined);
}

// Build-time precache manifest (app shell hashed assets).
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', (event) => {
  /* No skipWaiting(): the lazy argon2 chunk (passphrase rooms) lives at a
     hashed URL that a deploy deletes. Activating mid-session would swap the
     precache out from under a running document and 404 that import. The new
     worker takes over on the next navigation instead. */
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      /* Prune only stale versions of OUR cache. Workbox's precache lives
         under its own name and owns its own cleanup; deleting every cache
         that is not ours wipes the precache precacheAndRoute() just
         installed and breaks offline. */
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/wss')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((response) => {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      }).catch(() =>
        caches.match(event.request)
          .then((cached) => cached ?? caches.match('/index.html'))
          .then((fallback) => {
            // Same observable outcome as the JS original (which resolved
            // undefined here and let the runtime fail the navigation),
            // but type-safe under strict TS.
            if (!fallback) throw new Error('offline — no cached shell');
            return fallback;
          }),
      ),
    );
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ??
          fetch(event.request).then((response) => {
            const copy = response.clone();
            void caches
              .open(CACHE)
              .then((cache) => cache.put(event.request, copy).then(() => trimRuntime(cache)))
              .catch(() => undefined);
            return response;
          }),
      ),
    );
  }
});
