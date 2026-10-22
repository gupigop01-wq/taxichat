// Bombila service worker: web push with buttons (Android), tap-to-open on iOS,
// offline shell caching, and passing the tap text back to the app for TTS.
const CACHE = "bombila-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/badge-72.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// App shell: network first for navigations (fresh JSX bundle after deploys),
// cache fallback when offline; cache-first for same-origin static assets only.
// API responses must never be cached: every list/order/chat read is live data.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Live API and media: always straight to the network, never the cache
  if (url.pathname.startsWith("/api/")) return;
  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(request)
        .catch(() => caches.match("/").then((cached) => cached || Response.error()))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => Response.error());
    })
  );
});

// Web push: informative notification, buttons on Android, deep link + TTS text
// passed to the app window on tap (TTS itself speaks after the app opens).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = { title: "Бомбила", body: event.data?.text() || "" };
  }
  const options = {
    body: data.body || "Открой приложение",
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: data.tag || data.kind || undefined, // one live card per order/kind
    renotify: Boolean(data.renotify),
    vibrate: data.kind === "offer" ? [120, 60, 120, 60, 120] : [100],
    data: {
      url: data.url || "/",
      speakText: data.speakText,
      orderId: data.orderId,
      offerId: data.offerId,
    },
    requireInteraction: Boolean(data.requireInteraction),
  };
  if (Array.isArray(data.actions) && data.actions.length) options.actions = data.actions;
  event.waitUntil(self.registration.showNotification(data.title || "Бомбила", options));
});

// Action buttons (Android): "Принять" performs the real API call with the
// session cookie right from the notification, then reports the outcome.
self.addEventListener("notificationclick", (event) => {
  const action = event.action;
  const { url, orderId, offerId, speakText } = event.notification.data ?? {};
  event.notification.close();

  const respond = (title, body, tag) =>
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-72.png",
        tag: tag || notificationTag(event.notification.tag),
      })
    );

  const focusOrOpen = event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appClient = windowClients.find((client) => client.url.includes(self.location.origin));
    if (appClient) {
      await appClient.focus();
      appClient.postMessage({ type: "bombila-push-open", url, orderId, speakText });
    } else {
      await self.clients.openWindow(url || "/");
    }
  })());

  if (action === "accept") {
    if (!orderId || !offerId) return;
    event.waitUntil((async () => {
      try {
        const response = await fetch(`/api/orders/${orderId}/accept`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offerId }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          return respond("Не удалось принять", error.message ?? "Попробуйте в приложении", event.notification.tag);
        }
        await self.registration.showNotification("Заказ принят", {
          body: "Водитель готов к поездке. Откройте игру в чате.",
          icon: "/icons/icon-192.png",
          badge: "/icons/badge-72.png",
          tag: event.notification.tag ? `${event.notification.tag}:accepted` : undefined,
        });
      } catch (error) {
        return respond("Нет сети", "Откройте приложение и примите оффер", event.notification.tag);
      }
      void focusOrOpen;
    })());
    return;
  }

  if (action === "decline") {
    event.waitUntil(Promise.resolve());
    return;
  }

  event.waitUntil(focusOrOpen);
});

