'use strict';

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Pocket Term', body: 'Agent 状态已更新' };
  }
  const title = String(data.title || 'Pocket Term').slice(0, 120);
  const body = String(data.body || 'Agent 状态已更新').slice(0, 500);
  const url = typeof data.url === 'string' && data.url.startsWith('/herd/')
    ? data.url
    : '/herd/#/chats';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: String(data.tag || 'pt2-status').slice(0, 180),
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/herd/#/chats', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin + '/herd/')) {
        return client.focus().then(() => client.navigate(target));
      }
    }
    return clients.openWindow(target);
  }));
});
