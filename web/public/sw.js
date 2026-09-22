// sw.js — minimal, correct service worker for the Unicorn Stable Vite SPA.
//
// Design goals:
//   * Keep the app shell available offline (network-first navigations).
//   * Cache immutable Vite assets so the cached shell can boot offline.
//   * Be forward-compatible with web-push (push + notificationclick handlers)
//     even though the backend isn't wired up yet.
//
// Dependency-free vanilla JS.

const CACHE = "stable-shell-v2";

// Just the app shell. index.html is the SPA entry; "/" resolves to it.
const SHELL = ["/", "/index.html"];

// --- install -------------------------------------------------------------
// Pre-cache the shell, but never let a precache failure block installation
// (e.g. offline first-load, or one URL 404ing). skipWaiting so the new SW
// activates immediately instead of waiting for all tabs to close.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        await cache.addAll(SHELL);
      } catch (err) {
        // Precache is best-effort; navigations will re-fill the cache later.
        console.warn("[sw] precache failed (non-fatal):", err);
      }
    })(),
  );
});

// --- activate ------------------------------------------------------------
// Take control of open clients immediately and drop any stale cache buckets
// from previous SW versions.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (name !== CACHE ? caches.delete(name) : null)),
      );
      await self.clients.claim();
    })(),
  );
});

// --- fetch ---------------------------------------------------------------
// ONLY intercept top-level GET navigations. Everything else (hashed assets,
// /api, ws) falls through to the network untouched.
//
// Strategy for navigations: network-first, fall back to cached "/" so the
// SPA shell still boots offline. On a successful load we refresh the cached
// shell so the offline copy stays reasonably current.
self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (
    req.method === "GET" &&
    new URL(req.url).origin === self.location.origin &&
    new URL(req.url).pathname.startsWith("/assets/")
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(req, fresh.clone());
        }
        return fresh;
      })(),
    );
    return;
  }

  // Only GET navigations. request.mode === "navigate" is true for full-page
  // loads / address-bar hits, not for fetch()/XHR/asset subrequests.
  if (req.method !== "GET" || req.mode !== "navigate") {
    return; // do nothing → default network handling
  }

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        // Keep the shell copy fresh for offline use.
        try {
          const cache = await caches.open(CACHE);
          await cache.put("/", fresh.clone());
        } catch (_) {
          /* cache write is best-effort */
        }
        return fresh;
      } catch (_) {
        // Offline (or network error): serve the cached shell.
        const cache = await caches.open(CACHE);
        const cached =
          (await cache.match("/")) || (await cache.match("/index.html"));
        if (cached) return cached;
        // Nothing cached yet — surface a minimal offline response.
        return new Response("Offline", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }
    })(),
  );
});

// --- push ----------------------------------------------------------------
// Defensive handler for future web-push. Expects a JSON payload of the shape
// { title, body, url, tag, icon }. Tolerates missing/invalid data.
// `icon` is a resolved face URL. Only same-origin paths and https on our
// hosts are accepted — a push payload is attacker-influenced.
function notificationIcon(url) {
  if (typeof url !== "string" || !url.trim()) return "/icon-192.png";
  const raw = url.trim();
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return "/icon-192.png";
    const host = parsed.hostname.toLowerCase();
    const ok =
      host === self.location.hostname ||
      host === "magicunicorn.dev" ||
      host.endsWith(".magicunicorn.dev") ||
      host === "magicunicorn.tech" ||
      host.endsWith(".magicunicorn.tech") ||
      host === "unicorncommander.ai" ||
      host.endsWith(".unicorncommander.ai");
    return ok ? raw : "/icon-192.png";
  } catch (_) {
    return "/icon-192.png";
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_) {
      // Fall back to raw text as the body.
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title || "Unicorn Stable";
  const options = {
    body: payload.body || "",
    tag: payload.tag, // undefined is fine → no coalescing
    icon: notificationIcon(payload.icon),
    badge: "/icon-192.png",
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// --- notificationclick ---------------------------------------------------
// Close the toast, then focus an existing tab for the target URL if one is
// open, otherwise open a new window.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        // Focus any open Stable tab (best-effort URL match).
        if ("focus" in client) {
          try {
            await client.focus();
            if ("navigate" in client && client.url !== url) {
              await client.navigate(url).catch(() => {});
            }
            return;
          } catch (_) {
            /* try next client */
          }
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
