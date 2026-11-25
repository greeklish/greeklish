import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// All network APIs and browser push services are fixtures; no live comments or pushes are sent.
const server = await createServer({
	plugins: [
		{
			name: 'reply-test-feeds',
			enforce: 'pre',
			load(id) {
				if (id.endsWith('/src/lib/server/initial-feed.ts'))
					return `export async function loadInitialFeeds(topics) {
			return { feeds: Object.fromEntries(topics.map(topic => [topic.topic, {
				displayName: topic.displayName, strategy: topic.strategy, snapshots: [], asOf: Date.now()
			}])) };
		}`;
			}
		}
	],
	server: { host: '127.0.0.1', hmr: false }
});
await server.listen();
const parentId = '11111111-1111-4111-8111-111111111111';
const replyId = '22222222-2222-4222-8222-222222222222';
const ownId = '33333333-3333-4333-8333-333333333333';
const newId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const subscriptionId = '66666666-6666-4666-8666-666666666666';
const stamp = new Date().toISOString();
const comment = (id, body, own = false, parent = null) => ({
	id,
	body,
	own,
	reply_to_comment_id: parent,
	author_display_name: own ? 'Εγώ' : 'Μαρία',
	status: 'approved',
	auto_approved: false,
	created_at: stamp
});
// Shared links keep their Greek literal; `location.hash` is read back through
// `decodeURIComponent`, so one literal expectation covers both.
const hash = (id = '') => `#σχόλια/r-greece-rising/archived${id ? '/' + id : ''}`;
const errors = [];
let browser;

async function createPage({ width = 390, dark = false, identity = true, push = 'supported' } = {}) {
	const page = await browser.newPage({
		viewport: { width, height: 850 },
		isMobile: width < 768,
		hasTouch: width < 768,
		colorScheme: dark ? 'dark' : 'light'
	});
	page.setDefaultTimeout(15000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(
		({ identity, push }) => {
			delete window.SharedWorker;
			try {
				if (identity)
					localStorage.setItem('guest-comment-author-token', JSON.stringify('test-author'));
			} catch {
				/* Initial empty document may lack an origin. */
			}
			window.pushCalls = [];
			window.sharedLinks = [];
			Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: { writeText: async (url) => window.sharedLinks.push(url) }
			});
			if (push === 'unsupported' || push === 'ios') {
				delete window.PushManager;
				delete window.Notification;
				if (push === 'ios')
					Object.defineProperty(navigator, 'userAgent', { value: 'iPhone Safari' });
				return;
			}
			let permission = push === 'denied' ? 'denied' : 'default';
			Object.defineProperty(window, 'Notification', {
				configurable: true,
				value: {
					get permission() {
						return permission;
					},
					requestPermission() {
						throw new Error('Do not request permission outside the subscribe gesture');
					}
				}
			});
			Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
			const native = {
				toJSON: () => ({
					endpoint: 'https://fcm.googleapis.com/fcm/send/test',
					keys: { p256dh: 'test-key', auth: 'test-auth' }
				}),
				unsubscribe: async () => {
					window.pushCalls.push({ type: 'unsubscribe' });
					localStorage.removeItem('test-native-push');
					return true;
				}
			};
			const registration = {
				active: { state: 'activated' },
				pushManager: {
					getSubscription: async () => (localStorage.getItem('test-native-push') ? native : null),
					subscribe: async (options) => {
						window.pushCalls.push({
							type: 'subscribe',
							gesture: navigator.userActivation.isActive,
							visible: options.userVisibleOnly
						});
						if (permission === 'denied') throw new DOMException('Blocked', 'NotAllowedError');
						permission = 'granted';
						localStorage.setItem('test-native-push', 'yes');
						return native;
					}
				}
			};
			Object.defineProperty(navigator, 'serviceWorker', {
				configurable: true,
				value: {
					register: async () => registration
				}
			});
		},
		{ identity, push }
	);
	await page.routeWebSocket(/.*/, () => {});
	const state = {
		comments: [
			comment(parentId, 'Ένα σχόλιο που αξίζει να συζητήσουμε.'),
			comment(ownId, 'Το προηγούμενο δικό μου σχόλιο.', true),
			comment(replyId, 'Η απάντηση που έλαβες.', false, ownId)
		],
		posts: [],
		calls: [],
		watches: new Set(),
		unread: true,
		failWatch: false,
		failPost: false,
		inboxError: false
	};
	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		state.calls.push({ path, method, token: request.headers()['x-guest-token'] });
		const json = (body, status = 200) => route.fulfill({ json: body, status });
		const empty = () => route.fulfill({ status: 204 });
		if (path === '/api/push/config') return json({ enabled: true, public_key: 'B'.repeat(87) });
		if (path.startsWith('/api/push/subscriptions')) {
			assert.equal(request.headers()['x-guest-token'], 'test-author');
			if (path.includes('/watches/')) {
				if (state.failWatch)
					return json({ code: 'unavailable', message: 'Δοκίμασε ξανά αργότερα.' }, 503);
				const id = path.split('/').at(-1);
				if (method === 'PUT') state.watches.add(id);
				else state.watches.delete(id);
				return empty();
			}
			if (method === 'DELETE') {
				state.watches.clear();
				return empty();
			}
			return json({ id: subscriptionId, watched_comment_ids: [...state.watches] });
		}
		if (path.startsWith('/api/replies')) {
			assert.equal(request.headers()['x-guest-token'], 'test-author');
			if (method === 'POST') {
				state.unread = false;
				return empty();
			}
			if (state.inboxError)
				return json(
					{ code: 'unavailable', message: 'Οι απαντήσεις δεν είναι διαθέσιμες τώρα.' },
					503
				);
			return json({
				replies: [
					{
						id: eventId,
						reply_id: replyId,
						parent_id: ownId,
						topic: 'r-greece-rising',
						external_id: 'archived',
						item_title: 'Το παλιότερο άρθρο της συζήτησης',
						item_url: 'https://example.test/article',
						author_display_name: 'Μαρία',
						body: 'Η απάντηση που έλαβες.',
						created_at: stamp,
						unread: state.unread
					}
				],
				unread_count: state.unread ? 1 : 0,
				next_cursor: null
			});
		}
		if (path === '/api/captcha/challenge')
			return json({
				algorithm: 'SHA-256',
				challenge: createHash('sha256').update('reply0').digest('hex'),
				salt: 'reply',
				maxnumber: 1,
				signature: 'fixture'
			});
		if (path === '/api/comments' && method === 'POST') {
			const body = request.postDataJSON();
			state.posts.push(body);
			if (state.failPost)
				return json(
					{ code: 'invalid_reply', message: 'Το αρχικό σχόλιο δεν είναι πλέον διαθέσιμο.' },
					400
				);
			const added = comment(newId, body.body, true, body.reply_to_comment_id);
			state.comments.push(added);
			return json(
				{ comment: added, guest_comment_count: state.comments.length, author_token: 'test-author' },
				201
			);
		}
		if (path.includes('/counts/')) return json({ counts: {} });
		if (path.startsWith('/api/comments/'))
			return json({
				comments: state.comments,
				guest_comment_count: state.comments.length,
				item_title: 'Το παλιότερο άρθρο της συζήτησης',
				item_url: 'https://example.test/article'
			});
		return json({});
	});
	await page.goto(server.resolvedUrls.local[0] + hash());
	await page.waitForFunction(() =>
		['open', 'problem'].includes(document.querySelector('.live-connection-button')?.dataset.state)
	);
	try {
		await page.locator(`[data-comment-id="${parentId}"]`).waitFor();
	} catch (error) {
		console.log('BOOT', {
			errors,
			calls: state.calls,
			url: page.url(),
			text: (await page.locator('body').innerText()).slice(-4500)
		});
		throw error;
	}
	return { page, state };
}

try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	await mkdir('/tmp/greeklish-replies-review', { recursive: true });
	for (const [width, dark] of [
		[320, false],
		[390, true],
		[1440, false]
	]) {
		const { page, state } = await createPage({ width, dark, identity: false });
		assert.equal(await page.evaluate(() => window.pushCalls.length), 0, 'no permission on load');
		const parent = page.locator(`[data-comment-id="${parentId}"]`);
		await page.locator('.composer-body').fill('Πρόχειρη απάντηση');
		await parent.getByRole('button', { name: 'Απάντηση', exact: true }).click();
		assert(
			await page.locator('.composer-body').evaluate((node) => node === document.activeElement),
			'reply focuses composer'
		);
		assert.equal(await page.locator('.composer-body').inputValue(), 'Πρόχειρη απάντηση');
		await page.getByRole('button', { name: 'Ακύρωση απάντησης' }).click();
		assert.equal(
			await page.locator('.composer-body').inputValue(),
			'Πρόχειρη απάντηση',
			'cancel keeps draft'
		);
		await parent.getByRole('button', { name: 'Απάντηση', exact: true }).click();
		await page.getByRole('button', { name: 'Αποστολή σχολίου' }).click();
		const added = page.locator(`[data-comment-id="${newId}"]`);
		await added.waitFor();
		assert.equal(state.posts[0].reply_to_comment_id, parentId);
		assert.equal(await page.locator('.composer-body').inputValue(), '');
		assert.equal(
			await page.evaluate(() => window.pushCalls.length),
			0,
			'posting never asks permission'
		);
		await added.getByRole('button', { name: 'Ενεργοποίηση', exact: true }).click();
		await added.getByRole('button', { name: 'Διακοπή ειδοποιήσεων' }).waitFor();
		assert.deepEqual([...state.watches], [newId], 'only the explicitly chosen comment is watched');
		assert.deepEqual(await page.evaluate(() => window.pushCalls), [
			{ type: 'subscribe', gesture: true, visible: true }
		]);
		await page.screenshot({
			path: `/tmp/greeklish-replies-review/reply-${width}-${dark ? 'dark' : 'light'}.png`
		});
		assert(
			await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			'no horizontal overflow'
		);
		await parent.getByRole('button', { name: 'Κοινοποίηση' }).click();
		await page.waitForFunction(() => window.sharedLinks.length === 1);
		assert((await page.evaluate(() => window.sharedLinks[0])).endsWith(hash(parentId)));
		await page
			.locator('.comments-rail')
			.getByRole('button', { name: /Απαντήσεις μου/ })
			.click();
		await page.locator('.reply-entry').click();
		await page.locator(`[data-comment-id="${replyId}"].comment-highlighted`).waitFor();
		assert.equal(state.unread, false);
		assert.match(
			decodeURIComponent(await page.evaluate(() => location.hash)),
			new RegExp(replyId + '$')
		);
		await page.reload();
		await page
			.locator(`[data-comment-id="${newId}"]`)
			.getByRole('button', { name: 'Διακοπή ειδοποιήσεων' })
			.waitFor();
		assert.equal(
			await page.evaluate(() => window.pushCalls.length),
			0,
			'reload restores without a permission request'
		);
		await page.keyboard.press('Escape');
		await page.locator('.comments-rail').waitFor({ state: 'detached' });
		await page.getByRole('button', { name: 'Ρυθμίσεις', exact: true }).click();
		await page
			.getByRole('button', { name: 'Απενεργοποίηση ειδοποιήσεων σε αυτή τη συσκευή' })
			.click();
		await page.waitForFunction(() => window.pushCalls.some((call) => call.type === 'unsubscribe'));
		assert.equal(state.watches.size, 0);
		await page.keyboard.press('Escape');
		await page
			.getByRole('dialog', { name: 'Ρυθμίσεις', exact: true })
			.waitFor({ state: 'detached' });
		assert(
			await page.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'),
			'closing panel releases page scroll'
		);
		console.log(
			`PASS ${width}px ${dark ? 'dark' : 'light'}: anonymous reply, draft, opt-in gesture, per-comment watch, share, inbox, deep link, reload and device disable`
		);
		await page.close();
	}
	for (const push of ['denied', 'unsupported', 'ios']) {
		const { page, state } = await createPage({ push });
		if (push === 'denied') {
			await page
				.locator(`[data-comment-id="${ownId}"]`)
				.getByRole('button', { name: 'Ειδοποίηση για απαντήσεις' })
				.click();
			await page
				.getByText(
					'Οι ειδοποιήσεις είναι αποκλεισμένες στις ρυθμίσεις του περιηγητή. Οι απαντήσεις σου παραμένουν διαθέσιμες εδώ.',
					{ exact: true }
				)
				.waitFor();
			assert.equal(state.watches.size, 0);
		}
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Ρυθμίσεις', exact: true }).click();
		await page
			.locator('.notification-settings')
			.getByText(
				push === 'ios'
					? /Αρχική οθόνη/
					: push === 'unsupported'
						? /δεν υποστηρίζονται/
						: /είναι αποκλεισμένες/
			)
			.waitFor();
		assert.equal(
			await page.evaluate(
				() => window.pushCalls.filter((call) => call.type === 'subscribe').length
			),
			push === 'denied' ? 1 : 0
		);
		console.log(`PASS ${push}: actionable fallback without forced notifications`);
		await page.close();
	}
	const { page, state } = await createPage({ width: 1440 });
	state.failWatch = true;
	const own = page.locator(`[data-comment-id="${ownId}"]`);
	await own.getByRole('button', { name: 'Ειδοποίηση για απαντήσεις' }).click();
	await own.getByText('Δοκίμασε ξανά αργότερα.').waitFor();
	assert.equal(state.watches.size, 0);
	state.failWatch = false;
	await own.getByRole('button', { name: 'Ειδοποίηση για απαντήσεις' }).click();
	await own.getByRole('button', { name: 'Διακοπή ειδοποιήσεων' }).waitFor();
	await own.getByRole('button', { name: 'Διακοπή ειδοποιήσεων' }).click();
	await own.getByRole('button', { name: 'Ειδοποίηση για απαντήσεις' }).waitFor();
	assert.equal(state.watches.size, 0);
	state.failPost = true;
	await page
		.locator(`[data-comment-id="${parentId}"]`)
		.getByRole('button', { name: 'Απάντηση', exact: true })
		.click();
	await page.locator('.composer-body').fill('Το κείμενό μου πρέπει να παραμείνει.');
	await page.getByRole('button', { name: 'Αποστολή σχολίου' }).click();
	await page
		.locator('.composer-error')
		.getByText('Το αρχικό σχόλιο δεν είναι πλέον διαθέσιμο.')
		.waitFor();
	assert.equal(
		await page.locator('.composer-body').inputValue(),
		'Το κείμενό μου πρέπει να παραμείνει.'
	);
	assert.equal(await page.locator('.composer-reply-target').count(), 1);
	await page.evaluate(() =>
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
	);
	await own.getByRole('button', { name: 'Κοινοποίηση' }).click();
	await page.locator('.comment-share-url').waitFor();
	assert((await page.locator('.comment-share-url').inputValue()).endsWith(hash(ownId)));
	console.log(
		'PASS watch error/retry/unwatch, failed reply draft preservation, manual share fallback'
	);
	assert.deepEqual(errors, [], 'no browser errors');
} finally {
	await browser?.close();
	await server.close();
}
