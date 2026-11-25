// Push only: deliberately no fetch handler or page/asset caching.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function safeReplyUrl(value) {
	try {
		const url = new URL(value, self.location.origin);
		const prefix = decodeURIComponent(url.hash.split('/')[0]);
		if (url.origin === self.location.origin && url.pathname === '/' && prefix === '#σχόλια')
			return url.href;
	} catch { /* Malformed push data opens the site without following another origin. */ }
	return `${self.location.origin}/`;
}

self.addEventListener('push', (event) => {
	event.waitUntil((async () => {
		let payload = {};
		try { payload = event.data?.json() ?? {}; } catch { /* A malformed push still needs a visible fallback. */ }
		const id = typeof payload?.id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.id) ? payload.id : null;
		// A stable tag replaces duplicate deliveries. Always show a visible notification:
		// silently consuming pushes would violate userVisibleOnly and revoke Safari permission.
		await self.registration.showNotification('Νέα απάντηση στο Greeklish.gr', {
			body: 'Κάποιος απάντησε σε σχόλιό σου.',
			icon: '/android-chrome-192x192.png',
			tag: id ? `greeklish-reply-${id}` : 'greeklish-reply',
			renotify: false,
			data: { url: safeReplyUrl(id ? payload.url : null), id }
		});
	})());
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil((async () => {
		const target = safeReplyUrl(event.notification.data?.url);
		const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
		if (existing) {
			try {
				const navigated = await existing.navigate(target);
				if (navigated) { await navigated.focus(); return; }
			} catch { /* A tab may close between matching and navigating it. */ }
		}
		await self.clients.openWindow(target);
	})());
});
