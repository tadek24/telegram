self.addEventListener('push', event => {
  let message = {}
  try { message = event.data?.json() || {} } catch { message = {} }
  const title = typeof message.title === 'string' ? message.title : 'Komunikator E-Prom'
  const options = {
    body: typeof message.body === 'string' ? message.body : 'Masz nową wiadomość.',
    icon: '/icons/eprom-icon-192.png',
    badge: '/icons/eprom-icon-192.png',
    tag: typeof message.tag === 'string' ? message.tag : 'eprom-message',
    renotify: true,
    data: { url: typeof message.data?.url === 'string' ? message.data.url : '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const visibleWindow = windows.find(windowClient => 'focus' in windowClient)
    if (visibleWindow) {
      visibleWindow.navigate(targetUrl)
      return visibleWindow.focus()
    }
    return self.clients.openWindow(targetUrl)
  }))
})
