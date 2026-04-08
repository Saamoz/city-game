self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Territory', body: event.data.text() };
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Territory';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const gameId = typeof payload.gameId === 'string' ? payload.gameId : null;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
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
      await matchingClient.navigate(targetUrl);
      await matchingClient.focus();
      return;
    }

    await self.clients.openWindow(targetUrl);
  })());
});
