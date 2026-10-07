// Take over immediately: installed apps on phones are rarely fully closed, so a waiting
// worker would otherwise keep the old push handling around indefinitely.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Saadventure', body: event.data.text() };
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Saadventure';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const gameId = typeof payload.gameId === 'string' ? payload.gameId : null;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      data: {
        url: gameId ? '/game/' + gameId : '/',
      },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/';

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const matchingClient = windows.find((client) => 'focus' in client);

    if (matchingClient) {
      // navigate() rejects for windows this worker doesn't control yet; focusing is still useful.
      const focused = await matchingClient.focus();
      try {
        await (focused ?? matchingClient).navigate(targetUrl);
      } catch {
        // Leave the focused window where it is.
      }
      return;
    }

    await self.clients.openWindow(targetUrl);
  })());
});
