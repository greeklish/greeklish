import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
	plugins: [
		{
			name: 'feed-ux-fixtures',
			enforce: 'pre',
			load(id) {
				if (!id.endsWith('/src/lib/server/initial-feed.ts')) return;
				return `export async function loadInitialFeeds(topics) {
				const now = Date.now();
				const timestamp = new Date(now).toISOString();
				return { feeds: Object.fromEntries(topics.map(topic => [topic.topic, {
					displayName: topic.displayName, strategy: topic.strategy, asOf: now,
					snapshots: [{ id: topic.topic, crawled_at: timestamp, items: Array.from({length: 12}, (_, index) => ({
						external_id: topic.topic + index,
						title: 'Συζήτηση ' + (index + 1) + ': Νέες ιδέες για την τεχνολογία και την καθημερινότητα στις ελληνικές κοινότητες',
						url: 'https://www.reddit.com/r/greece/comments/fixture' + index + '/discussion/',
						score: 120 - index, comments_count: 24, rank_position: index + 1,
						published_at: timestamp, crawled_at: timestamp
					})) }]
				}])) };
			}`;
			}
		}
	],
	server: { host: '127.0.0.1', hmr: false }
});
await server.listen();
let browser;
const errors = [];
try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	await mkdir('/tmp/greeklish-ux-review', { recursive: true });
	for (const [width, dark, javaScriptEnabled] of [
		[320, false, true],
		[390, true, true],
		[768, false, true],
		[1440, true, true],
		[2160, false, true],
		[390, false, false]
	]) {
		const context = await browser.newContext({
			viewport: { width, height: 900 },
			colorScheme: dark ? 'dark' : 'light',
			hasTouch: width < 1180,
			isMobile: width < 768,
			javaScriptEnabled
		});
		await context.route('https://www.reddit.com/**', (route) =>
			route.fulfill({ contentType: 'text/html', body: '<h1>Source fixture</h1>' })
		);
		const page = await context.newPage();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.addInitScript(() => {
			delete window.SharedWorker;
		});
		await page.routeWebSocket(/.*/, () => {});
		await page.route('**/api/**', (route) => {
			assert.equal(route.request().method(), 'GET');
			return route.fulfill({
				json: {
					counts: {},
					comments: [],
					guest_comment_count: 0,
					discussions: [],
					next_cursor: null
				}
			});
		});
		await page.goto(server.resolvedUrls.local[0]);
		if (javaScriptEnabled)
			await page.waitForFunction(() =>
				['open', 'problem'].includes(
					document.querySelector('.live-connection-button')?.dataset.state
				)
			);
		assert.equal(await page.locator('h1').count(), 1);
		assert.equal(await page.locator('.feed-panel').count(), 7);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		const navigation = page.getByRole('navigation', { name: 'Μετάβαση σε πηγή' });
		if (width < 1180) {
			assert(await navigation.isVisible());
			assert.equal(await navigation.getByRole('link').count(), 7);
			for (const name of ['myphone', 'lagonika', 'r/greece']) {
				const link = navigation.getByRole('link', { name, exact: true });
				if (name === 'r/greece') {
					await link.focus();
					await page.keyboard.press('Enter');
				} else await link.click();
				const id = (await link.getAttribute('href')).slice(1);
				await page.waitForFunction((id) => {
					const nav = document.querySelector('.source-navigation').getBoundingClientRect();
					const heading = document.querySelector('#' + id + ' .feed-title').getBoundingClientRect();
					return heading.top >= nav.bottom - 1 && heading.bottom < innerHeight;
				}, id);
				assert.equal(new URL(page.url()).hash, '#' + id);
				assert((await link.boundingBox()).height >= 44);
			}
		} else assert.equal(await navigation.isVisible(), false);
		const panel = page.locator('#feed-r-greece-rising');
		const row = panel.locator('.feed-list li').first();
		const title = row.locator('.item-title-link');
		const sourceBounds = await row.locator('.item-meta-comments').evaluate((element) => ({
			link: element.getBoundingClientRect().toJSON(),
			icon: element.querySelector('.source-comments-icon').getBoundingClientRect().toJSON()
		}));
		assert(sourceBounds.icon.right <= sourceBounds.link.right + 1, JSON.stringify(sourceBounds));
		assert.equal(await title.getAttribute('aria-haspopup'), null);
		assert.equal(await row.locator('a.item-meta-main-link').count(), 0);
		const popupPromise = page.waitForEvent('popup');
		await title.click();
		const popup = await popupPromise;
		await popup.waitForLoadState();
		assert.match(popup.url(), /^https:\/\/www.reddit.com\/r\/greece\/comments\/fixture/);
		await popup.close();
		assert.equal(await page.locator('.comments-rail').count(), 0, 'article opens only its source');
		assert.equal(await page.locator('.feed-comments-menu').count(), 0);
		if (javaScriptEnabled) {
			const local = row.locator('.item-guest-comments');
			await local.click();
			await page.locator('.comments-rail').waitFor();
			assert.equal(
				await page.locator('.feed-comments-menu').count(),
				0,
				'local discussion does not open source options'
			);
			await page.locator('.comments-rail-close').click();
			await page.locator('.comments-rail').waitFor({ state: 'detached' });
			await row.locator('.item-meta-comments').click();
			await page.locator('.feed-comments-menu').waitFor();
			assert.equal(
				await page.locator('.comments-rail').count(),
				0,
				'source options do not open local discussion'
			);
			await page.keyboard.press('Escape');
			if (width < 1180) {
				assert((await local.boundingBox()).height >= 44);
				assert((await title.boundingBox()).height >= 44);
				assert((await row.locator('.item-meta-comments').boundingBox()).height >= 32);
			}
		}
		await page.evaluate(() => scrollTo(0, 0));
		await page.screenshot({
			path: `/tmp/greeklish-ux-review/${width}-${dark ? 'dark' : 'light'}-${javaScriptEnabled ? 'js' : 'static'}.png`
		});
		console.log(
			`PASS ${width}px ${dark ? 'dark' : 'light'}, JS ${javaScriptEnabled}: navigation, source links, separate discussions, touch sizes and overflow`
		);
		if (width === 1440) {
			await page.evaluate(() => localStorage.setItem('external-links-new-tabs-switch', 'false'));
			await page.reload();
			await page.waitForFunction(() =>
				['open', 'problem'].includes(
					document.querySelector('.live-connection-button')?.dataset.state
				)
			);
			const sameTabTitle = page.locator('#feed-r-greece-rising .item-title-link').first();
			assert.equal(await sameTabTitle.getAttribute('target'), null);
			await sameTabTitle.click();
			await page.waitForURL('https://www.reddit.com/**');
			assert.equal(context.pages().length, 1, 'source navigation respects the same-tab preference');
			console.log('PASS source links respect the same-tab preference');
		}
		await context.close();
	}
	assert.deepEqual(errors, []);
} finally {
	await browser?.close();
	await server.close();
}
