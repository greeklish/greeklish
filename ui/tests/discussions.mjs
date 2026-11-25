import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Exercise the real page/router with fixed server feed data and intercepted public APIs.
const server = await createServer({
	plugins: [
		{
			name: 'discussion-test-feeds',
			enforce: 'pre',
			load(id) {
				if (id.endsWith('/src/lib/server/initial-feed.ts'))
					return `
				export async function loadInitialFeeds(topics) {
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
const errors = [];
let browser;
const discussion = (id, count = 2) => ({
	topic: 'greece-rising',
	topic_display_name: 'r/greece',
	external_id: id,
	item_title: `Συζήτηση ${id}: Ένα άρθρο με σχόλια από την κοινότητα`,
	item_url: `https://example.test/${id}`,
	guest_comment_count: count,
	last_comment_at: new Date().toISOString()
});

async function createPage(width, dark = false) {
	const page = await browser.newPage({
		viewport: { width, height: 900 },
		isMobile: width < 768,
		hasTouch: width < 768,
		colorScheme: dark ? 'dark' : 'light'
	});
	page.setDefaultTimeout(10000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => {
		delete window.SharedWorker;
	});
	await page.routeWebSocket(/.*/, () => {});
	const requests = [];
	let responseMode = 'normal';
	await page.route('**/api/**', async (route) => {
		assert.equal(route.request().method(), 'GET', 'tests never write to the backend');
		const url = new URL(route.request().url());
		const json = (body, status = 200) => route.fulfill({ json: body, status });
		if (url.pathname === '/api/comments/discussions') {
			requests.push(url.searchParams.get('cursor'));
			if (responseMode === 'error')
				return json({ code: 'unavailable', message: 'Δοκιμαστικό σφάλμα.' }, 503);
			if (responseMode === 'empty') return json({ discussions: [], next_cursor: null });
			return url.searchParams.has('cursor')
				? json({ discussions: [discussion('older', 1)], next_cursor: null })
				: json({
						discussions: [discussion('recent'), discussion('previous')],
						next_cursor: 'next-page'
					});
		}
		if (url.pathname.includes('/counts/')) return json({ counts: {} });
		if (url.pathname.startsWith('/api/comments/'))
			return json({
				comments: [
					{
						id: 'comment',
						body: 'Το σχόλιο της συζήτησης.',
						author_display_name: 'Επισκέπτης',
						created_at: new Date().toISOString(),
						status: 'approved',
						auto_approved: false,
						own: false
					}
				],
				guest_comment_count: 1
			});
		return json({});
	});
	await page.goto(server.resolvedUrls.local[0]);
	// Wait for hydration before clicking a server-rendered control.
	await page.waitForFunction(() => document.querySelector('.feed-panel'));
	await page.waitForTimeout(400);
	return {
		page,
		requests,
		setMode: (mode) => {
			responseMode = mode;
		}
	};
}

try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	await mkdir('/tmp/greeklish-discussions-review', { recursive: true });
	for (const [width, dark] of [
		[320, false],
		[390, true],
		[1600, false],
		[2560, true]
	]) {
		const { page, requests } = await createPage(width, dark);
		const toggle = page
			.locator('.header-controls')
			.getByRole('button', { name: 'Συζητήσεις', exact: true });
		assert.equal(await page.locator('.comments-rail').count(), 0, 'list starts closed');
		assert.equal(requests.length, 0, 'list only loads when opened');
		assert.equal(
			await page.locator('.site-intro p .info-text-link').innerText(),
			'Περισσότερες πληροφορίες…'
		);
		assert.equal(
			await page.getByRole('button', { name: 'Ρυθμίσεις', exact: true }).innerText(),
			'Ρυθμίσεις'
		);
		assert(
			await toggle.evaluate((node) =>
				getComputedStyle(node).animationName.includes('discussions-pulse')
			)
		);
		assert.equal(
			await page.evaluate(() => document.documentElement.classList.contains('dark')),
			dark
		);
		assert(
			await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			'toolbar fits viewport'
		);
		for (const button of await page.locator('.header-controls button').all()) {
			const bounds = await button.evaluate((node) => ({
				button: node.getBoundingClientRect().toJSON(),
				label: node.querySelector('span')?.getBoundingClientRect().toJSON(),
				icon: node.querySelector('svg')?.getBoundingClientRect().toJSON(),
				width: getComputedStyle(node).width,
				display: getComputedStyle(node).display
			}));
			assert(
				bounds.label.left >= bounds.button.left && bounds.label.right <= bounds.button.right,
				JSON.stringify(bounds)
			);
			assert(
				bounds.icon.width >= 15 && bounds.icon.right <= bounds.label.left,
				JSON.stringify(bounds)
			);
		}
		await toggle.click();
		await page.locator('.discussion-entry').first().waitFor();
		assert.equal(await page.locator('.discussion-entry').count(), 2);
		assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
		assert.equal(await toggle.evaluate((node) => getComputedStyle(node).animationName), 'none');
		await page.waitForTimeout(400);
		await page.screenshot({
			path: `/tmp/greeklish-discussions-review/${width}-${dark ? 'dark' : 'light'}.png`
		});
		await page.getByRole('button', { name: 'Περισσότερες συζητήσεις' }).click();
		await page.waitForFunction(() => document.querySelectorAll('.discussion-entry').length === 3);
		assert.deepEqual(requests, [null, 'next-page']);
		await page.locator('.discussion-entry').last().click();
		await page.getByText('Το σχόλιο της συζήτησης.', { exact: true }).waitFor();
		assert.match(await page.locator('#comments-rail-title').innerText(), /older/);
		assert.match(
			decodeURIComponent(await page.evaluate(() => location.hash)),
			/σχόλια\/greece-rising\/older/
		);
		await page.getByRole('button', { name: 'Όλες οι συζητήσεις', exact: true }).click();
		await page.locator('.discussion-entry').first().waitFor();
		assert.equal(await page.evaluate(() => location.hash), '');
		await page.keyboard.press('Escape');
		await page.locator('.comments-rail').waitFor({ state: 'detached' });
		assert(await toggle.evaluate((node) => node === document.activeElement));
		await page.locator('.live-connection-button').click();
		await page.getByRole('dialog', { name: 'Τι είναι το Greeklish.gr' }).waitFor();
		await page.keyboard.press('Escape');
		await page.getByRole('dialog').waitFor({ state: 'detached' });
		await page.getByRole('button', { name: 'Ρυθμίσεις', exact: true }).click();
		await page.getByRole('dialog', { name: 'Ρυθμίσεις', exact: true }).waitFor();
		await page.keyboard.press('Escape');
		await page.getByRole('dialog').waitFor({ state: 'detached' });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		assert.equal(await toggle.evaluate((node) => getComputedStyle(node).animationName), 'none');
		console.log(
			`PASS ${width}px ${dark ? 'dark' : 'light'}: labels, pulse, list, pagination, thread/back, focus, dialogs, reduced motion`
		);
		await page.close();
	}
	const { page, setMode } = await createPage(1600);
	const toggle = page
		.locator('.header-controls')
		.getByRole('button', { name: 'Συζητήσεις', exact: true });
	setMode('error');
	await toggle.click();
	await page.getByRole('alert').waitFor();
	setMode('empty');
	await page.getByRole('button', { name: 'Δοκίμασε ξανά' }).click();
	await page.getByText('Δεν υπάρχουν συζητήσεις ακόμη.', { exact: false }).waitFor();
	await toggle.click();
	await page.locator('.comments-rail').waitFor({ state: 'detached' });
	setMode('normal');
	await toggle.click();
	await page.locator('.discussion-entry').first().waitFor();
	await toggle.click();
	await page.locator('.comments-rail').waitFor({ state: 'detached' });
	assert.deepEqual(errors, [], 'no browser errors');
	console.log('PASS empty state, error/retry, reopen, desktop toggle');
} finally {
	await browser?.close();
	await server.close();
}
