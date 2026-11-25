// Run against a running UI and backend (or a preview with prerendered feed data).
// Comment submissions and moderator operations use intercepted fixture responses only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	headless: true
});
const baseURL = process.env.UI_REVIEW_BASE_URL ?? 'http://127.0.0.1:5173';
const dir = process.env.UI_REVIEW_OUTPUT ?? 'test-results/comments-ui';
await fs.mkdir(dir, { recursive: true });
const errors = [];
async function createPage(width = 1600, height = 1000, opts = {}) {
	const page = await browser.newPage({ viewport: { width, height }, ...opts });
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
	await page.locator('.item-guest-comments').first().waitFor();
	await page.waitForTimeout(600);
	return page;
}
async function captureMotion(page, close = false) {
	return page.evaluate(async (close) => {
		const first = document.querySelector('.feed-panel');
		const main = document.querySelector('.app-main');
		const result = [];
		const start = performance.now();
		(close
			? document.querySelector('.comments-rail-close')
			: document.querySelector('.item-guest-comments')
		).click();
		await new Promise((resolve) => {
			const frame = () => {
				result.push({
					time: performance.now() - start,
					width: main.getBoundingClientRect().width,
					slot: document.querySelector('.comments-rail-slot')?.getBoundingClientRect().width ?? 0,
					originalFeed: first.isConnected
				});
				if (performance.now() - start < 600) requestAnimationFrame(frame);
				else resolve();
			};
			requestAnimationFrame(frame);
		});
		return result;
	}, close);
}
try {
	for (const [width, height] of [
		[320, 740],
		[390, 844],
		[430, 932],
		[640, 900],
		[768, 1024],
		[1024, 768],
		[1280, 800],
		[1440, 900],
		[1600, 1000],
		[1680, 1050],
		[1920, 1080],
		[2160, 1200],
		[2560, 1440]
	]) {
		const page = await browser.newPage({
			viewport: { width, height },
			deviceScaleFactor: 1,
			isMobile: width < 768,
			hasTouch: width < 768
		});
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
		await page.locator('.item-guest-comments').first().waitFor();
		await page.waitForTimeout(600);
		const trigger = page.locator('.item-guest-comments').first();
		const row = page.locator('.feed-list li').first();
		assert.match((await trigger.innerText()).trim(), /^[0-9.,]+$/);
		const bb = await trigger.boundingBox(),
			title = await row.locator('.item-title-link').boundingBox();
		assert(bb.x + bb.width <= title.x + 1, `${width}: comment button precedes title`);
		await trigger.click();
		await page.waitForTimeout(450);
		const rail = page.locator('.comments-rail');
		const cls = await rail.getAttribute('class');
		assert(((await row.getAttribute('class')) ?? '').includes('item-comments-selected'));
		assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
		assert.equal(
			await page.locator('.comments-thread-error').count(),
			0,
			`thread errors at ${width}`
		);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth
		);
		assert(!overflow, `horizontal overflow at ${width}`);
		const panel = await rail.boundingBox();
		assert(panel.x >= 0 && panel.x + panel.width <= width + 1, `rail within viewport ${width}`);
		const composer = await page.locator('.comment-composer').boundingBox();
		assert(composer.y + composer.height <= height + 1, `composer within viewport ${width}`);
		const controls = await page.locator('.header-controls').boundingBox();
		if (cls.includes('push'))
			assert(controls.x + controls.width <= panel.x + 1, `toolbar inside feed ${width}`);
		else
			assert(
				await page.locator('.app-main').evaluate((el) => el.inert),
				`modal background inert ${width}`
			);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(450);
		assert.equal(await rail.count(), 0, `Escape closes ${width}`);
		assert.equal(await page.evaluate(() => document.body.style.overflow), '');
		assert.equal(await page.locator('.app-main').evaluate((el) => el.inert), false);
		assert.equal(
			await page.evaluate(() => document.activeElement?.className),
			'item-guest-comments'
		);
		assert.equal(await page.evaluate(() => location.hash), '');
		console.log('PASS responsive', width, height, cls);
		await page.close();
	}

	for (const width of [1600, 2160]) {
		const page = await createPage(width);
		for (const close of [false, true]) {
			const samples = await captureMotion(page, close);
			await fs.writeFile(
				`${dir}/motion-${width}-${close ? 'close' : 'open'}.json`,
				JSON.stringify(samples, null, 2)
			);
			const intermediate = samples.filter((x) => x.slot > 5 && x.slot < 350);
			assert(intermediate.length >= 5, `${width} ${close}: animated layout frames`);
			assert(
				samples.every((x) => x.originalFeed),
				`${width}: feed remount`
			);
			const deltas = samples.slice(1).map((x, i) => Math.abs(x.width - samples[i].width));
			assert(Math.max(...deltas) < 140, `${width}: layout snap ${Math.max(...deltas)}`);
			console.log(
				'PASS motion',
				width,
				close ? 'close' : 'open',
				intermediate.length,
				'intermediate frames; max step',
				Math.round(Math.max(...deltas))
			);
		}
		await page.close();
	}
	let page = await createPage();
	let buttons = page.locator('.item-guest-comments');
	// Real read-only API: drafts are local and kept separate by article.
	await buttons.nth(0).click();
	await page.waitForTimeout(400);
	await page.locator('.composer-body').fill('Πρόχειρο για την πρώτη είδηση');
	await buttons.nth(1).click();
	assert.equal(await page.locator('.composer-body').inputValue(), '');
	await page.locator('.composer-body').fill('Άλλο πρόχειρο');
	await buttons.nth(0).click();
	assert.equal(await page.locator('.composer-body').inputValue(), 'Πρόχειρο για την πρώτη είδηση');
	assert.equal(await page.locator('.item-comments-selected').count(), 1);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	await buttons.nth(1).click();
	await page.waitForTimeout(400);
	assert.equal(await page.locator('.composer-body').inputValue(), 'Άλλο πρόχειρο');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	assert(await buttons.nth(1).evaluate((el) => el === document.activeElement));
	console.log('PASS drafts, selection and focus after switching articles');
	await page.evaluate(() => document.querySelector('.item-guest-comments').click());
	await page.waitForTimeout(80);
	await page.evaluate(() => document.querySelector('.comments-rail-close').click());
	await page.waitForTimeout(70);
	await page.evaluate(() => document.querySelector('.item-guest-comments').click());
	await page.waitForTimeout(500);
	assert.equal(await page.locator('.comments-rail').count(), 1);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	console.log('PASS rapid open/close/reopen');
	await page.close();
	page = await createPage();
	buttons = page.locator('.item-guest-comments');
	// Fixture-only write paths: never publish review comments or moderate live data.
	let posts = 0;
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url()),
			path = url.pathname;
		const fulfill = (json, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
		if (path === '/api/captcha/challenge') {
			await new Promise((r) => setTimeout(r, 350));
			return fulfill({
				algorithm: 'SHA-256',
				challenge: createHash('sha256').update('review0').digest('hex'),
				salt: 'review',
				maxnumber: 1,
				signature: 'fixture'
			});
		}
		if (path === '/api/comments' && route.request().method() === 'POST') {
			posts++;
			return fulfill(
				{
					comment: {
						id: 'new',
						author_display_name: 'Επισκέπτης',
						body: JSON.parse(route.request().postData()).body,
						created_at: new Date().toISOString(),
						status: 'pending',
						auto_approved: false,
						own: true
					},
					guest_comment_count: 12,
					author_token: 'review-only'
				},
				201
			);
		}
		if (path.startsWith('/api/comments/') && !path.startsWith('/api/comments/counts/')) {
			const [, , , topic, external_id] = path.split('/');
			return fulfill({
				topic,
				external_id,
				guest_comment_count: 12,
				comments: Array.from({ length: 12 }, (_, i) => ({
					id: `fixture-${i}`,
					author_display_name: `Αναγνώστης ${i + 1}`,
					body: 'Ένα δοκιμαστικό σχόλιο για τον έλεγχο της διάταξης και της κύλισης.',
					created_at: new Date(Date.now() - i * 60000).toISOString(),
					status: 'approved',
					auto_approved: false,
					own: false
				})).reverse()
			});
		}
		if (path === '/api/moderation/session')
			return route.request().method() === 'DELETE'
				? route.fulfill({ status: 204 })
				: fulfill({ expires_at: new Date(Date.now() + 3600000).toISOString() }, 201);
		if (path === '/api/moderation/stats')
			return fulfill({
				pending: 0,
				approved: 12,
				rejected: 0,
				spam: 0,
				hidden: 0,
				auto_approved: 0
			});
		if (path === '/api/moderation/feeds') return fulfill([{ slug: 'test', display_name: 'Test' }]);
		if (path === '/api/moderation/queue') return fulfill({ comments: [], next_cursor: null });
		if (path === '/api/moderation/log') return fulfill({ events: [], next_cursor: null });
		if (route.request().method() !== 'GET') throw Error('Unexpected write ' + path);
		return route.continue();
	});
	await buttons.nth(2).click();
	await page.waitForTimeout(450);
	assert.equal((await buttons.nth(2).innerText()).trim(), '12');
	assert.match(await page.locator('.comments-rail-count').innerText(), /12/);
	await page.locator('.composer-body').fill('Δοκιμή με ελεγχόμενη απόκριση');
	await page.locator('.composer-send').click();
	await page.waitForTimeout(700);
	assert.equal(posts, 1);
	assert.equal(await page.locator('.composer-body').inputValue(), '');
	assert.match(await page.locator('.composer-status').innerText(), /στάλθηκε για έλεγχο/);
	console.log('PASS populated count, scrollable thread and submit while captcha is preparing');
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	await page.locator('body').click({ position: { x: 5, y: 5 } });
	for (const key of [
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
	])
		await page.keyboard.press(key);
	await page.locator('input[type=password]').fill('fixture-password');
	await page.locator('input[type=password]').press('Enter');
	await page.waitForTimeout(500);
	assert.equal(await page.locator('.comments-rail-title').innerText(), 'Διαχείριση σχολίων');
	assert.equal(await page.locator('.moderation-panel').count(), 1);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	await buttons.nth(0).click();
	await page.waitForTimeout(400);
	assert.equal(await page.locator('.moderation-panel').count(), 0);
	assert.equal(await page.locator('.comment-composer').count(), 1);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	await page.locator('.moderation-button').click();
	await page.waitForTimeout(400);
	await page.locator('.moderation-logout').click();
	await page.waitForTimeout(400);
	assert.equal(await page.locator('.comments-rail').count(), 0);
	assert.equal(await page.locator('.moderation-button').count(), 0);
	console.log(
		'PASS moderator login opens console, normal comments stay accessible, logout closes console'
	);
	await page.close();
	const mobile = await createPage(390, 844, { isMobile: true, hasTouch: true });
	await mobile.locator('.item-guest-comments').first().click();
	await mobile.waitForTimeout(400);
	await mobile.keyboard.press('Shift+Tab');
	assert(
		await mobile.locator('.comments-rail').evaluate((el) => el.contains(document.activeElement))
	);
	const grip = await mobile.locator('.comments-rail-grip').boundingBox();
	await mobile.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
	await mobile.mouse.down();
	await mobile.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 120, { steps: 8 });
	await mobile.mouse.up();
	await mobile.waitForTimeout(450);
	assert.equal(await mobile.locator('.comments-rail').count(), 0);
	console.log('PASS mobile focus containment and drag-to-dismiss');
	await mobile.close();
	for (const reduced of ['system', 'setting']) {
		const p = await browser.newPage({
			viewport: { width: 1600, height: 900 },
			reducedMotion: reduced === 'system' ? 'reduce' : 'no-preference'
		});
		if (reduced === 'setting')
			await p.addInitScript(() => localStorage.setItem('reduce-animations-switch', 'true'));
		await p.goto(baseURL, { waitUntil: 'domcontentloaded' });
		await p.locator('.item-guest-comments').first().waitFor();
		await p.waitForTimeout(500);
		await p.locator('.item-guest-comments').first().click();
		await p.waitForTimeout(40);
		assert.equal(
			await p.locator('.comments-rail-slot').evaluate((el) => el.getAnimations().length),
			0
		);
		await p.keyboard.press('Escape');
		await p.waitForTimeout(40);
		assert.equal(await p.locator('.comments-rail').count(), 0);
		console.log('PASS reduced motion', reduced);
		await p.close();
	}
	page = await createPage();
	for (const width of [
		767, 768, 782, 783, 1180, 1539, 1540, 1554, 1555, 1679, 1680, 1694, 1695, 2059, 2060, 2074, 2075
	]) {
		await page.setViewportSize({ width, height: 900 });
		await page.waitForTimeout(250);
		await page.evaluate(() => (window.originalFeed = document.querySelector('.feed-panel')));
		const modeBefore = await page.locator('.feed-stack').getAttribute('class');
		await page.locator('.item-guest-comments').first().click();
		await page.waitForTimeout(400);
		assert(await page.evaluate(() => window.originalFeed.isConnected), `Feed remount at ${width}`);
		assert.equal(
			await page.locator('.feed-stack').getAttribute('class'),
			modeBefore,
			`Column change ${width}`
		);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		assert(await page.evaluate(() => window.originalFeed.isConnected), `Close remount at ${width}`);
		assert.equal(await page.locator('.comments-rail').count(), 0);
		console.log('PASS breakpoint', width);
	}
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.waitForTimeout(250);
	await page.locator('.item-guest-comments').first().click();
	await page.waitForTimeout(400);
	for (const [width, height] of [
		[390, 360],
		[844, 390],
		[2160, 1000],
		[1024, 768],
		[320, 568]
	]) {
		await page.setViewportSize({ width, height });
		await page.waitForTimeout(450);
		const b = await page.locator('.comment-composer').boundingBox();
		assert(b.y + b.height <= height + 1, `Composer clipped ${width}x${height}`);
		assert.equal(await page.locator('.comments-rail').count(), 1);
	}
	await page.keyboard.press('Escape');
	await page.waitForTimeout(450);
	assert.equal(await page.locator('.app-main').evaluate((el) => el.inert), false);
	assert.equal(await page.evaluate(() => document.body.style.overflow), '');
	console.log('PASS resizing open rail across modes and short/landscape viewports');
	// Narrow-page feed chips must still wrap without horizontal overflow.
	for (const width of [390, 2160]) {
		await page.setViewportSize({ width, height: 1000 });
		await page.waitForTimeout(300);
		const feed = page.locator('.feed-panel-horizontal');
		await feed.scrollIntoViewIfNeeded();
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	}

	await page.close();
	assert.deepEqual(errors, []);
} finally {
	await browser.close();
}
