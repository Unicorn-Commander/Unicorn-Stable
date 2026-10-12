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
// `icon` is a resolved face URL. Only same-origin paths and https on hosts in
// the runtime instance descriptor are accepted — a push payload is
// attacker-influenced.
const runtimeExactHosts = new Set();
const runtimeSuffixHosts = new Set();
let runtimeHostsLoaded = false;

function addRuntimeOrigin(value) {
  if (Array.isArray(value)) {
    value.forEach(addRuntimeOrigin);
    return;
  }
  if (typeof value !== "string") return;
  value.split(",").forEach((item) => {
    const candidate = item.trim();
    if (!candidate) return;
    const wildcard = candidate.startsWith("*.");
    const input = wildcard ? candidate.slice(2) : candidate;
    try {
      const host = new URL(input, self.location.origin).hostname.toLowerCase().replace(/\.$/, "");
      if (!host) return;
      (wildcard ? runtimeSuffixHosts : runtimeExactHosts).add(host);
    } catch (_) {
      // Ignore malformed operator input; same-origin remains available.
    }
  });
}

async function loadRuntimeHosts() {
  if (runtimeHostsLoaded) return;
  runtimeHostsLoaded = true;
  try {
    const response = await fetch("/instances.json", { cache: "no-store" });
    if (!response.ok) return;
    const instances = await response.json();
    if (!Array.isArray(instances)) return;
    instances.forEach((instance) => {
      if (!instance || typeof instance !== "object") return;
      addRuntimeOrigin(instance.webOrigin);
      addRuntimeOrigin(instance.apiBaseUrl);
      addRuntimeOrigin(instance.wsUrl);
      addRuntimeOrigin(instance.keycloak && instance.keycloak.url);
      addRuntimeOrigin(instance.trustedOrigins);
    });
  } catch (_) {
    // Missing instances.json is the expected single-origin fallback.
  }
}

async function notificationIcon(url) {
  if (typeof url !== "string" || !url.trim()) return "/icon-192.png";
  const raw = url.trim();
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return "/icon-192.png";
    const host = parsed.hostname.toLowerCase();
    await loadRuntimeHosts();
    const ok =
      host === self.location.hostname ||
      runtimeExactHosts.has(host) ||
      [...runtimeSuffixHosts].some((suffix) => host === suffix || host.endsWith("." + suffix));
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

  event.waitUntil(
    (async () => {
      const title = payload.title || "Unicorn Stable";
      const options = {
        body: payload.body || "",
        tag: payload.tag, // undefined is fine → no coalescing
        icon: await notificationIcon(payload.icon),
        badge: "/icon-192.png",
        data: { url: notificationPath(payload.url) },
      };
      await self.registration.showNotification(title, options);
    })(),
  );
});

// --- notificationclick ---------------------------------------------------
// Close the toast, then focus an existing tab for the target URL if one is
// open, otherwise open a new window.
// A push payload is attacker-influenced. client.navigate / openWindow accept
// an absolute URL, which would leave this origin. Same-origin paths only.
function notificationPath(url) {
  if (typeof url !== "string") return "/";
  const raw = url.trim();
  if (!raw || raw.charAt(0) !== "/" || raw.charAt(1) === "/" || raw.indexOf("\\") !== -1) {
    return "/";
  }
  if (/[\u0000-\u001f\s]/.test(raw)) return "/";
  return raw;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationPath(event.notification.data && event.notification.data.url);

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
