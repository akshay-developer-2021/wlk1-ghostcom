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
const CACHE = 'wlk1-v1';
const ASSETS: string[] = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

// Build-time precache manifest (app shell hashed assets).
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
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
            void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return response;
          }),
      ),
    );
  }
});
