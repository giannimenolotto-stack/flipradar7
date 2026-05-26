// FlipRadar Service Worker — handles background push notifications
const CACHE_NAME = 'flipradar-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Handle push notifications from server
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  const title   = data.title   || 'FlipRadar';
  const options = {
    body:    data.body    || 'New listing found',
    icon:    '/icon.png',
    badge:   '/icon.png',
    tag:     data.tag     || 'flipradar-listing',
    data:    { url: data.url || '/' },
    actions: [{ action: 'view', title: 'View Listing' }],
    requireInteraction: false,
    vibrate: [200, 100, 200],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification click — open app or listing URL
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes('flipradar') && 'focus' in client) {
          client.focus();
          return;
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow('https://flipradar.pages.dev');
    })
  );
});
