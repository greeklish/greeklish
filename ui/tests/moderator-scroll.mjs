import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
	server: { host: '127.0.0.1', hmr: false, fs: { allow: ['.'] } }
});
await server.listen();
let browser;
const errors = [];
const failures = [];
const keys = [
	'ArrowUp',
	'ArrowUp',
	'ArrowDown',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	'ArrowLeft',
	'ArrowRight',
	'b',
	'a'
];

async function createPage(width, reduce) {
	const page = await browser.newPage({
		viewport: { width, height: 900 },
		isMobile: width < 768,
		hasTouch: width < 768
	});
	page.setDefaultTimeout(5000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => {
		globalThis.__sveltekit_dev = { env: {} };
	});
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/moderation/session') {
			assert.equal(route.request().method(), 'POST');
			assert.equal(route.request().postDataJSON().password, 'fixture-password');
			return route.fulfill({
				status: 201,
				json: { expires_at: new Date(Date.now() + 3600000).toISOString() }
			});
		}
		assert.equal(route.request().method(), 'GET', 'no real moderator writes');
		if (path === '/api/moderation/feeds') return route.fulfill({ json: [] });
		if (path === '/api/moderation/stats')
			return route.fulfill({
				json: { pending: 12, approved: 0, rejected: 0, spam: 0, hidden: 0, auto_approved: 0 }
			});
		if (path === '/api/moderation/queue')
			return route.fulfill({
				json: {
					comments: Array.from({ length: 12 }, (_, i) => ({
						id: `fixture-${i}`,
						body: 'A pending comment used only by the browser test.',
						author_id: 'author',
						author_display_name: 'Fixture author',
						author_approved_count: 0,
						author_trust_state: 'normal',
						author_fingerprint: null,
						status: 'pending',
						auto_approved: false,
						hold_reason: 'below_threshold',
						created_at: new Date().toISOString(),
						topic: 'test',
						topic_display_name: 'Test',
						external_id: 'fixture',
						item_title: 'Test article',
						item_url: 'https://example.test'
					})),
					next_cursor: null
				}
			});
		throw new Error(`Unexpected API request: ${path}`);
	});
	await page.route('**/__moderator-scroll*', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script type="module" src="/tests/fixtures/moderator-scroll.mjs"></script></body></html>'
		})
	);
	await page.goto(
		new URL(`/__moderator-scroll${reduce ? '?reduce' : ''}`, server.resolvedUrls.local[0]).href
	);
	await page.locator('body[data-ready=true]').waitFor();
	return page;
}

async function enterModerator(page) {
	await page.locator('#settings').focus();
	for (const key of keys) await page.keyboard.press(key);
	await page.locator('input[type=password]').fill('fixture-password');
	await page.locator('input[type=password]').press('Enter');
	await page.locator('.moderation-card').first().waitFor();
	await page.locator('input[type=password]').waitFor({ state: 'detached' });
	await page.waitForTimeout(400);
}

async function assertPageScrolls(page) {
	await page.mouse.move(50, 600);
	await page.mouse.wheel(0, 400);
	await page.waitForFunction(() => scrollY > 100);
}

try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	for (const width of [390, 1280, 1600, 1920])
		for (const reduce of [false, true]) {
			const page = await createPage(width, reduce);
			try {
				await enterModerator(page);
				const modal = width !== 1600;
				const lockedDuringModeration = await page.evaluate(() => document.body.style.overflow);
				const panel = page.locator('.moderation-panel');
				const bounds = await panel.boundingBox();
				await page.mouse.move(bounds.x + 40, bounds.y + bounds.height - 40);
				await page.mouse.wheel(0, 400);
				await page.waitForFunction(
					() => document.querySelector('.moderation-panel').scrollTop > 100
				);
				await page.locator('.comments-rail-close').click();
				await page.locator('.comments-rail').waitFor({ state: 'detached' });
				assert.equal(
					await page.evaluate(() => document.body.style.overflow),
					'',
					'closing moderation restores page scrolling'
				);
				assert.equal(await page.locator('.app-main').evaluate((node) => node.inert), false);
				await assertPageScrolls(page);
				assert.equal(
					lockedDuringModeration,
					modal ? 'hidden' : '',
					'overlay keeps its lock when the password dialog closes'
				);
				await page.evaluate(() => scrollTo(0, 0));
				await page.locator('.moderation-button').click();
				await page.locator('.moderation-panel').waitFor();
				if (width === 1280 && !reduce) {
					await page.setViewportSize({ width: 1600, height: 900 });
					await page.locator('.comments-rail-push').waitFor();
					assert.equal(await page.evaluate(() => document.body.style.overflow), '');
					await assertPageScrolls(page);
					await page.setViewportSize({ width: 1280, height: 900 });
					await page.locator('.comments-rail-overlay').waitFor();
					assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
				}
				await page.keyboard.press('Escape');
				await page.locator('.comments-rail').waitFor({ state: 'detached' });
				assert.equal(await page.evaluate(() => document.body.style.overflow), '');
				console.log(
					`PASS login, panel scrolling, close/reopen and page scrolling at ${width}px, reduced=${reduce}`
				);
			} catch (error) {
				failures.push(`${width}px reduced=${reduce}: ${error.message}`);
				console.error(`FAIL ${failures.at(-1)}`);
			} finally {
				await page.close();
			}
		}
	const page = await createPage(1280, false);
	await page.evaluate(() => document.body.style.setProperty('overflow', 'auto', 'important'));
	await enterModerator(page);
	await page.locator('.comments-rail-close').click();
	await page.locator('.comments-rail').waitFor({ state: 'detached' });
	assert.equal(await page.evaluate(() => document.body.style.overflow), 'auto');
	assert.equal(
		await page.evaluate(() => document.body.style.getPropertyPriority('overflow')),
		'important'
	);
	await assertPageScrolls(page);
	await page.close();
	console.log('PASS responsive lock changes and restoration of existing overflow styles');
	assert.deepEqual(errors, []);
	assert.deepEqual(failures, []);
} finally {
	await browser?.close();
	await server.close();
}
