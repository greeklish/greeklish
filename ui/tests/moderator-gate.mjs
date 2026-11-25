import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
const directions = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'];
const server = await createServer({
	server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: ['.'] } }
});
await server.listen();
let browser;
const errors = [];
const failures = [];

async function createPage(width = 1280, touch = false) {
	const page = await browser.newPage({
		viewport: { width, height: 844 },
		isMobile: touch,
		hasTouch: touch
	});
	page.setDefaultTimeout(5000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.addInitScript(() => {
		globalThis.__sveltekit_dev = { env: {} };
	});
	await page.route('**/api/**', (route) =>
		route.fulfill({
			status: 401,
			json: { code: 'unauthorized', message: 'Fixture rejection' }
		})
	);
	await page.route('**/__moderator-gate-test', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
		<style>body { margin: 0; min-height: 5000px; } main { padding: 20px; }
		:root { --wx-modal-z-index: 2000; --wx-modal-background: white; }</style></head><body>
		<main><button id="opener">Focus target</button><input aria-label="Editor">
		<textarea aria-label="Comment"></textarea><div contenteditable="true" aria-label="Rich text"></div></main>
		<script type="module" src="/tests/fixtures/moderator-gate.mjs"></script></body></html>`
		})
	);
	await page.goto(new URL('/__moderator-gate-test', server.resolvedUrls.local[0]).href);
	await page.locator('body[data-ready=true]').waitFor();
	return page;
}

async function enterKeys(page, sequence = keys) {
	for (const key of sequence) await page.keyboard.press(key);
}

// Native Chromium touch input exercises scrolling and browser-generated pointercancel events.
async function swipe(client, direction, { distance = 100, duration = 160, cancel = false } = {}) {
	const x = 180,
		y = 450;
	const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
	const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [{ x, y, id: 1 }]
	});
	for (let step = 1; step <= 5; step++) {
		await new Promise((resolve) => setTimeout(resolve, duration / 5));
		await client.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: x + (dx * step) / 5, y: y + (dy * step) / 5, id: 1 }]
		});
	}
	await client.send('Input.dispatchTouchEvent', {
		type: cancel ? 'touchCancel' : 'touchEnd',
		touchPoints: []
	});
}

async function run(name, task) {
	try {
		await task();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures.push(`${name}: ${error.message}`);
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

try {
	browser = await chromium.launch({
		executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
		headless: true
	});
	await run(
		'keyboard opens an empty, focused password field and preserves normal typing',
		async () => {
			const page = await createPage();
			await page.locator('#opener').focus();
			await enterKeys(page);
			const field = page.locator('input[type=password]');
			await field.waitFor();
			assert.equal(
				await field.inputValue(),
				'',
				'the final a must not become part of the password'
			);
			assert(await field.evaluate((input) => input === document.activeElement));
			await page.keyboard.type('actual-password');
			assert.equal(await field.inputValue(), 'actual-password');
			await page.keyboard.press('Escape');
			await field.waitFor({ state: 'detached' });
			assert(await page.locator('#opener').evaluate((button) => button === document.activeElement));
			assert.equal(await page.evaluate(() => document.body.style.overflow), '');
			await enterKeys(
				page,
				keys.map((key) => (key.length === 1 ? key.toUpperCase() : key))
			);
			await field.waitFor();
			assert.equal(await field.inputValue(), '');
			await page.close();
		}
	);
	await run('typing in editable fields and incomplete codes do not unlock', async () => {
		const page = await createPage();
		for (const label of ['Editor', 'Comment', 'Rich text']) {
			await page.getByLabel(label, { exact: true }).focus();
			await enterKeys(page);
			assert.equal(await page.locator('input[type=password]').count(), 0);
		}
		await page.locator('#opener').focus();
		await enterKeys(page, [...keys.slice(0, 5), 'x', ...keys.slice(5)]);
		assert.equal(await page.locator('input[type=password]').count(), 0);
		await enterKeys(page);
		await page.locator('input[type=password]').waitFor();
		await page.close();
	});
	for (const width of [320, 390, 430])
		await run(`native mobile swipes, scrolling and same-event focus at ${width}px`, async () => {
			const page = await createPage(width, true);
			const client = await page.context().newCDPSession(page);
			await page.evaluate(() => scrollTo(0, 800));
			await swipe(client, 'up');
			assert(await page.evaluate(() => scrollY > 800), 'swiping must still scroll the page');
			// Ordinary taps between swipes must neither count as directions nor erase progress.
			await page.touchscreen.tap(250, 650);
			for (const direction of directions.slice(1)) await swipe(client, direction);
			const letters = page.locator('.gate-letter-input');
			await letters.waitFor();
			const events = await page.evaluate(() => window.gateEvents);
			assert(
				events.some((event) => event.type === 'pointercancel'),
				'test must exercise native pointer cancellation'
			);
			assert(
				events.filter((event) => event.type === 'touchend').every((event) => !event.prevented)
			);
			assert.equal(
				events.filter((event) => event.type === 'touchend').at(-1).focused,
				await letters.getAttribute('aria-label'),
				'letter input is focused before touchend returns'
			);
			await page.keyboard.insertText('B');
			assert.equal(await page.locator('input[type=password]').count(), 0);
			await page.keyboard.insertText('A');
			const field = page.locator('input[type=password]');
			await field.waitFor();
			assert.equal(await field.inputValue(), '');
			assert(await field.evaluate((input) => input === document.activeElement));
			assert.equal(
				await page.evaluate(
					() => window.gateEvents.filter((event) => event.type === 'input').at(-1).focused
				),
				'Κωδικός',
				'password is focused before the input event returns'
			);
			await page.keyboard.insertText('phone-password');
			assert.equal(await field.inputValue(), 'phone-password');
			await page.keyboard.press('Escape');
			await field.waitFor({ state: 'detached' });
			await page.close();
		});
	await run(
		'a wrong mobile letter dismisses the input and requires a fresh swipe sequence',
		async () => {
			const page = await createPage(390, true);
			const client = await page.context().newCDPSession(page);
			const letters = page.locator('.gate-letter-input');
			const field = page.locator('input[type=password]');
			await page.evaluate(() => scrollTo(0, 800));
			for (const attempt of [['x'], ['a'], ['b', 'x'], ['b', 'b']]) {
				for (const direction of directions) await swipe(client, direction);
				await letters.waitFor();
				for (const letter of attempt) await page.keyboard.insertText(letter);
				await letters.waitFor({ state: 'detached' });
				assert.equal(await page.locator('.gate-veil').count(), 0, 'the overlay is dismissed too');
				await page.keyboard.insertText('a');
				await page.keyboard.type('ba');
				assert.equal(await field.count(), 0, `${attempt.join('')} invalidates the whole attempt`);
				for (const direction of directions.slice(1)) await swipe(client, direction);
				assert.equal(await letters.count(), 0, 'a partial swipe sequence cannot restore the input');
				for (const direction of directions) await swipe(client, direction);
				await letters.waitFor();
				assert.equal(await letters.inputValue(), '', 'a fresh attempt starts empty');
				await page.keyboard.insertText('b');
				assert.equal(await letters.inputValue(), 'b');
				assert.equal(await field.count(), 0, 'b alone does not unlock');
				await page.keyboard.insertText('a');
				await field.waitFor();
				assert.equal(await field.inputValue(), '');
				await page.keyboard.press('Escape');
				await field.waitFor({ state: 'detached' });
			}
			await page.close();
		}
	);
	await run(
		'cancelled, multi-touch and expired gestures reset; a fresh sequence still works',
		async () => {
			const page = await createPage(390, true);
			const client = await page.context().newCDPSession(page);
			await page.evaluate(() => scrollTo(0, 800));
			for (const interruption of ['cancel', 'multi-touch', 'timeout']) {
				await swipe(client, 'up');
				if (interruption === 'cancel') {
					await swipe(client, 'up', { cancel: true });
				} else if (interruption === 'multi-touch') {
					await client.send('Input.dispatchTouchEvent', {
						type: 'touchStart',
						touchPoints: [
							{ x: 150, y: 450, id: 1 },
							{ x: 250, y: 450, id: 2 }
						]
					});
					await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				} else {
					await page.waitForTimeout(2600);
				}
				for (const direction of directions.slice(1)) await swipe(client, direction);
				assert.equal(
					await page.locator('.gate-letter-input').count(),
					0,
					`${interruption} invalidates the prefix`
				);
			}
			for (const direction of directions) await swipe(client, direction);
			await page.locator('.gate-letter-input').waitFor();
			await page.keyboard.press('Escape');
			await page.locator('.gate-letter-input').waitFor({ state: 'detached' });
			for (const direction of directions) await swipe(client, direction);
			await page.locator('.gate-letter-input').waitFor();
			await page.touchscreen.tap(20, 650);
			await page.locator('.gate-letter-input').waitFor({ state: 'detached' });
			assert.equal(await page.locator('input[type=password]').count(), 0);
			await page.close();
		}
	);
	assert.deepEqual(errors, [], 'no browser runtime errors');
	assert.deepEqual(failures, [], 'all moderator gate regressions pass');
} finally {
	await browser?.close();
	await server.close();
}
