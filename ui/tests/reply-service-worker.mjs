import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const listeners = new Map();
const notifications = [];
const opened = [];
let windows = [];
const origin = 'https://greeklish.gr';
const id = '55555555-5555-4555-8555-555555555555';
const target =
	origin +
	'/#' +
	encodeURIComponent('σχόλια') +
	'/r-greece-rising/article/11111111-1111-4111-8111-111111111111';
runInNewContext(
	await readFile(new URL('../static/reply-notifications-sw.js', import.meta.url), 'utf8'),
	{
		URL,
		self: {
			location: { origin },
			addEventListener: (name, fn) => listeners.set(name, fn),
			skipWaiting: async () => {},
			registration: {
				showNotification: async (title, options) => notifications.push({ title, ...options })
			},
			clients: {
				claim: async () => {},
				matchAll: async () => windows,
				openWindow: async (url) => opened.push(url)
			}
		}
	}
);
async function dispatch(name, fields = {}) {
	let done;
	listeners.get(name)({
		...fields,
		waitUntil(promise) {
			done = promise;
		}
	});
	await done;
}
assert(!listeners.has('fetch'), 'notification worker must not cache or intercept browsing');
await dispatch('install');
await dispatch('activate');
for (let i = 0; i < 2; i++)
	await dispatch('push', {
		data: { json: () => ({ id, url: target, body: 'Private comment content' }) }
	});
assert.equal(notifications.length, 2, 'every push shows a visible notification');
assert.equal(notifications[0].tag, notifications[1].tag, 'retry replaces same notification');
assert.equal(notifications[0].renotify, false);
assert(!JSON.stringify(notifications).includes('Private comment content'));
assert.equal(notifications[0].data.url, target);
for (const url of [
	'https://attacker.test/',
	'javascript:alert(1)',
	origin + '/api/comments',
	'/#%invalid'
]) {
	await dispatch('push', { data: { json: () => ({ id, url }) } });
	assert.equal(notifications.at(-1).data.url, origin + '/');
}
await dispatch('push', {
	data: {
		json() {
			throw new Error('Invalid payload');
		}
	}
});
assert.equal(notifications.at(-1).data.url, origin + '/');
let closed = 0;
const notification = {
	data: { url: target },
	close() {
		closed++;
	}
};
await dispatch('notificationclick', { notification });
assert.deepEqual(opened, [target]);
let focused = 0;
let navigated;
windows = [
	{
		url: origin + '/',
		navigate: async (url) => {
			navigated = url;
			return { focus: async () => focused++ };
		}
	}
];
await dispatch('notificationclick', { notification });
assert.equal(navigated, target);
assert.equal(focused, 1);
assert.equal(opened.length, 1);
windows[0].navigate = async () => {
	throw new Error('Tab closed');
};
await dispatch('notificationclick', { notification });
assert.equal(opened.length, 2);
assert.equal(closed, 3);
console.log(
	'PASS push visibility, retry replacement, private content exclusion, safe URLs and notification click with closed-tab fallback'
);
