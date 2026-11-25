import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Mount the production feed and comments rail with deterministic data. No backend or images.
const server = await createServer({
	server: { host: '127.0.0.1', hmr: false, fs: { allow: ['.'] } }
});
await server.listen();
const baseURL = server.resolvedUrls.local[0];
let browser;
const errors = [];

async function createPage(
	width,
	height,
	{ touch = false, motion = false, horizontal = false } = {}
) {
	const page = await browser.newPage({
		viewport: { width, height },
		isMobile: touch,
		hasTouch: touch
	});
	page.setDefaultTimeout(10_000);
	page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') console.error(message.text());
	});
	page.on('response', (response) => {
		if (response.status() >= 400) console.error(response.status(), response.url());
	});
	await page.addInitScript(() => {
		globalThis.__sveltekit_dev = { env: {} };
		delete window.SharedWorker;
		window.openedUrls = [];
		window.open = (url) => {
			window.openedUrls.push(url);
			return null;
		};
	});
	await page.routeWebSocket(/.*/, () => {});
	await page.route('**/api/**', async (route) => {
		assert.equal(route.request().method(), 'GET', 'fixture must never write to the backend');
		const path = new URL(route.request().url()).pathname;
		return route.fulfill({
			json: path.includes('/counts/') ? { counts: {} } : { comments: [], guest_comment_count: 0 }
		});
	});
	await page.route('**/__feed-menu-test*', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
				<body><script type="module" src="/tests/fixtures/feed-menu.mjs"></script></body></html>`
		})
	);
	const url = new URL('/__feed-menu-test', baseURL);
	if (motion) url.searchParams.set('motion', '');
	if (horizontal) url.searchParams.set('horizontal', '');
	await page.goto(url.href);
	await page.locator('.item-guest-comments').first().waitFor();
	return page;
}

async function assertMenuFits(page) {
	await page.waitForFunction(() => {
		const menu = document.querySelector('.feed-comments-menu');
		if (!menu || getComputedStyle(menu).visibility !== 'visible') return false;
		const rect = menu.getBoundingClientRect();
		return (
			rect.width > 0 &&
			rect.height > 0 &&
			rect.left >= 7 &&
			rect.top >= 7 &&
			rect.right <= innerWidth - 7 &&
			rect.bottom <= innerHeight - 7
		);
	});
	assert.equal(await page.locator('.feed-comments-menu').count(), 1);
	return page.locator('.feed-comments-menu').boundingBox();
}

async function clickRowAt(page, y, edge = 'left') {
	const title = page.locator('.item-meta-comments').nth(6);
	await title.evaluate((element, targetY) => {
		window.scrollBy(0, element.getBoundingClientRect().top - targetY);
	}, y - 8);
	const box = await title.boundingBox();
	assert(Math.abs(box.y - (y - 8)) <= 1, 'fixture positions the requested row at the click');
	const point = { x: edge === 'right' ? box.x + box.width - 4 : box.x + 20, y };
	await page.mouse.click(point.x, point.y);
	await page.locator('.feed-comments-menu').waitFor();
	return point;
}

try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	for (const [width, touch] of [
		[320, true],
		[390, true],
		[1600, false],
		[2160, false]
	]) {
		const page = await createPage(width, 844, { touch, horizontal: true });
		const cards = page.locator('.feed-list-horizontal li');
		assert.equal(await cards.locator('.item-meta').count(), 0, 'Twitter cards omit empty metadata');
		for (const card of await cards.all()) {
			await card.scrollIntoViewIfNeeded();
			const dimensions = await card.evaluate((element) => {
				const bounds = element.querySelector('.item-main').getBoundingClientRect();
				const title = element.querySelector('.item-title-link').getBoundingClientRect();
				const button = element.querySelector('.item-guest-comments').getBoundingClientRect();
				return {
					center: bounds.top + bounds.height / 2,
					titleCenter: title.top + title.height / 2,
					buttonCenter: button.top + button.height / 2,
					height: bounds.height,
					titleHeight: title.height,
					buttonHeight: button.height
				};
			});
			assert(
				Math.abs(dimensions.titleCenter - dimensions.center) <= 1,
				`${width}: Twitter text centered`
			);
			assert(
				Math.abs(dimensions.buttonCenter - dimensions.center) <= 1,
				`${width}: Twitter button centered`
			);
			assert(
				dimensions.height <= Math.max(dimensions.titleHeight, dimensions.buttonHeight) + 1,
				`${width}: no empty metadata row makes the card taller`
			);
		}
		console.log(`PASS Twitter card height and vertical centering: ${width}px, touch=${touch}`);
		await page.close();
	}
	for (const [width, touch] of [
		[1600, false],
		[390, true],
		[320, false]
	]) {
		const page = await createPage(width, 844, { touch });
		for (const index of [0, 6]) {
			const row = page.locator('.feed-list li').nth(index);
			await row.scrollIntoViewIfNeeded();
			const dimensions = await row.evaluate((element) => {
				const button = element.querySelector('.item-guest-comments');
				const rect = button.getBoundingClientRect();
				const content = element.querySelector('.item-content').getBoundingClientRect();
				const centers = [...button.children].map((child) => {
					const bounds = child.getBoundingClientRect();
					return bounds.top + bounds.height / 2;
				});
				return {
					top: rect.top,
					bottom: rect.bottom,
					center: rect.top + rect.height / 2,
					contentTop: content.top,
					contentBottom: content.bottom,
					centers
				};
			});
			assert(
				Math.abs(dimensions.center - (dimensions.contentTop + dimensions.contentBottom) / 2) <= 1,
				`${width}: comment button vertically centered beside the content`
			);
			for (const center of dimensions.centers)
				assert(
					Math.abs(center - dimensions.center) <= 1,
					`${width}: icon and count vertically centered`
				);
		}
		// The lower edge of the comment button should still open the discussion.
		const button = page.locator('.item-guest-comments').nth(6);
		const box = await button.boundingBox();
		await button.click({ position: { x: box.width / 2, y: box.height - 3 } });
		assert.equal(await button.getAttribute('aria-expanded'), 'true');
		assert.equal(await page.locator('.feed-comments-menu').count(), 0);
		await page.keyboard.press('Escape');
		await page.locator('.comments-rail').waitFor({ state: 'detached' });
		console.log(`PASS centered comment button and contents: ${width}px, touch=${touch}`);
		await page.close();
	}

	for (const [width, height, y, edge] of [
		[1600, 900, 60, 'left'],
		[1600, 900, 870, 'left'],
		[390, 844, 814, 'right'],
		[320, 568, 538, 'left'],
		[2560, 1000, 970, 'right']
	]) {
		const page = await createPage(width, height, { touch: width < 768 });
		const point = await clickRowAt(page, y, edge);
		const menu = await assertMenuFits(page);
		if (y < 100) assert(menu.y >= point.y, 'menu opens below when there is room');
		else assert(menu.y + menu.height <= point.y, 'menu flips above near the bottom');
		await page.locator('.feed-comments-menu .wx-option').last().click();
		await page.locator('.feed-comments-menu').waitFor({ state: 'detached' });
		assert.match((await page.evaluate(() => window.openedUrls))[0], /fixture6.*sort=qa/);
		console.log(`PASS menu placement and last option: ${width}x${height}, ${edge} edge, y=${y}`);
		await page.close();
	}

	const short = await createPage(844, 180);
	await clickRowAt(short, 130, 'right');
	await assertMenuFits(short);
	const menu = short.locator('.feed-comments-menu');
	assert(
		await menu.evaluate((element) => element.scrollHeight > element.clientHeight),
		'tall menu scrolls'
	);
	await menu.locator('.wx-option').last().click();
	assert.match((await short.evaluate(() => window.openedUrls))[0], /sort=qa/);
	console.log('PASS short viewport scrolls to a reachable last option');
	await short.close();

	const page = await createPage(1600, 900, { motion: true });
	await clickRowAt(page, 850);
	await assertMenuFits(page);
	assert.equal(
		await page.locator('.comments-rail').count(),
		0,
		'source options do not open local comments'
	);
	await assertMenuFits(page);
	await page.setViewportSize({ width: 390, height: 360 });
	await assertMenuFits(page);
	await page.keyboard.press('Escape');
	await page.locator('.feed-comments-menu').waitFor({ state: 'detached' });
	assert.equal(
		await page.locator('.comments-rail').count(),
		0,
		'Source options never open a local discussion'
	);
	await page.setViewportSize({ width: 1600, height: 900 });
	const link = page.locator('.item-meta-comments').nth(6);
	await link.scrollIntoViewIfNeeded();
	await link.focus();
	await link.press('Enter');
	const keyboardMenu = await assertMenuFits(page);
	const anchor = await link.boundingBox();
	assert(
		keyboardMenu.x <= anchor.x + anchor.width && keyboardMenu.x + keyboardMenu.width >= anchor.x,
		'keyboard menu remains horizontally adjacent to the focused link when shifted at an edge'
	);
	assert(
		Math.abs(keyboardMenu.y - (anchor.y + anchor.height + 4)) < 2 ||
			Math.abs(keyboardMenu.y + keyboardMenu.height - (anchor.y - 4)) < 2,
		'keyboard menu is positioned above or below the focused link'
	);
	await page.locator('.feed-title').click();
	await page.locator('.feed-comments-menu').waitFor({ state: 'detached' });
	console.log(
		'PASS source menu isolation, viewport resize, Escape, keyboard anchor and outside click'
	);
	await page.close();
	assert.deepEqual(errors, [], 'no browser errors');
} catch (error) {
	console.error('Browser errors:', errors);
	throw error;
} finally {
	await browser?.close();
	await server.close();
}
