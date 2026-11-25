import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
	plugins: [
		{
			name: 'personalization-fixtures',
			enforce: 'pre',
			load(id) {
				if (!id.endsWith('/src/lib/server/initial-feed.ts')) return;
				return `export async function loadInitialFeeds(topics) {
			const now = Date.now(), timestamp = new Date(now).toISOString();
			return { feeds: Object.fromEntries(topics.map(topic => [topic.topic, {
				displayName: topic.displayName, strategy: topic.strategy, asOf: now,
				snapshots: [{ id: topic.topic, crawled_at: timestamp, items: Array.from({length: 40}, (_, i) => ({
					external_id: 'item-' + i, title: i === 2 ? 'Trending with Πουτιν' : 'Θέμα ' + i + ' από ' + topic.displayName,
					url: topic.topic === 'x-trends' ? 'https://x.com/search?q=example' : 'https://www.reddit.com/r/greece/comments/item' + i,
					score: 100 - i, comments_count: 10, rank_position: i + 1,
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
const errors = [];
const browser = await chromium.launch({
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
	headless: true
});
const storageKey = 'greeklish-feed-preferences';
const sourceOrder = (page) =>
	page.locator('.feed-panel').evaluateAll((nodes) => nodes.map((node) => node.dataset.topic));

async function createContext(width = 390, dark = false, blocked = false) {
	const context = await browser.newContext({
		viewport: { width, height: 900 },
		isMobile: width < 768,
		hasTouch: width < 768,
		colorScheme: dark ? 'dark' : 'light'
	});
	context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
	await context.addInitScript(
		({ blocked }) => {
			delete window.SharedWorker;
			if (blocked) {
				Storage.prototype.getItem = Storage.prototype.setItem = () => {
					throw new DOMException('Unavailable', 'SecurityError');
				};
			} else {
				try {
					localStorage.setItem('xcancel-switch', 'true');
				} catch {
					/* Initial opaque document. */
				}
			}
		},
		{ blocked }
	);
	await context.routeWebSocket(/.*/, () => {});
	await context.route('**/api/**', (route) =>
		route.fulfill({
			json: { counts: {}, comments: [], guest_comment_count: 0, discussions: [], next_cursor: null }
		})
	);
	return context;
}

async function open(context) {
	const page = await context.newPage();
	page.setDefaultTimeout(7000);
	await page.goto(server.resolvedUrls.local[0]);
	await ready(page);
	return page;
}

async function ready(page) {
	await page.waitForFunction(() =>
		['open', 'problem'].includes(document.querySelector('.live-connection-button')?.dataset.state)
	);
}

async function settings(page) {
	await page.getByRole('button', { name: 'Ρυθμίσεις', exact: true }).click();
	await page.getByRole('dialog', { name: 'Ρυθμίσεις', exact: true }).waitFor();
}

async function closeSettings(page) {
	await page.keyboard.press('Escape');
	await page.getByRole('dialog', { name: 'Ρυθμίσεις', exact: true }).waitFor({ state: 'detached' });
}

async function hideFirst(page) {
	const panel = page.locator('#feed-r-greece-rising');
	const row = panel.locator('.feed-list li').first();
	const id = await row.getAttribute('data-feed-item-id');
	await row.locator('.item-actions-button').click();
	await page.getByRole('menuitem', { name: 'Απόκρυψη θέματος', exact: true }).click();
	await panel.locator(`[data-feed-item-id="${id}"]`).waitFor({ state: 'detached' });
	return id;
}

try {
	await mkdir('/tmp/greeklish-personalization-review', { recursive: true });
	for (const [width, dark, hideGreece] of [
		[390, false, false],
		[2160, true, false],
		[2160, false, true]
	]) {
		const context = await createContext(width, dark);
		const order = [
			'r-greece-rising',
			'x-trends',
			'insomnia-topics',
			'phorum-topics',
			'adslgr-topics',
			'myphone-topics',
			'lagonika-offers'
		];
		const expected = order.filter((topic) => !hideGreece || topic !== 'r-greece-rising');
		await context.addInitScript(
			({ storageKey, order, hideGreece }) => {
				if (location.protocol === 'about:') return;
				localStorage.setItem(
					storageKey,
					JSON.stringify({
						version: 1,
						order,
						hiddenSources: hideGreece ? ['r-greece-rising'] : [],
						hiddenTopics: [{ topic: 'x-trends', externalId: 'item-0', title: 'Hidden topic' }]
					})
				);
			},
			{ storageKey, order, hideGreece }
		);
		let release;
		const scriptsReady = new Promise((resolve) => (release = resolve));
		await context.route('**/*', async (route) => {
			if (
				route.request().resourceType() === 'script' &&
				!/(?:theme|feed-preferences)-init\.js$/.test(new URL(route.request().url()).pathname)
			)
				await scriptsReady;
			await route.fallback();
		});
		const page = await context.newPage();
		page.on('console', (message) => {
			if (/hydration_/i.test(message.text())) errors.push(message.text());
		});
		try {
			await page.goto(server.resolvedUrls.local[0], { waitUntil: 'commit' });
			await page.waitForFunction(() => document.querySelectorAll('.feed-panel').length === 7);
			assert.deepEqual(await sourceOrder(page), [
				order[0],
				order[2],
				order[3],
				order[1],
				...order.slice(4)
			]);
			assert.equal(
				await page.locator('#feed-x-trends [data-feed-item-id="item-2"]').count(),
				0,
				'old related-trends captions are excluded even before hydration'
			);
			assert.equal(
				await page.locator('#feed-insomnia-topics [data-feed-item-id="item-2"]').count(),
				1,
				'other feed titles are unaffected'
			);
			const sample = await page.evaluate(() => {
				window.initialFeedFrames = [];
				const capture = () => {
					const panels = [...document.querySelectorAll('.feed-panel')]
						.filter((node) => getComputedStyle(node).display !== 'none')
						.map((node) => ({ topic: node.dataset.topic, box: node.getBoundingClientRect() }))
						.sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
					const twitter = document.querySelector('#feed-x-trends');
					const stack = document.querySelector('.feed-stack');
					const frame = {
						order: panels.map((panel) => panel.topic),
						width: twitter.getBoundingClientRect().width,
						stackWidth: stack.getBoundingClientRect().width,
						columnWidth: parseFloat(getComputedStyle(stack).gridTemplateColumns)
					};
					window.initialFeedFrames.push(frame);
					window.initialFeedFrameId = requestAnimationFrame(capture);
					return frame;
				};
				return capture();
			});
			assert.deepEqual(
				sample.order,
				expected,
				'saved order is visible before application scripts load'
			);
			assert.equal(
				await page.locator('#feed-x-trends li[data-feed-item-id="item-0"]').isVisible(),
				false
			);
			if (width === 390) {
				const links = await page
					.locator('.source-links a')
					.evaluateAll((nodes) =>
						nodes
							.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
							.map((node) => node.getAttribute('href').slice(6))
					);
				assert.deepEqual(
					links,
					expected,
					'mobile source navigation already follows the saved order'
				);
			}
			release();
			await ready(page);
			assert.equal(
				await page.locator('#feed-x-trends [data-feed-item-id="item-2"]').count(),
				0,
				'captions remain excluded after hydration'
			);
			await page.waitForFunction(() => !document.getElementById('feed-preferences-initial'));
			await page.evaluate(
				() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			);
			const frames = await page.evaluate(() => {
				cancelAnimationFrame(window.initialFeedFrameId);
				return window.initialFeedFrames;
			});
			assert(frames.length >= 2);
			for (const frame of frames) {
				assert.deepEqual(
					frame.order,
					expected,
					'no frame flashes the default order during hydration'
				);
				const wide = width === 2160 && hideGreece;
				assert(
					Math.abs(frame.width - (wide ? frame.stackWidth : frame.columnWidth)) < 1,
					JSON.stringify(frame)
				);
			}
			assert.deepEqual(
				await sourceOrder(page),
				expected,
				'DOM and reading order match after hydration'
			);
			await settings(page);
			await page.getByRole('button', { name: 'Επαναφορά πηγών και σειράς', exact: true }).click();
			await closeSettings(page);
			assert.equal(
				(await sourceOrder(page))[1],
				'insomnia-topics',
				'initial styles do not override later changes'
			);
			console.log(
				`PASS initial preferences ${width}px ${dark ? 'dark' : 'light'}: saved layout before hydration and no ordering or Twitter width flash`
			);
		} finally {
			release();
			await context.close();
		}
	}
	for (const [width, dark] of [
		[390, false],
		[1440, true]
	]) {
		const context = await createContext(width, dark);
		const page = await open(context);
		const original = await sourceOrder(page);
		assert.equal(original.length, 7);
		const firstRow = page.locator('#feed-r-greece-rising .feed-list li').first();
		const sourceLink = firstRow.locator('.item-meta-comments');
		const actions = firstRow.locator('.item-actions-button');
		const menu = page.getByRole('menu');
		const menuStyle = () =>
			menu.evaluate((node) => {
				const style = getComputedStyle(node);
				return [
					style.border,
					style.borderRadius,
					style.backgroundColor,
					style.boxShadow,
					style.fontFamily
				];
			});
		await sourceLink.click();
		await menu.waitFor();
		const sourceStyle = await menuStyle();
		await page.keyboard.press('Escape');
		await actions.click();
		await menu.waitFor();
		assert.deepEqual(await menuStyle(), sourceStyle, 'both menus have the same theme styling');
		assert.equal(await menu.getByRole('menuitem').count(), 1);
		const bounds = await menu.boundingBox();
		assert(
			bounds.width < 210 && bounds.x >= 7 && bounds.x + bounds.width <= width - 7,
			'single-action menu stays compact and inside the viewport'
		);
		if (width < 768) assert((await menu.getByRole('menuitem').boundingBox()).height >= 44);
		await page.locator('.site-intro h1').click();
		await menu.waitFor({ state: 'detached' });
		await actions.focus();
		await page.keyboard.press('Enter');
		await menu.waitFor();
		assert(
			await menu.getByRole('menuitem').evaluate((node) => node === document.activeElement),
			'keyboard opening focuses the action'
		);
		await page.keyboard.press('Escape');
		assert(
			await actions.evaluate((node) => node === document.activeElement),
			'Escape restores trigger focus'
		);
		await page.keyboard.press('Enter');
		await menu.waitFor();
		await page.keyboard.press('Enter');
		await menu.waitFor({ state: 'detached' });
		assert(
			await page
				.locator('.feed-undo .undo-action')
				.evaluate((node) => node === document.activeElement),
			'keyboard hiding moves focus to Undo'
		);
		await page.locator('.feed-undo .undo-action').click();
		await sourceLink.focus();
		await page.keyboard.press('Enter');
		await menu.waitFor();
		await page.keyboard.press('End');
		assert(
			await menu
				.getByRole('menuitem')
				.last()
				.evaluate((node) => node === document.activeElement)
		);
		await page.keyboard.press('Home');
		assert(
			await menu
				.getByRole('menuitem')
				.first()
				.evaluate((node) => node === document.activeElement)
		);
		await page.keyboard.press('Escape');
		console.log(
			`PASS matching menus ${width}px: theme, compact size, outside click, keyboard navigation, hide and Undo focus`
		);
		assert.match(
			await page.locator('#feed-x-trends .item-title-link').first().getAttribute('href'),
			/^https:\/\/x\.com\//
		);
		await settings(page);
		assert.equal(await page.getByText('Άνοιγμα στο xcancel.com').count(), 0);
		const greeceHandle = page.getByRole('button', {
			name: 'Μετακίνηση r/greece: σύρε ή χρησιμοποίησε τα βέλη',
			exact: true
		});
		await greeceHandle.focus();
		await page.keyboard.press('ArrowDown');
		assert.equal((await sourceOrder(page))[0], 'insomnia-topics');
		assert(await greeceHandle.evaluate((node) => node === document.activeElement));
		await page.keyboard.press('ArrowUp');
		assert.deepEqual(await sourceOrder(page), original);
		if (width >= 768) {
			await greeceHandle.dragTo(
				page.getByRole('button', {
					name: 'Μετακίνηση phorum: σύρε ή χρησιμοποίησε τα βέλη',
					exact: true
				})
			);
			assert.equal((await sourceOrder(page))[2], 'r-greece-rising');
			await page.getByRole('button', { name: 'Επαναφορά πηγών και σειράς', exact: true }).click();
		}
		await page.getByRole('button', { name: 'r/greece: μετακίνηση κάτω', exact: true }).click();
		await page.getByRole('checkbox', { name: 'insomnia', exact: true }).uncheck();
		await page.getByRole('checkbox', { name: 'twitter/x', exact: true }).uncheck();
		await closeSettings(page);
		assert.deepEqual(
			await sourceOrder(page),
			original.filter((topic) => !['insomnia-topics', 'x-trends'].includes(topic))
		);
		await page.reload();
		await ready(page);
		assert.equal(await page.locator('.feed-panel').count(), 5);
		const second = await open(context);
		await settings(page);
		await page.getByRole('button', { name: 'Επαναφορά πηγών και σειράς', exact: true }).click();
		await second.waitForFunction(() => document.querySelectorAll('.feed-panel').length === 7);
		assert.deepEqual(await sourceOrder(second), original);
		await page.getByRole('button', { name: 'r/greece: μετακίνηση κάτω', exact: true }).click();
		await closeSettings(page);
		assert.deepEqual((await sourceOrder(page)).slice(0, 2), ['insomnia-topics', 'r-greece-rising']);
		await second.waitForFunction(
			() => document.querySelector('.feed-panel')?.dataset.topic === 'insomnia-topics'
		);
		if (width < 1180)
			assert.equal(await page.locator('.source-links a').first().innerText(), 'insomnia');
		const initialCount = await page.locator('#feed-r-greece-rising .feed-list li').count();
		const hidden = await hideFirst(page);
		assert.equal(
			await page.locator('#feed-r-greece-rising .feed-list li').count(),
			initialCount,
			'hidden items are replaced before the visible limit'
		);
		assert.equal(
			await page.locator(`#feed-insomnia-topics [data-feed-item-id="${hidden}"]`).count(),
			1,
			'hiding is scoped to the source'
		);
		await second.waitForFunction(
			(id) => !document.querySelector(`#feed-r-greece-rising [data-feed-item-id="${id}"]`),
			hidden
		);
		await page.getByRole('button', { name: 'Αναίρεση', exact: true }).click();
		await page.locator(`#feed-r-greece-rising [data-feed-item-id="${hidden}"]`).waitFor();
		assert(
			await page
				.locator(`#feed-r-greece-rising [data-feed-item-id="${hidden}"] .item-actions-button`)
				.evaluate((node) => node === document.activeElement)
		);
		const hiddenAgain = await hideFirst(page);
		await page.reload();
		await ready(page);
		await page
			.locator(`#feed-r-greece-rising [data-feed-item-id="${hiddenAgain}"]`)
			.waitFor({ state: 'detached' });
		assert.equal(
			await page.locator(`#feed-r-greece-rising [data-feed-item-id="${hiddenAgain}"]`).count(),
			0,
			`persisted item ${hiddenAgain}: ${await page.evaluate((key) => localStorage.getItem(key), storageKey)}`
		);
		await settings(page);
		await page.getByText('Κρυμμένα θέματα (1)', { exact: true }).click();
		await page.getByRole('button', { name: 'Επαναφορά όλων των θεμάτων', exact: true }).click();
		for (const checkbox of await page.locator('.source-preferences input').all())
			await checkbox.uncheck();
		await closeSettings(page);
		await page.waitForFunction(() => document.querySelectorAll('.feed-panel').length === 0);
		assert.equal(await page.locator('.feed-panel').count(), 0);
		await page.getByRole('button', { name: 'Επιλογή πηγών', exact: true }).click();
		await page.getByRole('button', { name: 'Επαναφορά πηγών και σειράς', exact: true }).click();
		await page.screenshot({ path: `/tmp/greeklish-personalization-review/settings-${width}.png` });
		await closeSettings(page);
		assert.deepEqual(await sourceOrder(page), original);
		assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
		await page.screenshot({ path: `/tmp/greeklish-personalization-review/feed-${width}.png` });
		assert.equal(
			await page.evaluate(() => document.documentElement.classList.contains('dark')),
			dark
		);
		await settings(page);
		await page.getByText(dark ? 'Φωτεινό' : 'Σκούρο', { exact: true }).click();
		await second.waitForFunction(
			(expected) => document.documentElement.classList.contains('dark') === expected,
			!dark
		);
		await page.reload();
		await ready(page);
		assert.equal(
			await page.evaluate(() => document.documentElement.classList.contains('dark')),
			!dark,
			'theme choice survives reload'
		);
		await page.evaluate(() => localStorage.removeItem('mode-watcher-mode'));
		await second.waitForFunction(
			(expected) => document.documentElement.classList.contains('dark') === expected,
			dark
		);
		await second.emulateMedia({ colorScheme: dark ? 'light' : 'dark' });
		await second.waitForFunction(
			(expected) => document.documentElement.classList.contains('dark') === expected,
			!dark
		);
		console.log(
			`PASS ${width}px ${dark ? 'dark' : 'light'}: reorder, keyboard/drag, hide, Undo focus, persistence, tab sync, restore, empty feed, theme changes and xcancel removal`
		);
		await context.close();
	}
	const blocked = await createContext(390, false, true);
	const page = await open(blocked);
	await hideFirst(page);
	await settings(page);
	assert(await page.getByText('Η αποθήκευση δεν είναι διαθέσιμη.', { exact: false }).isVisible());
	await page.getByRole('button', { name: 'r/greece: μετακίνηση κάτω', exact: true }).click();
	await page.getByRole('checkbox', { name: 'twitter/x', exact: true }).uncheck();
	await page.getByText('Σκούρο', { exact: true }).click();
	await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
	await closeSettings(page);
	assert.equal(await page.locator('.feed-panel').count(), 6);
	assert.equal((await sourceOrder(page))[0], 'insomnia-topics');
	await blocked.close();
	console.log('PASS blocked storage: controls retain working in-memory preferences');
	const corrupted = await createContext();
	await corrupted.addInitScript((key) => {
		try {
			localStorage.setItem(key, '{broken');
		} catch {
			/* Initial opaque document. */
		}
	}, storageKey);
	const corruptPage = await open(corrupted);
	await settings(corruptPage);
	await corruptPage.getByRole('button', { name: 'r/greece: μετακίνηση κάτω', exact: true }).click();
	await closeSettings(corruptPage);
	assert.equal((await sourceOrder(corruptPage))[0], 'insomnia-topics');
	await corrupted.close();
	console.log('PASS malformed saved preferences recover to usable defaults');
	assert.deepEqual(errors, [], 'no browser errors');
} finally {
	if (errors.length) console.error('Browser errors:', errors);
	await browser.close();
	await server.close();
}
