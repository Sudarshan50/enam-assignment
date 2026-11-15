/* FINN service worker: Web Push only. No fetch handler, so nothing is cached or intercepted. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "FINN", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "FINN";
  const options = {
    body: payload.body || "",
    icon: "/pwa-icon/192",
    badge: "/pwa-icon/96",
    tag: payload.tag || payload.alertId || undefined,
    renotify: Boolean(payload.tag),
    timestamp: payload.createdAt ? Date.parse(payload.createdAt) : Date.now(),
    data: { url: payload.url || "/watch" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === target.origin && "focus" in client) {
          client.navigate(target.href);
          return client.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
